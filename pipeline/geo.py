"""ジオメトリの座標変換と整形（shapely 2・pyproj）。

lon/lat（EPSG:4326）・Web メルカトル（EPSG:3857。画素との対応に使う）・面積を m² で出す座標系（metric_crs）の間を変える。
"""

from __future__ import annotations

from functools import lru_cache

import numpy as np
import shapely
from pyproj import Transformer
from shapely import affinity
from shapely.geometry import MultiPolygon, Polygon

from . import tilemath


@lru_cache(maxsize=2)
def _to_metric(crs: str) -> Transformer:
    return Transformer.from_crs("EPSG:4326", crs, always_xy=True)


def metric_crs(lon: float, lat: float) -> str:
    """面積を m² で出す座標系。フランス本土は Lambert-93（EPSG:2154）。それ以外は、合成データ（テスト用）の平面直角座標系（EPSG:6670）。"""
    return "EPSG:2154" if -6.0 <= lon <= 10.0 and 41.0 <= lat <= 52.0 else "EPSG:6670"


def merc_to_lonlat_geom(geom):
    return shapely.transform(geom, lambda c: np.column_stack(tilemath.merc_to_lonlat(c[:, 0], c[:, 1])))


def lonlat_to_merc_geom(geom):
    return shapely.transform(geom, lambda c: np.column_stack(tilemath.lonlat_to_merc(c[:, 0], c[:, 1])))


def lonlat_to_metric_geom(geom):
    """lon/lat → 面積を測る座標系（metric_crs。x が東、y が北。m）。"""
    c = geom.centroid
    t = _to_metric(metric_crs(c.x, c.y))
    return shapely.transform(geom, lambda c: np.column_stack(t.transform(c[:, 0], c[:, 1])))


def area_m2(geom_lonlat) -> float:
    """lon/lat のジオメトリの面積（m²。metric_crs で計算）。"""
    return float(lonlat_to_metric_geom(geom_lonlat).area)


def affine_geom(geom, transform):
    """rasterio の Affine を、ジオメトリの座標へかける（画素 ↔ 地図座標）。"""
    a, b, c, d, e, f = transform[:6]
    return affinity.affine_transform(geom, [a, b, d, e, c, f])


def polygonal(geom):
    """壊れたジオメトリを直し、面（Polygon / MultiPolygon）だけを残す。残らなければ None。"""
    if geom is None or geom.is_empty:
        return None
    if not geom.is_valid:
        geom = shapely.make_valid(geom)
    parts = [p for p in shapely.get_parts(geom) if isinstance(p, Polygon) and not p.is_empty and p.area > 0]
    if not parts:
        return None
    return parts[0] if len(parts) == 1 else MultiPolygon(parts)


def largest_polygon(geom):
    """Polygon / MultiPolygon から、面積が最大の Polygon を返す（None はそのまま）。"""
    if geom is None:
        return None
    if isinstance(geom, Polygon):
        return geom
    return max(shapely.get_parts(geom), key=lambda p: p.area)


def round_coords(geom, ndigits: int = 7):
    """GeoJSON に書く座標の桁を丸める（lon/lat の 7 桁は約 1 cm）。"""
    return shapely.transform(geom, lambda c: np.round(c, ndigits))
