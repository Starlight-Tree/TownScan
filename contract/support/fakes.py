"""偽の画面のサーバー（Better Auth の代わり）: 署名用の鍵・JWKS を配る小さな HTTP サーバー・テスト用の JWT の作り方。

鍵は、検査の実行（プロセス）ごとに作る（ファイルに書かない）。API は起動時の設定（AUTH_JWKS_URL）でこのサーバーを指し、
最初の `/api/me` の要求で、ここへ JWKS を取りに来る（以後は API が覚える）。API の側は、この検査のコードを知らない。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import jwt
from cryptography.hazmat.primitives.asymmetric import ec, ed25519, rsa

# API を起動するときの設定と合わせる値（contract/README.md の「API の構成」）。環境変数で変えられる
ISSUER = os.environ.get("CONTRACT_AUTH_ISSUER", "https://auth.contract.test")
AUDIENCE = "townscan"  # AUTH_AUDIENCE を設定しないときの既定。API の構成 main は設定しない（既定の値の検査を兼ねる）
JWKS_PATH = "/api/auth/jwks"
JWKS_BIND = os.environ.get("CONTRACT_JWKS_BIND", "0.0.0.0")
JWKS_PORT = int(os.environ.get("CONTRACT_JWKS_PORT", "8901"))

_SUFFIX = os.urandom(3).hex()  # kid に実行ごとの印を付ける（前の実行の鍵と取り違えない）
KID = f"contract-es256-a-{_SUFFIX}"  # JWKS に alg・use が付く鍵
KID_PLAIN = f"contract-es256-b-{_SUFFIX}"  # JWKS に alg・use が付かない鍵（Better Auth の実際の出力はこの形）
DEFAULT_SUB = "ba_user_0000000001"

# ---- 会話の履歴（構成 history）の検査用の利用者 ----
# 偽の JWT の sub に対応する auth_user の行が要る（外部キー・LLM の前の存在の確認）。scripts/test-contract.sh が、データを読み込んだあとに、
# `ct_user_000001`〜`ct_user_<USER_POOL_SIZE>` を使い捨ての DB へ入れる。検査は互いの状態に依存しないよう、検査ごとに別の利用者を使う（fresh_user）。
USER_POOL_SIZE = int(os.environ.get("CONTRACT_USER_POOL", "200"))
USER_PREFIX = "ct_user_"
NOUSER_SUB = "ct_nouser_000001"  # プールの外の固定の sub。auth_user に行が無い（H-A4）
_user_lock = threading.Lock()
_users_given = 0  # fresh_user() が配った回数（同じ実行〔プロセス〕の中で重ならない番号の元）

PRIVATE_KEY = ec.generate_private_key(ec.SECP256R1())
PRIVATE_KEY_PLAIN = ec.generate_private_key(ec.SECP256R1())
OTHER_PRIVATE_KEY = ec.generate_private_key(ec.SECP256R1())  # JWKS に載せない鍵（偽造の想定）
RSA_PRIVATE_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)  # RS256 の偽造・JWKS に混ぜる使えない鍵
P384_PRIVATE_KEY = ec.generate_private_key(ec.SECP384R1())  # ES384 の偽造・JWKS に混ぜる使えない鍵
ED25519_PRIVATE_KEY = ed25519.Ed25519PrivateKey.generate()  # JWKS に混ぜる使えない鍵（Better Auth の既定の alg は EdDSA）


def _jwk(algorithm: Any, public_key: Any, **extra: Any) -> dict:
    return {**json.loads(algorithm.to_jwk(public_key)), **extra}


def jwks_document() -> dict:
    """配る JWKS。使える鍵（EC P-256・kid あり・署名用）が 2 つと、使えない鍵が混ざる。使えない鍵があっても、使える鍵で検証できること。"""
    ec_alg = jwt.algorithms.ECAlgorithm
    return {
        "keys": [
            _jwk(ec_alg, PRIVATE_KEY.public_key(), kid=KID, alg="ES256", use="sig"),
            _jwk(ec_alg, PRIVATE_KEY_PLAIN.public_key(), kid=KID_PLAIN),
            _jwk(jwt.algorithms.OKPAlgorithm, ED25519_PRIVATE_KEY.public_key(), kid=f"contract-ed25519-{_SUFFIX}", alg="EdDSA"),
            _jwk(jwt.algorithms.RSAAlgorithm, RSA_PRIVATE_KEY.public_key(), kid=f"contract-rsa-{_SUFFIX}"),
            _jwk(ec_alg, P384_PRIVATE_KEY.public_key(), kid=f"contract-p384-{_SUFFIX}"),
            _jwk(ec_alg, OTHER_PRIVATE_KEY.public_key()),  # kid が無い
            _jwk(ec_alg, OTHER_PRIVATE_KEY.public_key(), kid=f"contract-enc-{_SUFFIX}", use="enc"),  # 暗号化用
        ]
    }


class JwksServer:
    """JWKS（と、それ以外のパスへの 404）を返すサーバー。`hits` に、受けた GET のパスが残る。"""

    def __init__(self, host: str = JWKS_BIND, port: int = JWKS_PORT) -> None:
        self.hits: list[str] = []
        body = json.dumps(jwks_document()).encode()
        hits = self.hits

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                hits.append(self.path)
                ok = self.path == JWKS_PATH
                payload = body if ok else b"{}"
                self.send_response(200 if ok else 404)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                try:
                    self.wfile.write(payload)
                except OSError:
                    pass

            def log_message(self, *args: Any) -> None:
                pass

        self._server = ThreadingHTTPServer((host, port), Handler)
        self._server.daemon_threads = True
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    def start(self) -> "JwksServer":
        self._thread.start()
        return self

    def stop(self) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)


# ---- JWT ----

def claims(**overrides: Any) -> dict:
    """検証に通る既定の claims（Better Auth の definePayload と同じ形）。None を渡した項目は外す。"""
    now = int(time.time())
    base = {
        "iss": ISSUER,
        "aud": AUDIENCE,
        "sub": DEFAULT_SUB,
        "iat": now,
        "exp": now + 900,
        "email": "tanaka@example.com",
        "email_verified": True,
        "name": "田中 太郎",
        "picture": "https://lh3.googleusercontent.com/a/test",
    }
    base.update(overrides)
    return {k: v for k, v in base.items() if v is not None}


def make_token(*, key: Any = None, kid: str | None = KID, alg: str = "ES256", **overrides: Any) -> str:
    """署名した JWT。key の既定は JWKS の鍵 A（kid=KID）。kid=None で kid ヘッダーを外す。"""
    headers = {"kid": kid} if kid else {}
    return jwt.encode(claims(**overrides), PRIVATE_KEY if key is None else key, algorithm=alg, headers=headers)


def user_sub(number: int) -> str:
    """プールの number 番目（1 から）の利用者の sub。`ct_user_000001` の形（sub の規則 `[A-Za-z0-9_-]{8,64}` に合う）。"""
    return f"{USER_PREFIX}{number:06d}"


def fresh_user() -> str:
    """同じ実行の中でまだ使っていない利用者の sub を返す（auth_user に行がある）。プールを使い切ったら、はっきり失敗する（同じ利用者を使い回さない）。
    同じ DB に履歴の構成を 2 回流すと、前の実行の会話が残っていて、新しい利用者のはずが新しくならない（README の「データの準備」）。"""
    global _users_given
    with _user_lock:
        number = _users_given + 1
        if number > USER_POOL_SIZE:
            raise RuntimeError(
                f"検査用の利用者を使い切りました（{USER_POOL_SIZE} 人）。scripts/test-contract.sh が入れる人数（HISTORY_USERS）を増やし、"
                "検査の側の CONTRACT_USER_POOL もそろえてください。同じ利用者を使い回すと、検査が互いの状態に依存します"
            )
        _users_given = number
    return user_sub(number)


def users_used() -> int:
    """これまでに fresh_user() が配った人数。"""
    with _user_lock:
        return _users_given


def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def make_unsigned_token(**overrides: Any) -> str:
    """alg=none（署名なし）のトークン。"""
    header = {"alg": "none", "kid": KID, "typ": "JWT"}
    return f"{b64(json.dumps(header).encode())}.{b64(json.dumps(claims(**overrides)).encode())}."


def make_hs256_token(**overrides: Any) -> str:
    """公開鍵（JWKS で誰でも読める）を共有秘密にして HS256 で署名した偽造。PyJWT は作ること自体を拒むので、手で作る。"""
    secret = json.dumps(jwks_document()["keys"][0]).encode()
    header = {"alg": "HS256", "kid": KID, "typ": "JWT"}
    signing_input = f"{b64(json.dumps(header).encode())}.{b64(json.dumps(claims(**overrides)).encode())}"
    return f"{signing_input}.{b64(hmac.new(secret, signing_input.encode(), hashlib.sha256).digest())}"


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}
