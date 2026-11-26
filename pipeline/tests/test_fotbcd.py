"""FOTBCD の読み込みと指標（仕様 §6.1・ADR 0015）。期待値は、矩形の座標から手で計算した値。

座標は組の画素（512 px・0.2 m/px）。48 px の正方形は 9.6 m 四方 = 92.16 m²。
どの辺も 8 の倍数にした矩形は、倍率 0.5（256）・0.625（320）でも画素の境目に乗る。
"""

from __future__ import annotations

import io
import json
import tarfile

import numpy as np
import pytest

from pipeline import evaluate_fotbcd as ev
from pipeline import fotbcd

NAMES = {1: "UNCHANGED", 2: "DEMOLISHED", 3: "NEW"}
IDS = {v: k for k, v in NAMES.items()}


def ring(x0, y0, x1, y1):
    return [x0, y0, x1, y0, x1, y1, x0, y1]


def doc(footprints, dep="92", years=("2014", "2024")):
    """footprints は [(分類, (x0, y0, x1, y1))]。"""
    return {
        "image": {
            "dep": dep,
            "before_year": years[0],
            "after_year": years[1],
            "width": 512,
            "height": 512,
            "epsg": 2154,
            "patch_bounds": {"minx": 641433.6, "miny": 6861825.6, "maxx": 641536.0, "maxy": 6861928.0},
        },
        "categories": [{"id": i, "name": n} for i, n in NAMES.items()],
        "annotations": [{"category_id": IDS[label], "segmentation": [ring(*rect)]} for label, rect in footprints],
    }


def pair(footprints, key="000000000", **kw):
    return fotbcd.parse_pair(key, doc(footprints, **kw))


def prob(rects, size=512, value=0.9, background=0.0):
    """画素の矩形を塗った確率の配列。矩形は rect か (rect, 値)。"""
    a = np.full((size, size), background, dtype=np.float32)
    for r in rects:
        rect, v = r if isinstance(r[0], tuple) else (r, value)
        x0, y0, x1, y1 = (int(round(c * size / 512)) for c in rect)
        a[y0:y1, x0:x1] = v
    return a


def write_tar(path, docs: dict, extra: dict | None = None, skip=()):
    members = {}
    for key, d in docs.items():
        members.update({f"{key}.before.png": b"png", f"{key}.after.png": b"png", f"{key}.json": json.dumps(d).encode()})
    members.update(extra or {})
    with tarfile.open(path, "w") as tf:
        for name, data in members.items():
            if name in skip:
                continue
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
    return path


# ---- 読み込み ----

def test_footprints_are_converted_to_metres_and_edge_is_detected():
    p = pair([("NEW", (40, 40, 88, 88)), ("UNCHANGED", (464, 200, 512, 248)), ("DEMOLISHED", (0, 300, 48, 348))])
    assert p.footprints[0].geom.area == pytest.approx(92.16)
    assert p.footprints[0].geom.bounds == pytest.approx((8.0, 8.0, 17.6, 17.6))
    assert [f.edge_touch for f in p.footprints] == [False, True, True]
    assert [f.label for f in p.refs("before")] == ["UNCHANGED", "DEMOLISHED"]
    assert [f.label for f in p.refs("after")] == ["NEW", "UNCHANGED"]


def test_edge_is_strict_but_allows_rounding_error():
    near = pair([("NEW", (400, 200, 511.5, 248)), ("NEW", (400, 300, 511.9999999, 348))])
    assert [f.edge_touch for f in near.footprints] == [False, True]


def test_read_pairs_sorted_by_key(tmp_path):
    tar = write_tar(tmp_path / "val-x.tar", {"000000002": doc([], dep="29"), "000000001": doc([("NEW", (40, 40, 88, 88))])})
    pairs = fotbcd.read_pairs(tar)
    assert [(p.key, p.dep, len(p.footprints)) for p in pairs] == [("000000001", "92", 1), ("000000002", "29", 0)]


