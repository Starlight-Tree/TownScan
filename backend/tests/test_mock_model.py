"""模擬モデルの意図の判定（DB なしで動く単体テスト）。plan(messages) が選ぶツール呼び出しだけを見る。

返答の型・数字の検査は test_chat.py（API 経由）に任せ、ここは「聞き方の揺れで判定が変わらないこと」を押さえる。
"""

from __future__ import annotations

import pytest

from app.chat import mock_model
from app.chat.guard import find_unsupported_numbers
from app.chat.mock_model import MockModel

# 実データ（熊本 12 地区）と同じ形の名前・区。区は 3 つ（中央・西・南）
AREAS = [
    {"id": "z18-226274-105752", "name": "黒髪六丁目", "ward": "中央区"},
    {"id": "z18-226266-105755", "name": "渡鹿五丁目", "ward": "中央区"},
    {"id": "z18-226238-105782", "name": "二本木四丁目", "ward": "西区"},
    {"id": "z18-226227-105787", "name": "新土河原一丁目", "ward": "西区"},
    {"id": "z18-226240-105790", "name": "近見三丁目", "ward": "南区"},
    {"id": "z18-226218-105791", "name": "土河原町", "ward": "南区"},
]
KUROKAMI = "z18-226274-105752"
CID = "c-226249-105759-2"


def plan(text: str, history: tuple = ()) -> list[dict]:
    return MockModel(AREAS).plan([*history, {"role": "user", "content": text}])


def first(text: str, history: tuple = ()) -> dict:
    return plan(text, history)[0]


def refusal_reason(call: dict) -> str | None:
    return call["args"]["reason"] if call["name"] == "refuse" else None


# ---- 候補 ID・地区 ID は、日本語に直接つながっていても読める ----

@pytest.mark.parametrize("text", [
    f"{CID}の写真を見せて",
    f"候補{CID}の写真",
    f"候補{CID}について写真を見せて",
    f"写真{CID}",
    f"({CID})の写真",
    f"（{CID}）の写真",
    f"「{CID}」の写真を見せて",
    f"C-226249-105759-2の写真を見せて",
    "ｃ－２２６２４９－１０５７５９－２の写真を見せて",
    f"{CID} の写真を見せて",
])
def test_candidate_id_next_to_japanese_is_recognised(text):
    assert plan(text) == [{"name": "show_candidate", "args": {"candidate_id": CID}}]


def test_candidate_id_next_to_japanese_works_for_the_map_too():
    assert plan(f"{CID}を地図で見せて") == [{"name": "focus_map", "args": {"candidate_id": CID}}]


@pytest.mark.parametrize("text", [
    f"{KUROKAMI}の新築は何件？",
    f"地区{KUROKAMI}の新築は何件？",
    f"Z18-226274-105752の新築は何件？",
    f"{KUROKAMI} の新築は何件？",
])
def test_area_id_next_to_japanese_is_recognised(text):
    assert plan(text) == [{"name": "count_candidates", "args": {"area_ids": [KUROKAMI], "cls": "confirmed_new"}}]


@pytest.mark.parametrize("text", ["c-1-2-3-4 の写真", "abc-1-2-3 の写真", "c-1-2-3abc の写真", "c-1-2 の写真"])
def test_id_like_strings_that_are_not_ids_are_not_taken_as_ids(text):
    assert mock_model.CANDIDATE_ID.search(mock_model.normalize(text)) is None


def test_candidate_id_from_the_previous_turn_is_kept_for_a_followup():
    history = ({"role": "user", "content": f"{CID}の写真を見せて"}, {"role": "assistant", "content": "候補の写真です"})
    assert first("その地図での位置は？", history) == {"name": "focus_map", "args": {"candidate_id": CID}}


# ---- 区が複数あれば、すべて使う ----

def test_two_wards_are_both_used_in_the_order_written():
    assert plan("中央区と西区を比べて") == [{"name": "compare_areas", "args": {"wards": ["中央区", "西区"]}}]
    assert first("西区と中央区を比べて")["args"] == {"wards": ["西区", "中央区"]}
    assert plan("中央区と南区の新築は何件？") == [
        {"name": "count_candidates", "args": {"wards": ["中央区", "南区"], "cls": "confirmed_new"}}]
    assert first("中央区、西区、南区の候補を一覧で")["args"]["wards"] == ["中央区", "西区", "南区"]


def test_one_ward_keeps_the_single_ward_argument():
    assert first("中央区の新築は何件？")["args"] == {"ward": "中央区", "cls": "confirmed_new"}


def test_named_area_wins_over_ward_names():
    # 「中央区の黒髪六丁目」は、中央区の中の 1 地区。区を足さず、その地区だけを見る
    assert first("中央区の黒髪六丁目の新築は何件？")["args"] == {"area_ids": [KUROKAMI], "cls": "confirmed_new"}


def test_two_wards_are_inherited_by_a_followup():
    history = ({"role": "user", "content": "中央区と西区の新築は何件？"}, {"role": "assistant", "content": "…"})
    assert first("その地区の候補を一覧で", history) == {
        "name": "list_candidates", "args": {"wards": ["中央区", "西区"], "cls": "confirmed_new"}}


