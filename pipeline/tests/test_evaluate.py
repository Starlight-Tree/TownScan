import numpy as np
import pytest
from shapely.geometry import box

from pipeline import diff, evaluate, tilemath

from .helpers import TILE, prob_with_rects, rect_lonlat


# ---- 画素の指標（手計算できる 2×3 の例） ----

def test_pixel_counts_by_hand():
    pred = np.array([[1, 1, 0], [0, 1, 0]], dtype=bool)
    ref = np.array([[1, 0, 0], [0, 1, 1]], dtype=bool)
    # 重なり 2（(0,0)(1,1)）。予測だけ 1（(0,1)）、参照だけ 1（(1,2)）
    assert evaluate.pixel_counts(pred, ref) == (2, 1, 1)
    m = evaluate.pixel_metrics(2, 1, 1)
    assert m["iou"] == 0.5  # 2 / (2+1+1)
    assert m["precision"] == pytest.approx(0.6667, abs=1e-4)  # 2/3
    assert m["recall"] == pytest.approx(0.6667, abs=1e-4)
    assert m["f1"] == pytest.approx(0.6667, abs=1e-4)  # 4 / 6


def test_metrics_with_zero_denominators_are_none_not_zero_or_nan():
    m = evaluate.pixel_metrics(0, 0, 0)
    assert m["iou"] is None and m["precision"] is None and m["recall"] is None and m["f1"] is None
    o = evaluate.object_metrics(0, 2, 0)  # 予測だけあり、参照が無い
    assert o["precision"] == 0.0 and o["recall"] is None and o["f1"] == 0.0
    o = evaluate.object_metrics(0, 0, 3)  # 参照だけあり、予測が無い
    assert o["precision"] is None and o["recall"] == 0.0 and o["f1"] == 0.0


def test_object_metrics_by_hand():
    o = evaluate.object_metrics(3, 1, 2)
    assert o["precision"] == 0.75 and o["recall"] == 0.6
    assert o["f1"] == pytest.approx(0.6667, abs=1e-4)  # 6 / 9
    assert (o["n_ref"], o["n_pred"]) == (5, 4)


# ---- 物体の対応づけ ----

def test_match_iou_threshold_is_inclusive():
    ref = [box(0, 0, 10, 10)]
    assert evaluate.match_objects([box(0, 0, 10, 5)], ref) == 1  # IoU = 0.5 ちょうど
    assert evaluate.match_objects([box(0, 0, 10, 4.9)], ref) == 0  # 0.49
    assert evaluate.match_objects([box(20, 20, 30, 30)], ref) == 0  # 重ならない
    assert evaluate.match_objects([], ref) == 0 and evaluate.match_objects(ref, []) == 0


def test_match_is_one_to_one():
    ref = [box(0, 0, 10, 10)]
    two_halves = [box(0, 0, 10, 5), box(0, 5, 10, 10)]  # どちらも IoU 0.5
    assert evaluate.match_objects(two_halves, ref) == 1
    # 予測 1 つに、参照 2 つが IoU 0.5 以上ということは起きない（参照が重ならない限り）が、重なる参照でも 1 対 1
    assert evaluate.match_objects([box(0, 0, 10, 10)], [box(0, 0, 10, 10), box(0, 0, 10, 10)]) == 1


def test_match_greedy_by_iou_gives_maximum_here():
    # 参照 R0（10×10）・R1（10×8）。予測 P0（10×6）は R0 と 0.6・R1 と 0.75、P1（10×8）は R1 と 1.0・R0 と 0.8
    r0, r1 = box(0, 0, 10, 10), box(0, 0, 10, 8)
    p0, p1 = box(0, 0, 10, 6), box(0, 0, 10, 8)
    assert evaluate.match_objects([p0, p1], [r0, r1]) == 2  # IoU の大きい順: P1-R1(1.0) → P0-R0(0.6)


# ---- 縁の除外（手計算） ----

def _edge_case_arrays(scale=1.0):
    """内側の建物 X（20×20）を予測・参照の両方に、縁の建物 Y（右端に接する）も両方に、予測だけの内側の建物 Z（10×10）を置く。"""
    X, Y, Z = (50, 50, 70, 70), (236, 100, 256, 120), (150, 150, 160, 160)
    prob = prob_with_rects([X, Y, Z], scale=scale)
    reference = evaluate.prepare_reference(*TILE, [rect_lonlat(*X), rect_lonlat(*Y)])
    return prob, reference


