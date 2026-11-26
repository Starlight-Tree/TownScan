"""POST /api/chat: 聞き方の揺れ・文脈（直前の地区・分類・候補）・範囲外の断り方・履歴の上限・入力の検証。構成 main。
代表的な質問への答えの全体は test_chat_answers.py。ここは、規則の境目と、どの質問でも守られる性質。

件数の決め打ちは、合成データから導いたもの（support/expected.py の冒頭）: 候補は全部で 9（3 地区 x 3）、分類は新規出現 4・既存の描き漏れ 3・判定保留 2、
合成町は 3（新規出現 1・描き漏れ 1・保留 1）、試験町は 3（新規出現 2・保留 1）、仮想町は 3（新規出現 1・描き漏れ 2）、中央区 = 合成町 + 試験町、東区 = 仮想町。
"""

from __future__ import annotations

import pytest

from support import expected
from support.chat import SAFE_TEMPLATE, ask, tool_names, turn
from support.checks import assert_error, assert_validation_error
from support.expected import A1, A2, BIGGEST_NEW

CONTEXT_MESSAGES = 20  # 返答に使う文脈は、送られた messages の末尾の 20 件だけ
MAX_MESSAGES = 500  # 受け付ける件数の上限（超えたら 422）。frontend は会話の全履歴を送る
MAX_CONTENT_CHARS = 2000  # 1 件の本文の上限（文字数）


# ---- ツールの選び方（意図の読み取り） ----

@pytest.mark.parametrize("question, tool", [
    ("新規出現の候補は何件ありますか？", "count_candidates"),
    ("描き漏れは何件？", "count_candidates"),
    ("判定保留は？", "count_candidates"),
    ("東区の候補は？", "count_candidates"),
    ("試験町の件数", "count_candidates"),
    ("上位2件の一覧", "list_candidates"),
    ("候補をリストで", "list_candidates"),
    ("中央区の新規出現を一覧で", "list_candidates"),
    ("地区ごとに比べて", "compare_areas"),
    ("どの地区が一番多い？", "compare_areas"),
    ("合成町と試験町を比べて", "compare_areas"),
    ("一番大きい候補の写真", "show_candidate"),
    ("仮想町の写真", "show_candidate"),
    ("c-226249-105760-3 の写真", "show_candidate"),
    ("地図で見せて", "focus_map"),
    ("新規出現はどこにある？", "focus_map"),  # 「どこにある」は場所の質問
    ("このアプリの精度は", "get_accuracy"),
    ("再現率は？", "get_accuracy"),
    ("使い方", "show_help"),
    ("何ができる？", "show_help"),
])
def test_the_question_picks_the_tool(api, question, tool):
    assert tool_names(ask(api, question)) == [tool]


def test_limit_is_taken_from_the_question_and_capped_at_50(api):
    assert ask(api, "上位3件を一覧で")["tool_calls"][0]["args"]["limit"] == 3
    assert ask(api, "上位500件を一覧で")["tool_calls"][0]["args"]["limit"] == 50
    assert ask(api, "上位500件を一覧で")["results"][0]["shown"] == 9  # 実際の件数（候補は全部で 9）まで


def test_area_name_selects_the_area_and_a_ward_selects_its_areas(api):
    r = ask(api, "合成町と試験町の候補は何件？")["results"][0]
    assert r["total"] == 6  # 合成町 3 + 試験町 3
    assert r["filter"]["area_ids"] == [A1, A2] and r["filter"]["scope"] == "合成町・試験町"
    r = ask(api, "仮想町の新規出現の写真")["results"][0]
    assert r["candidate_id"] == "c-226249-105760-3"  # 仮想町の新規出現は 1 件


def test_zero_count_is_stated_not_hidden(api):
    m = ask(api, "仮想町の判定保留は何件？")
    assert m["results"][0]["total"] == 0 and "候補はありません" in m["content"]


