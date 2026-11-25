"""保存の動き（`POST /api/chat` の `conversation_id`。構成 history。H-C1〜H-C7。仕様 §2.3.4・§2.3.5・§8 の E9）。

追記・本人ごとの会話・失敗した往復は保存しない・上限（質問 2000 文字・1 会話 500 件）・結果の往復・NUL。
検査の順は、本文（形・空でない最後の user・`conversation_id` の形・NUL）→ ログイン → `auth_user` の存在 → 発言数の上限 →（LLM）→ 保存。
LLM を呼ぶ前に断ること（偽の LLM の呼び出しが 0 回）は、契約から見えないので Go のテストが持つ。
"""

from __future__ import annotations

import pytest

from support.chat import RESULT_TYPES, check_message
from support.checks import assert_error, assert_validation_error
from support.history import (
    CONVERSATION_FULL_MESSAGE,
    LAST_MESSAGE_RULE,
    MAX_STORED_MESSAGES,
    QUESTION,
    assert_json_equal,
    assert_not_answered,
    assert_not_found,
    assistant_message,
    new_id,
    user_message,
)

pytestmark = [pytest.mark.history, pytest.mark.variant("history")]


# ---- H-C1: 追記 ----

def test_h_c1_the_same_id_appends_to_the_same_conversation_in_order(api, jwks, member):
    user = member()
    cid = new_id()
    questions = [QUESTION, "では試験町は？", "上位2件の一覧", "地図で見せて"]
    history: list[dict] = []
    answers = []
    for q in questions:
        answer = user.say(q, cid, history=history)
        answers.append(answer)
        history = [*history, user_message(q), assistant_message(answer["content"])]
    assert user.listed_ids() == [cid]  # 同じ会話に追記（一覧は 1 件）
    stored = user.stored(cid)
    assert len(stored) == 8
    assert [m["content"] for m in stored[0::2]] == questions  # 順は seq どおり（質問が順に並ぶ）
    for message, answer in zip(stored[1::2], answers):
        assert message["role"] == "assistant" and message["content"] == answer["content"]


# ---- H-C2: 同じ ID を別の人が使う ----

def test_h_c2_two_users_with_the_same_conversation_id_have_separate_conversations(api, jwks, member):
    a, b = member(), member()
    cid = new_id()
    a.say("合成町の新規出現は何件？", cid)
    a_before = (a.listed(), a.stored(cid))
    b.say("仮想町の写真を見せて", cid)
    b.say("では試験町は？", cid)
    # B の送信で、A の会話は変わらない
    assert (a.listed(), a.stored(cid)) == a_before
    assert [m["content"] for m in a.stored(cid) if m["role"] == "user"] == ["合成町の新規出現は何件？"]
    # 互いの発言が見えない
    assert [m["content"] for m in b.stored(cid) if m["role"] == "user"] == ["仮想町の写真を見せて", "では試験町は？"]
    assert a.listed_ids() == [cid] and b.listed_ids() == [cid]


# ---- H-C3: 失敗した往復は保存しない ----

BAD_ROUND_TRIPS = [
    pytest.param(lambda: [user_message(QUESTION), assistant_message("9 件です")], id="last-is-assistant"),
    pytest.param(lambda: [user_message("")], id="empty"),
    pytest.param(lambda: [user_message("   ")], id="spaces-only"),
    pytest.param(lambda: [user_message("　\n\t")], id="ideographic-space-newline-tab"),
    # Python の str.strip() と同じ集合で「空」と判定する: U+001F（FS・GS・RS・US の 1 つ）だけの発言も、空白だけ
    pytest.param(lambda: [user_message("\u001f")], id="u001f-only"),
    pytest.param(lambda: [user_message(" \u0085 ")], id="nbsp-nel-line-separator"),
]


@pytest.mark.parametrize("make_messages", BAD_ROUND_TRIPS)
def test_h_c3_a_failed_round_trip_is_not_saved(api, jwks, member, make_messages):
    user = member()
    kept = new_id()
    user.say(QUESTION, kept)  # すでに 1 往復ある会話
    before = (user.listed(), user.stored(kept))
    fresh = new_id()
    for cid in (kept, fresh):  # 既存の会話への追記・新しい会話の作成のどちらも、保存されない
        resp = user.chat_raw({"messages": make_messages(), "conversation_id": cid})
        assert_error(resp, 422, "validation_error", LAST_MESSAGE_RULE)
        assert_not_answered(resp)
    assert (user.listed(), user.stored(kept)) == before  # 一覧・発言の数が変わらない（updated_at も）
    assert_not_found(user.messages(fresh))


# ---- H-C4: 質問の上限 ----