def _broken(change):
    d = doc([("NEW", (40, 40, 88, 88))])
    change(d)
    return d


@pytest.mark.parametrize(
    "change",
    [
        lambda d: d["image"].update(width=256),
        lambda d: d["image"].update(epsg=4326),
        lambda d: d["image"]["patch_bounds"].update(maxx=641600.0),
        lambda d: d["categories"].append({"id": 4, "name": "OTHER"}),
        lambda d: d["annotations"][0].update(category_id=9),
        lambda d: d["annotations"][0].update(segmentation=[ring(40, 40, 88, 88), ring(1, 1, 2, 2)]),
        lambda d: d["annotations"][0].update(segmentation=[[40, 40, 88, 40, 88]]),
        lambda d: d["annotations"][0].update(segmentation=[ring(40, 40, 513, 88)]),
        lambda d: d["annotations"][0].update(segmentation=[[40, 40, 88, 40, 64, 40]]),
        lambda d: d.pop("annotations"),
    ],
)
def test_broken_pair_stops_with_its_key(change):
    with pytest.raises(ValueError, match="000000007"):
        fotbcd.parse_pair("000000007", _broken(change))


@pytest.mark.parametrize(
    "kwargs",
    [{"skip": ("000000000.after.png",)}, {"extra": {"notes.txt": b"x"}}, {"extra": {"../000000001.json": b"{}"}}],
)
def test_incomplete_or_unexpected_members_stop(tmp_path, kwargs):
    tar = write_tar(tmp_path / "val-x.tar", {"000000000": doc([])}, **kwargs)
    with pytest.raises(ValueError):
        fotbcd.read_pairs(tar)


# ---- 建物の取り出し ----

@pytest.mark.parametrize("size", [256, 320, 512])
def test_predicted_area_is_the_same_in_every_input_size(size):
    (b,) = ev.predict_buildings(prob([(40, 40, 88, 88)], size), 0.5)
    assert b.area_m2 == pytest.approx(92.16, abs=0.5)  # 単純化で角が欠けない
    assert b.geom.bounds == pytest.approx((8.0, 8.0, 17.6, 17.6))
    assert not b.edge_touch


def test_blob_under_4_m2_is_removed():
    # 8×8 px = 2.56 m²（消える）・16×16 px = 10.24 m²（残る）
    (b,) = ev.predict_buildings(prob([(40, 40, 48, 48), (160, 160, 176, 176)]), 0.5)
    assert b.area_m2 == pytest.approx(10.24)


# ---- 新築の指標（手計算の場面） ----

U1, N1, N2, N3 = (40, 40, 88, 88), (160, 40, 208, 88), (280, 40, 328, 88), (400, 40, 448, 88)
D1, F1 = (40, 160, 88, 208), (160, 160, 208, 208)
N3_UPPER_THIRD = (400, 40, 448, 56)  # N3 の 48 px のうち 16 px（1/3）を覆う。48×16 px = 30.72 m²


def _scene(size):
    p = pair([("UNCHANGED", U1), ("NEW", N1), ("NEW", N2), ("NEW", N3), ("DEMOLISHED", D1)])
    before = prob([U1, D1, N3_UPPER_THIRD], size)
    after = prob([U1, N1, N3, F1], size)  # N2 は見落とす。F1 は正解の無い建物
    return p, before, after


@pytest.mark.parametrize("size", [256, 320, 512])
def test_scene_by_hand(size):
    c = ev.pair_counts(*_scene(size), threshold=0.5)
    # 前の写真: 正解 U1・D1、予測 U1・D1・N3 の上 1/3 → 対応 2・誤検出 1・見落とし 0
    assert (c["before.tp"], c["before.fp"], c["before.fn"]) == (2, 1, 0)
    # 後の写真: 正解 U1・N1・N2・N3、予測 U1・N1・N3・F1 → 対応 3・誤検出 1・見落とし 1
    assert (c["after.tp"], c["after.fp"], c["after.fn"]) == (3, 1, 1)
    # U1 は前でも検出（候補にしない）。N1・F1 は未検出。N3 は ov=1/3 で未判定
    assert (c["new.n_ref"], c["new.n_pred"], c["new.tp"]) == (3, 2, 1)
    assert (c["new.unc.n_pred"], c["new.unc.tp"]) == (3, 2)


