"""対象をフランスにしたときに足した動き（ADR 0015）。外部通信なし。"""

import json

import pytest

from pipeline import diff, geo, geocode, make_synthetic_run, run_postprocess


def _classify(**kw):
    base = dict(area_m2=100.0, ov_kiban=0.0, ov_2014=0.0, prob_2014_p90=0.0, edge_touch=False)
    return diff.classify(**{**base, **kw})


def test_drop_present_before_drops_only_buildings_seen_in_the_earlier_photo():
    p = diff.DiffParams(drop_present_before=True)
    assert _classify(ov_2014=0.5, params=p) == diff.Decision(None, diff.DROP_PRESENT_BEFORE)
    assert _classify(ov_2014=0.49, params=p).cls == diff.CLASS_UNCERTAIN
    assert _classify(ov_2014=0.0, params=p).cls == diff.CLASS_NEW
    # 写真の端で切れたものは、前の写真に写っていても、分けないで残す
    assert _classify(ov_2014=0.9, edge_touch=True, params=p).cls == diff.CLASS_UNCERTAIN
    # 既定は落とさない
    assert _classify(ov_2014=0.5).cls == diff.CLASS_OMISSION


def test_metric_crs_uses_lambert93_in_france_and_the_synthetic_crs_elsewhere():
    assert geo.metric_crs(2.2474, 48.8376) == "EPSG:2154"
    assert geo.metric_crs(130.7, 32.8) == "EPSG:6670"


def _ign(props):
    return {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": props}]}


def test_ign_reverse_geocode_gives_street_name_and_japanese_commune():
    got = geocode.build_area_name(_ign({"street": "rue de l'Église", "citycode": "92050", "city": "Nanterre"}))
    assert got == {"name": "Rue de l’Église", "ward": "ナンテール", "municipality": "オー・ド・セーヌ県", "name_source": geocode.IGN_NAME_SOURCE}
    # 表に無い市町村は、応答の名前をそのまま使う。県 92 の外は、県の名前を付けない
    other = geocode.build_area_name(_ign({"name": "Avenue X", "citycode": "75056", "city": "Paris"}))
    assert (other["name"], other["ward"], other["municipality"]) == ("Avenue X", "Paris", None)


@pytest.mark.parametrize("bad", [{"features": []}, {"features": None}, {"features": [1]}, {"features": [{"properties": None}]}])
def test_ign_unexpected_shapes_give_null(bad):
    assert geocode.build_area_name(bad) == {"name": None, "ward": None, "municipality": None, "name_source": None}


def test_ign_unsafe_street_name_is_dropped():
    got = geocode.build_area_name(_ign({"street": "<img src=x>", "citycode": "92050"}))
    assert got["name"] is None and got["ward"] == "ナンテール"


def test_fixed_run_uses_no_reference_and_reports_unmeasured(tmp_path):
    make_synthetic_run.make_synthetic_run(tmp_path, created="2026-01-01T00:00:00+00:00")
    out = tmp_path / "fixed_out"
    res = run_postprocess.run_postprocess(tmp_path, "run1", out_dir=out, fixed=(1.0, 0.5), kiban_dir=tmp_path / "no-such-dir", log=lambda _: None)
    load = lambda name: json.loads((out / name).read_text(encoding="utf-8"))  # noqa: E731
    ev = load("eval.json")
    assert ev["reference"] is None and ev["new_building_recall"] is None
    assert not ({"holdout", "tune", "sweep", "split"} & set(ev))
    assert ev["chosen"] == {"scale": 1.0, "threshold": 0.5, "selected_by": "fixed"}
    run = load("run.json")
    assert run["params"]["selected_on"] == "fixed" and run["params"]["kiban"] is None
    assert run["params"]["diff"]["drop_present_before"] is True
    classes = {f["properties"]["class"] for f in load("candidates.geojson")["features"]}
    assert classes and diff.CLASS_OMISSION not in classes
    assert res["holdout"] is None
