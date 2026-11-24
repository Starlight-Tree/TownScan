import numpy as np
import pytest

from pipeline import geo, tilemath, vectorize

from .helpers import TILE, Z, prob_with_rects


def _res():
    _, lat = tilemath.tile_center_lonlat(*TILE)
    return tilemath.ground_resolution_m(Z, lat)


def test_single_rectangle_area_and_shape():
    prob = prob_with_rects([(100, 80, 120, 90)])  # 20×10 画素
    (b,) = vectorize.vectorize_tile(prob, *TILE)
    # 面積は EPSG:6670 の m²。地上の一辺 × 画素数（投影のひずみは 1% 未満）
    assert b.area_m2 == pytest.approx(20 * 10 * _res() ** 2, rel=0.01)
    assert b.edge_touch is False
    assert b.prob_mean == pytest.approx(0.9, abs=1e-6)
    assert len(b.geom_lonlat.exterior.coords) == 5  # 矩形は 4 頂点に単純化される
    w, s, e, n = tilemath.tile_bbox_lonlat(*TILE)
    minx, miny, maxx, maxy = b.geom_lonlat.bounds
    assert w < minx < maxx < e and s < miny < maxy < n
    # 位置: 画素 (100, 80)〜(120, 90) の lon/lat
    lon0, lat0 = tilemath.pixel_to_lonlat(*TILE, 100, 80)
    lon1, lat1 = tilemath.pixel_to_lonlat(*TILE, 120, 90)
    assert (minx, maxx) == pytest.approx((lon0, lon1), abs=1e-9)
    assert (maxy, miny) == pytest.approx((lat0, lat1), abs=1e-9)
    # 面積は geo.area_m2（lon/lat から EPSG:6670）と一致する
    assert b.area_m2 == pytest.approx(geo.area_m2(b.geom_lonlat))


def test_threshold_is_inclusive_and_binarize_handles_nan():
    prob = np.zeros((256, 256), dtype=np.float32)
    prob[10:30, 10:30] = 0.5
    assert vectorize.binarize(prob, 0.5).sum() == 400  # prob >= threshold
    assert vectorize.binarize(prob, 0.5001).sum() == 0
    prob[0, 0] = np.nan
    assert vectorize.binarize(prob, 0.0)[0, 0] == True  # noqa: E712 NaN は 0 として扱い、閾値 0 なら建物側
    assert vectorize.binarize(prob, 0.1)[0, 0] == False  # noqa: E712


def test_float16_input_and_invalid_shapes():
    prob = prob_with_rects([(10, 10, 40, 40)]).astype(np.float16)
    assert len(vectorize.vectorize_tile(prob, *TILE)) == 1
    with pytest.raises(ValueError):
        vectorize.as_prob_array(np.zeros((256, 128)))
    with pytest.raises(ValueError):
        vectorize.as_prob_array(np.zeros((256,)))


def test_min_blob_px_scales_with_grid():
    assert vectorize.min_blob_px(*TILE, 256, 4.0) == pytest.approx(16, abs=1)
    assert vectorize.min_blob_px(*TILE, 512, 4.0) == pytest.approx(64, abs=2)
    assert vectorize.min_blob_px(*TILE, 256, 0.0) == 1


def test_small_specks_removed_large_kept():
    # 1 画素・2×2 画素（4 画素 < 16）の粒は消え、6×6（36 画素）は残る
    prob = prob_with_rects([(20, 20, 21, 21), (40, 40, 42, 42), (100, 100, 106, 106), (150, 150, 190, 190)])
    areas = sorted(round(b.area_m2) for b in vectorize.vectorize_tile(prob, *TILE))
    assert len(areas) == 2
    assert areas[0] == pytest.approx(36 * _res() ** 2, rel=0.02)


def test_small_hole_filled_large_hole_kept():
    prob = prob_with_rects([(50, 50, 90, 90)])
    prob[60:62, 60:62] = 0.0  # 4 画素の穴（< 16）→ 埋まる
    prob[70:80, 70:80] = 0.0  # 100 画素の穴 → 残る
    (b,) = vectorize.vectorize_tile(prob, *TILE)
    assert len(b.geom_lonlat.interiors) == 1
    assert b.area_m2 == pytest.approx((40 * 40 - 100) * _res() ** 2, rel=0.01)


def test_hole_is_excluded_from_prob_mean():
    prob = prob_with_rects([(50, 50, 90, 90)], value=0.8)
    prob[70:80, 70:80] = 0.1
    (b,) = vectorize.vectorize_tile(prob, *TILE, threshold=0.5)
    assert b.prob_mean == pytest.approx(0.8)


def test_prob_mean_is_mean_inside_polygon():
    prob = prob_with_rects([((100, 100, 110, 120), 0.8), ((110, 100, 120, 120), 0.6)])
    (b,) = vectorize.vectorize_tile(prob, *TILE)
    assert b.prob_mean == pytest.approx(0.7)


@pytest.mark.parametrize(
    "rect, touches",
    [
        ((236, 100, 256, 120), True),  # 右
        ((0, 100, 20, 120), True),  # 左
        ((100, 0, 120, 20), True),  # 上
        ((100, 236, 120, 256), True),  # 下
        ((100, 100, 120, 120), False),  # 内側
        ((235, 100, 255, 120), False),  # 縁から 1 画素離れている
        ((1, 100, 21, 120), False),
    ],
)
def test_edge_touch(rect, touches):
    (b,) = vectorize.vectorize_tile(prob_with_rects([rect]), *TILE)
    assert b.edge_touch is touches


