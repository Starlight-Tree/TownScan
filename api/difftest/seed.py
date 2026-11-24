#!/usr/bin/env python3
"""差分検査（diff.py）用の、追加のデータを SQL で書き出す（標準ライブラリだけ。DB には触れない）。

使い方: python3 -I seed.py PHASE | psql …   （PHASE: rich・bare・tie・weird。run.sh が呼ぶ）
合成データ（backend/tests/synthetic.py）は、Python のローダー（python -m app.load）が入れる。ここで足すのは、それでは出ない形:
  rich   620 件の候補・30 地区。面積の同値（id の順で並ぶ）・整数の値の浮動小数点・1e-05 のような小さい値・名前が NULL／空の地区・
         未知の reason・日本語・引用符・改行を含む文字列・jsonb の中のいろいろな数（0.00001・5.0 など）
  bare   run だけがあって、地区・候補・評価が無い（最新の run）
  tie    bare と同じ created_at で、run_id が大きい run（最新の選び方）。metrics に provenance のキーがある
  weird  面積が NaN の候補・配列の metrics（Python も Go も、500 のはず）
どれも、前の段階より新しい created_at を持つ run を足す（「現在の run」は、最新の created_at の run）。
"""

from __future__ import annotations

import json
import random
import sys


def q(v) -> str:
    """SQL のリテラル。"""
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


def jb(v) -> str:
    return q(json.dumps(v, ensure_ascii=False)) + "::jsonb"


def insert(table: str, cols: list[str], rows: list[list], jsonb_cols: frozenset[str] = frozenset()) -> str:
    vals = []
    for r in rows:
        vals.append("(" + ", ".join(jb(v) if c in jsonb_cols else q(v) for c, v in zip(cols, r)) + ")")
    return f"INSERT INTO {table} ({', '.join(cols)}) VALUES\n" + ",\n".join(vals) + ";\n"


RUN_COLS = ["run_id", "kind", "created_at", "model"]
AREA_COLS = ["run_id", "id", "z", "x", "y", "west", "south", "east", "north", "centroid_lon", "centroid_lat", "name", "ward", "municipality"]
CAND_COLS = ["id", "run_id", "area_id", "class", "area_m2", "west", "south", "east", "north", "centroid_lon", "centroid_lat", "geom", "evidence", "reason"]


def rich() -> str:
    rnd = random.Random(424242)
    run = "rich-run"
    out = [insert("runs", RUN_COLS, [[run, "real", "2026-11-25 09:30:15.123456+09", 'rich-model（日本語 "quote" \\ backslash \' apostrophe）']])]
    names = ["熊本城", "上通り", "下通り", "水前寺", '"引用"町', "<tag>&amp;", "絵文字😀町", "白川", "安政町", "手取", "新町", "古町", "坪井", "九品寺"]
    wards = ["中央区", "東区", "西区", "南区", "北区"]
    area_rows = []
    cells = [(x, y) for x in range(226240, 226250) for y in range(105755, 105758)]
    for i, (x, y) in enumerate(cells):
        w = 130.5 + rnd.random() * 0.3
        s = 32.7 + rnd.random() * 0.1
        area_rows.append([
            run, f"z18-{x}-{y}", 18, x, y, w, s, w + 0.00137329, s + 0.00115203, w + 0.0006866, s + 0.00057602,
            None if i % 7 == 0 else ("" if i % 7 == 1 else names[i % len(names)]),
            None if i % 5 == 0 else ("" if i % 5 == 1 else wards[i % len(wards)]),
            None if i % 4 == 0 else ("" if i % 4 == 1 else "43101"),
        ])
    shuffled = list(area_rows)
    rnd.shuffle(shuffled)  # 挿入の順を、y・x の順にしない
    out.append(insert("areas", AREA_COLS, shuffled))

    area_pool = [100.0, 100.0, 250.5, 250.5, 1e-05, 0.30000000000000004, 123456789.125, 1e16, 7.0, 7.0, 1.0, 0.0001, 99999999999999.9]
    reasons = ["new_absent_2018", "present_2018", "ambiguous", "edge", "small", "weird_reason"]
    cand_rows = []
    for ai, (x, y) in enumerate(cells):
        for n in range(1, 21 + (1 if ai < 20 else 0)):
            cls = ["confirmed_new", "existing_omission", "uncertain"][(ai + n) % 3]
            area = rnd.choice(area_pool) if rnd.random() < 0.3 else round(rnd.uniform(5, 800), rnd.choice([1, 1, 1, 3, 12]))
            w = area_rows[ai][5] + rnd.random() * 0.001
            s = area_rows[ai][6] + rnd.random() * 0.001
            coords = [[w, s], [w + 0.00005, s], [w + 0.00005, s + 0.00004], [w, s + 0.00004], [w, s]]
            if n % 9 == 0:
                coords = [[float(int(a)), float(int(b))] for a, b in coords]  # 5.0 のような、整数の値の小数
            if n % 11 == 0:
                coords[0] = [1e-05, 2.5e-05]  # 指数の書き方になる小さい値
            evidence = {
                "prob_2023_mean": rnd.random(), "ov_2018": rnd.choice([0.0, 1.0, 3e-05, rnd.random()]),
                "prob_2018_p90": round(rnd.random(), 4), "ov_kiban": rnd.choice([0.0, 0.05, 1e-06]), "edge_touch": rnd.random() < 0.2,
            }
            if n % 7 == 0:
                evidence["note"] = '日本語 "quote" \\ back\nline\ttab   \u007f 😀'
                evidence["nested"] = {"list": [1, 2.5, None, True, {"k": "v"}], "empty": [], "obj": {}}
            cand_rows.append([
                f"c-{x}-{y}-{n}", run, f"z18-{x}-{y}", cls, area, w, s, w + 0.00005, s + 0.00004, w + 0.000025, s + 0.00002,
                {"type": "Polygon", "coordinates": [coords]}, evidence, reasons[(ai * 3 + n) % len(reasons)],
            ])
    rnd.shuffle(cand_rows)
    out.append(insert("candidates", CAND_COLS, cand_rows, frozenset({"geom", "evidence"})))

    out.append(insert("buildings", ["run_id", "area_id", "year", "area_m2", "prob_mean", "geom"],
                      [[run, f"z18-{x}-{y}", 2018 + 5 * (k % 2), 30.5 + k, None if k % 3 == 0 else 0.9, {"type": "Polygon", "coordinates": []}]
                       for k, (x, y) in enumerate(cells)], frozenset({"geom"})))
    metrics = {
        "reference": "基盤地図情報（2018-10 版）",
        "split": {"tune": ["z18-226240-105755"], "holdout": ["z18-226241-105755", "z18-226242-105755"]},
        "sweep": [{"scale": 1.0, "threshold": 0.5, "tune_object_f1": 0.5}, {"scale": 1.5, "threshold": 0.5, "tune_object_f1": 0.6}],
        "chosen": {"scale": 1.5, "threshold": 0.5},
        "holdout": {"pixel": {"iou": 0.61, "precision": 0.78, "recall": 0.74, "f1": 0.76}, "object": {"f1": 0.58, "precision": 0.62, "recall": 0.55}},
        "tune": {"pixel": {"iou": 0.66, "f1": 0.79}, "object": {"f1": 1e-05, "precision": 0.0, "recall": 1.0}},
        "per_area": [{"area_id": f"z18-{x}-{y}", "object_f1": round(rnd.random(), 3)} for x, y in cells[:5]],
        "excluded_edge_objects": 4, "new_building_recall": None, "tiny": 3.2e-07, "big": 12345678901234567890, "exp": 1.5e+20,
        "notes": ['日本語 "quote"', "line1\nline2", "😀"], "ok": True,
    }
    out.append(insert("metrics", ["run_id", "body"], [[run, metrics]], frozenset({"body"})))
    return "\n".join(out)