def test_faint_probability_in_before_photo_makes_a_candidate_uncertain():
    # 前の写真の確率が 0.25: 閾値 0.3 では建物にならない（ov=0）が、p90 >= 0.2 なので「未検出」ではない
    p = pair([("NEW", N1)])
    c = ev.pair_counts(p, prob([(N1, 0.25)]), prob([N1]), threshold=0.3)
    assert (c["new.tp"], c["new.n_pred"]) == (0, 0)
    assert (c["new.unc.tp"], c["new.unc.n_pred"]) == (1, 1)
    c = ev.pair_counts(p, prob([(N1, 0.19)]), prob([N1]), threshold=0.3)
    assert (c["new.tp"], c["new.n_pred"]) == (1, 1)


def test_new_candidate_matching_an_unchanged_footprint_is_a_false_positive():
    # 前の写真で見落とした、もとからある建物は、新築の精度を下げる
    c = ev.pair_counts(pair([("UNCHANGED", U1)]), prob([]), prob([U1]), threshold=0.5)
    assert (c["new.n_ref"], c["new.n_pred"], c["new.tp"]) == (0, 1, 0)


# ---- 除外（手計算） ----

def _excluded(footprints, after_rects):
    refs = pair(footprints).refs("after")
    c, kept_refs, kept_preds = ev.side_counts("after", refs, ev.predict_buildings(prob(after_rects), 0.5))
    ex = {w: [c[f"after.excluded.{w}.{k}"] for k in ev.EXCLUDE_KINDS] for w in ("reference", "prediction")}
    return len(kept_refs), len(kept_preds), ex["reference"], ex["prediction"]


def test_edge_reference_also_drops_the_prediction_that_stops_before_the_edge():
    # 予測 x=456〜504 のうち 464〜504（40/48 = 83%）が、端の正解と重なる
    assert _excluded([("NEW", (464, 200, 512, 248))], [(456, 200, 504, 248)]) == (0, 0, [1, 0, 0], [0, 0, 1])


def test_edge_prediction_also_drops_the_reference_inside_it():
    assert _excluded([("NEW", (8, 300, 56, 348))], [(0, 300, 48, 348)]) == (0, 0, [0, 0, 1], [1, 0, 0])


def test_overlap_below_half_keeps_the_other_side():
    # 予測 x=424〜472 のうち 464〜472（8/48 = 17%）だけが、端の正解と重なる → 誤検出に数える
    assert _excluded([("NEW", (464, 200, 512, 248))], [(424, 200, 472, 248)]) == (0, 1, [1, 0, 0], [0, 0, 0])


def test_small_reference_drops_a_mostly_covered_prediction():
    # 正解 20×20 px = 16 m²。予測 24×28 px = 26.88 m² のうち 400/672 = 60% が重なる
    assert _excluded([("NEW", (200, 300, 220, 320))], [(200, 300, 224, 328)]) == (0, 0, [0, 1, 0], [0, 0, 1])


def test_small_prediction_drops_a_mostly_covered_reference():
    assert _excluded([("NEW", (300, 300, 324, 328))], [(300, 300, 320, 320)]) == (0, 0, [0, 0, 1], [0, 1, 0])


def test_small_reference_does_not_drop_a_much_larger_prediction():
    # 400/2304 = 17%
    assert _excluded([("NEW", (200, 300, 220, 320))], [(200, 300, 248, 348)]) == (0, 1, [0, 1, 0], [0, 0, 0])