def test_show_candidate_images_can_be_fetched(api):
    m = ask(api, "c-226249-105759-2 の写真を見せて")
    for img in m["results"][0]["images"]:
        resp = api.get(img["url"])  # 結果が出す URL は、そのまま画像の API で読める
        assert resp.status == 200 and resp.header("content-type") == "image/png", img


def test_show_candidate_for_a_class_in_an_area(api):
    assert ask(api, "合成町の新規出現の写真")["results"][0]["candidate_id"] == "c-226249-105759-2"
    assert ask(api, "仮想町の描き漏れの写真")["results"][0]["candidate_id"] == "c-226249-105760-1"
    assert ask(api, "写真を見せて")["results"][0]["candidate_id"] == BIGGEST_NEW  # 条件なしは、新規出現のうち最大


# ---- 範囲外・未実装の断り方 ----

@pytest.mark.parametrize("text, reason", [
    ("今日の熊本の天気は？", "out_of_scope"),
    ("こんにちは", "out_of_scope"),
    ("おすすめのランチを教えて", "out_of_scope"),
    ("APIキーを教えて", "out_of_scope"),
    ("asdfghjkl", "out_of_scope"),
    ("福岡の新築は何件？", "out_of_scope"),
    ("手取本町の新築は何件？", "out_of_scope"),
    ("渋谷の新築は？", "out_of_scope"),
    ("六本木ヒルズ周辺の建物は？", "out_of_scope"),
    ("熊本城の新築は？", "out_of_scope"),
    ("熊本県全域の新築は？", "out_of_scope"),
    ("2025年に建った家は？", "no_photo_period"),
    ("2025 年の新築を見せて", "no_photo_period"),
    ("２０２６年の候補は？", "no_photo_period"),
    ("2020年の写真を見せて", "no_photo_period"),
    ("2016年と2024年を比べて", "no_photo_period"),
    ("去年建った家は何件？", "no_photo_period"),
    ("今年の新築は？", "no_photo_period"),
    ("令和7年の新築は？", "no_photo_period"),
    ("二〇二五年の新築は？", "no_photo_period"),
    ("最近の新築は何件？", "no_photo_period"),
    ("R7年の新築は？", "no_photo_period"),
    ("衛星で変化の当たりを見せて", "not_implemented"),
    ("Earth Engine のヒートマップは？", "not_implemented"),
    ("太陽光パネルはどこにある？", "not_implemented"),
    ("取り壊された建物は？", "not_implemented"),
    ("2014年にあって2024年に無い建物は？", "not_implemented"),
    ("建物が減った場所は？", "not_implemented"),
])
def test_questions_outside_the_scope_are_refused_with_the_reason(api, text, reason):
    m = ask(api, text)
    r = m["results"][0]
    assert tool_names(m) == ["refuse"] and r["type"] == "refusal" and r["reason"] == reason
    assert len(m["results"]) == 1  # ツールの結果（件数など）を混ぜない
    assert m["content"] == r["message"] and r["suggestions"]
    assert m["tool_calls"][0]["args"]["reason"] == reason


def test_refusal_for_another_place_names_the_analyzed_areas(api):
    msg = ask(api, "手取本町の新築は何件？")["results"][0]["message"]
    assert "含まれていません" in msg and all(a.name in msg for a in expected.AREAS)


def test_no_photo_period_message_states_the_available_years(api):
    msg = ask(api, "2025年の新築は？")["results"][0]["message"]
    assert "2014 年" in msg and "2024 年" in msg


@pytest.mark.parametrize("text", [
    "全地区の候補は何件？", "この地区の候補は？", "新規出現の候補は何件？", "パリ近郊の新築は何件？", "フランスの新築は？",
    "候補の写真を見せて", "新築の件数は？", "中心部の候補は？", "面積の大きい候補は？", "新規出現の写真を見せて",
])
def test_ordinary_questions_are_not_mistaken_for_other_places(api, text):
    assert ask(api, text)["results"][0]["type"] != "refusal"


