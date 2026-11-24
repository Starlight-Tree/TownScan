"""新規出現の候補の見本を、複数時点の地理院の年度別写真で並べて、目視の検証用の画像を作る。
読み取りだけ（地理院タイルの取得。間隔を空ける）。写真は data/ にだけ置く（再配布しない）。

使い方（開発コンテナで。Pillow が要る）:
  python validate_multi.py <candidates.json> <出力フォルダ> <小さい件数> <大きい件数> <seed> <年1,年2,...> [タイル絞り込み JSON]
  タイル絞り込み JSON: {"both": [[x, y], ...]}（z15 のタイル。これに含まれる候補だけを使う）
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


def lonlat_to_px(lat, lon, z=Z):
    n = 2 ** z * 256
    x = (lon + 180) / 360 * n
    y = (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n
    return x, y


def fetch_any(cache, layer, z, tx, ty):
    """png、だめなら jpg。404 は 0 バイトのファイルで記録する。"""
    for ext in ("png", "jpg"):
        path = os.path.join(cache, layer, str(z), str(tx), f"{ty}.{ext}")
        if os.path.exists(path):
            if os.path.getsize(path):
                return Image.open(path).convert("RGB")
            continue
        os.makedirs(os.path.dirname(path), exist_ok=True)
        req = urllib.request.Request(f"{BASE}{layer}/{z}/{tx}/{ty}.{ext}", headers={"User-Agent": UA})
        time.sleep(0.25)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                data = r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                open(path, "wb").close()
                continue
            raise
        with open(path, "wb") as f:
            f.write(data)
        return Image.open(io.BytesIO(data)).convert("RGB")
    return None


def mosaic(cache, layer, cx, cy, half):
    x0, y0, x1, y1 = int(cx - half), int(cy - half), int(cx + half), int(cy + half)
    tiles = {}
    for ty in range(y0 // 256, y1 // 256 + 1):
        for tx in range(x0 // 256, x1 // 256 + 1):
            im = fetch_any(cache, layer, Z, tx, ty)
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


def panel(cache, year, cand, panel_px=240):
    lat, lon, area = cand["lat"], cand["lon"], cand["area_m2"]
    cx, cy = lonlat_to_px(lat, lon)
    m_per_px = 156543.03392 * math.cos(math.radians(lat)) / 2 ** Z
    half = max(48, min(128, int(math.sqrt(area) / m_per_px * 1.3 + 40)))
    r = mosaic(cache, f"nendophoto{year}", cx, cy, half)
    if r is None:
        return False, Image.new("RGB", (panel_px, panel_px), (200, 200, 200))
    im, (x0, y0) = r
    scale = panel_px / im.width
    im = im.resize((panel_px, int(im.height * scale)), Image.BICUBIC)
    ring = [((lonlat_to_px(la, lo)[0] - x0) * scale, (lonlat_to_px(la, lo)[1] - y0) * scale) for la, lo in cand["ring"]]
    ImageDraw.Draw(im).line(ring, fill=(255, 0, 0), width=2)
    return True, im


def main():
    cand_path, out = sys.argv[1], sys.argv[2]
    n_small, n_large, seed = int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
    years = [int(y) for y in sys.argv[6].split(",")]
    cands = json.load(open(cand_path, encoding="utf-8"))
    if len(sys.argv) > 7:
        both = {tuple(t) for t in json.load(open(sys.argv[7], encoding="utf-8"))["both"]}
        n = 2 ** 15

        def tile15(c):
            return (int((c["lon"] + 180) / 360 * n),
                    int((1 - math.log(math.tan(math.radians(c["lat"])) + 1 / math.cos(math.radians(c["lat"]))) / math.pi) / 2 * n))
        before = len(cands)
        cands = [c for c in cands if tile15(c) in both]
        print("タイルで絞り込み:", before, "->", len(cands))
    rng = random.Random(seed)
    small = [c for c in cands if 30 <= c["area_m2"] < 100]
    large = [c for c in cands if c["area_m2"] >= 100]
    print("小さい", len(small), "大きい", len(large))
    sample = rng.sample(small, min(n_small, len(small))) + rng.sample(large, min(n_large, len(large)))
    os.makedirs(out, exist_ok=True)
    cache = os.path.join(out, "tiles")
    pw = 240
    rows, meta = [], []
    for i, c in enumerate(sample, 1):
        ims, flags = [], []
        for y in years:
            ok, im = panel(cache, y, c, pw)
            ims.append(im); flags.append(ok)
        cap = f"#{i:02d} {c['area_m2']:.0f}m2 " + " ".join(f"{y}{'' if f else '(none)'}" for y, f in zip(years, flags))
        row = Image.new("RGB", (len(years) * (pw + 6), pw + 20), (255, 255, 255))
        for k, im in enumerate(ims):
            row.paste(im, (k * (pw + 6), 20))
        ImageDraw.Draw(row).text((2, 4), cap, fill=(0, 0, 0))
        rows.append(row)
        meta.append({"n": i, "gid": c["gid"], "area_m2": c["area_m2"], "type": c["type"], "lat": c["lat"], "lon": c["lon"], "years": years, "have": flags})
        print(cap, flush=True)
    per = 4
    for s in range(0, len(rows), per):
        group = rows[s:s + per]
        sheet = Image.new("RGB", (len(years) * (pw + 6), per * (pw + 26)), (255, 255, 255))
        for k, row in enumerate(group):
            sheet.paste(row, (0, k * (pw + 26)))
        sheet.save(os.path.join(out, f"sheet_{s // per + 1}.png"))
    json.dump(meta, open(os.path.join(out, "samples.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("sheets:", math.ceil(len(rows) / per), "samples:", len(rows))


if __name__ == "__main__":
    main()
