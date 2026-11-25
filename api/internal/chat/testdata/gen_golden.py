#!/usr/bin/env python3
"""模擬モデルの規則・文字の整え方・数字の検査の「期待値」を、Python の実装（backend/app/chat/）から作る。

Go の単体テスト（golden_test.go）が、この出力（golden.json）と、同じ入力での結果を比べる。
契約の検査（contract/）が見ない規則の境目（正規表現の書き換え・Unicode の扱い・優先順位）を、広い入力で Python の実装に合わせるため。
入力は、契約・Python のテストにある質問の全部と、規則の語の展開・年の書き方・場所の語・ID の前後の文字・文脈の組み合わせと、乱数（固定の種）の文。

作り直し（backend/ を読み取り専用で、この testdata を書き込み可で重ねる。ネットワークは要らない）:

    docker run --rm --network none --user "$(id -u):$(id -g)" -e PYTHONDONTWRITEBYTECODE=1 \\
      -v "$PWD/backend:/code:ro" -v "$PWD/contract:/contract:ro" -v "$PWD/api/internal/chat/testdata:/out" \\
      townscan-backend-test python /out/gen_golden.py

標準ライブラリと、backend/app の import（psycopg）だけ。Python の実装を直したら、作り直して、差分を確かめる。
"""

from __future__ import annotations

import ast
import gzip
import itertools
import json
import random
import re
import sys
from pathlib import Path

sys.path.insert(0, "/code")

from app.chat import mock_model as mm  # noqa: E402
from app.chat.guard import find_unsupported_numbers  # noqa: E402

OUT = Path("/out/golden.json.gz")

REAL = [  # 実データ（熊本 12 地区）と同じ形の名前・区（backend/tests/test_mock_model.py）
    {"id": "z18-226274-105752", "name": "黒髪六丁目", "ward": "中央区"},
    {"id": "z18-226266-105755", "name": "渡鹿五丁目", "ward": "中央区"},
    {"id": "z18-226238-105782", "name": "二本木四丁目", "ward": "西区"},
    {"id": "z18-226227-105787", "name": "新土河原一丁目", "ward": "西区"},
    {"id": "z18-226240-105790", "name": "近見三丁目", "ward": "南区"},
    {"id": "z18-226218-105791", "name": "土河原町", "ward": "南区"},
]
SYNTH = [  # 合成データ（契約の検査が使う）
    {"id": "z18-226249-105759", "name": "合成町", "ward": "中央区"},
    {"id": "z18-226250-105759", "name": "試験町", "ward": "中央区"},
    {"id": "z18-226249-105760", "name": "仮想町", "ward": "東区"},
]
ODD = [  # 名前の形が変わった地区（丁目だけ・全角・区なし・名前が id）
    {"id": "z18-1-1", "name": "一丁目", "ward": "中央区"},
    {"id": "z18-2-2", "name": "大江町", "ward": "中央区"},
    {"id": "z18-3-3", "name": "z18-3-3", "ward": ""},
    {"id": "z18-4-4", "name": "ＡＢ町", "ward": "北区"},
    {"id": "z18-5-5", "name": "新町2丁目", "ward": "北区"},
    {"id": "z18-6-6", "name": "町", "ward": "北区"},
]
AREA_SETS = {"real": REAL, "synth": SYNTH, "odd": ODD}

# 長い定型の断りは、短い印にして書く（golden.json を小さくするため。golden_test.go が戻す）
MESSAGE_TOKENS = {
    mm.MSG_CHITCHAT: "@chitchat",
    mm.MSG_SATELLITE: "@satellite",
    mm.MSG_PANEL: "@panel",
    mm.MSG_DISAPPEAR: "@disappear",
    mm.MSG_YEAR: "@year",
}


# ---- 規則の語の展開（正規表現の構文木から、書ける語を集める） ----