@pytest.mark.parametrize("scale", [1.0, 1.5, 2.0])
def test_scales_give_same_ground_area(scale):
    """倍率が違っても、同じ地上の矩形（タイルの 20×10 画素分）は同じ面積・同じ位置になる。"""
    prob = prob_with_rects([(100, 80, 120, 90)], scale=scale)
    assert prob.shape == (int(256 * scale),) * 2
    (b,) = vectorize.vectorize_tile(prob, *TILE)
    assert b.area_m2 == pytest.approx(20 * 10 * _res() ** 2, rel=0.01)
    lon0, _ = tilemath.pixel_to_lonlat(*TILE, 100, 80)
    assert b.geom_lonlat.bounds[0] == pytest.approx(lon0, abs=1e-9)


def test_mask_without_edge_drops_only_edge_components():
    prob = prob_with_rects([(236, 100, 256, 120), (100, 100, 120, 120)])
    mask, comps = vectorize.extract(prob, *TILE)
    assert len(comps) == 2
    kept = vectorize.mask_without_edge(comps, mask.shape)
    assert kept.sum() == 400 and mask.sum() == 800
    assert kept[110, 110] and not kept[110, 250]
    assert vectorize.mask_without_edge([], (8, 8)).sum() == 0


def test_mask_without_edge_skip_drops_chosen_components_too():
    prob = prob_with_rects([(236, 100, 256, 120), (100, 100, 120, 120), (150, 150, 170, 170)])
    mask, comps = vectorize.extract(prob, *TILE)
    inner = [i for i, c in enumerate(comps) if not c.edge_touch]
    assert len(comps) == 3 and len(inner) == 2
    assert vectorize.mask_without_edge(comps, mask.shape, skip=[inner[0]]).sum() == 400  # 縁の 1 つと、番号で指した 1 つを除く
    assert vectorize.mask_without_edge(comps, mask.shape, skip=inner).sum() == 0
    assert vectorize.mask_without_edge(comps, mask.shape, skip=[]).sum() == 800  # 指定なしは従来どおり


def test_buildings_remember_their_component_index():
    prob = prob_with_rects([(236, 100, 256, 120), (100, 100, 120, 120), (150, 150, 170, 170)])
    extracted = vectorize.extract(prob, *TILE)
    comps = extracted[1]
    blds = vectorize.vectorize_tile(prob, *TILE, extracted=extracted)
    assert sorted(b.comp_index for b in blds) == list(range(len(comps)))
    for b in blds:  # 番号の指す成分は、同じ縁の判定を持つ
        assert comps[b.comp_index].edge_touch == b.edge_touch


def test_values_in_polygon_px_counts_pixels():
    from shapely.geometry import box

    prob = np.arange(100, dtype=np.float32).reshape(10, 10) / 100
    vals = vectorize.values_in_polygon_px(prob, box(2, 3, 5, 6))  # col 2〜4・row 3〜5 の 9 画素
    assert sorted(vals.tolist()) == pytest.approx(sorted(prob[3:6, 2:5].ravel().tolist()))
    assert vectorize.values_in_polygon_px(prob, box(20, 20, 30, 30)).size == 0  # 配列の外


def test_values_in_polygon_merc_matches_pixels():
    prob = prob_with_rects([(100, 80, 120, 90)])
    (b,) = vectorize.vectorize_tile(prob, *TILE)
    vals = vectorize.values_in_polygon_merc(prob, b.geom_merc, *TILE)
    assert vals.size == 200 and vals.min() == pytest.approx(0.9)


def test_simplify_keeps_diagonal_edge_within_tolerance():
    """斜めの建物の階段状の縁は、少ない頂点に単純化される（面積は大きく変わらない）。"""
    prob = np.zeros((256, 256), dtype=np.float32)
    yy, xx = np.mgrid[0:256, 0:256]
    prob[(abs((xx - 128) + (yy - 128)) < 12) & (abs((xx - 128) - (yy - 128)) < 30)] = 0.9
    raw = vectorize.vectorize_tile(prob, *TILE, simplify_m=0)[0]
    simp = vectorize.vectorize_tile(prob, *TILE, simplify_m=0.3)[0]
    assert len(simp.geom_lonlat.exterior.coords) < len(raw.geom_lonlat.exterior.coords)
    assert simp.area_m2 == pytest.approx(raw.area_m2, rel=0.03)


def test_empty_and_full_arrays():
    assert vectorize.vectorize_tile(np.zeros((256, 256)), *TILE) == []
    (b,) = vectorize.vectorize_tile(np.ones((256, 256)), *TILE)
    assert b.edge_touch and b.area_m2 == pytest.approx(256 * 256 * _res() ** 2, rel=0.01)


def test_buildings_sorted_by_area_desc():
    prob = prob_with_rects([(10, 10, 30, 30), (100, 100, 160, 160), (200, 10, 220, 25)])
    areas = [b.area_m2 for b in vectorize.vectorize_tile(prob, *TILE)]
    assert areas == sorted(areas, reverse=True) and len(areas) == 3