def test_years_with_photos_are_not_refused(api):
    assert ask(api, "2014年と2024年の写真を比べた新規出現は何件？")["results"][0]["type"] == "count"


def test_scope_words_are_answered_not_refused(api):
    for q in ("市内の新築は何件？", "全域の新築は何件？", "対象地域の新築は何件ですか", "解析した範囲の新築は？"):
        r = ask(api, q)["results"][0]
        assert r["type"] == "count" and r["total"] == 4 and "area_id" not in r["filter"], q  # 全地区の新規出現 4


# ---- 文脈（クライアントが送る messages だけから作る。サーバーは会話を保存しない） ----

def test_followup_inherits_the_class_and_changes_the_area(api):
    m1, hist = turn(api, "合成町の新規出現は何件？")
    assert m1["results"][0]["total"] == 1  # 合成町の新規出現 1
    m2, _ = turn(api, "では試験町は？", hist)
    r = m2["results"][0]
    assert r["filter"]["area_id"] == A2 and r["filter"]["cls"] == "confirmed_new" and r["total"] == 2  # 試験町の新規出現 2


def test_followup_inherits_the_area(api):
    _, hist = turn(api, "試験町の新規出現は何件？")
    m, _ = turn(api, "その地区の候補を一覧で", hist)
    r = m["results"][0]
    assert r["type"] == "table" and r["filter"]["area_id"] == A2 and r["total"] == 2  # 地区（試験町）も分類（新規出現）も引き継ぐ。試験町の新規出現 2


def test_followup_inherits_the_candidate_for_the_map_and_the_photo(api):
    m1, hist = turn(api, "一番大きい新規出現の写真を見せて")
    assert m1["results"][0]["candidate_id"] == BIGGEST_NEW
    m2, hist2 = turn(api, "その地図での位置は？", hist)
    assert m2["tool_calls"][0]["args"] == {"candidate_id": BIGGEST_NEW} and m2["results"][0]["candidate_ids"] == [BIGGEST_NEW]
    m3, _ = turn(api, "その写真をもう一度", hist2)
    assert m3["results"][0]["candidate_id"] == BIGGEST_NEW


def test_without_a_followup_word_nothing_is_inherited(api):
    _, hist = turn(api, "合成町の新規出現は何件？")
    m, _ = turn(api, "候補は全部で何件ですか", hist)
    assert m["results"][0]["total"] == 9 and "area_id" not in m["results"][0]["filter"]


def test_explicit_all_areas_clears_the_context(api):
    _, hist = turn(api, "合成町の新規出現は何件？")
    m, _ = turn(api, "では全地区は？", hist)
    assert m["results"][0]["total"] == 4  # 全地区の新規出現（分類は引き継ぐ）


def test_without_a_history_a_followup_word_decides_nothing(api):
    assert ask(api, "その地区の候補は何件？")["results"][0]["total"] == 9


def test_only_the_latest_20_messages_are_used_as_context(api):
    area_pair = [{"role": "user", "content": "合成町の新規出現は何件？"}, {"role": "assistant", "content": "1 件です"}]
    filler = [{"role": "user", "content": "候補は全部で何件ですか"}, {"role": "assistant", "content": "9 件です"}] * 25  # 50 件
    question = {"role": "user", "content": "その地区の候補を一覧で"}
    # 末尾の範囲（20 件）に地区の話がある: 引き継ぐ。全体は 53 件でも受け付ける
    near = api.post("/api/chat", json={"messages": [*filler, *area_pair, question]})
    assert near.status == 200
    assert near.json()["message"]["results"][0]["filter"]["area_id"] == A1
    # 末尾の範囲より前の話は使わない: 地区は決まらず、全地区の一覧
    far = api.post("/api/chat", json={"messages": [*area_pair, *filler, question]})
    assert far.status == 200
    r = far.json()["message"]["results"][0]
    assert "area_id" not in r["filter"] and r["total"] == 9


