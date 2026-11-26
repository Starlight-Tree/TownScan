"""テスト用の合成データ（kind="synthetic"）。pipeline の出力（仕様 §4.1・§4.2）と同じ形で、3 地区・9 候補。

実データではない。area_m2・評価の値はテスト用の作り物。
使い方:
  python tests/synthetic.py --out DIR [--tiles DIR]   # DIR に pipeline の出力（run.json など）、--tiles に写真タイルを書く
テスト（conftest.py）は、tests/fixtures/synthetic_run/ にコミットした写し（このスクリプトの出力）を読む。
test_fixture_in_sync が、写しとこのスクリプトの出力が同じことを確かめる。
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

from PIL import Image

Z = 18
TILE_PX = 256
# 熊本城の近くの z18 タイル番号（実在する場所。ただし中身は合成）
X0, Y0 = 226249, 105759
AREA_DEFS = [
    # (dx, dy, name, ward)
    (0, 0, "合成町", "中央区"),
    (1, 0, "試験町", "中央区"),
    (0, 1, "仮想町", "東区"),
]
# 地区ごとの候補: (左, 上, 右, 下)（タイル内のピクセル）, class, reason, edge_touch
CANDIDATE_DEFS = {
    0: [
        ((100, 100, 140, 130), "confirmed_new", "new_absent_2014", False),
        ((30, 40, 50, 55), "existing_omission", "present_2014", False),
        ((216, 200, 256, 236), "uncertain", "edge", True),
    ],
    1: [
        ((60, 60, 110, 100), "confirmed_new", "new_absent_2014", False),
        ((150, 150, 170, 165), "confirmed_new", "new_absent_2014", False),
        ((0, 10, 24, 30), "uncertain", "edge", True),
    ],
    2: [
        ((90, 90, 120, 115), "existing_omission", "present_2014", False),
        ((10, 200, 30, 220), "existing_omission", "present_2014", False),
        ((140, 30, 160, 45), "confirmed_new", "new_absent_2014", False),
    ],
}
EVIDENCE = {
    "confirmed_new": {"prob_2024_mean": 0.91, "ov_2014": 0.02, "prob_2014_p90": 0.05, "ov_kiban": 0.0},
    "existing_omission": {"prob_2024_mean": 0.88, "ov_2014": 0.83, "prob_2014_p90": 0.77, "ov_kiban": 0.05},
    "uncertain": {"prob_2024_mean": 0.74, "ov_2014": 0.30, "prob_2014_p90": 0.40, "ov_kiban": 0.10},
}


def tile_bbox(x: int, y: int) -> list[float]:
    n = 2**Z

    def lon(px):
        return px / n * 360.0 - 180.0

    def lat(py):
        return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * py / n))))

    return [lon(x), lat(y + 1), lon(x + 1), lat(y)]  # [西, 南, 東, 北]


def px_to_lonlat(x: int, y: int, px: float, py: float) -> tuple[float, float]:
    n = 2**Z
    lon = (x + px / TILE_PX) / n * 360.0 - 180.0
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + py / TILE_PX) / n))))
    return lon, lat


def _metres_per_px(lat: float) -> float:
    return 156543.03392 * math.cos(math.radians(lat)) / 2**Z


def rect_polygon(x: int, y: int, box: tuple[int, int, int, int]) -> dict:
    l, t, r, b = box
    ring = [px_to_lonlat(x, y, px, py) for px, py in ((l, t), (r, t), (r, b), (l, b), (l, t))]
    return {"type": "Polygon", "coordinates": [[[round(lon, 7), round(lat, 7)] for lon, lat in ring]]}


def areas() -> list[dict]:
    out = []
    for dx, dy, name, ward in AREA_DEFS:
        x, y = X0 + dx, Y0 + dy
        bbox = tile_bbox(x, y)
        out.append({
            "id": f"z{Z}-{x}-{y}", "z": Z, "x": x, "y": y, "bbox": bbox,
            "centroid": [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2],
            "name": name, "ward": ward, "municipality": "43101" if ward == "中央区" else "43102",
            "name_source": "synthetic",
        })
    return out


def _area_m2(lat: float, box: tuple[int, int, int, int]) -> float:
    l, t, r, b = box
    return round((r - l) * (b - t) * _metres_per_px(lat) ** 2, 1)


def candidates_geojson() -> dict:
    features = []
    for i, a in enumerate(areas()):
        lat = a["centroid"][1]
        rows = sorted(CANDIDATE_DEFS[i], key=lambda d: -_area_m2(lat, d[0]))  # 面積の大きい順に連番
        for n, (box, cls, reason, edge) in enumerate(rows, start=1):
            poly = rect_polygon(a["x"], a["y"], box)
            lons = [p[0] for p in poly["coordinates"][0]]
            lats = [p[1] for p in poly["coordinates"][0]]
            features.append({
                "type": "Feature",
                "id": f"c-{a['x']}-{a['y']}-{n}",
                "geometry": poly,
                "properties": {
                    "area_id": a["id"], "class": cls, "area_m2": _area_m2(lat, box),
                    "bbox": [min(lons), min(lats), max(lons), max(lats)],
                    "centroid": [sum(lons[:4]) / 4, sum(lats[:4]) / 4],
                    "evidence": {**EVIDENCE[cls], "edge_touch": edge},
                    "reason": reason,
                },
            })
    return {"type": "FeatureCollection", "features": features}


def buildings_geojson(year: int) -> dict:
    boxes = [(20, 20, 45, 40), (150, 60, 175, 85), (60, 180, 90, 205)]
    if year == 2024:
        boxes += [(100, 100, 140, 130), (200, 20, 220, 40)]
    features = []
    for a in areas():
        lat = a["centroid"][1]
        for box in boxes:
            features.append({
                "type": "Feature",
                "geometry": rect_polygon(a["x"], a["y"], box),
                "properties": {"area_id": a["id"], "area_m2": _area_m2(lat, box), "prob_mean": 0.9},
            })
    return {"type": "FeatureCollection", "features": features}


def run_json() -> dict:
    return {
        "run_id": "synthetic-test",
        "kind": "synthetic",
        "created": "2026-11-24T12:00:00+09:00",
        "model": "synthetic-fixture（モデルなし。合成データ）",
        "params": {"ov_kiban_max": 0.25, "min_area_m2": 20, "chosen": {"scale": 1.5, "threshold": 0.5}},
        "tiles": [a["id"] for a in areas()],
        "notes": ["合成データ（テスト用）。実データではない"],
    }


def eval_json() -> dict:
    a = [x["id"] for x in areas()]
    return {
        "reference": "合成データ（基盤地図情報ではない）",
        "split": {"tune": [a[0]], "holdout": [a[1], a[2]]},
        "sweep": [{"scale": 1.0, "threshold": 0.5, "tune_object_f1": 0.5}, {"scale": 1.5, "threshold": 0.5, "tune_object_f1": 0.6}],
        "chosen": {"scale": 1.5, "threshold": 0.5},
        "holdout": {
            "pixel": {"iou": 0.61, "precision": 0.78, "recall": 0.74, "f1": 0.76},
            "object": {"f1": 0.58, "precision": 0.62, "recall": 0.55},
        },
        "tune": {
            "pixel": {"iou": 0.66, "precision": 0.8, "recall": 0.79, "f1": 0.79},
            "object": {"f1": 0.6, "precision": 0.64, "recall": 0.57},
        },
        "per_area": [{"area_id": i, "object_f1": 0.5} for i in a],
        "excluded_edge_objects": 4,
        "new_building_recall": None,
        "notes": ["合成データ（テスト用）の値で、実測ではない"],
    }


def write_run(out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    files = {
        "run.json": run_json(),
        "areas.json": areas(),
        "buildings_2014.geojson": buildings_geojson(2014),
        "buildings_2024.geojson": buildings_geojson(2024),
        "candidates.geojson": candidates_geojson(),
        "eval.json": eval_json(),
    }
    for name, body in files.items():
        (out_dir / name).write_text(json.dumps(body, ensure_ascii=False, indent=1, sort_keys=True) + "\n", encoding="utf-8")


def write_tiles(tiles_dir: Path) -> None:
    """R=列, G=行（タイル内の位置が画素から分かる）, B=年（2014→50、2024→200）の傾斜画像。"""
    for year, blue in ((2014, 50), (2024, 200)):
        d = tiles_dir / str(year)
        d.mkdir(parents=True, exist_ok=True)
        for a in areas():
            img = Image.new("RGB", (TILE_PX, TILE_PX))
            img.putdata([(i, j, blue) for j in range(TILE_PX) for i in range(TILE_PX)])
            img.save(d / f"{a['x']}_{a['y']}.png")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="合成データ（テスト用）を書き出す")
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--tiles", type=Path)
    ns = ap.parse_args()
    write_run(ns.out)
    if ns.tiles:
        write_tiles(ns.tiles)
    print(f"書き出しました: {ns.out}" + (f"、{ns.tiles}" if ns.tiles else ""))
