"""XYZ タイルの境界・画素座標。Web メルカトル（EPSG:3857）と lon/lat の変換を、pyproj なしの式で行う。

画素座標は、タイルの左上が (0, 0)、col が右、row が下。整数が画素の境界で、画素の中心は +0.5。
"""

from __future__ import annotations

import math
import re

import numpy as np
from rasterio.transform import Affine, from_bounds

EARTH_RADIUS_M = 6378137.0
ORIGIN_M = math.pi * EARTH_RADIUS_M  # Web メルカトルの半周（m）
TILE_SIZE_PX = 256
DEFAULT_Z = 18

_AREA_ID_RE = re.compile(r"^z(\d+)-(\d+)-(\d+)$")


def _scalar(v):
    """0 次元ならば Python の float にする（配列はそのまま）。"""
    return float(v) if np.ndim(v) == 0 else v


def tile_size_m(z: int) -> float:
    """z のタイル 1 枚の一辺（Web メルカトルの m）。"""
    return 2 * ORIGIN_M / (2**z)


def _check_tile(z: int, x: int, y: int) -> None:
    n = 2**z
    if not (0 <= x < n and 0 <= y < n):
        raise ValueError(f"タイル番号が範囲外: z={z} x={x} y={y}（0〜{n - 1}）")


def merc_to_lonlat(mx, my):
    """Web メルカトル（m）→ (経度, 緯度)。スカラーも配列も可。"""
    mx = np.asarray(mx, dtype=float) if np.ndim(mx) else float(mx)
    my = np.asarray(my, dtype=float) if np.ndim(my) else float(my)
    lon = np.degrees(mx / EARTH_RADIUS_M)
    lat = np.degrees(np.arctan(np.sinh(my / EARTH_RADIUS_M)))
    return _scalar(lon), _scalar(lat)


def lonlat_to_merc(lon, lat):
    """(経度, 緯度) → Web メルカトル（m）。"""
    lon = np.asarray(lon, dtype=float) if np.ndim(lon) else float(lon)
    lat = np.asarray(lat, dtype=float) if np.ndim(lat) else float(lat)
    mx = EARTH_RADIUS_M * np.radians(lon)
    my = EARTH_RADIUS_M * np.arcsinh(np.tan(np.radians(lat)))
    return _scalar(mx), _scalar(my)


def tile_bounds_3857(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    """タイルの境界 (minx, miny, maxx, maxy)。EPSG:3857 の m。"""
    _check_tile(z, x, y)
    size = tile_size_m(z)
    minx = -ORIGIN_M + x * size
    maxy = ORIGIN_M - y * size
    return (minx, maxy - size, minx + size, maxy)


def tile_bbox_lonlat(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    """タイルの境界 (west, south, east, north)。lon/lat。"""
    minx, miny, maxx, maxy = tile_bounds_3857(z, x, y)
    west, south = merc_to_lonlat(minx, miny)
    east, north = merc_to_lonlat(maxx, maxy)
    return (west, south, east, north)


def tile_center_lonlat(z: int, x: int, y: int) -> tuple[float, float]:
    """タイルの中心（メルカトルでの中央。画素 (128, 128) の位置）の (経度, 緯度)。"""
    minx, miny, maxx, maxy = tile_bounds_3857(z, x, y)
    return merc_to_lonlat((minx + maxx) / 2, (miny + maxy) / 2)


def tile_transform(z: int, x: int, y: int, size: int = TILE_SIZE_PX) -> Affine:
    """size×size の配列の画素 (col, row) → EPSG:3857 の座標。北が上（e が負）。"""
    minx, miny, maxx, maxy = tile_bounds_3857(z, x, y)
    return from_bounds(minx, miny, maxx, maxy, size, size)


def pixel_to_lonlat(z: int, x: int, y: int, col, row, size: int = TILE_SIZE_PX):
    """画素座標（実数。整数が境界）→ (経度, 緯度)。"""
    minx, miny, maxx, maxy = tile_bounds_3857(z, x, y)
    span = maxx - minx
    mx = minx + np.asarray(col, dtype=float) / size * span
    my = maxy - np.asarray(row, dtype=float) / size * span
    return merc_to_lonlat(mx, my)


def lonlat_to_pixel(z: int, x: int, y: int, lon, lat, size: int = TILE_SIZE_PX):
    """(経度, 緯度) → 画素座標（実数）。タイルの外は 0 未満・size 以上になる。"""
    minx, miny, maxx, maxy = tile_bounds_3857(z, x, y)
    span = maxx - minx
    mx, my = lonlat_to_merc(lon, lat)
    col = (np.asarray(mx) - minx) / span * size
    row = (maxy - np.asarray(my)) / span * size
    return _scalar(col), _scalar(row)


def lonlat_to_tile(lon: float, lat: float, z: int = DEFAULT_Z) -> tuple[int, int]:
    """(経度, 緯度) を含むタイルの (x, y)。"""
    mx, my = lonlat_to_merc(lon, lat)
    size = tile_size_m(z)
    return int(math.floor((mx + ORIGIN_M) / size)), int(math.floor((ORIGIN_M - my) / size))


def ground_resolution_m(z: int, lat_deg: float, size: int = TILE_SIZE_PX) -> float:
    """画素 1 つの、地上での一辺（m）。size は配列の一辺（倍率をかけた配列なら 256×倍率）。"""
    return tile_size_m(z) / size * math.cos(math.radians(lat_deg))


def area_id(z: int, x: int, y: int) -> str:
    return f"z{z}-{x}-{y}"


def parse_area_id(value: str) -> tuple[int, int, int]:
    m = _AREA_ID_RE.match(value)
    if not m:
        raise ValueError(f"地区 id の形式が違う: {value!r}（z18-<x>-<y>）")
    return int(m.group(1)), int(m.group(2)), int(m.group(3))