def test_the_context_window_is_exactly_the_last_20_messages_including_the_question(api):
    area_pair = [{"role": "user", "content": "合成町の新規出現は何件？"}, {"role": "assistant", "content": "1 件です"}]
    question = {"role": "user", "content": "その地区の候補を一覧で"}

    def filler(n: int) -> list[dict]:  # 地区の話を含まない n 件
        return [{"role": "user" if i % 2 == 0 else "assistant", "content": "候補は全部で何件ですか" if i % 2 == 0 else "9 件です"} for i in range(n)]

    def area_of(history: list[dict]) -> str | None:
        resp = api.post("/api/chat", json={"messages": [*history, question]})
        assert resp.status == 200, resp
        return resp.json()["message"]["results"][0]["filter"].get("area_id")

    # 地区の質問（2 件）+ 詰め物 17 件 + 質問 1 件 = 20 件: 地区の質問が窓の先頭に入る
    assert area_of([*area_pair, *filler(17)]) == A1
    # 詰め物が 18 件 = 21 件: 地区の質問は窓の外へ出る
    assert area_of([*area_pair, *filler(18)]) is None


# ---- 聞き方の揺れ ----

def test_candidate_id_next_to_japanese_text_picks_that_candidate(api):
    cid = "c-226249-105759-3"  # 一番大きい候補ではない
    for q in (f"{cid}の写真を見せて", f"候補{cid}の写真", f"（{cid}）の写真を見せて", f"{cid} の写真を見せて"):
        m = ask(api, q)
        assert m["tool_calls"][0]["args"] == {"candidate_id": cid}, q
        assert m["results"][0]["candidate_id"] == cid, q
    assert ask(api, f"{cid}を地図で見せて")["results"][0]["candidate_ids"] == [cid]


def test_area_id_next_to_japanese_text_limits_the_area(api):
    for q in (f"{A1}の新築は何件？", f"地区{A1}の新築は何件？", f"{A1} の新築は何件？"):
        r = ask(api, q)["results"][0]
        assert r["filter"]["area_id"] == A1 and r["total"] == 1, q  # 合成町の新規出現 1


def test_two_wards_are_counted_and_compared_together(api):
    r = ask(api, "中央区と東区の新規出現は何件？")["results"][0]
    assert r["total"] == 4 and r["filter"]["scope"] == "中央区・東区"  # 中央区 3（合成町 1 + 試験町 2）+ 東区 1
    # 片方の区だけの値（中央区 3 件・東区 1 件）とは別の、2 区の合計
    assert ask(api, "中央区の新規出現は何件？")["results"][0]["total"] == 3
    assert ask(api, "東区の新規出現は何件？")["results"][0]["total"] == 1
    c = ask(api, "中央区と東区を比べて")["results"][0]
    assert c["type"] == "compare" and {i["area_id"] for i in c["items"]} == {a.id for a in expected.AREAS}


# ---- 返答文の数字（`guard_numbers` の契約）: どの質問でも、数字は結果の値だけから出る（ask が確かめる） ----

QUESTIONS = [
    "新規出現の候補は何件ありますか？", "候補は全部で何件ですか", "描き漏れは何件？", "判定保留は？", "東区の候補は？",
    "試験町の件数", "地区ごとに比べて", "どの地区が一番多い？", "上位2件の一覧", "候補をリストで",
    "一番大きい候補の写真", "c-226249-105760-3 の写真", "地図で見せて", "このアプリの精度は", "再現率は？",
    "使い方", "何ができる？", "天気は？", "2030年は？", "福岡は？", "衛星は？", "パネルは？", "あ", "?", "候補",
    "合成町と試験町を比べて", "中央区の新規出現を一覧で", "仮想町の写真", "新築はどこにある？",
    "c-226249-105760-3の写真", "中央区と東区を比べて", "市内の新築は？", "取り壊された建物は？", "令和7年の新築は？", "二〇二五年の新築は？",
    "最近の新築は？", "三年町の新築は？", "百件の一覧", "１２３件の候補", "新規出現は何棟？", "上位１０件を表で",
]


