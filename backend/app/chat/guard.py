"""返答文の数字の検査（仕様 §4.5「数字は結果からだけ」）。

返答文 content に出る数字は、results に含まれる値（数値・文字列の中の数字）だけから出ていなければならない。
満たさない返答は返さず、数字を含まない安全なテンプレートに落とす。

見るもの: 半角・全角のアラビア数字（NFKC で揃える）。アルファベットの直後の数字（F1・m2 など）は単位・記号として見ない。
漢数字は、助数詞（件・棟・地区・年など）が続くものだけ見る（「一覧」「一番」のような語を巻き込まないため）。
実モデルをつなぐときも、返答文はここを通す。
"""

from __future__ import annotations

import logging
import math
import re
import unicodedata
from typing import Any

log = logging.getLogger("townscan")

SAFE_TEMPLATE = "結果は下のカードのとおりです。数字はカードに表示された値を見てください。"

_NUM_RE = re.compile(r"(?<![A-Za-z])\d+(?:,\d{3})*(?:\.\d+)?")
_KANJI_COUNT_RE = re.compile(
    r"[〇零一二三四五六七八九十百千万]+\s*(?:件|棟|地区|枚|割|倍|%|％|か所|ヶ所|カ所|平方|パーセント|年)"
)


def _norm_text(text: str) -> str:
    return unicodedata.normalize("NFKC", text)


def normalize_number(token: str) -> str:
    """"1,234" → "1234"、"0.60" → "0.6"、"007" → "7"、"5.0" → "5"。"""
    token = token.replace(",", "")
    if "." in token:
        head, tail = token.split(".", 1)
        tail = tail.rstrip("0")
        return (str(int(head)) + ("." + tail if tail else ""))
    return str(int(token))


def number_tokens(text: str) -> list[str]:
    return [normalize_number(m.group(0)) for m in _NUM_RE.finditer(_norm_text(text))]


def number_forms(value: int | float) -> set[str]:
    """数値 1 つから、返答文に書いてよい表記（四捨五入・百分率を含む）を作る。"""
    if isinstance(value, bool):
        return set()
    if isinstance(value, int):
        return {normalize_number(str(abs(value)))}
    if not math.isfinite(value):
        return set()
    v = abs(value)
    forms = {f"{v:.{d}f}" for d in range(0, 5)} | {repr(v)}
    if v <= 1.0:  # 割合は百分率でも書ける
        forms |= {f"{v * 100:.{d}f}" for d in range(0, 3)}
    out = set()
    for f in forms:
        if "e" in f.lower():  # 極端に小さい値の指数表記は使わない
            continue
        out.add(normalize_number(f))
    return out


def allowed_numbers(results: Any) -> set[str]:
    """results（辞書・配列の入れ子）の中の、数値と、文字列の中の数字を集める。キー名は含めない。"""
    found: set[str] = set()

    def walk(node: Any) -> None:
        if isinstance(node, bool) or node is None:
            return
        if isinstance(node, (int, float)):
            found.update(number_forms(node))
        elif isinstance(node, str):
            found.update(number_tokens(node))
        elif isinstance(node, dict):
            for v in node.values():
                walk(v)
        elif isinstance(node, (list, tuple)):
            for v in node:
                walk(v)

    walk(results)
    return found


def find_unsupported_numbers(content: str, results: Any) -> list[str]:
    """content にあって、results から出せない数字（と、漢数字＋助数詞）。空なら合格。"""
    allowed = allowed_numbers(results)
    bad = [t for t in number_tokens(content) if t not in allowed]
    bad += [m.group(0) for m in _KANJI_COUNT_RE.finditer(_norm_text(content))]
    return bad


def guard_numbers(content: str, results: Any) -> str:
    """合格なら content をそのまま、満たさなければ安全なテンプレートを返す（元の文は返さない）。"""
    bad = find_unsupported_numbers(content, results)
    if not bad:
        return content
    log.warning("返答文の数字が結果から出せないため、安全なテンプレートに差し替え: %s", bad[:5])
    return SAFE_TEMPLATE
