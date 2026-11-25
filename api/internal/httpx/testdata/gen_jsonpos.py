#!/usr/bin/env python3
"""壊れた JSON の「誤りの位置」の期待値を、Python（json.loads）から作る。

FastAPI は、JSON として読めない本文を、422 の loc に ["body", JSONDecodeError.pos] として返す（pos は文字数）。
Go の単体テスト（jsonpos_test.go）が、この出力（jsonpos.json.gz）と、同じ本文での Go の位置を比べる。
入力は、手で選んだ壊れ方と、正しい JSON を壊した文（固定の種の乱数。1 文字の削除・挿入・置き換え・入れ替え・途中で切る）と、
入れ子の深さの境目（DEEP。jsonpos.go の maxPyJSONDepth = 9990 の前後。Python 3.13 の C 版は、素の json.loads なら 9997 段まで位置を返す）。

作り直し（この testdata を書き込み可で重ねる。ネットワークは要らない。Python は 3.13 の townscan-backend-test イメージ。
townscan-api のタグは Go の API のイメージに替わったので、使わない）:

    docker run --rm --name <名前> --network none --user "$(id -u):$(id -g)" -e PYTHONDONTWRITEBYTECODE=1 \\
      -v "$PWD/api/internal/httpx/testdata:/out" townscan-backend-test python -I /out/gen_jsonpos.py

標準ライブラリだけ。出力の各行: {"raw": 本文, "pos": 誤りの位置 | null（Python が受け入れる）, "msg": Python の誤りの種類}。
"""

import gzip
import json
import random
from pathlib import Path

OUT = Path("/out/jsonpos.json.gz")

HAND = [
    "", " ", "x", "not json", "nul", "nulll", "tru", "fals", "NaN", "Infinity", "-Infinity", "-Inf", "[NaN]", "[Infinity,]", '{"a":-Infinity}',
    "[1,]", '{"a":1,}', "[1 2]", '{"a":1 "b":2}', "[,1]", "[1,,2]", '{,"a":1}', '{"a":1,,"b":2}', "[", "[ ", "{", "{ ", '{"a"', '{"a" ', '{"a":', '{"a": ',
    '{"a":1', '{"a":1 ', '{"a" 1}', '{a:1}', "{'a':1}", '{"a":}', '{"a":1}x', '{"a":1} {', "[1]]", "]", "}", ",", ":", '"', '"abc', '"abc\\', '"ab\\"',
    '"\\x"', '"a\\x"', '"\\u12"', '"\\u12"x', '"\\u12', '"\\u123', '"\\u1234', '"\\u1234"', '"\\uzzzz"', '"\\u12zz"', '"\\ud83d"', '"\\ud83d\\ude00"', '"\\ud83d\\uzzzz"',
    '"\\ud83d\\u12"', '"\\ud83d\\ude0"', '"\\ud83d\\ude00', '"\\ud83dabcdefg"', '"\\ude00"', "\"\n\"", '"\t"', '"\x00"', '"\x1f"', '"\x7f"', '"\\/"', '"\\b\\f\\n\\r\\t"',
    "-", "-x", "--1", "+1", "01", "00", "-01", "1.", "1.e5", ".5", "1.5.5", "1e", "1e+", "1e-", "1e5", "1E+5", "1e5.5", "0e", "0.0e0", "-0", "-0.0", "1_000", "0x10",
    "tru e", "True", "False", "None", "null1", "true false", "[true,fals]", "[nul]", "[1,2,3", "[1,2,3,", "[[[[", "[[[[]]]", '{"a":{"b":{"c":',
    '{"a":[1,2,{"b":', '{"a":[1,2,{"b":}]}', '{"a":"b"', '{"a":"b', '{"a":"b\\q"}', '[ "a" "b" ]', '[ "a" , ]', '{ "a" : 1 , }', "\u00a0[]", "\u3000{}",
    "[1]\n\n x", "[1] \t\r\n ", "  [1,\n  2,\n  ]", '{"messages":[{"role":"user","content":"候補は？"}],}', '{"messages":[{"role":"user","content":"あ\\q"}]}',
    '{"messages":[{"role":"user","content":"😀"} {"role":"user"}]}', '😀', '"😀', '["😀" x]', '{"😀":1 x}', "[1,\u2028]", "[\u0085]",
]

