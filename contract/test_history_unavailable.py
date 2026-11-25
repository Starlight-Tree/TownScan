"""会話の履歴が使えないとき（H-A5・H-A6・H-A7。仕様 §4.4 の履歴まわりのエラー・§8 の E9）。既存の構成（noauth・badauth・jwksdown・dbdown）に足す。

- noauth・badauth（H-A5）: ログインの設定が無い・不正。履歴の 3 本と、`conversation_id` つきの chat は、JWT の有無・形を見る前に 503 `unavailable`。
  `conversation_id` を付けない chat は、これまでどおり 200（test_auth_independence.py も確かめる）。
- jwksdown（H-A6）: JWKS に届かない。`Authorization` が無い・壊れている → 401。形の正しいトークン → 503（鍵を取れない）。
- dbdown（H-A7）: DB が止まっている。有効な JWT で、3 経路と `conversation_id` つきの chat が 503 `db_unavailable`。

3 経路の 503 は `Cache-Control: no-store`（`POST /api/chat` には付けない約束で、ここでは確かめない）。
どの検査も機能の印 `history` を持つ。履歴の経路が無い API には流さない（CONTRACT_FEATURES）。
"""

from __future__ import annotations

import pytest

from support.checks import assert_error
from support.client import Client, Response
from support.fakes import bearer, make_token
from support.history import (
    CANNOT_VERIFY,
    DB_DOWN_TIMEOUT,
    DB_UNAVAILABLE_MESSAGE,
    NOT_CONFIGURED,
    QUESTION,
    assert_no_store,
    assert_not_answered,
    assert_unauthorized,
    chat_body,
    conversation_path,
    messages_path,
    new_id,
)

pytestmark = pytest.mark.history

READ_ROUTES = ("list", "messages", "delete")
ROUTES = (*READ_ROUTES, "chat")


def call(api: Client, route: str, headers: dict[str, str], *, conversation_id: str | None = None, timeout: float | None = None) -> Response:
    """4 つの入口のどれかを、与えた `Authorization` で叩く（会話 ID は、形の正しい新しいもの）。"""
    cid = conversation_id or new_id()
    if route == "list":
        return api.get("/api/conversations", headers=headers, timeout=timeout)
    if route == "messages":
        return api.get(messages_path(cid), headers=headers, timeout=timeout)
    if route == "delete":
        return api.request("DELETE", conversation_path(cid), headers=headers, timeout=timeout)
    assert route == "chat", route
    return api.post("/api/chat", json=chat_body(QUESTION, cid), headers=headers, timeout=timeout)


# ---- H-A5: ログインの設定が無い・不正（noauth・badauth） ----

HEADER_KINDS = ["no-header", "basic", "garbage", "valid-looking"]


def headers_of(kind: str) -> dict[str, str]:
    return {
        "no-header": {},
        "basic": {"Authorization": "Basic abc"},
        "garbage": {"Authorization": "Bearer not-a-jwt"},
        "valid-looking": bearer(make_token()),
    }[kind]


@pytest.mark.variant("noauth", "badauth")
@pytest.mark.parametrize("kind", HEADER_KINDS)
@pytest.mark.parametrize("route", ROUTES)
def test_h_a5_not_configured_is_503_before_the_token_is_looked_at(api, jwks, route, kind):
    resp = call(api, route, headers_of(kind))
    assert resp.status == 503, resp
    assert resp.json() == NOT_CONFIGURED, resp
    assert resp.content_type.startswith("application/json")
    assert resp.header("www-authenticate") is None  # 「もう一度ログインを」と誤解させない
    if route in READ_ROUTES:
        assert_no_store(resp)
    assert_not_answered(resp)


