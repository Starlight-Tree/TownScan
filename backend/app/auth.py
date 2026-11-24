"""ログイン中の人を、リクエストから取り出す（FastAPI の依存）。ログインは任意で、`GET /api/me` だけがこれを使う（ほかの入口は、ログインを要求しない）。

ログイン（Google との通信・セッション・JWT の発行）は、画面のサーバーの中の Better Auth の仕事（frontend/）で、この API は扱わない。
ここでは、`Authorization: Bearer <JWT>` を jwt_auth.py で検証する。エラーの本文は固定の文（例外の文字列・URL・パスは返さない）。
"""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import Header, Request

from . import jwt_auth
from .errors import ApiError

log = logging.getLogger("townscan")

# どの応答（成功・失敗）も、ブラウザーや中継に保存させない（人ごとに違う内容）
NO_STORE_HEADERS = {"Cache-Control": "no-store"}


# 例外は、投げるたびに作る（同じ例外オブジェクトを使い回すと、トレースバックが積み上がる）。本文は固定の文
def not_logged_in() -> ApiError:
    return ApiError(401, "unauthorized", "ログインしてください", {"WWW-Authenticate": "Bearer", **NO_STORE_HEADERS})


def not_configured() -> ApiError:
    return ApiError(503, "unavailable", "Google でのログインは、まだ設定されていません", dict(NO_STORE_HEADERS))


def unavailable() -> ApiError:
    return ApiError(503, "unavailable", "ログインを確認できませんでした。しばらくしてから、もう一度お試しください", dict(NO_STORE_HEADERS))


def bearer_token(authorization: str | None) -> str:
    """`Bearer <トークン>` からトークンを取り出す。無い・形が違うときは、401 の ApiError。"""
    scheme, _, token = (authorization or "").partition(" ")
    token = token.strip()
    if scheme.lower() != "bearer" or not token or " " in token:
        raise not_logged_in()
    return token


def current_identity(
    request: Request,
    authorization: Annotated[str | None, Header(description="Authorization: Bearer <JWT>（web のサーバーが付ける）")] = None,
) -> jwt_auth.Identity:
    """ログイン中の人。認証の設定が無ければ 503（トークンの有無より先）、トークンが無い・違う・期限切れなら 401、JWKS を取れなければ 503。"""
    verifier: jwt_auth.JwtVerifier | None = request.app.state.verifier
    if verifier is None:
        raise not_configured()  # 設定が無いときは、トークンの有無を見る前に 503（仕様 §4.4）
    token = bearer_token(authorization)
    try:
        return verifier.verify(token)
    except jwt_auth.InvalidToken as exc:
        log.info("認証に失敗しました (reason=%s)", exc)  # 失敗の種類だけ。トークンの中身は出さない
        raise not_logged_in() from None
    except jwt_auth.AuthUnavailable:
        raise unavailable() from None