def test_exactly_20_m2_is_kept():
    # 20×25 px = 4 m × 5 m = 20 m²
    assert _excluded([("NEW", (200, 300, 220, 325))], [(200, 300, 220, 325)]) == (1, 1, [0, 0, 0], [0, 0, 0])


def test_edge_and_small_counts_once_as_edge():
    assert _excluded([("NEW", (500, 300, 512, 312))], []) == (0, 0, [1, 0, 0], [0, 0, 0])


# ---- 併記（端の除外だけを外した値） ----

EDGE_NEW, EDGE_OLD = (464, 200, 512, 248), (0, 400, 48, 448)  # 右の端・左の端に接する 92.16 m²
EDGE_SMALL = (500, 300, 512, 312)  # 端に接する 5.76 m²


def _with_edge(c):
    return {k.removeprefix("with_edge."): v for k, v in c.items() if k.startswith("with_edge.")}


def _after_excluded(c, who):
    return [c[f"after.excluded.{who}.{k}"] for k in ev.EXCLUDE_KINDS]


@pytest.mark.parametrize("size", [256, 320, 512])
def test_with_edge_adds_edge_buildings_without_changing_the_main_values(size):
    p = pair(
        [("UNCHANGED", U1), ("NEW", N1), ("NEW", N2), ("NEW", N3), ("DEMOLISHED", D1), ("NEW", EDGE_NEW), ("UNCHANGED", EDGE_OLD)]
    )
    before = prob([U1, D1, N3_UPPER_THIRD, EDGE_OLD], size)
    after = prob([U1, N1, N3, F1, EDGE_NEW, EDGE_OLD], size)
    c = ev.pair_counts(p, before, after, threshold=0.5)
    main = ev.pair_counts(*_scene(size), threshold=0.5)
    for key in ("before.tp", "before.fp", "before.fn", "after.tp", "after.fp", "after.fn"):
        assert c[key] == main[key]
    assert (c["new.n_ref"], c["new.n_pred"], c["new.tp"], c["new.unc.n_pred"], c["new.unc.tp"]) == (3, 2, 1, 3, 2)
    w = _with_edge(c)
    # 端の 2 件が、抽出に加わる。EDGE_OLD は前でも検出（候補にしない）。EDGE_NEW は「未検出」の候補になる（端でも未判定にしない）
    assert (w["before.tp"], w["before.fp"], w["before.fn"]) == (3, 1, 0)
    assert (w["after.tp"], w["after.fp"], w["after.fn"]) == (5, 1, 1)
    assert (w["new.n_ref"], w["new.n_pred"], w["new.tp"]) == (4, 3, 2)
    assert (w["new.unc.n_pred"], w["new.unc.tp"]) == (4, 3)


def test_with_edge_still_excludes_small_buildings_on_the_edge():
    c = ev.pair_counts(pair([("NEW", EDGE_SMALL)]), prob([]), prob([EDGE_SMALL]), threshold=0.5)
    assert (_after_excluded(c, "reference"), _after_excluded(c, "prediction")) == ([1, 0, 0], [1, 0, 0])
    w = _with_edge(c)
    assert (_after_excluded(w, "reference"), _after_excluded(w, "prediction")) == ([0, 1, 0], [0, 1, 0])
    assert (w["after.tp"], w["after.fp"], w["after.fn"], w["new.n_ref"], w["new.n_pred"]) == (0, 0, 0, 0, 0)


def test_with_edge_is_reported_per_department_and_does_not_choose_the_setting():
    pairs, probs = _two_pairs()
    for size in ev.SCALE_SIZES.values():
        probs[("000000001", "after", size)] = prob([(F1, 0.35), (EDGE_OLD, 0.9)], size)  # 端の誤検出を足す
    r = ev.run_evaluation(pairs, lambda k, s, n: probs[(k, s, n)])
    assert (r["chosen"]["scale"], r["chosen"]["threshold"]) == (0.5, 0.5)
    assert {row["after_object_f1"] for row in r["sweep"] if row["threshold"] == 0.5} == {1.0}  # 端の誤検出は入らない
    o = r["overall"]
    assert (o["extraction"]["after"]["fp"], o["with_edge"]["extraction"]["after"]["fp"]) == (0, 1)
    assert (o["new_building"]["n_pred"], o["with_edge"]["new_building"]["n_pred"]) == (1, 2)
    assert o["with_edge"]["new_building"]["precision"] == 0.5
    assert r["by_dep"]["13"]["with_edge"]["new_building"]["precision"] == 0.0
    assert r["by_dep"]["92"]["with_edge"]["new_building"]["precision"] == 1.0


