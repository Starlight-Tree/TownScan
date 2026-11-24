"""テスト共通の部品。タイルは熊本の z18 の 1 枚（座標は合成のテストでも使う）。"""

from __future__ import annotations

import numpy as np
from shapely.geometry import Polygon

from pipeline import tilemath

Z, X, Y = 18, 226249, 105769
TILE = (Z, X, Y)


def rect_lonlat(x0, y0, x1, y1, tile=TILE) -> Polygon:
    """タイルの画素座標の矩形 → lon/lat のポリゴン。"""
    z, x, y = tile
    pts = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    return Polygon([tilemath.pixel_to_lonlat(z, x, y, c, r) for c, r in pts])


def prob_with_rects(rects, scale: float = 1.0, value: float = 0.9, background: float = 0.0) -> np.ndarray:
    """タイルの画素座標の矩形 (x0, y0, x1, y1) を value で塗った確率の配列（256×倍率）。矩形は rect または (rect, value)。"""
    n = int(round(256 * scale))
    a = np.full((n, n), background, dtype=np.float32)
    for r in rects:
        rect, v = (r if isinstance(r[0], (tuple, list)) else (r, value))
        x0, y0, x1, y1 = (int(round(c * scale)) for c in rect)
        a[y0:y1, x0:x1] = v
    return a
