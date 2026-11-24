"""新築候補の見本を、地理院の航空写真（旧: 年度別写真、新: 最新写真）で並べて、目視の検証用の画像を作る。
読み取りだけ（地理院タイルの取得。見本 1 件あたり最大でタイル数枚。間隔を空ける）。写真は data/ にだけ置く（再配布しない）。

使い方（開発コンテナで。Pillow が要る）:
  python validate_samples.py <candidates.json> <出力フォルダ> [小さい建物の件数=12] [大きい建物の件数=12] [seed=42]
出典: 国土地理院（地理院タイル）。出力画像は、公開するときに出典の記載が要る。
"""
import io
import json
import math
import os
import random
import sys
import time
import urllib.error
import urllib.request

from PIL import Image, ImageDraw

BASE = "https://cyberjapandata.gsi.go.jp/xyz/"
UA = "research-spike/0.1"
Z = 18
OLD_YEARS = [2018, 2019, 2017, 2020, 2016, 2021]  # 旧データ（2018-12 作成）に近い年から
LAT_M_PER_PX = None


def lonlat_to_px(lat, lon, z=Z):
    n = 2 ** z * 256
    x = (lon + 180) / 360 * n
    y = (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n
    return x, y


def fetch(cache, layer, ext, z, tx, ty):
    path = os.path.join(cache, layer, str(z), str(tx), f"{ty}.{ext}")
    if os.path.exists(path):
        size = os.path.getsize(path)
        return Image.open(path).convert("RGB") if size else None  # 0 バイト = 404 の記録
    os.makedirs(os.path.dirname(path), exist_ok=True)
    req = urllib.request.Request(f"{BASE}{layer}/{z}/{tx}/{ty}.{ext}", headers={"User-Agent": UA})
    time.sleep(0.25)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            data = r.read()
    except urllib.error.HTTPError as e:
        if e.code == 404:
            open(path, "wb").close()
            return None
        raise
    with open(path, "wb") as f:
        f.write(data)
    return Image.open(io.BytesIO(data)).convert("RGB")


def mosaic(cache, layer, ext, cx, cy, half):
    """中心 (cx, cy)（z18 の全体ピクセル）の ±half の窓を返す。タイルが 1 枚でも無ければ None。"""
    x0, y0 = int(cx - half), int(cy - half)
    x1, y1 = int(cx + half), int(cy + half)
    tiles = {}
    for ty in range(y0 // 256, y1 // 256 + 1):
        for tx in range(x0 // 256, x1 // 256 + 1):
            im = fetch(cache, layer, ext, Z, tx, ty)
            if im is None:
                return None
            tiles[(tx, ty)] = im
    w = (x1 // 256 - x0 // 256 + 1) * 256
    h = (y1 // 256 - y0 // 256 + 1) * 256
    canvas = Image.new("RGB", (w, h))
    for (tx, ty), im in tiles.items():
        canvas.paste(im, ((tx - x0 // 256) * 256, (ty - y0 // 256) * 256))
    ox, oy = x0 - (x0 // 256) * 256, y0 - (y0 // 256) * 256
    return canvas.crop((ox, oy, ox + (x1 - x0), oy + (y1 - y0))), (x0, y0)


def panel(cache, layer_options, cand, panel_px=280):
    lat, lon, area = cand["lat"], cand["lon"], cand["area_m2"]
    cx, cy = lonlat_to_px(lat, lon)
    m_per_px = 156543.03392 * math.cos(math.radians(lat)) / 2 ** Z
    half = max(48, min(128, int(math.sqrt(area) / m_per_px * 1.3 + 40)))
    for label, layer, ext in layer_options:
        r = mosaic(cache, layer, ext, cx, cy, half)
        if r is None:
            continue
        im, (x0, y0) = r
        scale = panel_px / im.width
        im = im.resize((panel_px, int(im.height * scale)), Image.BICUBIC)
        d = ImageDraw.Draw(im)
        ring = [((lonlat_to_px(la, lo)[0] - x0) * scale, (lonlat_to_px(la, lo)[1] - y0) * scale) for la, lo in cand["ring"]]
        d.line(ring, fill=(255, 0, 0), width=2)
        return label, im
    return None, Image.new("RGB", (panel_px, panel_px), (200, 200, 200))


def main():
    cand_path, out, n_small, n_large, seed = sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 12, int(sys.argv[4]) if len(sys.argv) > 4 else 12, int(sys.argv[5]) if len(sys.argv) > 5 else 42
    cands = json.load(open(cand_path, encoding="utf-8"))
    rng = random.Random(seed)
    small = [c for c in cands if 30 <= c["area_m2"] < 100]
    large = [c for c in cands if c["area_m2"] >= 100]
    sample = rng.sample(small, min(n_small, len(small))) + rng.sample(large, min(n_large, len(large)))
    os.makedirs(out, exist_ok=True)
    cache = os.path.join(out, "tiles")
    old_opts = [(f"old {y}", f"nendophoto{y}", "png") for y in OLD_YEARS]
    new_opts = [("new latest", "seamlessphoto", "jpg")]
    cells, meta = [], []
    for i, c in enumerate(sample, 1):
        lo, po = panel(cache, old_opts, c)
        ln, pn = panel(cache, new_opts, c)
        cap = f"#{i:02d} {c['area_m2']:.0f}m2 {lo or 'old: none'} | {ln or 'new: none'}"
        cell = Image.new("RGB", (2 * 280 + 8, 280 + 20), (255, 255, 255))
        cell.paste(po, (0, 20)); cell.paste(pn, (288, 20))
        ImageDraw.Draw(cell).text((2, 4), cap, fill=(0, 0, 0))
        cells.append(cell)
        meta.append({"n": i, "gid": c["gid"], "area_m2": c["area_m2"], "type": c["type"], "lat": c["lat"], "lon": c["lon"], "old": lo, "new": ln})
        print(cap, flush=True)
    per = 6
    for s in range(0, len(cells), per):
        group = cells[s:s + per]
        sheet = Image.new("RGB", (2 * (568 + 10), 3 * (300 + 6)), (255, 255, 255))
        for k, cell in enumerate(group):
            sheet.paste(cell, ((k % 2) * (568 + 10), (k // 2) * (300 + 6)))
        sheet.save(os.path.join(out, f"sheet_{s // per + 1}.png"))
    json.dump(meta, open(os.path.join(out, "samples.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("sheets:", math.ceil(len(cells) / per), "samples:", len(cells))


if __name__ == "__main__":
    main()