# ---- 対象そのものを指す語は、対象外の場所と取り違えない ----

@pytest.mark.parametrize("text", [
    "熊本市内の新築は何件？", "全域の新築は何件？", "全エリアの新築は何件？", "対象地域の新築は何件ですか", "解析した範囲の新築は？",
    "熊本市全域の新築は？", "熊本市内全域の建物は？", "市内の建物は？", "対象エリアの候補は？", "解析範囲の新築は何件？",
    "以前の新築は何件？", "過去の建物は？",
])
def test_words_for_our_own_target_are_not_refused_as_other_places(text):
    call = first(text)
    assert call["name"] == "count_candidates", call


@pytest.mark.parametrize("text", [
    "渋谷の新築は？", "渋谷全域の新築は？", "渋谷エリアの新築は？", "六本木ヒルズ周辺の建物は？", "熊本城の新築は？",
    "熊本県全域の新築は？", "福岡市内の新築は？", "手取本町の新築は何件？",
])
def test_other_places_are_still_refused(text):
    call = first(text)
    assert refusal_reason(call) == "out_of_scope", call


# ---- このアプリが扱わない向き（取り壊し・減少）は、件数で答えず断る ----

@pytest.mark.parametrize("text", [
    "取り壊された建物は？", "2018年にあって2023年に無い建物は？", "建物が減った場所は？", "解体された家は何件？", "無くなった建物は？",
    "旧写真にあって新写真に無い建物を見せて", "減少した建物の数は？", "消えた建物はどこ？", "撤去された建物の一覧",
])
def test_demolition_and_decrease_questions_are_refused_not_counted(text):
    call = first(text)
    assert call["name"] == "refuse" and call["args"]["reason"] == "not_implemented", call
    assert "取り壊し" in call["args"]["message"] and "新築の候補" in call["args"]["message"]
    assert len(plan(text)) == 1


@pytest.mark.parametrize("text", [
    "旧写真に無い新築は何件？", "新規出現（旧写真に無い）の件数は？", "既存の描き漏れ（旧写真に既にある）は何件？", "新しく建った建物は？",
    "新築が増えた地区は？",
])
def test_labels_and_new_building_questions_are_not_mistaken_for_demolition(text):
    assert refusal_reason(first(text)) is None


# ---- 写真が無い時期: 和暦・漢数字・相対語 ----

@pytest.mark.parametrize("text", [
    "2024年の新築は？", "令和6年の新築は？", "令和７年の新築は？", "令和六年の新築は？", "令和十二年の新築は？", "令和元年の新築は？",
    "平成31年の新築は？", "昭和60年の建物は？", "R6年の新築は？", "r7年の新築は？", "H31年の新築は？",
    "二〇二四年の新築は？", "二千二十四年の新築は？", "二〇一九年の新築は？",
    "最近の新築は何件？", "近年の新築は？", "現在の新築は何件？", "今後の新築は？", "将来の建物は？",
])
def test_years_without_photos_and_relative_times_are_refused_as_no_photo_period(text):
    call = first(text)
    assert refusal_reason(call) == "no_photo_period", call
    # 断りの文に、利用者の語（漢数字+年など）を写さない。写すと数字の検査で本文が差し替わる
    assert find_unsupported_numbers(call["args"]["message"], [{"message": call["args"]["message"]}]) == []


@pytest.mark.parametrize("text", [
    "2018年の新築は？", "2023年の新築は何件？", "令和5年の新築は何件？", "令和五年の新築は？", "平成30年の新築は？", "R5年の新築は？",
    "二〇二三年の新築は？", "二千十八年の建物は？", "平成30年と令和5年を比べた新築は何件？",
])
def test_years_with_photos_are_not_refused(text):
    assert refusal_reason(first(text)) is None


def test_the_relative_time_word_is_not_taken_for_a_place():
    call = first("最近の新築は何件？")
    assert call["args"]["reason"] == "no_photo_period" and "含まれていません" not in call["args"]["message"]


@pytest.mark.parametrize("text, expected", [
    ("二〇二四", 2024), ("二千二十四", 2024), ("千九百九十九", 1999), ("十二", 12), ("六", 6), ("二十", 20), ("百", 100),
])
def test_kanji_numbers(text, expected):
    assert mock_model.kanji_to_int(text) == expected


@pytest.mark.parametrize("text", ["", "二a", "二二千", "abc"])
def test_unreadable_kanji_numbers_are_none(text):
    assert mock_model.kanji_to_int(text) is None


# ---- 断りの文は、利用者の語を写しても、数字の検査で差し替わらない ----

@pytest.mark.parametrize("text", [
    "三年町の新築は？", "十棟町の新築は何件？", "二千二十四番町の新築は？", "九州の新築は？", "渋谷の新築は？",
])
def test_refusal_messages_pass_the_number_guard(text):
    call = first(text)
    if call["name"] == "refuse":
        msg = call["args"]["message"]
        assert find_unsupported_numbers(msg, [{"message": msg}]) == [], msg
