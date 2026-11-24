import numpy as np
import pytest
from shapely.geometry import box

from pipeline import diff, geo, tilemath, vectorize
from pipeline.diff import CLASS_NEW, CLASS_OMISSION, CLASS_UNCERTAIN, Decision, DiffParams, classify

from .helpers import TILE, prob_with_rects, rect_lonlat

BASE = dict(area_m2=100.0, ov_kiban=0.0, ov_2018=0.0, prob_2018_p90=0.0, edge_touch=False)


def c(**kw):
    return classify(**{**BASE, **kw})


# ---- 3 分類の境界値（仕様 §5） ----

def test_new_when_absent_in_2018():
    assert c() == Decision(CLASS_NEW, "new_absent_2018")


@pytest.mark.parametrize(
    "ov_2018, p90, expected",
    [
        (0.10, 0.19, (CLASS_NEW, "new_absent_2018")),  # ov_2018 <= 0.10 は confirmed_new（境界を含む）
        (0.10, 0.20, (CLASS_UNCERTAIN, "ambiguous")),  # prob_2018_p90 < 0.20（境界は含まない）
        (0.10, 0.1999, (CLASS_NEW, "new_absent_2018")),
        (0.1001, 0.0, (CLASS_UNCERTAIN, "ambiguous")),  # 0.10 をわずかに超える
        (0.0, 0.50, (CLASS_UNCERTAIN, "ambiguous")),  # 2018 のモデルが何か見ている
        (0.30, 0.10, (CLASS_UNCERTAIN, "ambiguous")),
        (0.4999, 0.99, (CLASS_UNCERTAIN, "ambiguous")),  # 0.50 未満
        (0.50, 0.0, (CLASS_OMISSION, "present_2018")),  # ov_2018 >= 0.50 は existing_omission（境界を含む）
        (0.5001, 0.0, (CLASS_OMISSION, "present_2018")),
        (1.0, 1.0, (CLASS_OMISSION, "present_2018")),
    ],
)
def test_classification_by_2018_evidence(ov_2018, p90, expected):
    assert c(ov_2018=ov_2018, prob_2018_p90=p90) == expected


@pytest.mark.parametrize(
    "ov_kiban, kept",
    [(0.0, True), (0.2499, True), (0.25, False), (0.2501, False), (1.0, False)],
)
def test_entry_condition_kiban_overlap(ov_kiban, kept):
    d = c(ov_kiban=ov_kiban)
    assert (d.cls is not None) is kept
    if not kept:
        assert d == Decision(None, diff.DROP_IN_KIBAN)


@pytest.mark.parametrize(
    "area, kept",
    [(20.0, True), (20.01, True), (19.99, False), (19.9999, False), (0.0, False), (500.0, True)],
)
def test_minimum_area(area, kept):
    d = c(area_m2=area)
    assert (d.cls is not None) is kept
    if not kept:
        assert d == Decision(None, diff.DROP_SMALL)


def test_edge_touch_is_uncertain_even_when_other_rules_would_apply():
    assert c(edge_touch=True) == Decision(CLASS_UNCERTAIN, "edge")  # 新規の条件を満たしていても
    assert c(edge_touch=True, ov_2018=0.9, prob_2018_p90=0.9) == Decision(CLASS_UNCERTAIN, "edge")  # 描き漏れの条件でも
    assert c(edge_touch=True, area_m2=19.0) == Decision(None, diff.DROP_SMALL)  # 小さいものは捨てる（縁でも）
    assert c(edge_touch=True, ov_kiban=0.25) == Decision(None, diff.DROP_IN_KIBAN)  # 建物データにあるものは対象外


def test_in_kiban_takes_precedence_over_small():
    assert c(ov_kiban=0.9, area_m2=5.0) == Decision(None, diff.DROP_IN_KIBAN)