def expand(pattern: str, limit: int = 12) -> list[str]:
    from re import _parser as sp  # 内部の構文解析（この作業の道具としてだけ使う）

    def walk(items) -> list[str]:
        outs = [""]
        for op, av in items:
            name = str(op)
            if name == "LITERAL":
                opts = [chr(av)]
            elif name == "NOT_LITERAL":
                opts = ["x"]
            elif name == "IN":
                chars = []
                for o, a in av:
                    if str(o) == "LITERAL":
                        chars.append(chr(a))
                    elif str(o) == "RANGE":
                        chars.extend([chr(a[0]), chr(a[1])])
                    elif str(o) == "CATEGORY":
                        chars.append("3" if "DIGIT" in str(a) else " ")
                opts = chars[:2] or ["x"]
            elif name == "BRANCH":
                opts = [s for branch in av[1] for s in walk(branch)]
            elif name == "SUBPATTERN":
                opts = walk(av[3])
            elif name in ("MAX_REPEAT", "MIN_REPEAT"):
                lo, hi, sub = av
                inner = walk(sub) if str(sub[0][0]) != "ANY" else ["あ"]
                opts = []
                for n in sorted({lo, min(max(hi, lo), lo + 1) if hi < 100 else lo + 1}):
                    if n == 0:
                        opts.append("")
                    else:
                        opts.extend(s * n for s in inner[:2])
                if str(sub[0][0]) == "ANY":
                    opts = ["", "あ", "あ" * 5]
            elif name == "ANY":
                opts = ["あ"]
            elif name == "AT":
                opts = [""]
            elif name == "CATEGORY":
                opts = ["3" if "DIGIT" in str(av) else " "]
            else:
                opts = [""]
            outs = [o + s for o in outs for s in opts][: limit * 8]
        return outs

    words = walk(sp.parse(pattern))
    seen, out = set(), []
    for w in words:
        if w and w not in seen:
            seen.add(w)
            out.append(w)
    return out


RULES = {
    "INJECTION": mm.INJECTION, "CHITCHAT": mm.CHITCHAT, "SATELLITE": mm.SATELLITE, "PANEL": mm.PANEL,
    "RELATIVE_TIME": mm.RELATIVE_TIME, "CLS_NEW": mm.CLS_NEW, "CLS_OMIT": mm.CLS_OMIT, "CLS_UNC": mm.CLS_UNC,
    "ALL_AREAS": mm.ALL_AREAS, "FOLLOWUP": mm.FOLLOWUP, "HELP": mm.HELP, "ACCURACY": mm.ACCURACY, "PHOTO": mm.PHOTO,
    "MAP": mm.MAP, "COMPARE_STRONG": mm.COMPARE_STRONG, "COMPARE_WEAK": mm.COMPARE_WEAK, "LIST": mm.LIST,
    "COUNT": mm.COUNT, "COUNT_STRONG": mm.COUNT_STRONG, "DISAPPEAR": mm.DISAPPEAR, "DOMAIN": mm.DOMAIN,
    "OWN_VOCABULARY": mm.OWN_VOCABULARY,
}


def keywords() -> list[str]:
    seen, out = set(), []
    for name in sorted(RULES):
        for w in expand(RULES[name].pattern):
            if w not in seen:
                seen.add(w)
                out.append(w)
    return out


# ---- 質問の集め方 ----

