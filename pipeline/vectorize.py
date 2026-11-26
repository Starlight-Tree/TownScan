"""建物の確率の配列 → 二値化 → 小さな粒・穴の除去 → ポリゴン（lon/lat）。

配列は 256×倍率 の正方形（タイル全体）。二値化は `prob >= threshold`。
小さな粒・穴の除去は rasterio.features.sieve（4 近傍）。面積のしきい値（m²）を、倍率に合わせて画素数に直す。
面積は m²（geo.metric_crs）。タイルの縁に接するか（edge_touch）は、単純化の前の画素のポリゴンで見る。
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from rasterio.features import rasterize, shapes, sieve
from shapely import affinity
from shapely.geometry import Polygon, shape

from . import geo, tilemath

DEFAULT_THRESHOLD = 0.5
DEFAULT_MIN_BLOB_M2 = 4.0  # これより小さい粒・穴は消す（約 16 画素＠1 倍）
DEFAULT_SIMPLIFY_M = 0.3  # メルカトルの m。1 倍の 1 画素（約 0.6 m）の半分


@dataclass
class Component:
    """二値の画素の連結成分 1 つ。polygon は画素座標（左上が原点）。"""

    polygon: Polygon
    edge_touch: bool


@dataclass
class Building:
    """建物 1 棟（2 時点とも同じ形）。"""

    geom_lonlat: Polygon  # 単純化済み
    geom_merc: Polygon  # 同じ形を EPSG:3857 で（確率の配列を切り出すため）
    geom_m: Polygon  # 同じ形を面積を測る座標系で（面積の重なりを計るため）
    area_m2: float
    prob_mean: float
    edge_touch: bool
    comp_index: int = -1  # 元の連結成分の番号（extract の comps の並び）。評価が、棟と画素を同じ決定で扱うために使う


def as_prob_array(prob) -> np.ndarray:
    """確率の配列を float32 の正方形にする。NaN は 0（建物なし）として扱う。"""
    a = np.asarray(prob)
    if a.ndim != 2 or a.shape[0] != a.shape[1] or a.shape[0] == 0:
        raise ValueError(f"確率の配列は正方形の 2 次元であること: shape={a.shape}")
    return np.nan_to_num(a.astype(np.float32), nan=0.0, posinf=1.0, neginf=0.0)


def binarize(prob: np.ndarray, threshold: float) -> np.ndarray:
    return as_prob_array(prob) >= threshold


def min_blob_px(z: int, x: int, y: int, size: int, min_blob_m2: float) -> int:
    """面積のしきい値（m²）を、size×size の配列での画素数にする（緯度は地区の中心）。"""
    _, lat = tilemath.tile_center_lonlat(z, x, y)
    res = tilemath.ground_resolution_m(z, lat, size)
    return max(1, int(round(min_blob_m2 / (res * res))))


def clean_mask(mask: np.ndarray, min_px: int) -> np.ndarray:
    """min_px 画素より小さい粒（建物側）と穴（建物でない側）を、隣の大きい側へ取り込む。"""
    if min_px <= 1:
        return mask.copy()
    return sieve(mask.astype(np.uint8), size=int(min_px), connectivity=4).astype(bool)


def components(mask: np.ndarray) -> list[Component]:
    """二値の画素を、連結成分（4 近傍。穴は内側の輪）ごとのポリゴンにする。画素座標。"""
    h, w = mask.shape
    out = []
    for geom, _ in shapes(mask.astype(np.uint8), mask=mask, connectivity=4):
        poly = shape(geom)
        minx, miny, maxx, maxy = poly.bounds
        out.append(Component(poly, bool(minx <= 0 or miny <= 0 or maxx >= w or maxy >= h)))
    return out


def extract(prob, z: int, x: int, y: int, *, threshold: float = DEFAULT_THRESHOLD, min_blob_m2: float = DEFAULT_MIN_BLOB_M2):
    """確率の配列 → (清掃した二値の画素, 連結成分のリスト)。評価と建物の書き出しが共有する。"""
    p = as_prob_array(prob)
    mask = clean_mask(p >= threshold, min_blob_px(z, x, y, p.shape[0], min_blob_m2))
    return mask, components(mask)


def mask_without_edge(comps: list[Component], shape_hw: tuple[int, int], skip=()) -> np.ndarray:
    """縁に接する成分を除いた、二値の画素。skip に番号を渡した成分（comps の並びでの番号）も除く。"""
    skip = set(skip)
    keep = [(c.polygon, 1) for i, c in enumerate(comps) if not c.edge_touch and i not in skip]
    if not keep:
        return np.zeros(shape_hw, dtype=bool)
    return rasterize(keep, out_shape=shape_hw, fill=0, dtype="uint8").astype(bool)


def values_in_polygon_px(prob: np.ndarray, poly_px, *, all_touched: bool = False) -> np.ndarray:
    """画素座標のポリゴンの内側にある確率の値（窓を切り出して数える）。配列の外は無視する。"""
    h, w = prob.shape
    minx, miny, maxx, maxy = poly_px.bounds
    c0, r0 = max(0, int(math.floor(minx))), max(0, int(math.floor(miny)))
    c1, r1 = min(w, int(math.ceil(maxx))), min(h, int(math.ceil(maxy)))
    if c1 <= c0 or r1 <= r0:
        return np.empty(0, dtype=np.float32)
    local = affinity.translate(poly_px, -c0, -r0)
    m = rasterize([(local, 1)], out_shape=(r1 - r0, c1 - c0), fill=0, dtype="uint8", all_touched=all_touched).astype(bool)
    return prob[r0:r1, c0:c1][m]


def values_in_polygon_merc(prob: np.ndarray, geom_merc, z: int, x: int, y: int) -> np.ndarray:
    """EPSG:3857 のポリゴンの内側にある確率の値。極小で画素の中心が入らないときは、触れる画素まで広げる。"""
    inv = ~tilemath.tile_transform(z, x, y, prob.shape[0])
    poly_px = geo.affine_geom(geom_merc, inv)
    vals = values_in_polygon_px(prob, poly_px)
    if vals.size == 0:
        vals = values_in_polygon_px(prob, poly_px, all_touched=True)
    return vals


def vectorize_tile(
    prob,
    z: int,
    x: int,
    y: int,
    *,
    threshold: float = DEFAULT_THRESHOLD,
    min_blob_m2: float = DEFAULT_MIN_BLOB_M2,
    simplify_m: float = DEFAULT_SIMPLIFY_M,
    extracted=None,
) -> list[Building]:
    """タイルの確率の配列 → 建物のリスト（面積の大きい順）。extracted は extract() の結果（あれば使い回す）。"""
    p = as_prob_array(prob)
    _, comps = extracted if extracted is not None else extract(p, z, x, y, threshold=threshold, min_blob_m2=min_blob_m2)
    transform = tilemath.tile_transform(z, x, y, p.shape[0])
    out: list[Building] = []
    for idx, comp in enumerate(comps):
        vals = values_in_polygon_px(p, comp.polygon)
        prob_mean = float(vals.mean()) if vals.size else 0.0
        merc = geo.affine_geom(comp.polygon, transform)
        if simplify_m > 0:
            merc = merc.simplify(simplify_m, preserve_topology=True)
        merc = geo.largest_polygon(geo.polygonal(merc))
        if merc is None:
            continue
        lonlat = geo.merc_to_lonlat_geom(merc)
        g_m = geo.lonlat_to_metric_geom(lonlat)
        out.append(
            Building(
                geom_lonlat=lonlat,
                geom_merc=merc,
                geom_m=g_m,
                area_m2=float(g_m.area),
                prob_mean=prob_mean,
                edge_touch=comp.edge_touch,
                comp_index=idx,
            )
        )
    out.sort(key=lambda b: (-b.area_m2, b.geom_lonlat.centroid.x, b.geom_lonlat.centroid.y))
    return out
