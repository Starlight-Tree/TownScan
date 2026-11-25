"""チャットの検査の道具: 結果（ToolResult）の形の確かめ方（仕様 §4.5）と、返答文の数字の検査（`guard_numbers` の契約）。

数字の検査は、API の実装を import せず、仕様（docs/spec-prototype.md §4.5「数字は結果からだけ」）と同じ規則を、検査の側で持つ:
返答文 content に出る数字は、results に含まれる値（数値・文字列の中の数字）だけから出ていなければならない。
  - 見るもの: 半角・全角のアラビア数字（NFKC で揃える）。アルファベットの直後の数字（F1・m2 など）は単位・記号として見ない。
  - 漢数字は、助数詞（件・棟・地区・年など）が続くものだけ見る（「一覧」「一番」のような語を巻き込まない）。
  - 数値は、四捨五入（小数 0〜4 桁）の表記も許す。0〜1 の割合は、百分率（小数 0〜2 桁）の表記も許す。
"""

from __future__ import annotations

import math
import re
import unicodedata
from typing import Any

from support.checks import is_num

# 数字の検査に落ちたときに返る、数字を含まない固定の文。模擬モデルの通常の返答は、これにならない
SAFE_TEMPLATE = "結果は下のカードのとおりです。数字はカードに表示された値を見てください。"

REFUSAL_REASONS = {"out_of_scope", "no_photo_period", "not_implemented", "no_data"}
RESULT_TYPES = {"count", "table", "compare", "map_focus", "detection_image", "accuracy", "refusal"}

_NUM_RE = re.compile(r"(?<![A-Za-z])\d+(?:,\d{3})*(?:\.\d+)?")
_KANJI_COUNT_RE = re.compile(r"[〇零一二三四五六七八九十百千万]+\s*(?:件|棟|地区|枚|割|倍|%|％|か所|ヶ所|カ所|平方|パーセント|年)")


def _normalize_number(token: str) -> str:
    """"1,234" → "1234"、"0.60" → "0.6"、"007" → "7"、"5.0" → "5"。"""
    token = token.replace(",", "")
    if "." in token:
        head, tail = token.split(".", 1)
        tail = tail.rstrip("0")
        return str(int(head)) + ("." + tail if tail else "")
    return str(int(token))


def _number_tokens(text: str) -> list[str]:
    return [_normalize_number(m.group(0)) for m in _NUM_RE.finditer(unicodedata.normalize("NFKC", text))]


def _number_forms(value: int | float) -> set[str]:
    if isinstance(value, bool):
        return set()
    if isinstance(value, int):
        return {_normalize_number(str(abs(value)))}
    if not math.isfinite(value):
        return set()
    v = abs(value)
    forms = {f"{v:.{d}f}" for d in range(0, 5)} | {repr(v)}
    if v <= 1.0:
        forms |= {f"{v * 100:.{d}f}" for d in range(0, 3)}
    return {_normalize_number(f) for f in forms if "e" not in f.lower()}


def allowed_numbers(results: Any) -> set[str]:
    """results（辞書・配列の入れ子）の中の、数値と、文字列の中の数字。キー名は含めない。"""
    found: set[str] = set()

    def walk(node: Any) -> None:
        if isinstance(node, bool) or node is None:
            return
        if isinstance(node, (int, float)):
            found.update(_number_forms(node))
        elif isinstance(node, str):
            found.update(_number_tokens(node))
        elif isinstance(node, dict):
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(results)
    return found


def unsupported_numbers(content: str, results: Any) -> list[str]:
    """content にあって、results から出せない数字（と、漢数字＋助数詞）。空なら合格。"""
    allowed = allowed_numbers(results)
    bad = [t for t in _number_tokens(content) if t not in allowed]
    bad += [m.group(0) for m in _KANJI_COUNT_RE.finditer(unicodedata.normalize("NFKC", content))]
    return bad


# ---- 結果の形（仕様 §4.5） ----

def check_provenance(p: dict) -> None:
    assert {"source", "photo_years", "model", "run_id", "run_kind"} <= set(p) <= {"source", "photo_years", "model", "run_id", "run_kind", "metric", "note"}, p
    assert isinstance(p["source"], str) and p["source"]
    assert isinstance(p["photo_years"], list) and all(isinstance(y, int) for y in p["photo_years"])
    assert isinstance(p["model"], str) and isinstance(p["run_id"], str)
    assert p["run_kind"] in ("real", "synthetic")
    assert isinstance(p.get("metric", ""), str) and isinstance(p.get("note", ""), str)


def check_filter(f: dict) -> None:
    assert set(f) <= {"area_id", "area_ids", "cls", "scope"} and isinstance(f["scope"], str) and f["scope"], f  # scope は常に付く
    assert not ("area_id" in f and "area_ids" in f), f


