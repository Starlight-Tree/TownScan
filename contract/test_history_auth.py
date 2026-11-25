"""会話の履歴のログイン（構成 history。H-A1・H-A2・H-A4。仕様 §2.3.4・§4.4・§8 の E9）。

- 履歴の 3 本（一覧・発言の取得・削除）は、`Authorization: Bearer <JWT>` が要る。未ログインは、どの失敗も同じ 401（ログインが先。ID の形の 422 より先）。
- `conversation_id` つきの chat は、本文の検査（422）が先で、そのあとログイン（401）。未ログインなら、回答も保存もしない。
- JWT は有効でも、`auth_user` に行が無い利用者は、chat だけ 401（LLM を呼ぶ前の存在の確認。呼ばれないことは契約から見えないので Go のテストが持つ）。読み取りは、行を確かめない。
- 設定が無い・JWKS に届かない・DB が止まるときの 503 は test_history_unavailable.py。`conversation_id` を付けない chat がログインに影響されないことは test_auth_independence.py（H-A3）。
"""

from __future__ import annotations

import pytest

from support.checks import assert_error, assert_json, assert_validation_error
from support.client import Response
from support.history import (
    BAD_CREDENTIALS,
    LAST_MESSAGE_RULE,
    LIST_PATH,
    QUESTION,
    assert_not_answered,
    assert_not_found,
    assert_unauthorized,
    assistant_message,
    bad_headers,
    chat_body,
    conversation_path,
    messages_path,
    new_id,
    user_message,
)

pytestmark = [pytest.mark.history, pytest.mark.variant("history")]

# 3 経路。形が違う ID（422 になる ID）でも、ログインが先なので 401
ROUTES = [
    pytest.param("GET", LIST_PATH, id="list"),
    pytest.param("GET", messages_path("5b0c2f4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f"), id="messages"),
    pytest.param("DELETE", conversation_path("5b0c2f4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f"), id="delete"),
    pytest.param("GET", messages_path("a:b"), id="messages-malformed-id"),
    pytest.param("DELETE", conversation_path("a:b"), id="delete-malformed-id"),
]


# ---- H-A1 ----

@pytest.mark.parametrize("kind", BAD_CREDENTIALS)
@pytest.mark.parametrize("method, path", ROUTES)
def test_h_a1_the_three_routes_are_401_without_a_valid_login(api, jwks, method, path, kind):
    resp = api.request(method, path, headers=bad_headers(kind))
    assert_unauthorized(resp)  # 固定の文・WWW-Authenticate: Bearer・Cache-Control: no-store。理由は返さない（どれも同じ応答）


# ---- H-A2 ----

@pytest.mark.parametrize("kind", BAD_CREDENTIALS)
def test_h_a2_chat_with_a_conversation_id_needs_login_and_saves_and_answers_nothing(api, jwks, member, kind):
    user = member()
    cid = new_id()
    resp = api.post("/api/chat", json=chat_body(QUESTION, cid), headers=bad_headers(kind, sub=user.sub))
    assert_unauthorized(resp, no_store=False)  # chat の 401 に no-store を求めない（chat には付けない約束。H-M4）
    assert_not_answered(resp)
    assert user.listed() == []  # 保存されていない
    assert_not_found(user.messages(cid))


BAD_BODIES = [
    pytest.param(lambda cid: {"messages": [user_message("   ")], "conversation_id": cid}, "rule", id="blank-message"),
    pytest.param(lambda cid: {"messages": [user_message("")], "conversation_id": cid}, "rule", id="empty-message"),
    pytest.param(lambda cid: {"messages": [user_message(QUESTION), assistant_message("9 件です")], "conversation_id": cid}, "rule", id="last-is-assistant"),
    pytest.param(lambda cid: {"messages": [user_message(QUESTION)], "conversation_id": "a:b"}, "cid", id="malformed-conversation-id"),
    pytest.param(lambda cid: {"messages": [user_message(QUESTION)], "conversation_id": ""}, "cid", id="empty-conversation-id"),
]


@pytest.mark.parametrize("kind", ["no-header", "garbage", "expired"])
@pytest.mark.parametrize("make_body, which", BAD_BODIES)
def test_h_a2_an_invalid_body_is_422_before_the_login_is_looked_at(api, jwks, make_body, which, kind):
    resp = api.post("/api/chat", json=make_body(new_id()), headers=bad_headers(kind))
    if which == "rule":
        assert_error(resp, 422, "validation_error", LAST_MESSAGE_RULE)
    else:
        assert_validation_error(resp, "body", "conversation_id")
    assert_not_answered(resp)


# ---- H-A4 ----

def test_h_a4_a_user_without_an_auth_user_row(api, jwks, nouser):
    cid = new_id()
    # chat＋conversation_id は 401（LLM を呼ぶ前の存在の確認。保存も回答も無い）
    resp = nouser.chat(QUESTION, cid)
    assert_unauthorized(resp, no_store=False)
    assert_not_answered(resp)
    # 読み取りは、行を確かめない: 一覧は 200・空、発言の取得・削除は 404
    listing: Response = nouser.list()
    assert assert_json(listing) == {"conversations": []}, listing
    assert_not_found(nouser.messages(cid))
    assert_not_found(nouser.delete(cid))
    # 保存は増えない（401 のあとも、一覧は空・その ID は無い）
    assert nouser.listed() == []
    assert_not_found(nouser.messages(cid))