def literal_questions() -> list[str]:
    """契約・Python のテストに書かれた文字列のうち、質問に見えるもの（f 文字列は、定数の部分だけ）。"""
    files = [
        "/contract/test_chat_answers.py", "/contract/test_chat_behavior.py", "/contract/test_no_data.py",
        "/code/tests/test_chat.py", "/code/tests/test_mock_model.py",
    ]
    found: set[str] = set()
    for f in files:
        tree = ast.parse(Path(f).read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                s = node.value
                if 1 <= len(s) <= 90 and "\n" not in s and re.search(r"[^\x00-\x7f]|[a-zA-Z]{3}", s):
                    found.add(s)
    # 契約が組み立てる質問（f 文字列）
    cid, aid = "c-226249-105759-3", "z18-226249-105759"
    for tpl in ("{}の写真を見せて", "候補{}の写真", "（{}）の写真を見せて", "{} の写真を見せて", "{}を地図で見せて", "{}の新築は何件？", "地区{}の新築は何件？", "{} の新築は何件？"):
        found.add(tpl.format(cid))
        found.add(tpl.format(aid))
    return sorted(found)


PLACES = ["渋谷", "六本木", "六本木ヒルズ", "新宿", "梅田", "天神", "博多", "熊本城", "水前寺", "手取本町", "三年町", "十棟町", "二千二十四番町",
          "九州", "ニューヨーク", "パリ", "ロンドン", "アメリカ", "国内", "市外", "県外", "江津湖", "下通", "上通", "花畑町", "安政町",
          "熊本市", "熊本市内", "熊本市全域", "熊本市全体", "全市", "市全域", "福岡市", "八代市", "南区", "北区", "中央区", "東区", "西区",
          "黒髪", "黒髪六丁目", "近見", "合成", "試験", "対象", "解析", "最新", "以前", "昔", "過去", "当時", "渋谷全域", "渋谷エリア", "渋谷周辺", "渋谷付近"]
NOUNS = ["新築", "建物", "建築", "新規", "候補", "件数", "写真", "地図", "棟", "家", "土地"]
LINKS = ["の", "での", "にある", "にあたる", "周辺の", "付近の", "あたりの", "辺りの", "近辺の"]

YEAR_WORDS = ["2018年", "2023年", "2024年", "2025年", "2016年", "2000年", "1999年", "2100年", "20245年", "12024年", "２０２４年", "２０１８年",
              "令和元年", "令和5年", "令和6年", "令和７年", "令和六年", "令和五年", "令和十二年", "令和 6 年", "平成30年", "平成元年", "平成31年", "昭和60年", "昭和元年",
              "大正3年", "明治45年", "R5年", "R6年", "r7年", "H30年", "h31年", "S60年", "R 6 年", "ar6年", "R100年", "R1年",
              "二〇二三年", "二〇二四年", "二千二十三年", "二千十八年", "二千二十四年", "千九百九十九年", "二〇一九年", "二千年", "十二年", "百年", "一二三年",
              "三年", "三年前", "２年前", "1年", "2018", "2023", "2030", "年", "来年", "去年", "昨年", "今年", "最近", "近年", "現在", "今後", "将来"]
ID_BEFORE = ["", " ", "候補", "（", "(", "「", "写真", "A", "a", "1", "-", "x-", "。", "、"]
ID_AFTER = ["", " ", "の写真", "を", "）", ")", "」", "a", "A", "1", "-", "-1", "、", "。", "について"]
CIDS = ["c-226249-105759-2", "c-226250-105759-1", "C-1-2-3", "ｃ－２２６２４９－１０５７５９－２", "c-1-2-3-4", "c-1-2", "c--1-2", "abc-1-2-3", "c-1-2-3abc"]
AIDS = ["z18-226249-105759", "Z18-226274-105752", "z18-1-1", "z1-2", "z18-226249-105759-1", "ｚ１８－２２６２４９－１０５７５９"]
FILLERS = ["の", "は", "を", "と", "で", "が", "、", "。", "？", "?", "って", "教えて", "見せて", "ください", " ", "　", "\t", "です", "か", "も"]
HISTORY_USER = ["合成町の新規出現は何件？", "中央区と西区の新築は何件？", "c-226249-105759-2の写真を見せて", "試験町の新規出現は何件？", "黒髪六丁目の描き漏れは？",
                "一番大きい新規出現の写真を見せて", "地区ごとに比べて", "全地区の候補は？", "判定保留は何件？", "中央区の候補を一覧で",
                "z18-226274-105752の新築は何件？", "東区と中央区を比べて", "こんにちは", "2024年の新築は？", "二本木四丁目の保留は？"]
HISTORY_ASSISTANT = ["全地区の新規出現候補は 9 件です。", "候補 c-226250-105759-1 の写真を、2018 年と 2023 年で並べます。", "1 件です", "結果は下のカードのとおりです。",
                     "合成町の「新規出現（旧写真に無い）」は 1 件です。機械が写真から見つけた候補で、確定ではありません。", "地図を合わせます: 全地区の候補 9 件を地図で表示。"]
FOLLOWUPS = ["その地区の候補を一覧で", "では試験町は？", "その地図での位置は？", "その写真をもう一度", "では全地区は？", "同じ条件で一覧", "それは何件？", "次は中央区は？",
             "他の地区は？", "さっきの候補の写真", "では保留は？", "その候補の場所は？", "ここの新築は？", "それを比べて", "続きを見せて", "では東区の描き漏れ", "その精度は？"]


def build_cases() -> list[dict]:
    rnd = random.Random(20261125)
    kws = keywords()
    cases: list[tuple[str, tuple, str]] = []

    def add(areas: str, q: str, hist: tuple = ()) -> None:
        cases.append((areas, hist, q))

    # 1) 契約・テストの質問（すべての地区の組で）
    for q in literal_questions():
        for areas in ("real", "synth"):
            add(areas, q)
    # 2) 規則の語（1 語・文の形に入れる・地区名つき）
    for i, kw in enumerate(kws):
        add("real", kw)
        add("synth", f"{kw}は？")
        if i % 3 == 0:
            add("real", f"新築の{kw}")
        if i % 4 == 0:
            add("real", f"黒髪六丁目の{kw}を教えて")
            add("synth", f"中央区の{kw}")
        if i % 7 == 0:
            add("odd", f"大江町の{kw}")
            add("real", kw.upper() + "を見せて")
    # 3) 年
    for y in YEAR_WORDS:
        for tpl in ("{}の新築は？", "{}に建った家は何件？", "{}", "{}と2023年を比べて"):
            add("synth", tpl.format(y))
    # 4) 場所の語
    for p in PLACES:
        for n in NOUNS[:4]:
            for link in LINKS[:3] if (sum(map(ord, p)) + sum(map(ord, n))) % 2 else LINKS[3:]:
                add("synth", f"{p}{link}{n}は？")
        add("real", f"{p}の新築は何件？")
        add("real", f"{p}")
        add("synth", f"{p}全域の建物")
    # 5) ID の前後
    for cid, before, after in itertools.product(CIDS, ID_BEFORE[:8], ID_AFTER[:9]):
        if rnd.random() < 0.25:
            add("synth", f"{before}{cid}{after}写真")
    for aid, before, after in itertools.product(AIDS, ID_BEFORE, ID_AFTER):
        if rnd.random() < 0.15:
            add("synth", f"{before}{aid}{after}新築は何件")
    # 6) 文脈
    for hist_user in HISTORY_USER:
        for fu in FOLLOWUPS:
            add("real", fu, ({"role": "user", "content": hist_user}, {"role": "assistant", "content": rnd.choice(HISTORY_ASSISTANT)}))
    for hist_user in HISTORY_USER[:8]:
        for fu in FOLLOWUPS[:8]:
            add("synth", fu, ({"role": "user", "content": hist_user}, {"role": "assistant", "content": rnd.choice(HISTORY_ASSISTANT)}))
    # 7) 乱数の文（語・地区・ID・年・場所・つなぎの組み合わせ）
    area_words = [a["name"] for a in REAL + SYNTH] + ["中央区", "東区", "西区", "南区", "北区", "全地区", "すべての地区"] + [a["id"] for a in REAL + SYNTH]
    pools = [kws, area_words, CIDS, AIDS, YEAR_WORDS, PLACES, ["新築", "新規", "描き漏れ", "保留", "候補", "建物"], ["何件", "一覧", "比べて", "写真", "地図", "精度", "上位3件", "トップ5", "10件", "使い方"]]
    for n in range(1800):
        parts = []
        for _ in range(rnd.randint(1, 5)):
            pool = rnd.choice(pools)
            parts.append(rnd.choice(pool))
            if rnd.random() < 0.6:
                parts.append(rnd.choice(FILLERS))
        text = "".join(parts)
        if len(text) > 150:
            text = text[:150]
        hist: tuple = ()
        if rnd.random() < 0.35:
            msgs = []
            for _ in range(rnd.randint(1, 3)):
                msgs.append({"role": "user", "content": rnd.choice(HISTORY_USER + FOLLOWUPS)})
                msgs.append({"role": "assistant", "content": rnd.choice(HISTORY_ASSISTANT)})
            hist = tuple(msgs)
        add(rnd.choice(["real", "synth", "synth", "odd"]), text, hist)
    # 8) 見た目の揺れ
    for q in ["", " ", "　", "?", "？", "あ", "A", "ＡＢＣ", "ｱｲｳ", "ﾃﾞｰﾀ", "　新規出現は何件？　", "新規出現は\n何件？", "新規\t出現は何件？", "NEW 新築は？", "HELP", "Help me", "help!", "ヘルプ",
              "ｆ１は？", "F1 は", "IoU は", "iou", "TOP3", "Top 5", "top5件", "ＴＯＰ１０の一覧", "上位１０件", "上位 3 件を一覧で", "３件", "３ 件の一覧", "１２３件の候補", "上位９９９件を一覧で", "上位0件",
              "gee", "ＧＥＥ", "geeの話", "衛星geeの話", "gee衛星", "(gee)", "gee_", "agee", "geek", "衛星", "Earth Engine", "earthengine", "EARTH  ENGINE"]:
        for areas in ("real", "synth"):
            add(areas, q)

    # 重複を除く（同じ入力の組は 1 回）
    seen: set[str] = set()
    out = []
    for areas, hist, q in cases:
        key = json.dumps([areas, list(hist), q], ensure_ascii=False)
        if key in seen:
            continue
        seen.add(key)
        messages = [*hist, {"role": "user", "content": q}]
        plan = mm.MockModel(AREA_SETS[areas]).plan(messages[-20:])
        rec: dict = {"a": areas, "q": q, "p": tokenize(plan)}
        if hist:
            rec["h"] = [[m["role"], m["content"]] for m in hist]
        out.append(rec)
    return out


def tokenize(plan: list[dict]) -> list[dict]:
    out = []
    for call in plan:
        call = json.loads(json.dumps(call, ensure_ascii=False))
        msg = call["args"].get("message")
        if msg in MESSAGE_TOKENS:
            call["args"]["message"] = MESSAGE_TOKENS[msg]
        out.append(call)
    return out


# ---- 文字の整え方・年・漢数字 ----

def build_normalize() -> list[list[str]]:
    rnd = random.Random(7)
    pieces = ["新築", "ＡＢＣ", "abc", "ABC", "ｱｲｳ", "ﾃﾞｰﾀ", "ｶﾞｷﾞ", "１２３", "123", "①②", "㈱", "㌔", "ﬁ", "ǅ", "Ⅳ", "½", "²", "Å", "Ω", "İ", "ß", "ẞ", "Σ", "ΑΣ", "K",
              " ", "　", "\t", "\n", "\r\n", " ", " ", " ", " ", "\x1c", "\x1d", "\x1f", "\x85", "​", "﻿", "᠎", "　",
              "０", "９", "٣", "۴", "𝟑", "－", "ー", "−", "～", "〜", "！", "？", "（", "）", "＼", "。", "、", "c-1-2-3", "ｃ－１－２－３", "令和6年", "Ｒ６年", "ｒ７年", "Ｈ３０年", "٢٠٢٤"]
    out = ["", " ", "　　", "A  B", "  前後の空白  "]
    for _ in range(600):
        s = "".join(rnd.choice(pieces) for _ in range(rnd.randint(1, 7)))
        out.append(s)
    return [[s, mm.normalize(s)] for s in out]


def build_years() -> list[dict]:
    sentences = [mm.normalize(f"{y}の新築は？") for y in YEAR_WORDS]
    sentences += [mm.normalize(f"{a}と{b}を比べた新規出現は何件？") for a, b in itertools.product(YEAR_WORDS[:30], YEAR_WORDS[30:60])][:200]
    sentences += [mm.normalize(s) for s in ["2018年の2023年", "20232023", "2023-2018", "1900年から2100年", "２０２３年２０１８年", "令和5年平成30年", "r5年h30年s60年", "ar5年 br6年 R7年", "R6年R7年", "平成 30 年", "令和 元 年"]]
    out = []
    for s in sentences:
        out.append({"t": s, "years": sorted(mm.mentioned_years(s)), "strip": mm.strip_years(s)})
    return out


def build_kanji() -> list[list]:
    texts = ["", "〇", "零", "二〇二四", "二千二十四", "千九百九十九", "十二", "六", "二十", "百", "千", "二二千", "二a", "abc", "一〇", "十一", "百五", "二百三十四", "九千九百九十九", "二千", "十十", "〇十",
             "一二三四五六七八九〇" * 3, "千千千", "二十三百", "百十", "一百二十三", "五千二百"]
    return [[t, mm.kanji_to_int(t)] for t in texts]


# ---- 数字の検査 ----

def build_guard() -> list[dict]:
    rnd = random.Random(99)
    numbers = ["0", "1", "5", "9", "12", "123", "1,234", "1,2345", "12,34", "1234", "0.58", "0.6", "0.60", "5.0", "12.50", "100", "76", "58", "0.7634", "0.763", "００１", "１２３", "１,２３４", "٣", "٢٠٢٣", "007", "9999", "2018", "2023", "424242", "3.14", ".5", "5.", "1.2.3", "1,000,000"]
    texts = ["年", "件", "棟", "地区", "m²", "%", "％", "割", "倍", "か所", "平方", "パーセント", "枚", "個", "年前", "の写真"]
    kanji = ["三十", "百", "二〇二三", "一", "一覧", "一番", "三", "十二", "千", "万", "二千二十四", "六"]
    contents = []
    for _ in range(700):
        parts = []
        for _ in range(rnd.randint(1, 5)):
            r = rnd.random()
            if r < 0.45:
                parts.append(rnd.choice(numbers) + rnd.choice(["", " ", "　", " ", " "]) + rnd.choice(texts + [""]))
            elif r < 0.6:
                parts.append(rnd.choice(kanji) + rnd.choice(["", " ", " "]) + rnd.choice(texts + ["", "件"]))
            elif r < 0.7:
                parts.append(rnd.choice(["F1", "f1", "z18", "c-226249-105759-2", "z18-226249-105759", "m2", "A4", "B52", "F12", "ab1", "あ1"]) + rnd.choice(["", " "]))
            else:
                parts.append(rnd.choice(["全地区の候補は", "です。", "内訳は、", "、", "合計", "平均", "結果", "新規出現"]))
        contents.append("".join(parts))
    results_pool = [
        [],
        [{"type": "count", "total": 1234, "breakdown": [{"key": "a", "label": "x", "value": 3}, {"key": "b", "label": "y", "value": 0}], "filter": {"area_id": "z18-226249-105759", "scope": "試験町"}, "provenance": {"photo_years": [2018, 2023], "run_id": "synthetic-test", "model": "m"}}],
        [{"type": "accuracy", "metrics": [{"key": "f1", "value": 0.7634}, {"key": "p", "value": 0.58}, {"key": "r", "value": 0.6}, {"key": "n", "value": None}, {"key": "i", "value": 1.0}, {"key": "z", "value": 0.0}, {"key": "tiny", "value": 1e-05}, {"key": "big", "value": 1e16}]}],
        [{"type": "detection_image", "candidate_id": "c-226249-105759-2", "images": [{"year": 2018}, {"year": 2023}], "caption": "面積 約 302 m²"}],
        [{"type": "table", "rows": [{"id": "c-1-2-3", "area_m2": 503.8}, {"id": "c-1-2-4", "area_m2": 75.6}], "total": 9, "shown": 2}, {"type": "x", "ok": True, "no": False, "none": None}],
        [{"type": "refusal", "message": "写真があるのは 2018 年と 2023 年だけです。", "suggestions": []}],
        [{"title": "2,000 件", "value": 2000}, {"v": -5, "w": -0.5, "x": 12.5, "y": 100.0}],
        [{"s": "٣ と ３ と 3", "t": "1,234 と 5.50"}],
        [{"2018": "x", "key9": 9}],
    ]
    out = []
    for c in contents:
        res = rnd.choice(results_pool)
        out.append({"c": c, "r": res, "bad": find_unsupported_numbers(c, res)})
    return out


def main() -> None:
    cases = build_cases()
    golden = {
        "areas": AREA_SETS,
        "tokens": {v: k for k, v in MESSAGE_TOKENS.items()},
        "cases": cases,
        "normalize": build_normalize(),
        "years": build_years(),
        "kanji": build_kanji(),
        "guard": build_guard(),
    }
    payload = (json.dumps(golden, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    with open(OUT, "wb") as f, gzip.GzipFile(filename="", mode="wb", fileobj=f, mtime=0, compresslevel=9) as z:  # 同じ入力なら同じバイト列
        z.write(payload)
    kinds: dict[str, int] = {}
    for c in cases:
        for call in c["p"]:
            key = call["name"] + (":" + call["args"]["reason"] if call["name"] == "refuse" else "")
            kinds[key] = kinds.get(key, 0) + 1
    print(f"書き出しました: {OUT}（{OUT.stat().st_size // 1024} KB。質問 {len(cases)} 件・整え方 {len(golden['normalize'])}・年 {len(golden['years'])}・数字の検査 {len(golden['guard'])}）")
    for k, v in sorted(kinds.items()):
        print(f"  {k}: {v}")


if __name__ == "__main__":
    main()