def check_result(r: dict) -> None:
    t = r["type"]
    assert t in RESULT_TYPES, f"未知の結果の型: {t}"
    if t == "refusal":
        assert set(r) == {"type", "reason", "message", "suggestions"}, r
        assert r["reason"] in REFUSAL_REASONS and isinstance(r["message"], str) and r["message"]
        assert isinstance(r["suggestions"], list) and all(isinstance(s, str) for s in r["suggestions"])
        return
    assert isinstance(r["title"], str) and r["title"]
    check_provenance(r["provenance"])
    if t == "count":
        assert set(r) == {"type", "title", "total", "breakdown", "filter", "provenance"}, r
        assert isinstance(r["total"], int) and not isinstance(r["total"], bool)
        check_filter(r["filter"])
        assert all(set(b) == {"key", "label", "value"} and isinstance(b["value"], int) for b in r["breakdown"])
        assert r["total"] == sum(b["value"] for b in r["breakdown"])
    elif t == "table":
        keys = [c["key"] for c in r["columns"]]
        assert all(set(c) == {"key", "label"} for c in r["columns"])
        assert isinstance(r["total"], int) and r["shown"] == len(r["rows"]) <= r["total"]
        assert all(set(keys) <= set(row) for row in r["rows"])
        if "filter" in r:
            check_filter(r["filter"])
    elif t == "compare":
        assert set(r) == {"type", "title", "items", "sort_key", "provenance", "filter"}, r
        check_filter(r["filter"])
        for it in r["items"]:
            assert set(it) == {"area_id", "name", "ward", "counts"}, it
            assert isinstance(it["area_id"], str) and isinstance(it["name"], str)
            assert set(it["counts"]) == {"confirmed_new", "existing_omission", "uncertain", "total"}
    elif t == "map_focus":
        assert set(r) == {"type", "title", "bbox", "candidate_ids", "provenance"}, r
        assert len(r["bbox"]) == 4 and all(is_num(v) for v in r["bbox"])
        assert r["bbox"][0] < r["bbox"][2] and r["bbox"][1] < r["bbox"][3]
        assert all(isinstance(i, str) for i in r["candidate_ids"])
    elif t == "detection_image":
        assert set(r) == {"type", "title", "candidate_id", "class", "images", "caption", "provenance"}, r
        assert re.fullmatch(r"c-\d+-\d+-\d+", r["candidate_id"])
        assert r["class"] in ("confirmed_new", "existing_omission", "uncertain")
        assert [i["year"] for i in r["images"]] == [2018, 2023]
        assert all(set(i) == {"year", "url"} and i["url"].startswith("/api/candidates/") for i in r["images"])
        assert isinstance(r["caption"], str) and r["caption"]
    elif t == "accuracy":
        assert set(r) == {"type", "title", "metrics", "provenance"}, r
        assert all(set(m) == {"key", "label", "value", "note"} and (m["value"] is None or is_num(m["value"])) for m in r["metrics"])


def check_message(msg: dict) -> None:
    """アシスタントの回答（`POST /api/chat` の `message`）の形・結果の形・数字の検査（「数字は結果からだけ」）。履歴から読み戻した回答にも使う（`run_created_at` を外してから渡す）。"""
    assert set(msg) == {"role", "content", "results", "tool_calls"}, msg
    assert msg["role"] == "assistant" and isinstance(msg["content"], str)
    assert len(msg["tool_calls"]) >= 1 and len(msg["results"]) == len(msg["tool_calls"]), msg
    for call in msg["tool_calls"]:
        assert set(call) == {"name", "args"} and isinstance(call["name"], str) and isinstance(call["args"], dict), call
    for res in msg["results"]:
        check_result(res)
    # 返答文の数字は、結果の値だけから出ている（満たさない文は、API が数字を含まない固定の文に替える）。模擬モデルは、替える必要のある文を作らない
    assert unsupported_numbers(msg["content"], msg["results"]) == [], msg["content"]
    assert msg["content"] != SAFE_TEMPLATE, "数字の検査で、返答文が固定の文に替わっている"


def ask(api, text: str, history: list[dict] | tuple = (), *, conversation_id: str | None = None, headers: dict | None = None) -> dict:
    """1 回問い合わせて、応答の形・結果の形・数字の検査（「数字は結果からだけ」）を確かめ、message を返す。
    conversation_id・headers は、会話の履歴（H-系）の検査だけが使う（付けなければ、今までと同じ要求）。"""
    messages = [*history, {"role": "user", "content": text}]
    body: dict = {"messages": messages}
    if conversation_id is not None:
        body["conversation_id"] = conversation_id
    resp = api.post("/api/chat", json=body, headers=headers)
    assert resp.status == 200, resp
    assert resp.content_type.startswith("application/json"), resp
    body = resp.json()
    assert set(body) == {"message"}, body
    msg = body["message"]
    check_message(msg)
    return msg


def turn(api, text: str, history: list[dict] | tuple = ()) -> tuple[dict, list[dict]]:
    """会話を続けるときの履歴（クライアントが送る messages だけから文脈を作る。サーバーは会話を保存しない）。"""
    msg = ask(api, text, history)
    return msg, [*history, {"role": "user", "content": text}, {"role": "assistant", "content": msg["content"]}]


def tool_names(msg: dict) -> list[str]:
    return [c["name"] for c in msg["tool_calls"]]