def test_prepare_reference_excludes_edge_buildings_and_counts_them():
    X, Y = (50, 50, 70, 70), (236, 100, 256, 120)
    outside = rect_lonlat(0, 0, 10, 10, tile=(18, 226249 + 5, 105769))  # 別のタイルの建物は数えない
    ref = evaluate.prepare_reference(*TILE, [rect_lonlat(*X), rect_lonlat(*Y), outside])
    assert (ref.n_total, ref.n_edge, len(ref.polys)) == (2, 1, 1)


@pytest.mark.parametrize("scale", [1.0, 1.5, 2.0])
def test_evaluate_tile_excludes_edge_objects_from_both_sides(scale):
    prob, reference = _edge_case_arrays(scale)
    c = evaluate.evaluate_tile(prob, *TILE, reference, threshold=0.5)
    k = scale * scale
    # 画素: X が一致（400 画素×k）、Z が予測だけ（100×k）、縁の Y は両方から外す → 参照だけの画素は 0
    assert (c.px_tp, c.px_fp, c.px_fn) == (400 * k, 100 * k, 0)
    # 物体: 参照（縁を除く）は X の 1、予測（縁を除く）は X と Z の 2
    assert (c.n_ref, c.n_pred, c.obj_tp, c.obj_fp, c.obj_fn) == (1, 2, 1, 1, 0)
    assert (c.excl_ref, c.excl_pred) == (1, 1)
    m = evaluate.metrics_from_counts(c)
    assert m["pixel"]["iou"] == 0.8 and m["pixel"]["precision"] == 0.8 and m["pixel"]["recall"] == 1.0
    assert m["object"]["f1"] == pytest.approx(0.6667, abs=1e-4)


# ---- 縁の除外は左右で対称（監査の ex7a・ex7b。修正前は、片側だけ外れて FP・FN が残った） ----

def _tile_counts(pred_rects, ref_rects, scale=1.0):
    reference = evaluate.prepare_reference(*TILE, [rect_lonlat(*r) for r in ref_rects])
    return evaluate.evaluate_tile(prob_with_rects(pred_rects, scale=scale), *TILE, reference, threshold=0.5)


def _zero_metrics(c):
    return (c.px_tp, c.px_fp, c.px_fn, c.obj_tp, c.obj_fp, c.obj_fn, c.n_ref, c.n_pred)


@pytest.mark.parametrize("scale", [1.0, 1.5, 2.0])
def test_prediction_stopping_short_of_the_edge_is_dropped_with_its_edge_reference(scale):
    """ex7a: 参照は右端に接し、予測は縁の 2 画素手前で止まる（縁に接しない）。参照だけ外れて予測が FP に残ってはならない。"""
    c = _tile_counts([(236, 100, 254, 120)], [(236, 100, 256, 120)], scale)
    assert _zero_metrics(c) == (0, 0, 0, 0, 0, 0, 0, 0)
    assert (c.excl_ref, c.excl_pred, c.excl_ref_overlap, c.excl_pred_overlap) == (1, 1, 0, 1)


@pytest.mark.parametrize("scale", [1.0, 1.5, 2.0])
def test_reference_one_pixel_inside_the_edge_is_dropped_with_its_edge_prediction(scale):
    """ex7b: 予測は右端に届き（縁に接する）、参照は縁の 1 画素内側（縁に接しない）。参照が FN に残ってはならない。"""
    c = _tile_counts([(236, 100, 256, 120)], [(237, 100, 255, 120)], scale)
    assert _zero_metrics(c) == (0, 0, 0, 0, 0, 0, 0, 0)
    assert (c.excl_ref, c.excl_pred, c.excl_ref_overlap, c.excl_pred_overlap) == (1, 1, 1, 0)


def test_merged_edge_prediction_drops_the_interior_references_it_swallowed():
    """縁まで届いて隣の建物と合体した予測（縁に接する）の中の参照 2 棟は、FN に残さず外す。縁の参照 1 棟は元から外れる。"""
    interior_a, interior_b, edge = (200, 100, 215, 120), (220, 100, 235, 120), (240, 100, 256, 120)
    c = _tile_counts([(200, 100, 256, 120)], [interior_a, interior_b, edge])
    assert _zero_metrics(c) == (0, 0, 0, 0, 0, 0, 0, 0)
    assert (c.excl_ref, c.excl_pred, c.excl_ref_overlap, c.excl_pred_overlap) == (3, 1, 2, 0)