def test_params_are_adjustable_and_serializable():
    p = DiffParams(kiban_ov_max=0.5, min_area_m2=50.0, omission_ov_2018_min=0.8, new_ov_2018_max=0.0, new_p90_max=0.1)
    assert c(ov_kiban=0.4, params=p).cls is not None
    assert c(area_m2=49.0, params=p).cls is None
    assert c(ov_2018=0.6, prob_2018_p90=0.9, params=p) == Decision(CLASS_UNCERTAIN, "ambiguous")
    assert c(ov_2018=0.8, params=p).cls == CLASS_OMISSION
    assert DiffParams().to_dict() == {
        "kiban_ov_max": 0.25,
        "min_area_m2": 20.0,
        "omission_ov_2018_min": 0.5,
        "new_ov_2018_max": 0.10,
        "new_p90_max": 0.20,
    }


def test_reasons_are_in_the_spec_vocabulary():
    seen = {c().reason, c(ov_2018=0.6).reason, c(ov_2018=0.3).reason, c(edge_touch=True).reason}
    assert seen <= set(diff.REASONS)


# ---- 重なりの計算 ----

def test_overlap_fraction():
    g = box(0, 0, 10, 10)
    assert diff.overlap_fraction(g, box(0, 0, 10, 5)) == pytest.approx(0.5)
    assert diff.overlap_fraction(g, box(-5, -5, 20, 20)) == pytest.approx(1.0)
    assert diff.overlap_fraction(g, box(20, 20, 30, 30)) == 0.0
    assert diff.overlap_fraction(g, None) == 0.0
    assert diff.overlap_fraction(box(0, 0, 0, 0), g) == 0.0


def test_cover_of_repairs_and_unions():
    bow = geo.lonlat_to_6670_geom(rect_lonlat(0, 0, 10, 10))
    assert diff.cover_of([]) is None
    assert diff.cover_of([bow, bow]).area == pytest.approx(bow.area)


# ---- ポリゴンから候補まで（確率の配列 → 建物 → 差分） ----

def _scenario():
    """2023: N（新規）・P（2018 にもある）・K（建物データにある）・S（小さい）・E（縁）・U（2018 に一部）。2018: P と、U の左 30%。"""
    N, P, K = (20, 20, 40, 40), (60, 20, 80, 40), (100, 20, 120, 40)
    S, E, U = (140, 20, 147, 27), (236, 100, 256, 120), (20, 100, 60, 130)
    U_2018 = (20, 100, 32, 130)  # 幅 40 のうち左 12（30%）
    b23 = vectorize.vectorize_tile(prob_with_rects([N, P, K, S, E, U]), *TILE)
    p18 = prob_with_rects([P, U_2018])
    b18 = vectorize.vectorize_tile(p18, *TILE)
    kiban = [rect_lonlat(*K)]
    return b23, b18, p18, kiban, dict(N=N, P=P, K=K, S=S, E=E, U=U)


