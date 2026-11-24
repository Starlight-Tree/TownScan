"""煙テスト: 基盤地図情報の建物の面を、地理院の写真タイル（z18）に重ねて、マスク（学習ラベルの候補）を作る。
目的: (1) 座標変換とラスタライズの道具（pyproj・shapely・rasterio）が動くこと、(2) 建物の形と写真の位置が、どのくらい合うかを目で見ること。
使い方（開発コンテナの venv で）:
  python rasterize_smoke.py <BldA の解凍フォルダ> <キャッシュ済みの写真レイヤー（例: .../tiles/nendophoto2023）> <出力 PNG>
出典: 国土地理院（地理院タイル・基盤地図情報）。出力画像は data/ に置く（再配布しない）。
"""
import glob
import importlib.util
import math
import os
import sys

import numpy as np
from PIL import Image
from pyproj import Transformer
from rasterio.features import rasterize
from rasterio.transform import from_bounds
from shapely.geometry import Polygon, box

here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("cmp", os.path.join(here, "loader_only.py"))
cmp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cmp)

folder, layer_dir, out_png = sys.argv[1], sys.argv[2], sys.argv[3]

# 1. キャッシュ済みのタイルから、取得済み（0 バイトでない）のものを 1 枚選ぶ（建物が多そうな、サイズが大きいもの）
tiles = [p for p in glob.glob(os.path.join(layer_dir, "18", "*", "*.png")) if os.path.getsize(p) > 20000]
tiles.sort(key=os.path.getsize, reverse=True)
path = tiles[0]
ty = int(os.path.basename(path).split(".")[0])
tx = int(os.path.basename(os.path.dirname(path)))
print("タイル:", tx, ty, "ファイル", os.path.relpath(path, layer_dir), os.path.getsize(path), "B")

# 2. タイルの範囲（Web メルカトル m）
R = 6378137.0
ORIGIN = -math.pi * R
n = 2 ** 18
size = 2 * math.pi * R / n
minx, maxy = ORIGIN + tx * size, -ORIGIN - ty * size
maxx, miny = minx + size, maxy - size
tile_box = box(minx, miny, maxx, maxy)
to_merc = Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)
lat_c = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (ty + 0.5) / n))))
print("タイルの幅: メルカトル %.1f m／地上 %.1f m（緯度 %.2f 度。1 画素 地上 %.2f m）" % (
    size, size * math.cos(math.radians(lat_c)), lat_c, size * math.cos(math.radians(lat_c)) / 256))

# 3. 建物を読み込み、タイルと交わるものだけを取り出す
feats, _ = cmp.load(folder)
polys = []
for v in feats.values():
    c = v["coords"]
    ll = [(float(c[i + 1]), float(c[i])) for i in range(0, len(c) - 1, 2)]  # (経度, 緯度)
    xs, ys = to_merc.transform([p[0] for p in ll], [p[1] for p in ll])
    poly = Polygon(list(zip(xs, ys)))
    if poly.is_valid and poly.intersects(tile_box):
        polys.append(poly)
print("読み込んだ建物:", len(feats), "／このタイルと交わる建物:", len(polys))

# 4. ラスタライズ（256×256）
transform = from_bounds(minx, miny, maxx, maxy, 256, 256)
mask = rasterize([(p, 1) for p in polys], out_shape=(256, 256), transform=transform, fill=0, dtype="uint8", all_touched=False)
print("建物が占める画素の割合: %.1f%%" % (100 * mask.mean()))

# 5. 写真に、建物の輪郭（赤）と塗りの薄い重ねを描いて、並べて保存する
img = Image.open(path).convert("RGB")
arr = np.array(img)
edge = np.zeros_like(mask, dtype=bool)
edge[1:-1, 1:-1] = (mask[1:-1, 1:-1] == 1) & ((mask[:-2, 1:-1] == 0) | (mask[2:, 1:-1] == 0) | (mask[1:-1, :-2] == 0) | (mask[1:-1, 2:] == 0))
over = arr.copy()
over[mask == 1] = (0.6 * over[mask == 1] + 0.4 * np.array([255, 0, 0])).astype("uint8")
over[edge] = (255, 0, 0)
scale = 3
left = img.resize((256 * scale, 256 * scale), Image.BICUBIC)
right = Image.fromarray(over).resize((256 * scale, 256 * scale), Image.NEAREST)
sheet = Image.new("RGB", (256 * scale * 2 + 8, 256 * scale), (255, 255, 255))
sheet.paste(left, (0, 0)); sheet.paste(right, (256 * scale + 8, 0))
os.makedirs(os.path.dirname(os.path.abspath(out_png)), exist_ok=True)
sheet.save(out_png)
print("保存:", out_png)
