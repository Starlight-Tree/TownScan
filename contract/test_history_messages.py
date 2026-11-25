"""会話の発言の取得 `GET /api/conversations/{conversation_id}/messages`（構成 history。H-M1〜H-M5。仕様 §2.3.4・§4.4・§8 の E9）。

発言は古い順。ユーザーの発言は `{role, content}` だけ。回答は、その回答を返した chat の `message` と JSON として等しく、履歴だけの項目 `run_created_at` が付く。
見るだけでは更新しない。形が違う ID は 422、無い ID と他人の ID は同じ 404（本文も同じ）。3 本の応答は `Cache-Control: no-store`。
"""

from __future__ import annotations

import pytest

from support import expected
from support.chat import check_message
from support.checks import assert_json, assert_validation_error, same_instant
from support.history import (
    QUESTION,
    assert_json_equal,
    assert_no_store,
    assert_not_found,
    assistant_message,
    conversation_path,
    messages_path,
    new_id,
    user_message,
)

pytestmark = [pytest.mark.history, pytest.mark.variant("history")]


# ---- H-M1: 発言の往復と、見るだけでは更新しない ----

def test_h_m1_two_round_trips_come_back_in_order_and_the_answers_equal_the_chat_messages(api, jwks, member):
    user = member()
    cid = new_id()
    q1, q2 = QUESTION, "では試験町は？"
    a1 = user.say(q1, cid)
    a2 = user.say(q2, cid, history=[user_message(q1), assistant_message(a1["content"])])  # 画面は全履歴を送る。保存するのは最後の 1 往復だけ
    stored = user.stored(cid)
    assert [m["role"] for m in stored] == ["user", "assistant", "user", "assistant"], stored
    assert stored[0] == user_message(q1) and stored[2] == user_message(q2)  # ユーザーの発言は {role, content} だけ
    for message, answer in ((stored[1], a1), (stored[3], a2)):
        assert set(message) == {"role", "content", "results", "tool_calls", "run_created_at"}, message
        body = {k: v for k, v in message.items() if k != "run_created_at"}
        assert_json_equal(body, answer)  # chat の message と JSON として等しい（キーの順は問わない）
        check_message(body)  # 保存したものにも、返答の数字の検査を流す


def test_h_m1_reading_a_conversation_does_not_change_the_order_or_updated_at(api, jwks, member):
    user = member()
    older, newer = new_id(), new_id()
    user.say(QUESTION, older)
    user.say(QUESTION, newer)
    before = user.listed()
    assert [c["id"] for c in before] == [newer, older]
    assert len(user.stored(older)) == 2  # 古い方を開く
    assert user.listed() == before  # 並びも updated_at も変わらない（開いて見るだけでは更新しない）
    assert len(user.stored(newer)) == 2
    assert user.listed() == before


# ---- H-M2: 形が違う ID ----

# 422 になる ID（形が `^[A-Za-z0-9_-]{1,128}$` に合わない）。「:」は、`<利用者 ID>:<会話 ID>` のような接頭辞を持ち込む形。
# 空文字は、経路では作れない（`/api/conversations//messages` は別の経路）ので、chat の本文の側だけで確かめる
MALFORMED_PATH_IDS = [
    pytest.param("a:b", id="colon"),
    pytest.param("other-user:abc", id="prefix-like"),
    pytest.param("a%20b", id="space"),
    pytest.param("a.b", id="dot"),
    pytest.param("%E6%97%A5%E6%9C%AC", id="non-ascii"),
    pytest.param("a" * 129, id="129-chars"),
]
MALFORMED_BODY_IDS = ["a:b", "other-user:abc", " ", "a b", "a.b", "日本", "a" * 129, ""]


@pytest.mark.parametrize("bad", MALFORMED_PATH_IDS)
def test_h_m2_a_malformed_id_in_the_path_is_422_naming_the_path(api, jwks, member, bad):
    user = member()
    for resp in (api.get(messages_path(bad), headers=user.headers), api.request("DELETE", conversation_path(bad), headers=user.headers)):
        assert_validation_error(resp, "path", "conversation_id")
        assert_no_store(resp)
        assert bad not in resp.text, resp  # 入力値は応答に出ない