BASES = [
    '{"messages":[{"role":"user","content":"候補は何件ですか"}]}',
    '{"messages": [ {"role": "user", "content": "新規出現は？"},\n  {"role": "assistant", "content": "3件です"} ]}',
    '[1, 2.5e3, -0, "a\\u3042\\n", true, false, null, {"k": []}, [[], {}]]',
    '{"a": "\\ud83d\\ude00 \\u00e9 \\/ \\\\ \\"", "b": [1.5E-3, -12, 0], "c": {"d": null}}',
    '"日本語の文字列😀"',
    '[{"x":1},{"y":[true,false]}]',
]

ALPHABET = list('"\\u{}[],: \t\n\r01-.eE+ntfa/x') + ["あ", "😀", "é", "\x00", "\x1f", "\u00a0", "\u2028", "true", "null", "ud83d", "\\ude00", "9"]


def mutate(rnd: random.Random, s: str) -> str:
    kind = rnd.randrange(6)
    i = rnd.randrange(len(s) + 1)
    if kind == 0 and s:
        i = min(i, len(s) - 1)
        return s[:i] + s[i + 1:]
    if kind == 1:
        return s[:i] + rnd.choice(ALPHABET) + s[i:]
    if kind == 2 and s:
        i = min(i, len(s) - 1)
        return s[:i] + rnd.choice(ALPHABET) + s[i + 1:]
    if kind == 3 and len(s) > 1:
        i = min(i, len(s) - 2)
        return s[:i] + s[i + 1] + s[i] + s[i + 2:]
    if kind == 4:
        return s[:i]
    return s[:i] + rnd.choice(ALPHABET) + rnd.choice(ALPHABET) + s[i:]


DEEP_MAX = 9990  # api/internal/httpx/jsonpos.go の maxPyJSONDepth。jsonpos_test.go が、この値の本文の位置を、ここの期待値と比べる


def deep_cases() -> list[str]:
    """入れ子の深さの境目の本文。どれも Python が JSONDecodeError にする（RecursionError にならない深さまで）。"""
    out: list[str] = []
    for n in (100, 970, 971, 1000, 1001, 5000, DEEP_MAX - 1, DEEP_MAX):
        out += [
            "[" * n,  # 閉じない配列: 末尾で Expecting value
            '{"a":' * n,  # 閉じないオブジェクト
            "[" * n + "x",
            "[" * n + ",]",
            "[" * n + "]" * n + "x",  # 閉じた入れ子のあとの余分な文字
            '{"a":' * n + "1" + "}" * n + "x",
            "[" * n + "1" + "]" * (n - 1),  # 閉じ方が 1 つ足りない
            '{"a":[' * (n // 2),  # 配列とオブジェクトの入れ子
            # 次の 4 つは、Go の encoding/json の位置が Python と違う誤り（数字・文字列・リテラルの途中で切れる）。位置を探す読み取りが深さで諦めたかが、位置に出る
            "[" * n + "1.",
            "[" * n + '"abc',
            "[" * n + "nul",
            '{"a":' * n + '"abc',
        ]
    return out


def probe(raw: str) -> dict:
    try:
        json.loads(raw)
    except json.JSONDecodeError as e:
        return {"raw": raw, "pos": e.pos, "msg": e.msg}
    return {"raw": raw, "pos": None, "msg": "ok"}


def main() -> None:
    rnd = random.Random(20261125)
    raws = list(HAND)
    for base in BASES:
        raws.append(base)
        for _ in range(400):
            s = base
            for _ in range(rnd.choice((1, 1, 1, 2, 3))):
                s = mutate(rnd, s)
            raws.append(s)
    raws += deep_cases()  # 乱数を使わない。末尾に足すので、上の本文の並びは変わらない
    seen: set[str] = set()
    rows = []
    for raw in raws:
        if raw in seen:
            continue
        seen.add(raw)
        try:
            raw.encode("utf-8")
        except UnicodeEncodeError:  # 対の無いサロゲート（UTF-8 に書けない本文は、HTTP では送れない）
            continue
        rows.append(probe(raw))
    lines = ",\n".join(json.dumps(r, ensure_ascii=True) for r in rows)
    with gzip.GzipFile(OUT, "wb", mtime=0) as f:  # mtime=0: 作り直しても、同じバイト列
        f.write(("[\n" + lines + "\n]\n").encode("utf-8"))
    errs = sum(1 for r in rows if r["pos"] is not None)
    print(f"{len(rows)} 件（Python が誤りにする: {errs}・受け入れる: {len(rows) - errs}）")


main()
