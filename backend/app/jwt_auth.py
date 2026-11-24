"""ログイン中の人の確認（画面のサーバー（Next.js）の中の Better Auth が発行した JWT の検証）。JobNavi の backend/app/jwt_auth.py と同じ考え方。

ログイン（Google との通信・セッション・JWT の発行）は Better Auth（web 側）の仕事で、この API は扱わない。web のサーバーが、ログイン中の人の JWT（ES256・15 分）を
`Authorization: Bearer <JWT>` で送ってくるので、ここで確かめる。

- 署名の検証は、Better Auth の JWKS（`AUTH_JWKS_URL`。web のサーバーが配る）の公開鍵だけで行う。alg は ES256 に固定する。alg=none・HS256（公開鍵を共有秘密にする攻撃）・RS256 などは、鍵を取りに行く前に断る。
  発行元（`iss`）は `AUTH_ISSUER`、対象（`aud`）は `AUTH_AUDIENCE`（既定 townscan）。`exp` `iss` `aud` `sub` は必須。
- 利用者の ID は、検証に通ったトークンの `sub` だけから取る。クライアントが送った別の値は使わない。
- トークンの中身・Authorization ヘッダはログに出さない。ログに残すのは、失敗の種類（例外のクラス名）だけ。例外の文字列・URL・パスは、応答にも出さない。
- 鍵を取れないときは、前に取れた鍵で続ける。前の鍵が無ければ、検証できない（`AuthUnavailable`。呼び出し側は 503）。共有秘密の検証には切り替えない。
  取得に失敗したあとは、しばらく取りに行かない（`_FAILURE_BACKOFF_SECONDS`）。web が落ちている間に、要求のたびに待たされて、API のスレッドが埋まらないように。
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import jwt

from .config import AuthConfig

logger = logging.getLogger("townscan")

# 署名に使ってよいアルゴリズムと鍵。ES256（EC の P-256）だけ
ALLOWED_ALGORITHM = "ES256"
_ALLOWED_KEY_TYPE = "EC"
# Better Auth の利用者 ID（英数字と _ -）
_USER_ID = re.compile(r"[A-Za-z0-9_-]{8,64}")
_REQUIRED_CLAIMS = ["exp", "iss", "aud", "sub"]
# 端末・サーバーの時計のずれを許す秒数
_LEEWAY_SECONDS = 10
# JWKS の取得: 1 回の待ち時間の上限と、読む本文の上限
_FETCH_TIMEOUT_SECONDS = 3.0
_MAX_JWKS_BYTES = 1_000_000
# 取得した鍵を使い続ける時間。過ぎたら取り直す（取り直しに失敗したときは、前の鍵を使い続ける）
_KEYS_TTL_SECONDS = 600.0
# 鍵があるときの取り直しの最小間隔（未知の kid を理由にした取り直しも、この間隔まで）。でたらめな kid のトークンで、JWKS への問い合わせを増幅させないため
_MIN_REFRESH_INTERVAL_SECONDS = 60.0
# 鍵が 1 つも無いまま取得に失敗したあと、次に取りに行くまでの間隔（その間の要求は、待たせずに 503）
_FAILURE_BACKOFF_SECONDS = 5.0
_JWKS_USER_AGENT = "townscan-api/1.0"
# 受け取る文字列の上限
_MAX_TOKEN = 8192
_MAX_EMAIL = 254
_MAX_NAME = 100
_MAX_PICTURE = 2048

# テストが差し替える（時計と、JWKS の取得）
_now: Callable[[], float] = time.monotonic


class InvalidToken(Exception):
    """トークンを受け付けない。理由はログ用で、クライアントへは返さない。"""


class AuthUnavailable(Exception):
    """鍵を取得できず、検証できない。"""


@dataclass(frozen=True)
class Identity:
    """検証に通った JWT から取り出した、ログイン中の人。sub は Better Auth の利用者 ID。"""

    sub: str
    email: str | None
    name: str | None
    picture: str | None

    def as_dict(self) -> dict[str, str | None]:
        return {"sub": self.sub, "email": self.email, "name": self.name, "picture": self.picture}


def fetch_jwks_document(url: str) -> dict[str, Any]:
    """JWKS を取得して JSON として返す（同期）。"""
    request = urllib.request.Request(  # noqa: S310 (http/https は設定の読み取りで検証済み)
        url, headers={"Accept": "application/json", "User-Agent": _JWKS_USER_AGENT}
    )
    with urllib.request.urlopen(request, timeout=_FETCH_TIMEOUT_SECONDS) as response:  # noqa: S310
        body = response.read(_MAX_JWKS_BYTES + 1)
    if len(body) > _MAX_JWKS_BYTES:
        raise ValueError("JWKS が大きすぎます")
    document = json.loads(body)
    if not isinstance(document, dict):
        raise ValueError("JWKS が JSON のオブジェクトではありません")
    return document


def _parse_keys(document: dict[str, Any]) -> dict[str, jwt.PyJWK]:
    """JWKS から、使ってよい鍵（EC の P-256 で、kid があり、署名用のもの）だけを kid で引ける形にする。"""
    keys: dict[str, jwt.PyJWK] = {}
    raw_keys = document.get("keys")
    for item in raw_keys if isinstance(raw_keys, list) else []:
        if not isinstance(item, dict) or item.get("kty") != _ALLOWED_KEY_TYPE:
            continue
        kid = item.get("kid")
        if not isinstance(kid, str) or not kid or item.get("use", "sig") != "sig":
            continue
        try:
            key = jwt.PyJWK(item)
        except Exception:  # noqa: BLE001 - 壊れた鍵 1 つで、ほかの鍵まで使えなくしない（その鍵だけ捨てる）
            continue
        if key.algorithm_name == ALLOWED_ALGORITHM:
            keys[kid] = key
    return keys


class JwksCache:
    """JWKS の公開鍵の置き場。期限が来たら取り直し、未知の kid は間隔を空けて取り直す。"""

    def __init__(self, url: str) -> None:
        self.url = url
        self._keys: dict[str, jwt.PyJWK] = {}
        self._fetched_at: float | None = None  # 最後に取得に成功した時刻
        self._attempted_at: float | None = None  # 最後に取得を試みた時刻（成功・失敗とも）
        self._lock = threading.Lock()

    def _refresh_locked(self) -> None:
        self._attempted_at = _now()
        keys = _parse_keys(fetch_jwks_document(self.url))
        if not keys:
            raise ValueError("JWKS に使える鍵がありません")
        self._keys = keys
        self._fetched_at = _now()

    def get_key(self, kid: str) -> jwt.PyJWK | None:
        """kid の鍵。無ければ None（受け付けない）。鍵が 1 つも無く、取得もできないときは AuthUnavailable。"""
        with self._lock:
            now = _now()
            fresh = self._fetched_at is not None and now - self._fetched_at < _KEYS_TTL_SECONDS
            if fresh and kid in self._keys:
                return self._keys[kid]
            interval = _MIN_REFRESH_INTERVAL_SECONDS if self._keys else _FAILURE_BACKOFF_SECONDS
            if self._attempted_at is not None and now - self._attempted_at < interval:
                if not self._keys:
                    raise AuthUnavailable
                return self._keys.get(kid)
            try:
                self._refresh_locked()
            except Exception as exc:  # noqa: BLE001 - 原因を問わず、取れなかったこととして扱う（失敗の種類だけを残す）
                logger.warning("JWKS を取得できませんでした (%s)", type(exc).__name__)  # URL・本文は出さない
                if not self._keys:
                    raise AuthUnavailable from None
            return self._keys.get(kid)


def _text(value: Any, limit: int) -> str | None:
    """前後の空白を除いた、1〜limit 文字の文字列。そうでなければ None。"""
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value if 0 < len(value) <= limit else None


def _display_name(value: Any) -> str | None:
    """名前を、表示の上限（コードポイントで _MAX_NAME 文字）までにした値。空・文字列でなければ None（制御文字は持たない）。"""
    if not isinstance(value, str):
        return None
    value = "".join(ch for ch in value if ch.isprintable()).strip()[:_MAX_NAME]
    return value.strip() or None


def _identity(claims: dict[str, Any]) -> Identity:
    sub = claims.get("sub")
    if not isinstance(sub, str) or not _USER_ID.fullmatch(sub):
        raise InvalidToken("sub")
    email = _text(claims.get("email"), _MAX_EMAIL)
    # 画像は claim `picture`（Better Auth の既定の payload では `image`）。画面は https の画像だけを表示するので、それ以外は持たない
    picture = _text(claims.get("picture"), _MAX_PICTURE) or _text(claims.get("image"), _MAX_PICTURE)
    return Identity(
        sub=sub,
        email=email if email and "@" in email else None,
        name=_display_name(claims.get("name")),
        picture=picture if picture and picture.startswith("https://") else None,
    )


class JwtVerifier:
    """設定（発行元・JWKS の URL・対象）に対する、トークンの検証。JWKS の鍵の置き場を持つ（アプリごとに 1 つ）。"""

    def __init__(self, config: AuthConfig) -> None:
        self.config = config
        self._cache = JwksCache(config.jwks_url)

    def verify(self, token: str) -> Identity:
        """トークンを検証して、ログイン中の人を返す。受け付けないときは InvalidToken、鍵が取れないときは AuthUnavailable。"""
        if not token or len(token) > _MAX_TOKEN:
            raise InvalidToken("malformed")
        try:
            header = jwt.get_unverified_header(token)
        except (jwt.PyJWTError, ValueError) as exc:
            raise InvalidToken("malformed") from exc
        # alg は ES256 だけ。none・HS256・RS256 などは、鍵を取りに行く前に断る
        if header.get("alg") != ALLOWED_ALGORITHM:
            raise InvalidToken("algorithm")
        kid = header.get("kid")
        if not isinstance(kid, str) or not kid:
            raise InvalidToken("kid")

        key = self._cache.get_key(kid)
        if key is None:
            raise InvalidToken("unknown_key")
        try:
            claims = jwt.decode(
                token,
                key.key,
                algorithms=[ALLOWED_ALGORITHM],
                audience=self.config.audience,
                issuer=self.config.issuer,
                leeway=_LEEWAY_SECONDS,
                options={"require": _REQUIRED_CLAIMS},
            )
        except (jwt.PyJWTError, ValueError, TypeError) as exc:
            raise InvalidToken(type(exc).__name__) from exc
        return _identity(claims)