# ---- 設定の選び方と、全体の流れ ----

def _two_pairs():
    pairs = [pair([("NEW", N1), ("UNCHANGED", U1)]), pair([], key="000000001", dep="13", years=("2014", "2023"))]
    probs = {}
    for size in ev.SCALE_SIZES.values():
        probs[("000000000", "before", size)] = prob([U1], size)
        # 正解の建物は 0.65、2 組目の誤検出は 0.35: 閾値 0.4〜0.6 が最良。0.3 は誤検出が増え、0.7 は何も出ない
        probs[("000000000", "after", size)] = prob([(U1, 0.65), (N1, 0.65)], size)
        probs[("000000001", "before", size)] = prob([], size)
        probs[("000000001", "after", size)] = prob([(F1, 0.35)], size)
    return pairs, probs


def test_setting_is_chosen_by_after_f1_with_ties_broken_by_scale_then_threshold():
    pairs, probs = _two_pairs()
    r = ev.run_evaluation(pairs, lambda k, s, n: probs[(k, s, n)])
    assert (r["chosen"]["scale"], r["chosen"]["threshold"]) == (0.5, 0.5)
    f1 = {(row["scale"], row["threshold"]): row["after_object_f1"] for row in r["sweep"]}
    assert len(f1) == 15
    assert f1[(1.0, 0.3)] == 0.8  # 対応 2・誤検出 1 → 4/5
    assert f1[(1.0, 0.5)] == 1.0
    assert f1[(1.0, 0.7)] == 0.0
    assert all(not any(k.startswith("new") for k in row) for row in r["sweep"])  # 新築の指標で選ばせない


def test_a_better_larger_scale_wins_over_the_tie_break():
    pairs, probs = _two_pairs()
    for size in (256, 320):
        probs[("000000000", "after", size)] = prob([(U1, 0.65)], size)  # 小さい入力では N1 を落とす
    r = ev.run_evaluation(pairs, lambda k, s, n: probs[(k, s, n)])
    assert (r["chosen"]["scale"], r["chosen"]["threshold"]) == (1.0, 0.5)


def test_totals_and_departments():
    pairs, probs = _two_pairs()
    r = ev.run_evaluation(pairs, lambda k, s, n: probs[(k, s, n)], fixed=(1.0, 0.3))
    assert r["chosen"] == {"scale": 1.0, "threshold": 0.3, "selected_by": "fixed"}
    assert [row["threshold"] for row in r["sweep"]] == [0.3]
    o = r["overall"]
    assert (o["pairs"], o["extraction"]["after"]["tp"], o["extraction"]["after"]["fp"]) == (2, 2, 1)
    # 新築の候補は N1 と、2 組目の誤検出 → 再現率 1/1・精度 1/2
    assert (o["new_building"]["recall"], o["new_building"]["precision"]) == (1.0, 0.5)
    assert list(r["by_dep"]) == ["13", "92"]
    d13 = r["by_dep"]["13"]
    assert d13["years"] == [{"before": "2014", "after": "2023", "pairs": 1}]
    assert d13["new_building"]["recall"] is None and d13["new_building"]["precision"] == 0.0
    assert r["by_dep"]["92"]["new_building"]["precision"] == 1.0


# ---- ファイルからの再現（コマンド 1 つ） ----