@pytest.mark.parametrize("question", QUESTIONS)
def test_every_answer_has_a_valid_shape_and_only_numbers_from_the_results(api, question):
    msg = ask(api, question)
    assert msg["content"] != SAFE_TEMPLATE


def test_the_user_text_is_never_echoed_into_numbers(api):
    # 利用者が書いた数字（424242）は、結果に無ければ、返答文に出ない
    msg = ask(api, "424242件の候補を一覧で")
    assert "424242" not in msg["content"]


# ---- SQL インジェクション: 質問の文字列は、検索の条件を変えない ----

@pytest.mark.parametrize("text", [
    "合成町' OR '1'='1 の新規出現は何件？",
    "合成町\"; DELETE FROM areas; -- の新規出現は何件？",
    "合成町'); DROP TABLE candidates; -- の新規出現は何件",
])
def test_injection_strings_do_not_change_the_query(api, text):
    m = ask(api, text)
    assert m["results"][0]["total"] == 1 and m["results"][0]["filter"]["area_id"] == A1
    assert api.get("/api/candidates").json()["total"] == 9 and len(api.get("/api/areas").json()) == 3


@pytest.mark.parametrize("text", [
    "'; DROP TABLE candidates; --",
    "1; SELECT * FROM runs",
    "c-1-1-1'; DROP TABLE candidates;-- の写真を見せて",
    "z18-1-1'; DROP TABLE areas; -- の件数",
    "' OR 1=1 --",
])
def test_injection_only_input_is_harmless(api, text):
    ask(api, text)  # 型・数字の検査を通る（どの結果でもよい）
    assert api.get("/api/candidates").json()["total"] == 9


# ---- 履歴の上限・長さ ----

def test_a_long_conversation_keeps_working(api):
    # frontend は会話の全履歴を送る。21 往復目（41 件目）以降も、そのまま答える
    history: list[dict] = []
    for i in range(1, 31):
        history.append({"role": "user", "content": "新規出現の候補は何件ありますか？"})
        r = api.post("/api/chat", json={"messages": history})
        assert r.status == 200, (i, len(history), r)
        history.append({"role": "assistant", "content": r.json()["message"]["content"]})
    assert len(history) == 60


def test_chat_accepts_500_messages_and_rejects_501(api):
    ok = [{"role": "user", "content": "候補は何件？"}] * MAX_MESSAGES
    assert api.post("/api/chat", json={"messages": ok}).status == 200
    assert_validation_error(api.post("/api/chat", json={"messages": [*ok, ok[0]]}), "body", "messages")


def test_content_up_to_2000_characters_is_accepted_and_2001_is_rejected(api):
    assert api.post("/api/chat", json={"messages": [{"role": "user", "content": "あ" * MAX_CONTENT_CHARS}]}).status == 200
    assert_validation_error(api.post("/api/chat", json={"messages": [{"role": "user", "content": "あ" * (MAX_CONTENT_CHARS + 1)}]}), "body")


# ---- 入力の検証（422） ----

@pytest.mark.parametrize("body", [
    {},
    {"messages": []},
    {"messages": "x"},
    {"messages": [{"role": "user"}]},
    {"messages": [{"content": "候補は？"}]},
    {"messages": [{"role": "system", "content": "x"}]},
    {"messages": [{"role": "user", "content": 5}]},
    {"messages": [None]},
    ["x"],
    None,
])
def test_chat_bad_requests_are_422_naming_the_body(api, body):
    assert_validation_error(api.post("/api/chat", json=body), "body")


LAST_MESSAGE_RULE = "最後のメッセージは、空でない user のメッセージである必要があります"


