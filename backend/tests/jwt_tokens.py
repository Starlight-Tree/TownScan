"""テスト用の JWT。EC P-256 の鍵をテストの中で作り、API が読む JWKS をその公開鍵に差し替える（Better Auth の代わり）。
鍵・トークンはファイルに書かない（実行のたびに作る）。"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time

import jwt
from cryptography.hazmat.primitives.asymmetric import ec, rsa

ISSUER = "http://localhost:3500"
JWKS_URL = "http://web:3000/api/auth/jwks"
AUDIENCE = "townscan"
KID = "test-key-1"
DEFAULT_SUB = "ba_user_0000000001"

PRIVATE_KEY = ec.generate_private_key(ec.SECP256R1())
OTHER_PRIVATE_KEY = ec.generate_private_key(ec.SECP256R1())  # JWKS に載せない鍵（偽造の想定）
RSA_PRIVATE_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)  # RS256 で署名した偽造の想定


def jwks_document(private_key=PRIVATE_KEY, kid: str = KID, *, with_alg: bool = True) -> dict:
    """JWKS の本文。with_alg=False は、alg / use の無い形（実際の Better Auth の出力がどちらでも読めることの確認用）。"""
    jwk = json.loads(jwt.algorithms.ECAlgorithm.to_jwk(private_key.public_key()))
    jwk["kid"] = kid
    if with_alg:
        jwk.update(alg="ES256", use="sig")
    return {"keys": [jwk]}


def claims(**overrides) -> dict:
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


def make_token(*, key=PRIVATE_KEY, kid: str | None = KID, alg: str = "ES256", **overrides) -> str:
    headers = {"kid": kid} if kid else {}
    return jwt.encode(claims(**overrides), key, algorithm=alg, headers=headers)


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def make_unsigned_token(**overrides) -> str:
    """alg=none（署名なし）のトークン。"""
    header = {"alg": "none", "kid": KID, "typ": "JWT"}
    return f"{_b64(json.dumps(header).encode())}.{_b64(json.dumps(claims(**overrides)).encode())}."


def make_hs256_token(**overrides) -> str:
    """公開鍵（JWKS で誰でも読める）を共有秘密にして HS256 で署名した偽造。PyJWT は、この署名を作ること自体を拒むので、手で作る。"""
    secret = json.dumps(jwks_document()["keys"][0]).encode()
    header = {"alg": "HS256", "kid": KID, "typ": "JWT"}
    signing_input = f"{_b64(json.dumps(header).encode())}.{_b64(json.dumps(claims(**overrides)).encode())}"
    return f"{signing_input}.{_b64(hmac.new(secret, signing_input.encode(), hashlib.sha256).digest())}"
