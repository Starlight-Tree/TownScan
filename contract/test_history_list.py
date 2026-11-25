"""会話の一覧（構成 history。H-L1〜H-L8。仕様 §2.3.2・§2.3.4・§4.4・§8 の E9）。

保存は `POST /api/chat` に `conversation_id` を付けたときだけ。一覧は本人の会話だけ（更新が新しい順・最大 50 件）。
利用者は検査ごとに別の人（`member()`）。「一覧が空」や件数は、同じ利用者を別の検査が使うと順序で壊れるため。
同時刻は `id` の昇順（HTTP からは同時刻を作れない）は、契約にしない（Go のテスト）。
"""

from __future__ import annotations

import pytest

from support.checks import assert_json
from support.history import (
    LIST_KEYS,
    MAX_CONVERSATIONS,
    MAX_TITLE_CHARS,
    QUESTION,
    assert_not_found,
    assistant_message,
    chat_body,
    new_id,
    parse_time,
    user_message,
)

pytestmark = [pytest.mark.history, pytest.mark.variant("history")]


# ---- H-L1 ----

def test_h_l1_the_list_of_a_new_user_is_empty(api, jwks, member):
    resp = member().list()
    assert assert_json(resp) == {"conversations": []}, resp


# ---- H-L2 ----

def test_h_l2_one_saved_conversation_is_listed_with_exactly_four_keys(api, jwks, member):
    user = member()
    cid = new_id()
    user.say(QUESTION, cid)
    (item,) = user.listed()
    assert set(item) == LIST_KEYS, item
    assert item["id"] == cid
    assert item["title"] == QUESTION
    created, updated = parse_time(item["created_at"]), parse_time(item["updated_at"])
    assert created <= updated, item


def test_h_l2_a_second_round_trip_moves_updated_at_but_not_created_at(api, jwks, member):
    user = member()
    cid = new_id()
    user.say(QUESTION, cid)
    (first,) = user.listed()
    user.say("では試験町は？", cid)
    (second,) = user.listed()
    assert second["id"] == cid and second["created_at"] == first["created_at"]
    assert parse_time(second["updated_at"]) > parse_time(first["updated_at"]), (first, second)


# ---- H-L3: 題名の規則 ----

BASE = "新規出現の候補は何件ありますか？"  # 16 文字
Q40 = (BASE * 3)[:MAX_TITLE_CHARS]
Q41 = (BASE * 3)[: MAX_TITLE_CHARS + 1]
Q100 = (BASE * 7)[:100]
assert len(Q40) == 40 and len(Q41) == 41 and len(Q100) == 100

# 文字数は、コードポイントで数える（UTF-16 の単位ではない）。「𠮷」は U+20BB7 で、UTF-16 では 2 単位
ASTRAL_40 = "𠮷" * 40
ASTRAL_41 = "𠮷" * 41

TITLE_CASES = [
    pytest.param(QUESTION, QUESTION, id="short-as-is"),
    pytest.param(Q40, Q40, id="exactly-40-as-is"),
    pytest.param(Q41, Q41[:39] + "…", id="41-is-39-plus-ellipsis"),
    pytest.param(Q100, Q100[:39] + "…", id="100-is-39-plus-ellipsis"),
    pytest.param(ASTRAL_40, ASTRAL_40, id="astral-40-as-is"),
    pytest.param(ASTRAL_41, "𠮷" * 39 + "…", id="astral-41-counted-in-code-points"),
    # 連続する空白（半角・タブ・改行・全角空白 U+3000・NBSP U+00A0）は半角空白 1 つ。前後は除く
    pytest.param("合成町の新規出現は何件ですか？", "合成町の新規出現は何件ですか？", id="no-whitespace"),
    pytest.param("  　合成町の　　新規出現は\t\n何件ですか？  ", "合成町の 新規出現は 何件ですか？", id="whitespace-collapsed-and-trimmed"),
    pytest.param("合成町の   新規出現", "合成町の 新規出現", id="nbsp-collapsed"),
    pytest.param("合成町の\r\n\r\n新規出現", "合成町の 新規出現", id="crlf-collapsed"),
    # 空白をまとめてから数える: もとは 40 文字を大きく超えても、まとめて 40 文字なら、そのまま。まとめて 41 文字なら、39 文字＋「…」
    pytest.param("あ" * 19 + "　" * 30 + "い" * 20, "あ" * 19 + " " + "い" * 20, id="collapsed-to-exactly-40-as-is"),
    pytest.param("あ" * 20 + "　" * 30 + "い" * 20, "あ" * 20 + " " + "い" * 18 + "…", id="collapsed-to-41-is-39-plus-ellipsis"),
]


@pytest.mark.parametrize("question, title", TITLE_CASES)
def test_h_l3_the_title_is_the_question_with_the_rules(api, jwks, member, question, title):
    user = member()
    cid = new_id()
    user.say(question, cid)
    (item,) = user.listed()
    assert item["title"] == title, item
    assert len(item["title"]) <= MAX_TITLE_CHARS


def test_h_l3_the_title_does_not_change_on_later_questions(api, jwks, member):
    user = member()
    cid = new_id()
    first = user.say(QUESTION, cid)
    history = [user_message(QUESTION), assistant_message(first["content"])]
    user.say("では試験町は？", cid, history=history)
    (item,) = user.listed()
    assert item["title"] == QUESTION, item