def _find(cands, rect):
    lon, lat = tilemath.pixel_to_lonlat(*TILE, (rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2)
    from shapely.geometry import Point

    hits = [c for c in cands if c["geometry"].contains(Point(lon, lat))]
    assert len(hits) <= 1
    return hits[0] if hits else None


def test_build_candidates_from_polygons():
    b23, b18, p18, kiban, r = _scenario()
    cands, stats = diff.build_candidates(*TILE, b23, b18, p18, kiban)
    by = {name: _find(cands, rect) for name, rect in r.items()}

    assert by["N"]["properties"]["class"] == CLASS_NEW and by["N"]["properties"]["reason"] == "new_absent_2018"
    assert by["P"]["properties"]["class"] == CLASS_OMISSION and by["P"]["properties"]["reason"] == "present_2018"
    assert by["U"]["properties"]["class"] == CLASS_UNCERTAIN and by["U"]["properties"]["reason"] == "ambiguous"
    assert by["E"]["properties"]["class"] == CLASS_UNCERTAIN and by["E"]["properties"]["reason"] == "edge"
    assert by["K"] is None  # 建物データにある → 対象外
    assert by["S"] is None  # 20 m² 未満 → 捨てる
    assert stats["in_kiban"] == 1 and stats["dropped_small"] == 1 and stats["candidates"] == 4
    assert stats[CLASS_NEW] == 1 and stats[CLASS_OMISSION] == 1 and stats[CLASS_UNCERTAIN] == 2
    assert stats["buildings_2023"] == 6

    # 根拠の数字
    ev = {k: v["properties"]["evidence"] for k, v in by.items() if v}
    assert ev["N"]["ov_2018"] == 0.0 and ev["N"]["prob_2018_p90"] == 0.0 and ev["N"]["ov_kiban"] == 0.0
    assert ev["P"]["ov_2018"] == pytest.approx(1.0, abs=1e-3) and ev["P"]["prob_2018_p90"] == pytest.approx(0.9)
    assert ev["U"]["ov_2018"] == pytest.approx(0.3, abs=0.01)
    assert ev["U"]["prob_2018_p90"] == pytest.approx(0.9)  # 左 30% に 0.9。p90 は高い側
    assert ev["E"]["edge_touch"] is True and ev["N"]["edge_touch"] is False
    assert ev["N"]["prob_2023_mean"] == pytest.approx(0.9)
    # 面積は m²（EPSG:6670）。N は 20×20 画素
    _, lat = tilemath.tile_center_lonlat(*TILE)
    assert by["N"]["properties"]["area_m2"] == pytest.approx(400 * tilemath.ground_resolution_m(18, lat) ** 2, rel=0.01)


def test_candidate_properties_shape():
    b23, b18, p18, kiban, _ = _scenario()
    cands, _ = diff.build_candidates(*TILE, b23, b18, p18, kiban)
    for cand in cands:
        p = cand["properties"]
        assert set(p) == {"area_id", "class", "area_m2", "bbox", "centroid", "evidence", "reason"}
        assert set(p["evidence"]) == {"prob_2023_mean", "ov_2018", "prob_2018_p90", "ov_kiban", "edge_touch"}
        assert p["area_id"] == tilemath.area_id(*TILE)
        w, s, e, n = p["bbox"]
        lon, lat = p["centroid"]
        assert w < lon < e and s < lat < n
        assert cand["geometry"].geom_type == "Polygon"
        assert p["class"] in diff.CLASSES and p["reason"] in diff.REASONS


def test_without_any_kiban_everything_is_an_entry():
    b23, b18, p18, _, r = _scenario()
    cands, stats = diff.build_candidates(*TILE, b23, b18, p18, [])
    assert _find(cands, r["K"]) is not None and stats["in_kiban"] == 0


def test_empty_inputs():
    cands, stats = diff.build_candidates(*TILE, [], [], np.zeros((256, 256)), [])
    assert cands == [] and stats["candidates"] == 0


def test_p90_uses_2018_probability_even_when_below_building_threshold():
    """2018 の確率が弱く出ている（閾値未満）→ 2018 の建物には入らない（ov_2018=0）が、p90 は 0.2 以上で、保留になる。"""
    r = (100, 100, 140, 140)
    b23 = vectorize.vectorize_tile(prob_with_rects([r]), *TILE)
    weak = prob_with_rects([r], value=0.25)
    b18 = vectorize.vectorize_tile(weak, *TILE, threshold=0.5)
    assert b18 == []
    cands, _ = diff.build_candidates(*TILE, b23, b18, weak, [])
    assert [(x["properties"]["class"], x["properties"]["reason"]) for x in cands] == [(CLASS_UNCERTAIN, "ambiguous")]
    assert cands[0]["properties"]["evidence"]["prob_2018_p90"] == pytest.approx(0.25)
    assert cands[0]["properties"]["evidence"]["ov_2018"] == 0.0


def test_number_candidates_by_area_desc_with_stable_ties():
    def cand(area, cx):
        return {"geometry": None, "properties": {"area_m2": area, "centroid": [cx, 32.0]}}

    items = [cand(50.0, 130.3), cand(200.0, 130.9), cand(50.0, 130.1), cand(80.0, 130.5)]
    out = diff.number_candidates(226249, 105769, items)
    assert [o["id"] for o in out] == [f"c-226249-105769-{n}" for n in (1, 2, 3, 4)]
    assert [o["properties"]["area_m2"] for o in out] == [200.0, 80.0, 50.0, 50.0]
    assert [o["properties"]["centroid"][0] for o in out][2:] == [130.1, 130.3]  # 同じ面積は西から
    assert diff.number_candidates(1, 2, []) == []
