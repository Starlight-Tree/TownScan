#!/usr/bin/env python3
"""検出画像の差分検査（image.sh）に使うデータを DIR に書く。Pillow が要る（townscan-backend-test のイメージで流す）。

  DIR/run/    pipeline の出力の形。合成データ（backend/tests/synthetic.py の write_run）の 9 候補に、不規則な形の候補を足したもの
              （回した長方形・L 字・24 角形（円）・小さな三角形・タイルの左の縁に接する大きな長方形 を、3 地区それぞれに 5 つ。計 24 候補）
  DIR/tiles/  写真タイル（256x256 RGB の PNG）。傾斜だけの合成の写真（契約の検査用）と違い、補間の違いが画素に出るように、
              質感がある: なめらかな色のむら・屋根・道・細かい粒（種を固定。2018 年と 2023 年は、同じ場所で、建物が少し増えて明るさが違う）

使い方: python3 -I image_data.py --synthetic backend/tests/synthetic.py --out DIR
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import math
import random
from pathlib import Path

from PIL import Image, ImageDraw

TILE_PX = 256


def load_synthetic(path: Path):
    spec = importlib.util.spec_from_file_location("synthetic", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ---- 追加の候補（タイルの中の画素の座標で定義する） ----

def rotated_rect(cx: float, cy: float, w: float, h: float, deg: float) -> list[tuple[float, float]]:
    a = math.radians(deg)
    out = []
    for dx, dy in ((-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2)):
        out.append((cx + dx * math.cos(a) - dy * math.sin(a), cy + dx * math.sin(a) + dy * math.cos(a)))
    return out


def regular_polygon(cx: float, cy: float, r: float, n: int) -> list[tuple[float, float]]:
    return [(cx + r * math.cos(2 * math.pi * k / n), cy + r * math.sin(2 * math.pi * k / n)) for k in range(n)]


EXTRA_SHAPES = {
    "rotated": lambda: rotated_rect(80, 70, 56, 22, 30),
    "L": lambda: [(150, 150), (190, 150), (190, 168), (170, 168), (170, 196), (150, 196)],
    "circle": lambda: regular_polygon(60, 190, 18, 24),
    "triangle": lambda: [(200, 40), (207, 40), (203.5, 46)],
    "edge": lambda: [(0, 100), (70, 100), (70, 150), (0, 150)],
}
CLASS_CYCLE = ["confirmed_new", "existing_omission", "uncertain"]
REASON_OF = {"confirmed_new": "new_absent_2018", "existing_omission": "present_2018", "uncertain": "edge"}


def extra_features(syn, base_count: dict[str, int]) -> list[dict]:
    feats = []
    for ai, area in enumerate(syn.areas()):
        x, y = area["x"], area["y"]
        n = base_count[area["id"]]
        for si, (name, shape) in enumerate(EXTRA_SHAPES.items()):
            n += 1
            pts = shape()
            lonlat = [syn.px_to_lonlat(x, y, px, py) for px, py in pts]
            ring = [[round(lon, 7), round(lat, 7)] for lon, lat in lonlat]
            ring.append(ring[0])
            lons, lats = [p[0] for p in ring], [p[1] for p in ring]
            cls = CLASS_CYCLE[(ai + si) % 3]
            # 面積は、頂点の画素から（靴ひも公式）
            twice = sum(pts[i][0] * pts[(i + 1) % len(pts)][1] - pts[(i + 1) % len(pts)][0] * pts[i][1] for i in range(len(pts)))
            area_m2 = round(abs(twice) / 2 * syn._metres_per_px(area["centroid"][1]) ** 2, 1)
            feats.append({
                "type": "Feature",
                "id": f"c-{x}-{y}-{n}",
                "geometry": {"type": "Polygon", "coordinates": [ring]},
                "properties": {
                    "area_id": area["id"], "class": cls, "area_m2": area_m2,
                    "bbox": [min(lons), min(lats), max(lons), max(lats)],
                    "centroid": [sum(lons[:-1]) / (len(lons) - 1), sum(lats[:-1]) / (len(lats) - 1)],
                    "evidence": {**syn.EVIDENCE[cls], "edge_touch": name == "edge"},
                    "reason": REASON_OF[cls],
                },
            })
    return feats


# ---- 質感のある写真 ----

def soft_field(rng: random.Random, grid: int, amp: float) -> Image.Image:
    """grid x grid の乱数の色を、なめらかに TILE_PX に広げる（色のむら）。"""
    small = Image.new("RGB", (grid, grid))
    small.putdata([tuple(int(128 + rng.uniform(-amp, amp)) for _ in range(3)) for _ in range(grid * grid)])
    return small.resize((TILE_PX, TILE_PX), Image.Resampling.BICUBIC)


def make_tile(seed: int, year: int) -> Image.Image:
    rng = random.Random(seed)  # 2018 と 2023 で同じ（地面・既存の建物・道は共通）
    base = Image.blend(soft_field(rng, 6, 60), soft_field(rng, 20, 40), 0.4)
    # 地面の色を、緑・茶に寄せる
    r, g, b = base.split()
    base = Image.merge("RGB", (r.point(lambda v: 60 + v * 0.45), g.point(lambda v: 80 + v * 0.5), b.point(lambda v: 40 + v * 0.35)))
    d = ImageDraw.Draw(base)
    for _ in range(3):  # 道
        a, c = (rng.uniform(-20, 276), rng.uniform(-20, 276)), (rng.uniform(-20, 276), rng.uniform(-20, 276))
        d.line([a, c], fill=(150, 148, 142), width=rng.randint(4, 9))
    for _ in range(26):  # 既存の建物（屋根の色・濃い縁）
        w, h = rng.uniform(8, 34), rng.uniform(8, 30)
        cx, cy, ang = rng.uniform(10, 246), rng.uniform(10, 246), rng.uniform(0, 90)
        roof = rng.choice([(176, 90, 70), (120, 124, 132), (200, 196, 188), (90, 100, 112), (160, 120, 90)])
        poly = rotated_rect(cx, cy, w, h, ang)
        d.polygon(poly, fill=roof, outline=tuple(int(c * 0.55) for c in roof))
    if year == 2023:  # 新しい建物と、全体の明るさの違い
        for _ in range(6):
            cx, cy = rng.uniform(20, 236), rng.uniform(20, 236)
            d.polygon(rotated_rect(cx, cy, rng.uniform(10, 26), rng.uniform(10, 22), rng.uniform(0, 90)), fill=(214, 210, 204), outline=(120, 118, 114))
        base = base.point(lambda v: min(255, int(v * 1.08 + 6)))
    # 細かい粒（航空写真の粒状感）
    grain = Image.effect_noise((TILE_PX, TILE_PX), 18).convert("RGB")
    return Image.blend(base, grain, 0.12)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--synthetic", required=True, type=Path, help="合成データの生成スクリプト（backend/tests/synthetic.py）")
    ap.add_argument("--out", required=True, type=Path, help="書き出す先（空のディレクトリ）")
    ns = ap.parse_args()

    syn = load_synthetic(ns.synthetic)
    run_dir = ns.out / "run"
    syn.write_run(run_dir)
    path = run_dir / "candidates.geojson"
    body = json.loads(path.read_text(encoding="utf-8"))
    base_count: dict[str, int] = {}
    for f in body["features"]:
        aid = f["properties"]["area_id"]
        base_count[aid] = base_count.get(aid, 0) + 1
    extra = extra_features(syn, base_count)
    body["features"].extend(extra)
    path.write_text(json.dumps(body, ensure_ascii=False, indent=1, sort_keys=True) + "\n", encoding="utf-8")

    for year in (2018, 2023):
        d = ns.out / "tiles" / str(year)
        d.mkdir(parents=True, exist_ok=True)
        for i, area in enumerate(syn.areas()):
            make_tile(1000 + i, year).save(d / f"{area['x']}_{area['y']}.png")
    print(f"書き出しました: {ns.out}（候補 {len(body['features'])} 件・写真 6 枚）")


if __name__ == "__main__":
    main()