def bare() -> str:
    return insert("runs", RUN_COLS, [["z-bare", "real", "2026-11-26 00:00:00+00", None]])


def tie() -> str:
    # bare と同じ created_at。run_id が大きい方（z-tie）が、現在の run になる
    out = [insert("runs", RUN_COLS, [["z-tie", "synthetic", "2026-11-26 00:00:00+00", None]])]
    out.append(insert("areas", AREA_COLS, [["z-tie", "z18-1-1", 18, 1, 1, 130.5, 32.5, 130.75, 32.75, 130.625, 32.625, None, None, None]]))
    out.append(insert("candidates", CAND_COLS, [["c-1-1-1", "z-tie", "z18-1-1", "uncertain", 100, 1, 2, 3, 4, 2, 3,
                                                  {"type": "Polygon", "coordinates": [[[1.5, 2.0]]]}, {}, "small"]], frozenset({"geom", "evidence"})))
    body = {"a": 1, "provenance": "old", "日本語のキー": [1.0, 2], "z": {"provenance": "inner"}}
    out.append(insert("metrics", ["run_id", "body"], [["z-tie", body]], frozenset({"body"})))
    return "\n".join(out)


def weird() -> str:
    out = [insert("runs", RUN_COLS, [["zz-weird", "real", "2026-11-27 00:00:00+00", "m"]])]
    out.append(insert("areas", AREA_COLS, [["zz-weird", "z18-2-2", 18, 2, 2, 130.5, 32.5, 130.75, 32.75, 130.625, 32.625, "名前", "区", "43101"]]))
    out.append("INSERT INTO candidates (id, run_id, area_id, class, area_m2, west, south, east, north, centroid_lon, centroid_lat, geom, evidence, reason)"
               " VALUES ('c-2-2-1', 'zz-weird', 'z18-2-2', 'uncertain', 'NaN'::float8, 1, 2, 3, 4, 2, 3, '{}'::jsonb, '{}'::jsonb, 'small');\n")
    out.append("INSERT INTO metrics (run_id, body) VALUES ('zz-weird', '[1, 2]'::jsonb);\n")
    return "\n".join(out)


PHASES = {"rich": rich, "bare": bare, "tie": tie, "weird": weird}

if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in PHASES:
        sys.exit(f"使い方: seed.py {{{'|'.join(PHASES)}}}")
    sys.stdout.write(PHASES[sys.argv[1]]())