def test_symmetric_exclusion_leaves_unrelated_objects_alone():
    """縁と関係のない一致（X）と誤検出（Z）は、縁の例を足しても、数も画素も変わらない。"""
    X, Z = (50, 50, 70, 70), (150, 150, 160, 160)
    base = _tile_counts([X, Z], [X])
    with_edge = _tile_counts([X, Z, (236, 100, 254, 120)], [X, (236, 100, 256, 120)])
    assert _zero_metrics(with_edge) == _zero_metrics(base) == (400, 100, 0, 1, 1, 0, 1, 2)
    assert with_edge.excl_pred_overlap == 1


def test_overlap_below_half_keeps_the_object():
    """縁の参照との重なりが自分の面積の半分未満なら外さない（予測は FP のまま残る。参照の画素は縁で外れているので、画素も FP）。"""
    c = _tile_counts([(200, 100, 242, 120)], [(236, 100, 256, 120)])  # 予測 42 画素幅のうち、参照と重なるのは 6 画素幅（約 14%）
    assert (c.n_pred, c.obj_fp, c.excl_pred, c.excl_pred_overlap) == (1, 1, 0, 0)
    assert (c.px_fp, c.px_tp, c.px_fn) == (42 * 20, 0, 0)


def test_overlapping_threshold_is_inclusive_and_uses_the_union_of_others():
    own = [box(0, 0, 10, 10)]
    assert evaluate.overlapping(own, [box(5, 0, 15, 10)]) == {0}  # 自分の面積のちょうど半分 → 外す
    assert evaluate.overlapping(own, [box(5.1, 0, 15, 10)]) == set()  # 49%
    assert evaluate.overlapping(own, [box(6, 0, 15, 10), box(3.5, 0, 6, 10)]) == {0}  # 40% + 25%（別々では半分に届かず、和で超える）
    assert evaluate.overlapping(own, [box(2, 0, 8, 10), box(4, 0, 9, 10)]) == {0}  # 重なる相手は二重に数えない（和は 70%）
    assert evaluate.overlapping([], [box(0, 0, 1, 1)]) == set() and evaluate.overlapping(own, []) == set()


def test_prepare_reference_keeps_edge_polygons_for_the_symmetric_rule():
    X, Y = (50, 50, 70, 70), (236, 100, 256, 120)
    ref = evaluate.prepare_reference(*TILE, [rect_lonlat(*X), rect_lonlat(*Y)])
    assert len(ref.edge_polys) == ref.n_edge == 1 and len(ref.polys) == 1


def test_evaluate_tile_perfect_prediction():
    X = (50, 50, 70, 70)
    ref = evaluate.prepare_reference(*TILE, [rect_lonlat(*X)])
    c = evaluate.evaluate_tile(prob_with_rects([X], scale=2.0), *TILE, ref, threshold=0.5)
    m = evaluate.metrics_from_counts(c)
    assert m["pixel"]["iou"] == 1.0 and m["object"]["f1"] == 1.0


def test_evaluate_tile_threshold_changes_result():
    X = (50, 50, 70, 70)
    ref = evaluate.prepare_reference(*TILE, [rect_lonlat(*X)])
    prob = prob_with_rects([X], value=0.4)
    assert evaluate.evaluate_tile(prob, *TILE, ref, threshold=0.5).obj_tp == 0  # 0.4 は閾値 0.5 未満
    assert evaluate.evaluate_tile(prob, *TILE, ref, threshold=0.3).obj_tp == 1


def test_counts_add():
    a = evaluate.Counts(px_tp=1, obj_fp=2, excl_ref=3)
    b = evaluate.Counts(px_tp=10, obj_fp=20, excl_ref=30, n_pred=5)
    s = a + b
    assert (s.px_tp, s.obj_fp, s.excl_ref, s.n_pred) == (11, 22, 33, 5)


# ---- 分割と選択 ----

