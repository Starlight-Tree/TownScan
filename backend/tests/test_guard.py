"""guard_numbers: 返答文の数字は results の値だけから出ていること。"""

from __future__ import annotations

from app.chat.guard import SAFE_TEMPLATE, allowed_numbers, find_unsupported_numbers, guard_numbers, number_forms

RESULTS = [{
    "type": "count", "title": "新規出現候補の件数（全地区）", "total": 1234,
    "breakdown": [{"key": "confirmed_new", "label": "新規出現", "value": 3}, {"key": "x", "label": "y", "value": 0}],
    "filter": {"area_id": "z18-226249-105759"},
    "provenance": {"photo_years": [2018, 2023], "run_id": "synthetic-test", "model": "m"},
}]


def test_numbers_from_results_pass():
    text = "全地区の候補は 1,234 件です。内訳は新規出現 3 件、2018 年と 2023 年の写真から。"
    assert find_unsupported_numbers(text, RESULTS) == []
    assert guard_numbers(text, RESULTS) == text


def test_fabricated_number_is_dropped():
    text = "全地区の候補は 9999 件です。"
    assert find_unsupported_numbers(text, RESULTS) == ["9999"]
    out = guard_numbers(text, RESULTS)
    assert out == SAFE_TEMPLATE and "9999" not in out


def test_fullwidth_digits_are_normalised():
    assert find_unsupported_numbers("候補は１２３４件です", RESULTS) == []  # NFKC で 1234 に揃う
    assert find_unsupported_numbers("候補は 5 件です", RESULTS) == ["5"]


def test_fullwidth_fabrication_is_caught():
    assert find_unsupported_numbers("候補は９９９件です", RESULTS) == ["999"]


def test_kanji_numeral_with_counter_is_caught():
    assert find_unsupported_numbers("候補は三十件です", RESULTS)
    assert find_unsupported_numbers("二〇二三年の写真です", RESULTS)
    # 「一覧」「一番」のような語は数字として扱わない
    assert find_unsupported_numbers("一覧を表示します。一番大きい候補です。", RESULTS) == []


def test_digits_after_letters_are_symbols_not_numbers():
    assert find_unsupported_numbers("F1 と m2 と z18 は記号", RESULTS) == []


def test_ids_in_result_strings_are_allowed():
    res = [{"type": "detection_image", "candidate_id": "c-226249-105759-1", "images": [{"year": 2018}, {"year": 2023}]}]
    assert find_unsupported_numbers("候補 c-226249-105759-1 の 2018 年と 2023 年", res) == []
    assert find_unsupported_numbers("候補 c-226249-105759-2 です", res) == ["2"]  # 末尾の番号を取り違えている


def test_numbers_without_results_are_dropped():
    assert guard_numbers("候補は 3 件です", []) == SAFE_TEMPLATE
    assert guard_numbers("結果はありません", []) == "結果はありません"


def test_float_forms_rounding_and_percent():
    res = [{"value": 0.7634}]
    forms = number_forms(0.7634)
    assert {"0.76", "0.763", "0.7634", "76"} <= forms
    assert find_unsupported_numbers("F1 は 0.76 です", res) == []
    assert find_unsupported_numbers("F1 は 76 % です", res) == []
    assert find_unsupported_numbers("F1 は 0.91 です", res) == ["0.91"]


def test_trailing_zero_and_comma_normalisation():
    res = [{"v": 12.5, "n": 1200}]
    assert find_unsupported_numbers("12.50 と 1,200 と 1200", res) == []


def test_bool_and_none_are_ignored():
    assert allowed_numbers({"a": True, "b": None}) == set()


def test_keys_are_not_a_source_of_numbers():
    assert allowed_numbers({"2018": "x"}) == set()
    assert find_unsupported_numbers("2018 年", [{"2018": "x"}]) == ["2018"]


def test_safe_template_has_no_digits():
    assert not any(ch.isdigit() for ch in SAFE_TEMPLATE)