@pytest.mark.parametrize("bad", MALFORMED_BODY_IDS, ids=lambda v: repr(v)[:20])
def test_h_m2_a_malformed_conversation_id_in_the_chat_body_is_422_naming_the_body(api, jwks, member, bad):
    user = member()
    resp = user.chat(QUESTION, bad)
    assert_validation_error(resp, "body", "conversation_id")
    if bad.strip():
        assert bad not in resp.text, resp
    assert "message" not in resp.json()
    assert user.listed() == []  # 保存されない


@pytest.mark.parametrize("cid", ["a" * 128, "A-b_9" * 25 + "xyz", "-", "_", "0"], ids=["128-chars", "128-mixed", "hyphen", "underscore", "digit"])
def test_h_m2_ids_that_match_the_rule_are_accepted_up_to_128_characters(api, jwks, member, cid):
    assert len(cid) <= 128
    user = member()
    assert user.messages(cid).status == 404  # 形は正しいが、まだ無い（422 ではない）
    user.say(QUESTION, cid)
    assert user.listed_ids() == [cid]
    assert len(user.stored(cid)) == 2


# ---- H-M3: 無い ID・他人の ID は同じ 404 ----

def test_h_m3_an_unknown_id_and_another_users_id_are_the_same_404(api, jwks, member):
    a, b = member(), member()
    cid = new_id()
    a.say(QUESTION, cid)
    a_before = (a.listed(), a.stored(cid))
    unknown = b.messages(new_id())
    other = b.messages(cid)
    assert_not_found(unknown)
    assert_not_found(other)
    assert other.body == unknown.body  # 本文も文字単位で同じ（存在を確かめさせない）
    assert other.content_type == unknown.content_type
    # B の操作（発言の取得・削除）のあとも、A の会話は変わらない
    assert_not_found(b.delete(cid))
    assert (a.listed(), a.stored(cid)) == a_before


def test_h_m3_unknown_ids_are_404_for_the_delete_too(api, jwks, member):
    resp = member().delete(new_id())
    assert_not_found(resp)


# ---- H-M4: ヘッダー ----

def test_h_m4_every_response_of_the_three_routes_is_no_store(api, jwks, member):
    user = member()
    cid = new_id()
    user.say(QUESTION, cid)
    ok_list, ok_messages = user.list(), user.messages(cid)
    assert ok_list.status == ok_messages.status == 200
    assert_no_store(ok_list)
    assert_no_store(ok_messages)
    assert_no_store(api.get("/api/conversations"))  # 401
    assert_no_store(user.messages(new_id()))  # 404
    assert_no_store(api.get(messages_path("a:b"), headers=user.headers))  # 422
    deleted = user.delete(cid)
    assert deleted.status == 204, deleted
    assert_no_store(deleted)  # 204


def test_h_m4_chat_does_not_get_the_header(api, jwks, member):
    user = member()
    resp = user.chat(QUESTION, new_id())
    assert resp.status == 200, resp
    assert resp.header("cache-control") is None, resp  # POST /api/chat には付けない（既存のまま）


# ---- H-M5: 回答を作った run ----

def test_h_m5_each_answer_carries_the_run_it_was_made_from_and_the_user_message_does_not(api, jwks, member):
    health = assert_json(api.get("/api/health"))
    user = member()
    cid = new_id()
    first = user.say(QUESTION, cid)
    user.say("では試験町は？", cid, history=[user_message(QUESTION), assistant_message(first["content"])])
    stored = user.stored(cid)
    assert len(stored) == 4
    for message in stored:
        if message["role"] == "user":
            assert "run_created_at" not in message, message
        else:
            assert isinstance(message["run_created_at"], str), message
            assert same_instant(message["run_created_at"], health["run"]["created_at"]), message  # 時刻として比べる（表記は問わない）
            assert same_instant(message["run_created_at"], expected.RUN_CREATED_AT), message