@pytest.mark.parametrize("n, tune, holdout", [(12, 6, 6), (11, 5, 6), (2, 1, 1), (1, 0, 1), (0, 0, 0)])
def test_split_tiles(n, tune, holdout):
    tiles = list(range(n))
    t, h = evaluate.split_tiles(tiles)
    assert (len(t), len(h)) == (tune, holdout)
    assert t + h == tiles and t == tiles[: n // 2]  # 前半が調整用・後半が評価用


def _row(scale, thr, f1o, f1p):
    return {"scale": scale, "threshold": thr, "tune_object_f1": f1o, "tune_pixel_f1": f1p}


def test_choose_setting_tie_breaks():
    # 物体 F1 が最大
    assert evaluate.choose_setting([_row(1.0, 0.5, 0.4, 0.9), _row(2.0, 0.3, 0.5, 0.1)])["scale"] == 2.0
    # 同点なら画素 F1
    assert evaluate.choose_setting([_row(1.0, 0.5, 0.5, 0.6), _row(2.0, 0.5, 0.5, 0.7)])["scale"] == 2.0
    # さらに同点なら、倍率が小さい方
    assert evaluate.choose_setting([_row(2.0, 0.5, 0.5, 0.6), _row(1.5, 0.5, 0.5, 0.6)])["scale"] == 1.5
    # さらに同点なら、閾値が 0.5 に近い方
    assert evaluate.choose_setting([_row(1.0, 0.3, 0.5, 0.6), _row(1.0, 0.6, 0.5, 0.6)])["threshold"] == 0.6
    # 0.4 と 0.6 は 0.5 から等距離 → 小さい方
    assert evaluate.choose_setting([_row(1.0, 0.6, 0.5, 0.6), _row(1.0, 0.4, 0.5, 0.6)])["threshold"] == 0.4
    # None（定義できない）は最も悪い扱い
    assert evaluate.choose_setting([_row(1.0, 0.5, None, None), _row(2.0, 0.5, 0.0, 0.0)])["scale"] == 2.0


# ---- 全体の流れ（選択が調整用だけで行われること） ----

def _four_tiles():
    return [(18, 226249 + i, 105769) for i in range(4)]


def _refs_and_loader(tiles, good_scale):
    rect = (60, 60, 100, 100)
    refs = {t: evaluate.prepare_reference(*t, [rect_lonlat(*rect, tile=t)]) for t in tiles}
    calls = []

    def load(tile, scale):
        calls.append((tile, scale))
        # good_scale のときだけ参照と一致。それ以外は大きくずらす（物体は一致しない）
        r = rect if scale == good_scale else (160, 160, 200, 200)
        return prob_with_rects([r], scale=scale)

    return refs, load, calls


def test_run_evaluation_selects_on_tune_only_and_reports_separately():
    tiles = _four_tiles()
    refs, load, calls = _refs_and_loader(tiles, good_scale=1.5)
    out = evaluate.run_evaluation(tiles, load, refs, thresholds=(0.3, 0.5, 0.7))
    assert out["chosen"]["scale"] == 1.5 and out["chosen"]["threshold"] == 0.5
    assert out["split"] == {"tune": [tilemath.area_id(*t) for t in tiles[:2]], "holdout": [tilemath.area_id(*t) for t in tiles[2:]]}
    assert len(out["sweep"]) == 3 * 3 and all(r["tune_object_f1"] is not None for r in out["sweep"])
    # 評価用のタイルは、選んだ倍率でしか読まれていない（選択に使っていない）
    holdout_scales = {s for (t, s) in calls if t in tiles[2:]}
    assert holdout_scales == {1.5}
    assert out["tune"]["object"]["f1"] == 1.0 and out["holdout"]["object"]["f1"] == 1.0
    assert out["overall"]["object"]["tp"] == 4
    assert [a["split"] for a in out["per_area"]] == ["tune", "tune", "holdout", "holdout"]
    assert out["new_building_recall"] is None
    assert set(out["excluded_edge_objects"]) == {"reference", "prediction"}  # 平らな辞書（画面がそのまま表示する）
    assert set(out["excluded_edge_by_split"]) == {"tune", "holdout"}
    assert isinstance(out["reference"], str)
    # 地区ごとの行は平ら（入れ子の値を持たない）
    assert all(not isinstance(v, (dict, list)) for row in out["per_area"] for v in row.values())
    for key in ("reference", "split", "sweep", "chosen", "holdout", "tune", "per_area", "excluded_edge_objects", "new_building_recall", "notes"):
        assert key in out
    assert any("未測定" in n for n in out["notes"])


def test_run_evaluation_needs_two_tiles():
    tiles = _four_tiles()[:1]
    refs, load, _ = _refs_and_loader(tiles, 1.0)
    with pytest.raises(ValueError):
        evaluate.run_evaluation(tiles, load, refs)


def test_holdout_does_not_influence_choice():
    """評価用のタイルの中身を変えても、選ばれる値は変わらない。"""
    tiles = _four_tiles()
    refs, load, _ = _refs_and_loader(tiles, good_scale=1.0)
    a = evaluate.run_evaluation(tiles, load, refs, thresholds=(0.3, 0.5, 0.7))

    def load_bad_holdout(tile, scale):
        return np.zeros((int(256 * scale),) * 2) if tile in tiles[2:] else load(tile, scale)

    b = evaluate.run_evaluation(tiles, load_bad_holdout, refs, thresholds=(0.3, 0.5, 0.7))
    assert a["chosen"] == b["chosen"] and a["sweep"] == b["sweep"]
    assert b["holdout"]["object"]["f1"] == 0.0 and a["holdout"]["object"]["f1"] == 1.0


def test_tile_without_reference_objects_has_null_metrics_and_a_note():
    tiles = _four_tiles()
    refs, load, _ = _refs_and_loader(tiles, good_scale=1.0)
    refs[tiles[3]] = evaluate.Reference(polys=[], n_total=0, n_edge=0)
    out = evaluate.run_evaluation(tiles, load, refs, thresholds=(0.5,))
    row = out["per_area"][3]
    assert row["n_ref"] == 0 and row["object_recall"] is None and row["object_f1"] == 0.0  # 予測だけある → 適合率 0
    assert any(tilemath.area_id(*tiles[3]) in n for n in out["notes"])


# ---- 追加の診断（eval.json の任意項目） ----

def test_run_evaluation_adds_year_compare_without_changing_existing_keys():
    tiles = _four_tiles()
    refs, load, _ = _refs_and_loader(tiles, good_scale=1.5)
    base = evaluate.run_evaluation(tiles, load, refs, thresholds=(0.3, 0.5, 0.7))
    # 評価の年（2014）は参照と一致する抽出。比べる年（2024）は何も抽出しない配列。2 年の値が混ざらないことも見る
    out = evaluate.run_evaluation(
        tiles, load, refs, thresholds=(0.3, 0.5, 0.7), load_prob_compare=lambda k, s: np.zeros((int(256 * s),) * 2), compare_year=2024
    )
    assert "year_compare" not in base and "compare_year" not in base["protocol"]
    # 既存のキー・値は、追加の有無で変わらない
    for key in base:
        if key not in ("notes",):
            assert out[key] == base[key] or key == "protocol", key
    assert {k: v for k, v in out["protocol"].items() if k != "compare_year"} == base["protocol"]
    assert out["protocol"]["year"] == 2014 and out["protocol"]["compare_year"] == 2024  # 評価の年は 2014 のまま。比べる年を別に明示
    yc = out["year_compare"]
    assert (yc["selected_on_year"], yc["compare_year"]) == (2014, 2024)
    assert yc["setting"] == {"scale": out["chosen"]["scale"], "threshold": out["chosen"]["threshold"]}
    assert set(yc["by_year"]) == {"2014", "2024"} and set(yc["by_year"]["2024"]) == {"tune", "holdout", "overall"}
    # 2014 年の側は、トップレベルの値と同じ（同じ集計から出す）。2024 年（何も抽出しない）は 0
    assert yc["by_year"]["2014"] == {"tune": out["tune"], "holdout": out["holdout"], "overall": out["overall"]}
    assert yc["by_year"]["2024"]["overall"]["object"]["tp"] == 0 and yc["by_year"]["2024"]["overall"]["object"]["fn"] == 4
    assert yc["by_year"]["2024"]["overall"]["pixel"]["recall"] == 0.0 and yc["by_year"]["2024"]["overall"]["pixel"]["precision"] is None
    assert any("year_compare" in n for n in out["notes"]) and not any("year_compare" in n for n in base["notes"])


def test_year_compare_arguments_are_validated():
    tiles = _four_tiles()
    refs, load, _ = _refs_and_loader(tiles, 1.0)
    with pytest.raises(ValueError):
        evaluate.run_evaluation(tiles, load, refs, load_prob_compare=load)  # 年が無い
    with pytest.raises(ValueError):
        evaluate.run_evaluation(tiles, load, refs, compare_year=2024)  # 読み込み関数が無い
    with pytest.raises(ValueError):
        evaluate.run_evaluation(tiles, load, refs, load_prob_compare=load, compare_year=evaluate.EVAL_YEAR)  # 同じ年


def _absence_setup():
    """参照 4 棟 + 小さい 1 棟 + 縁の 1 棟。2014 年の確率は、A にだけ高く、D には弱く（閾値未満）、B・C には無い。"""
    A, B, D = (50, 50, 70, 70), (100, 100, 120, 120), (150, 50, 170, 70)
    small = (200, 200, 205, 205)  # 約 3 m 四方 = 9 m² < 20 m²
    edge = (236, 100, 256, 120)
    reference = evaluate.prepare_reference(*TILE, [rect_lonlat(*r) for r in (A, B, D, small, edge)])
    prob = prob_with_rects([A, (D, 0.3)])
    return reference, prob


def test_reference_vs_2014_counts_absent_and_present_with_the_diff_rules():
    reference, prob = _absence_setup()
    r = evaluate.reference_vs_2014(prob, *TILE, reference, threshold=0.5, params=diff.DiffParams())
    # 数える: A（覆われる=present）・B（何も無い=absent）・D（弱く出ていて、どちらでもない）。小さい 1 棟と縁の 1 棟は数えない
    assert r == {"n": 3, "absent": 1, "present": 1}
    # 閾値を下げると D も抽出される → absent は B だけのまま、present が増える
    assert evaluate.reference_vs_2014(prob, *TILE, reference, threshold=0.3, params=diff.DiffParams()) == {"n": 3, "absent": 1, "present": 2}
    # 面積の下限を上げると、数える建物が減る（params をそのまま使う）
    big_only = diff.DiffParams(min_area_m2=200.0)
    assert evaluate.reference_vs_2014(prob, *TILE, reference, threshold=0.5, params=big_only)["n"] == 0


def test_run_evaluation_reports_existing_absent_in_2014_by_split():
    tiles = _four_tiles()
    refs, load, _ = _refs_and_loader(tiles, good_scale=1.0)  # 参照の矩形 (60,60,100,100) と一致する抽出
    out = evaluate.run_evaluation(tiles, load, refs, thresholds=(0.5,), scales=(1.0,))
    e = out["existing_absent_in_2014"]
    assert e["setting"] == {"scale": 1.0, "threshold": 0.5} and e["params"] == diff.DiffParams().to_dict()
    for part in ("tune", "holdout", "overall"):
        assert set(e[part]) == {"n_buildings", "absent", "absent_share", "present", "present_share"}
    assert e["overall"] == {"n_buildings": 4, "absent": 0, "absent_share": 0.0, "present": 4, "present_share": 1.0}
    assert e["tune"]["n_buildings"] == e["holdout"]["n_buildings"] == 2
    assert any("existing_absent_in_2014" in n and "正解データの代わりにはならない" in n for n in out["notes"])
    # 抽出が何も無ければ、既存の建物はすべて「何も見ていない」
    none = evaluate.run_evaluation(tiles, lambda k, s: np.zeros((int(256 * s),) * 2), refs, thresholds=(0.5,), scales=(1.0,))
    assert none["existing_absent_in_2014"]["overall"] == {"n_buildings": 4, "absent": 4, "absent_share": 1.0, "present": 0, "present_share": 0.0}


def test_excluded_edge_detail_adds_up_to_excluded_edge_objects():
    tiles = _four_tiles()
    rect = (60, 60, 100, 100)
    refs = {t: evaluate.prepare_reference(*t, [rect_lonlat(*rect, tile=t), rect_lonlat(236, 100, 256, 120, tile=t)]) for t in tiles}
    # 予測: 一致する 1 棟 + 縁の手前で止まった 1 棟（縁の参照と重なって外れる）
    out = evaluate.run_evaluation(tiles, lambda k, s: prob_with_rects([rect, (236, 100, 254, 120)], scale=s), refs, thresholds=(0.5,), scales=(1.0,))
    d, total = out["excluded_edge_detail"], out["excluded_edge_objects"]
    assert d["overall"] == {
        "reference": {"touching_edge": 4, "overlapping_excluded_prediction": 0},
        "prediction": {"touching_edge": 0, "overlapping_excluded_reference": 4},
    }
    assert total == {"reference": 4, "prediction": 4}
    for part in ("overall", "tune", "holdout"):
        src = total if part == "overall" else out["excluded_edge_by_split"][part]
        assert sum(d[part]["reference"].values()) == src["reference"] and sum(d[part]["prediction"].values()) == src["prediction"]
    assert out["overall"]["object"]["tp"] == 4 and out["overall"]["object"]["fp"] == 0  # 縁の手前の予測は FP に残らない