def test_h_c4_a_question_of_2000_characters_is_saved_as_it_is_and_2001_is_rejected(api, jwks, member):
    user = member()
    cid = new_id()
    text = "あ" * 2000
    user.say(text, cid)
    stored = user.stored(cid)
    assert stored[0] == user_message(text), "保存した質問が、送った文字列と違います"
    # 2001 文字は 422（既存）で、保存されない
    over = new_id()
    resp = user.chat("あ" * 2001, over)
    assert_validation_error(resp, "body")
    assert_not_answered(resp)
    assert_not_found(user.messages(over))
    assert user.listed_ids() == [cid]
    resp = user.chat("あ" * 2001, cid)  # 既存の会話への追記も同じ
    assert resp.status == 422, resp
    assert len(user.stored(cid)) == 2


# ---- H-C5: 1 会話の発言数の上限（500 件） ----

def test_h_c5_a_conversation_of_500_messages_does_not_take_more(api, jwks, member):
    user = member()
    cid = new_id()
    for _ in range(MAX_STORED_MESSAGES // 2):  # 250 往復 = 500 件（模擬モデル。実行は数秒の見込みで、実測はしていない）
        resp = user.chat("候補は何件？", cid)
        assert resp.status == 200, resp
    assert len(user.stored(cid)) == MAX_STORED_MESSAGES
    # 続きは 422 conversation_full。回答は無く、保存は増えない
    resp = user.chat("候補は何件？", cid)
    assert_error(resp, 422, "conversation_full", CONVERSATION_FULL_MESSAGE)
    assert_not_answered(resp)
    assert len(user.stored(cid)) == MAX_STORED_MESSAGES
    # 別の会話は影響を受けない
    other = new_id()
    user.say("候補は何件？", other)
    assert len(user.stored(other)) == 2
    assert set(user.listed_ids()) == {cid, other}


# ---- H-C6: 結果の往復 ----

# 件数・表・比較・地図・検出画像・精度・断りの 7 種類の結果
RESULT_QUESTIONS = [
    ("新規出現の候補は何件ありますか？", "count"),
    ("上位2件の一覧", "table"),
    ("地区ごとに比べて", "compare"),
    ("地図で見せて", "map_focus"),
    ("一番大きい候補の写真", "detection_image"),
    ("このアプリの精度は", "accuracy"),
    ("今日の熊本の天気は？", "refusal"),
]


def test_h_c6_every_kind_of_result_comes_back_with_the_same_values(api, jwks, member):
    user = member()
    cid = new_id()
    answers = []
    for question, kind in RESULT_QUESTIONS:
        answer = user.say(question, cid)
        assert [r["type"] for r in answer["results"]][0] == kind, (question, answer["results"])
        answers.append(answer)
    assert {r["type"] for a in answers for r in a["results"]} == RESULT_TYPES  # 7 種類をすべて含む
    stored = user.stored(cid)
    assert len(stored) == 2 * len(RESULT_QUESTIONS)
    for message, answer in zip(stored[1::2], answers):
        body = {k: v for k, v in message.items() if k != "run_created_at"}
        assert_json_equal(body, answer)  # 数値・配列の順・入れ子が一致
        check_message(body)


# ---- H-C7: NUL を含む発言 ----

@pytest.mark.parametrize("make_messages, index", [
    pytest.param(lambda: [user_message("候補は\u0000何件？")], "0", id="only-message"),
    pytest.param(lambda: [user_message("合成町の新規出現は何件？"), assistant_message("1 件です"), user_message("では\u0000試験町は？")], "2", id="last-user-message"),
    pytest.param(lambda: [user_message("合成町の新規出現は何件？"), assistant_message("1\u0000件です"), user_message("では試験町は？")], "1", id="earlier-assistant-message"),
    pytest.param(lambda: [user_message("\u0000"), assistant_message("1 件です"), user_message("では試験町は？")], "0", id="first-message-only-nul"),
])
def test_h_c7_a_nul_in_any_message_is_422_and_nothing_is_saved(api, jwks, member, make_messages, index):
    user = member()
    cid = new_id()
    resp = user.chat_raw({"messages": make_messages(), "conversation_id": cid})
    err = assert_validation_error(resp, "body", "messages", index, "content")
    assert err["details"][0]["loc"] == ["body", "messages", index, "content"], err  # 番号は文字列
    assert_not_answered(resp)
    assert user.listed() == []
    assert_not_found(user.messages(cid))
    # 同じ本文を conversation_id なしで送ると、従来どおり 200
    plain = api.post("/api/chat", json={"messages": make_messages()}, headers=user.headers)
    assert plain.status == 200, plain


def test_h_c7_a_nul_is_422_before_the_login_is_looked_at(api, jwks):
    # 検査の順は、本文（NUL を含む）→ ログイン（仕様 §2.3.4）。未ログインでも、本文が不正なら 422
    resp = api.post("/api/chat", json={"messages": [user_message("候補は\u0000何件？")], "conversation_id": new_id()})
    assert_validation_error(resp, "body", "messages", "0", "content")
