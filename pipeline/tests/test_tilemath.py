import math

import numpy as np
import pytest
from pyproj import Transformer

from pipeline import tilemath

from .helpers import TILE, X, Y, Z


def test_world_tile_bounds():
    minx, miny, maxx, maxy = tilemath.tile_bounds_3857(0, 0, 0)
    half = math.pi * 6378137.0
    assert (minx, miny, maxx, maxy) == pytest.approx((-half, -half, half, half))
    w, s, e, n = tilemath.tile_bbox_lonlat(0, 0, 0)
    assert (w, e) == pytest.approx((-180.0, 180.0))
    assert n == pytest.approx(85.0511287798, abs=1e-8)
    assert s == pytest.approx(-85.0511287798, abs=1e-8)


def test_tile_bounds_match_pyproj():
    """自前の式が、pyproj の EPSG:3857 → 4326 と一致する（隅 4 点）。"""
    t = Transformer.from_crs("EPSG:3857", "EPSG:4326", always_xy=True)
    minx, miny, maxx, maxy = tilemath.tile_bounds_3857(*TILE)
    w, s, e, n = tilemath.tile_bbox_lonlat(*TILE)
    for (mx, my), (lon, lat) in zip([(minx, miny), (maxx, maxy), (minx, maxy), (maxx, miny)], [(w, s), (e, n), (w, n), (e, s)]):
        plon, plat = t.transform(mx, my)
        assert lon == pytest.approx(plon, abs=1e-10)
        assert lat == pytest.approx(plat, abs=1e-10)


def test_known_tile_center():
    """tiles.json（別の計算で得た値）の中心と一致する。熊本市中心部の z18 タイル。"""
    lon, lat = tilemath.tile_center_lonlat(*TILE)
    assert lon == pytest.approx(130.706406, abs=2e-6)
    assert lat == pytest.approx(32.794779, abs=2e-6)


def test_tile_size_and_ground_resolution():
    assert tilemath.tile_size_m(18) == pytest.approx(152.8740565703525)
    _, lat = tilemath.tile_center_lonlat(*TILE)
    # 1 画素の地上の一辺は約 0.5 m（0.597 m × cos 緯度）
    res = tilemath.ground_resolution_m(Z, lat)
    assert res == pytest.approx(156543.03392804097 / 2**18 * math.cos(math.radians(lat)))
    assert 0.49 < res < 0.51
    assert tilemath.ground_resolution_m(Z, lat, 512) == pytest.approx(res / 2)


def test_merc_lonlat_roundtrip_scalar_and_array():
    lon, lat = 130.7064, 32.7948
    assert tilemath.merc_to_lonlat(*tilemath.lonlat_to_merc(lon, lat)) == pytest.approx((lon, lat), abs=1e-12)
    lons, lats = np.array([130.1, 130.9]), np.array([32.5, 33.0])
    back = tilemath.merc_to_lonlat(*tilemath.lonlat_to_merc(lons, lats))
    assert np.allclose(back[0], lons) and np.allclose(back[1], lats)
    assert isinstance(tilemath.lonlat_to_merc(lon, lat)[0], float)


def test_pixel_lonlat_roundtrip_and_corners():
    w, s, e, n = tilemath.tile_bbox_lonlat(*TILE)
    assert tilemath.pixel_to_lonlat(*TILE, 0, 0) == pytest.approx((w, n))  # 左上
    assert tilemath.pixel_to_lonlat(*TILE, 256, 256) == pytest.approx((e, s))  # 右下
    col, row = tilemath.lonlat_to_pixel(*TILE, *tilemath.pixel_to_lonlat(*TILE, 12.25, 200.5))
    assert (col, row) == pytest.approx((12.25, 200.5))
    # 別の大きさの配列（倍率 2）でも、同じ位置を指す
    lon, lat = tilemath.pixel_to_lonlat(*TILE, 100, 50, size=512)
    assert (lon, lat) == pytest.approx(tilemath.pixel_to_lonlat(*TILE, 50, 25))


def test_pixel_axes_directions():
    """col は東へ、row は南へ増える（北が上の画像）。"""
    lon0, lat0 = tilemath.pixel_to_lonlat(*TILE, 10, 10)
    lon1, lat1 = tilemath.pixel_to_lonlat(*TILE, 20, 10)
    lon2, lat2 = tilemath.pixel_to_lonlat(*TILE, 10, 20)
    assert lon1 > lon0 and lat1 == pytest.approx(lat0)
    assert lat2 < lat0 and lon2 == pytest.approx(lon0)


def test_tile_transform_maps_corners():
    minx, miny, maxx, maxy = tilemath.tile_bounds_3857(*TILE)
    tr = tilemath.tile_transform(*TILE, size=384)
    assert tr @ (0, 0) == pytest.approx((minx, maxy))
    assert tr @ (384, 384) == pytest.approx((maxx, miny))


def test_lonlat_to_tile():
    lon, lat = tilemath.tile_center_lonlat(*TILE)
    assert tilemath.lonlat_to_tile(lon, lat, Z) == (X, Y)
    w, s, e, n = tilemath.tile_bbox_lonlat(*TILE)
    assert tilemath.lonlat_to_tile(w + 1e-9, n - 1e-9, Z) == (X, Y)
    assert tilemath.lonlat_to_tile(e + 1e-9, s + 1e-9, Z) == (X + 1, Y)


def test_area_id_roundtrip_and_errors():
    assert tilemath.area_id(18, 226249, 105769) == "z18-226249-105769"
    assert tilemath.parse_area_id("z18-226249-105769") == (18, 226249, 105769)
    for bad in ("18-1-2", "z18-1", "z18-a-2", "", "z18-1-2-3"):
        with pytest.raises(ValueError):
            tilemath.parse_area_id(bad)


def test_tile_out_of_range():
    with pytest.raises(ValueError):
        tilemath.tile_bounds_3857(18, 2**18, 0)
    with pytest.raises(ValueError):
        tilemath.tile_bounds_3857(18, 0, -1)