@pytest.mark.parametrize("messages", [
    [{"role": "assistant", "content": "x"}],  # 最後は user でなければならない
    [{"role": "user", "content": "候補は？"}, {"role": "assistant", "content": "9 件です"}],
    [{"role": "user", "content": "   "}],  # 最後が空白だけ
    [{"role": "user", "content": ""}],
    [{"role": "user", "content": "\u3000\n\t"}],
    # U+001C\u301cU+001F\uff08FS\u30fbGS\u30fbRS\u30fbUS\uff09\u3060\u3051\u3002Python \u306e str.strip() \u306f\u3053\u308c\u3089\u3092\u7a7a\u767d\u3068\u898b\u3066 422 \u306b\u3059\u308b\uff08Go \u306e unicode.IsSpace \u3060\u3051\u3067\u306f\u3001\u7a7a\u3068\u5224\u5b9a\u3055\u308c\u305a\u306b\u901a\u3063\u3066\u3057\u307e\u3046\u3002
    # \u4ed5\u69d8 \u00a74.4 \u306e\u300c\u7a7a\u767d\u306e\u96c6\u5408\u300d\uff09\u3002\u5c65\u6b74\u306e\u4fdd\u5b58\u306e\u984c\u540d\u304c\u7a7a\u306b\u306a\u308b\u306e\u3092\u9632\u3050\u898f\u5247\u306e\u5143\uff08E9 \u306e\u300c\u65e2\u5b58\u306e\u691c\u67fb\u3078\u8db3\u3059\u3082\u306e\u300d\uff09
    pytest.param([{"role": "user", "content": "\u001c"}], id="u001c-only"),
    pytest.param([{"role": "user", "content": "\u001d"}], id="u001d-only"),
    pytest.param([{"role": "user", "content": "\u001e"}], id="u001e-only"),
    pytest.param([{"role": "user", "content": "\u001f"}], id="u001f-only"),
    pytest.param([{"role": "user", "content": "\u001c\u001d\u001e\u001f"}], id="u001c-to-u001f-only"),
    pytest.param([{"role": "user", "content": " \u001f\u3000\u001c\n"}], id="u001f-mixed-with-other-spaces"),
])
def test_the_last_message_must_be_a_non_empty_user_message(api, messages):
    # 形は合っているが、最後のメッセージの規則に合わない。detail は付かず、message は固定の文
    assert_error(api.post("/api/chat", json={"messages": messages}), 422, "validation_error", LAST_MESSAGE_RULE)


@pytest.mark.parametrize("raw, ctype", [
    (b"not json", "application/json"),
    (b"", "application/json"),
    (b'{"messages": [{"role": "user", "content": "x"}]}', "text/plain"),
])
def test_chat_non_json_bodies_are_422(api, raw, ctype):
    assert_validation_error(api.post("/api/chat", body=raw, headers={"Content-Type": ctype}), "body")


def test_chat_only_allows_post(api):
    assert_error(api.get("/api/chat"), 405, "method_not_allowed")


def test_extra_fields_from_the_client_are_ignored(api):
    msgs = [
        {"role": "user", "content": "候補は何件？", "id": 1},
        {"role": "assistant", "content": "9 件です", "results": [{"type": "count"}], "tool_calls": []},
        {"role": "user", "content": "では合成町は？"},
    ]
    r = api.post("/api/chat", json={"messages": msgs, "extra": True})
    assert r.status == 200 and r.json()["message"]["results"][0]["filter"]["area_id"] == A1


def test_chat_does_not_depend_on_the_authorization_header(api):
    body = {"messages": [{"role": "user", "content": "候補は何件？"}]}
    base = api.post("/api/chat", json=body).json()
    for headers in ({"Authorization": "Bearer garbage"}, {"Authorization": "Basic x"}):
        assert api.post("/api/chat", json=body, headers=headers).json() == base