@pytest.mark.variant("noauth", "badauth")
@pytest.mark.parametrize("route", ("messages", "delete"))
def test_h_a5_login_comes_before_the_shape_of_the_id(api, jwks, route):
    # 検査の順は、ログイン（401・503）→ conversation_id の形（422）（仕様 §2.3.4）。設定が無いなら、形が不正な ID でも 503
    resp = call(api, route, bearer(make_token()), conversation_id="a:b")
    assert resp.status == 503 and resp.json() == NOT_CONFIGURED, resp
    assert_no_store(resp)


@pytest.mark.variant("noauth", "badauth")
@pytest.mark.parametrize("kind", HEADER_KINDS)
def test_h_a5_chat_without_a_conversation_id_is_200_as_before(api, jwks, kind):
    body = {"messages": [{"role": "user", "content": QUESTION}]}
    baseline = api.post("/api/chat", json=body)
    resp = api.post("/api/chat", json=body, headers=headers_of(kind))
    assert baseline.status == resp.status == 200, resp
    assert resp.json() == baseline.json()
    # `conversation_id: null` は「無し」と読む（H-L7）ので、同じ
    assert api.post("/api/chat", json={**body, "conversation_id": None}, headers=headers_of(kind)).status == 200


@pytest.mark.variant("noauth", "badauth")
def test_h_a5_does_not_try_to_fetch_the_jwks(api, jwks):
    for route in ROUTES:
        call(api, route, bearer(make_token()))
    assert jwks.hits == []  # 設定が無い・不正なので、検証を無効にして、鍵を取りに行かない


# ---- H-A6: JWKS に届かない（jwksdown） ----

@pytest.mark.variant("jwksdown")
@pytest.mark.parametrize("route", ROUTES)
def test_h_a6_a_well_formed_token_is_503_because_the_key_cannot_be_fetched(api, jwks, member, route):
    user = member()
    resp = call(api, route, user.headers)
    assert resp.status == 503, resp
    assert resp.json() == CANNOT_VERIFY, resp
    assert resp.header("www-authenticate") is None
    if route in READ_ROUTES:
        assert_no_store(resp)
    for leaked in ("refused", "ECONNREFUSED", "127.0.0.1", "jwks", "OSError", "URLError", "Traceback"):
        assert leaked not in resp.text, leaked
    assert_not_answered(resp)


@pytest.mark.variant("jwksdown")
@pytest.mark.parametrize("kind", ["no-header", "garbage"])
@pytest.mark.parametrize("route", ROUTES)
def test_h_a6_what_can_be_refused_without_a_key_is_still_401(api, jwks, route, kind):
    # Authorization が無い・形が違う: 鍵が要らずに断れるので、これまでどおり 401（H-A6 の行は 3 経路。chat は仕様 §2.3.4 の「ログイン」の段が同じ）
    resp = call(api, route, headers_of(kind))
    assert_unauthorized(resp, no_store=route in READ_ROUTES)
    assert_not_answered(resp)


@pytest.mark.variant("jwksdown")
def test_h_a6_chat_without_a_conversation_id_is_200(api, jwks):
    body = {"messages": [{"role": "user", "content": QUESTION}]}
    resp = api.post("/api/chat", json=body, headers=bearer(make_token()))
    assert resp.status == 200 and resp.json() == api.post("/api/chat", json=body).json(), resp


# ---- H-A7: DB が止まったとき（dbdown） ----

@pytest.mark.variant("dbdown")
@pytest.mark.parametrize("route", ROUTES)
def test_h_a7_db_down_is_503_db_unavailable_with_a_fixed_message(api, jwks, member, route):
    user = member()
    resp = call(api, route, user.headers, timeout=DB_DOWN_TIMEOUT)
    assert_error(resp, 503, "db_unavailable", DB_UNAVAILABLE_MESSAGE)
    if route in READ_ROUTES:
        assert_no_store(resp)
    assert_not_answered(resp)  # chat は、回答を返さない
    for leaked in ("postgresql", "psycopg", "pgx", "townscan-contract", "Traceback", "5432", "SQLSTATE", "auth_user", "conversations", "dial tcp", "refused"):
        assert leaked not in resp.text, leaked