def _write_inputs(tmp_path, split="val"):
    pairs, probs = _two_pairs()
    docs = {
        "000000000": doc([("NEW", N1), ("UNCHANGED", U1)]),
        "000000001": doc([], dep="13", years=("2014", "2023")),
    }
    tar = write_tar(tmp_path / f"{split}-000000.tar", docs)
    probs_dir = tmp_path / "probs"
    probs_dir.mkdir()
    for (key, side, size), a in probs.items():
        np.save(probs_dir / f"{key}_{side}_{size}.npy", a.astype(np.float16))
    return tar, probs_dir


def test_command_writes_the_same_result_twice(tmp_path, capsys):
    tar, probs_dir = _write_inputs(tmp_path)
    (probs_dir / "meta.json").write_text('{"model": "dummy"}', encoding="utf-8")
    outs = []
    for name in ("a.json", "b.json"):
        out = tmp_path / name
        assert ev.main(["--split", "val", "--tar", str(tar), "--probs", str(probs_dir), "--out", str(out)]) == 0
        outs.append(out.read_text(encoding="utf-8"))
    assert outs[0] == outs[1]
    r = json.loads(outs[0])
    assert r["dataset"]["pairs"] == 2 and r["dataset"]["footprints"] == {"UNCHANGED": 1, "DEMOLISHED": 0, "NEW": 1}
    assert len(r["dataset"]["sha256"]) == 64
    assert r["used_for_tuning"] is True and r["notes"][0].startswith("調整に使ったデータの値")
    assert r["inference"] == {"model": "dummy"}
    assert (r["chosen"]["scale"], r["chosen"]["threshold"]) == (0.5, 0.5)
    assert r["overall"]["with_edge"]["new_building"] == r["overall"]["new_building"]  # 端の建物が無い入力
    assert "併記（端の建物も含む）: 新築の再現率" in capsys.readouterr().out


def test_test_split_requires_fixed_setting(tmp_path):
    tar, probs_dir = _write_inputs(tmp_path, "test")
    with pytest.raises(ValueError, match="--fixed"):
        ev.evaluate_split(tar, probs_dir, "test", log=lambda _: None)
    r = ev.evaluate_split(tar, probs_dir, "test", fixed=(0.5, 0.5), log=lambda _: None)
    assert r["used_for_tuning"] is False and not r["notes"][0].startswith("調整に使った")


def test_split_must_match_the_file_name(tmp_path):
    tar, probs_dir = _write_inputs(tmp_path, "test")
    with pytest.raises(ValueError, match="分割"):
        ev.evaluate_split(tar, probs_dir, "val", log=lambda _: None)


@pytest.mark.parametrize("fixed", [(2.0, 0.5), (0.5, 1.5), (0.5,)])
def test_bad_fixed_setting_is_rejected(tmp_path, fixed):
    tar, probs_dir = _write_inputs(tmp_path)
    with pytest.raises(ValueError, match="--fixed"):
        ev.evaluate_split(tar, probs_dir, "val", fixed=fixed, log=lambda _: None)


def test_missing_prediction_stops_before_computing(tmp_path):
    tar, probs_dir = _write_inputs(tmp_path)
    (probs_dir / "000000001_before_320.npy").unlink()
    with pytest.raises(FileNotFoundError, match="000000001_before_320.npy"):
        ev.evaluate_split(tar, probs_dir, "val", log=lambda _: None)
    # 固定の設定なら、その大きさだけが要る
    ev.evaluate_split(tar, probs_dir, "val", fixed=(0.5, 0.5), log=lambda _: None)


@pytest.mark.parametrize(
    "array", [np.zeros((128, 128)), np.full((256, 256), np.nan), np.full((256, 256), 1.5), np.full((256, 256), -0.1)]
)
def test_broken_prediction_stops(tmp_path, array):
    np.save(tmp_path / "000000000_after_256.npy", array.astype(np.float16))
    with pytest.raises(ValueError):
        ev.load_prob_file(tmp_path, "000000000", "after", 256)