def test_h_l3_a_new_conversation_with_earlier_turns_is_titled_by_the_last_question_and_saves_only_that_round_trip(api, jwks, member):
    # 別のタブで消した会話に続きを送った場合: 画面は全履歴を送るが、保存先は新しい会話。題名は最後のユーザー発言で、保存されるのもその 1 往復だけ
    user = member()
    cid = new_id()
    earlier = [user_message("合成町の新規出現は何件？"), assistant_message("1 件です"), user_message("では試験町は？"), assistant_message("2 件です")]
    user.say("仮想町の写真を見せて", cid, history=earlier)
    (item,) = user.listed()
    assert item["title"] == "仮想町の写真を見せて", item
    stored = user.stored(cid)
    assert len(stored) == 2, stored
    assert stored[0] == user_message("仮想町の写真を見せて") and stored[1]["role"] == "assistant"


# ---- H-L4: 並び ----

def test_h_l4_newest_first_and_continuing_an_old_conversation_moves_it_to_the_top(api, jwks, member):
    user = member()
    a, b, c = new_id(), new_id(), new_id()
    for cid in (a, b, c):
        user.say(QUESTION, cid)
    assert user.listed_ids() == [c, b, a]
    user.say("では試験町は？", a)
    assert user.listed_ids() == [a, c, b]
    items = user.listed()
    updated = [parse_time(i["updated_at"]) for i in items]
    assert updated == sorted(updated, reverse=True), items  # 更新が新しい順


# ---- H-L5: 件数の上限と、保存時の整理 ----

def test_h_l5_a_user_keeps_the_newest_50_and_the_oldest_is_removed_when_the_51st_is_saved(api, jwks, member):
    user, bystander = member(), member()
    other_cid = new_id()
    bystander.say(QUESTION, other_cid)
    ids = [new_id() for _ in range(MAX_CONVERSATIONS + 1)]
    for cid in ids:
        user.say(QUESTION, cid)
    assert user.listed_ids() == ids[1:][::-1]  # 50 件。最も古い 1 件（ids[0]）は消えている
    assert_not_found(user.messages(ids[0]))
    for cid in ids[1:]:
        assert len(user.stored(cid)) == 2, cid  # 残る 50 件の発言は取れる
    assert bystander.listed_ids() == [other_cid]  # 整理は本人の会話だけ


def test_h_l5_continuing_the_oldest_conversation_keeps_it_and_the_next_new_one_removes_another(api, jwks, member):
    # 保存の整理は「更新が古い順」: 古い会話に続けて保存すると、その会話は先頭に上がり、次に新しい会話を足したとき、消えるのは最も古い別の会話
    user = member()
    ids = [new_id() for _ in range(MAX_CONVERSATIONS + 2)]
    for cid in ids[: MAX_CONVERSATIONS + 1]:
        user.say(QUESTION, cid)
    # ここで ids[0] は消えていて、ids[1] が最も古い
    oldest = ids[1]
    assert user.listed_ids()[-1] == oldest
    user.say("では試験町は？", oldest)
    listed = user.listed_ids()
    assert len(listed) == MAX_CONVERSATIONS and listed[0] == oldest  # 新しい会話ではないので、件数は増えず、消えもしない
    assert len(user.stored(oldest)) == 4
    user.say(QUESTION, ids[MAX_CONVERSATIONS + 1])  # 51 件目の新しい会話
    listed = user.listed_ids()
    assert len(listed) == MAX_CONVERSATIONS
    assert listed[0] == ids[MAX_CONVERSATIONS + 1] and listed[1] == oldest
    assert ids[2] not in listed  # 代わりに、最も古い別の会話が消える
    assert_not_found(user.messages(ids[2]))
    assert len(user.stored(oldest)) == 4  # 続けた会話は残っている


# ---- H-L6: 本人だけが見える ----

def test_h_l6_a_conversation_is_not_in_another_users_list(api, jwks, member):
    a, b = member(), member()
    secret = "ヒミツの質問なので他人には見せません"
    cid_a, cid_b = new_id(), new_id()
    a.say(secret, cid_a)
    b.say(QUESTION, cid_b)
    assert [c["id"] for c in a.listed()] == [cid_a]
    resp = b.list()
    assert [c["id"] for c in assert_json(resp)["conversations"]] == [cid_b]
    assert secret not in resp.text and cid_a not in resp.text, resp  # 応答の全文に、A の質問も ID も無い
    # 相手が何も保存していない人の一覧も、空のまま
    assert member().listed() == []


# ---- H-L7: 保存されないもの ----

@pytest.mark.parametrize("extra", [
    pytest.param({}, id="no-conversation-id"),
    pytest.param({"conversation_id": None}, id="null-conversation-id"),
])
@pytest.mark.parametrize("with_login", [True, False], ids=["with-jwt", "without-jwt"])
def test_h_l7_a_chat_without_a_conversation_id_saves_nothing(api, jwks, member, extra, with_login):
    user = member()
    headers = user.headers if with_login else None
    body = {**chat_body(QUESTION), **extra}
    resp = api.post("/api/chat", json=body, headers=headers)
    assert resp.status == 200 and set(resp.json()) == {"message"}, resp
    assert user.listed() == []


# ---- H-L8: 保存は回答を変えない ----

@pytest.mark.parametrize("question", [
    QUESTION,
    "上位2件の一覧",
    "地区ごとに比べて",
    "地図で見せて",
    "一番大きい候補の写真",
    "このアプリの精度は",
    "今日の熊本の天気は？",
    "合成町と試験町の候補は何件？",
])
def test_h_l8_saving_does_not_change_the_answer(api, jwks, member, question):
    user = member()
    plain = api.post("/api/chat", json=chat_body(question))
    saved = user.chat(question, new_id())
    assert plain.status == saved.status == 200, (plain, saved)
    assert saved.json() == plain.json()  # 模擬モデルは決定的。応答の形も同じ（{message} のまま）
