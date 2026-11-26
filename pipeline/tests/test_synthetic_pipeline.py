"""合成データ → 後処理 の通しのテスト（外部通信なし）。契約（docs/spec-prototype.md §4）の形と、置いた建物の期待どおりの分類を確かめる。"""

import json
import re
import shutil

import pytest
from shapely.geometry import Point, shape

from pipeline import evaluate, geo, make_synthetic_run, run_postprocess, tilemath

CREATED = "2026-01-01T00:00:00+00:00"


@pytest.fixture(scope="module")
def synth(tmp_path_factory):
    root = tmp_path_factory.mktemp("synthetic")
    res = make_synthetic_run.make_synthetic_run(root, created=CREATED)
    out = root / "run1" / "out"
    load = lambda name: json.loads((out / name).read_text(encoding="utf-8"))  # noqa: E731
    return {"root": root, "out": out, "res": res, "truth": res["truth"], "load": load}


def test_all_contract_files_are_written(synth):
    names = {p.name for p in synth["out"].iterdir()}
    assert names == {"run.json", "areas.json", "buildings_2014.geojson", "buildings_2024.geojson", "candidates.geojson", "eval.json"}
    # 入力の側（backend の画像切り出し・ローダーのテストが使う）
    root = synth["root"]
    for year in (2014, 2024):
        for x, y, *_ in make_synthetic_run.SYNTH_TILES:
            assert (root / "tiles" / str(year) / f"{x}_{y}.png").is_file()
    assert (root / "run1" / "colab" / "meta.json").is_file() and (root / "run1" / "truth.json").is_file()


def test_run_json_marks_synthetic_clearly(synth):
    run = synth["load"]("run.json")
    assert run["kind"] == "synthetic" and run["created"] == CREATED
    assert run["run_id"] == "synthetic-run1" and run["run_id"] != "run1"  # 実データの run_id と衝突しない
    assert isinstance(run["model"], str) and isinstance(run["notes"], str) and "合成" in run["notes"]
    p = run["params"]
    assert p["scale"] in evaluate.DEFAULT_SCALES and p["threshold"] in evaluate.DEFAULT_THRESHOLDS
    assert p["diff"] == {"kiban_ov_max": 0.25, "min_area_m2": 20.0, "omission_ov_2014_min": 0.5, "new_ov_2014_max": 0.1, "new_p90_max": 0.2, "drop_present_before": False}
    assert p["diff_thresholds_status"] == "unverified_initial_values"
    assert run["tiles"] == [a["id"] for a in synth["load"]("areas.json")]  # 地区 id の配列


def test_areas_json(synth):
    areas = synth["load"]("areas.json")
    assert len(areas) == 2
    for a in areas:
        assert set(a) == {"id", "z", "x", "y", "bbox", "centroid", "name", "ward", "municipality", "name_source"}
        assert a["id"] == tilemath.area_id(a["z"], a["x"], a["y"])
        w, s, e, n = a["bbox"]
        assert (w, s, e, n) == pytest.approx(tilemath.tile_bbox_lonlat(a["z"], a["x"], a["y"]), abs=1e-7)
        assert w < a["centroid"][0] < e and s < a["centroid"][1] < n
        assert "合成" in a["name"] and a["name_source"] == "synthetic"
    assert [a["ward"] for a in areas] == ["中央区", "東区"]


def _candidate_at(cands, center):
    pt = Point(*center)
    hits = [f for f in cands if shape(f["geometry"]).contains(pt)]
    assert len(hits) <= 1
    return hits[0] if hits else None


def test_planted_buildings_get_the_expected_classes(synth):
    cands = synth["load"]("candidates.geojson")["features"]
    expected = 0
    for t in synth["truth"]:
        hit = _candidate_at(cands, t["center"])
        if t["expected_class"] is None:
            assert hit is None, f"{t['name']} は候補にならないはず: {t['role']}"
            continue
        expected += 1
        assert hit is not None, f"{t['name']} が候補に無い: {t['role']}"
        assert (hit["properties"]["class"], hit["properties"]["reason"]) == (t["expected_class"], t["expected_reason"]), t["name"]
        assert hit["properties"]["area_id"] == t["area_id"]
    assert len(cands) == expected == 7


def test_candidates_geojson_matches_contract(synth):
    fc = synth["load"]("candidates.geojson")
    assert fc["type"] == "FeatureCollection"
    areas = {a["id"]: a for a in synth["load"]("areas.json")}
    by_area = {}
    for f in fc["features"]:
        assert re.fullmatch(r"c-\d+-\d+-\d+", f["id"])
        assert f["geometry"]["type"] == "Polygon"
        p = f["properties"]
        assert set(p) == {"area_id", "class", "area_m2", "bbox", "centroid", "evidence", "reason"}
        assert set(p["evidence"]) == {"prob_2024_mean", "ov_2014", "prob_2014_p90", "ov_kiban", "edge_touch"}
        a = areas[p["area_id"]]
        assert f["id"].startswith(f"c-{a['x']}-{a['y']}-")
        assert p["evidence"]["ov_kiban"] < 0.25 and p["area_m2"] >= 20.0  # 入口の条件
        assert p["evidence"]["edge_touch"] == (p["reason"] == "edge")
        # geometry は area の範囲の中
        minx, miny, maxx, maxy = shape(f["geometry"]).bounds
        eps = 1e-7  # 書き出しの丸め
        assert a["bbox"][0] - eps <= minx and maxx <= a["bbox"][2] + eps and a["bbox"][1] - eps <= miny and maxy <= a["bbox"][3] + eps
        by_area.setdefault(p["area_id"], []).append(f)
    # id の連番は 1 から、面積の大きい順
    for feats in by_area.values():
        ns = [int(f["id"].rsplit("-", 1)[1]) for f in feats]
        assert ns == list(range(1, len(feats) + 1))
        areas_m2 = [f["properties"]["area_m2"] for f in feats]
        assert areas_m2 == sorted(areas_m2, reverse=True)
    assert len({f["id"] for f in fc["features"]}) == len(fc["features"])


def test_evidence_values_for_known_buildings(synth):
    cands = synth["load"]("candidates.geojson")["features"]
    truth = {t["name"]: t for t in synth["truth"]}
    ev = lambda name: _candidate_at(cands, truth[name]["center"])["properties"]["evidence"]  # noqa: E731
    assert ev("A_new")["ov_2014"] == 0.0 and ev("A_new")["prob_2014_p90"] < 0.2
    assert ev("A_omit")["ov_2014"] > 0.9 and ev("A_omit")["prob_2014_p90"] > 0.8
    assert 0.2 <= ev("A_unc")["prob_2014_p90"] < 0.5 and ev("A_unc")["ov_2014"] == 0.0  # 2014 の確率が弱く出ている
    assert ev("A_edge")["edge_touch"] is True and ev("B_edge")["ov_2014"] > 0.9  # 描き漏れの値でも縁なら保留


def test_buildings_geojson_properties_and_area_in_6670(synth):
    for year in (2014, 2024):
        fc = synth["load"](f"buildings_{year}.geojson")
        assert fc["features"], year
        for f in fc["features"]:
            assert set(f["properties"]) == {"area_id", "area_m2", "prob_mean"}
            g = shape(f["geometry"])
            assert g.is_valid and g.geom_type == "Polygon"
            # 書き出しで座標を 1 cm 程度に丸めるぶんの差は許す
            assert f["properties"]["area_m2"] == pytest.approx(geo.area_m2(g), abs=0.5 + 1e-3 * g.area)
            assert 0 <= f["properties"]["prob_mean"] <= 1
    # 候補は 2024 年の建物の中から出る
    b23 = {json.dumps(f["geometry"]) for f in synth["load"]("buildings_2024.geojson")["features"]}
    assert all(json.dumps(f["geometry"]) in b23 for f in synth["load"]("candidates.geojson")["features"])
    # 2014 年には新築が無い（2024 年だけの建物の分、少ない）
    assert len(synth["load"]("buildings_2014.geojson")["features"]) < len(synth["load"]("buildings_2024.geojson")["features"])


def test_eval_json_matches_contract(synth):
    e = synth["load"]("eval.json")
    for key in ("reference", "split", "sweep", "chosen", "holdout", "tune", "per_area", "excluded_edge_objects", "new_building_recall", "notes"):
        assert key in e
    assert e["new_building_recall"] is None
    assert len(e["split"]["tune"]) == 1 and len(e["split"]["holdout"]) == 1 and not set(e["split"]["tune"]) & set(e["split"]["holdout"])
    assert len(e["sweep"]) == 15 and all("tune_object_f1" in r for r in e["sweep"])
    for part in (e["tune"], e["holdout"], e["overall"]):
        assert set(part) == {"pixel", "object"}
        assert {"iou", "precision", "recall", "f1"} <= set(part["pixel"]) and {"f1", "precision", "recall"} <= set(part["object"])
    run = synth["load"]("run.json")
    assert (e["chosen"]["scale"], e["chosen"]["threshold"]) == (run["params"]["scale"], run["params"]["threshold"])
    assert isinstance(e["reference"], str) and "基盤地図情報" in e["reference"]
    assert isinstance(e["excluded_edge_objects"], dict) and all(isinstance(v, int) for v in e["excluded_edge_objects"].values())
    # 全体の物体数は、地区ごとの合計
    assert e["overall"]["object"]["n_ref"] == sum(a["n_ref"] for a in e["per_area"])
    assert e["overall"]["object"]["n_pred"] == sum(a["n_pred"] for a in e["per_area"])
    assert e["excluded_edge_objects"]["prediction"] == sum(a["excluded_pred"] for a in e["per_area"])
    # 地区ごとの行は平ら（画面が表にそのまま出す）
    assert all(not isinstance(v, (dict, list)) for a in e["per_area"] for v in a.values())
    # 合成の置き方: 調整用の地区には「建物データにだけある建物」が 1 棟 → 物体の取りこぼしが 1（n_ref 3・一致 2）。
    # 評価用の地区は「見逃し」が 1（n_ref 2・一致 1）。B_edge（縁に接する予測）は外れる
    tune_area = next(a for a in e["per_area"] if a["split"] == "tune")
    hold_area = next(a for a in e["per_area"] if a["split"] == "holdout")
    assert tune_area["n_ref"] == 3 and e["tune"]["object"]["tp"] == 2 and e["tune"]["object"]["fn"] == 1
    assert hold_area["n_ref"] == 2 and e["holdout"]["object"]["tp"] == 1 and e["holdout"]["object"]["fn"] == 1
    assert hold_area["excluded_pred"] == 1


def test_eval_json_optional_diagnostics(synth):
    """仕様 §6 の任意項目: year_compare・existing_absent_in_2014・excluded_edge_detail・reference_detail.vintage。既存の項目と食い違わない。"""
    e = synth["load"]("eval.json")
    # year_compare: 2014 年の側はトップレベルと同じ。評価の年（protocol.year）は 2014 のまま、比べる年を別に明示
    assert e["protocol"]["year"] == 2014 and e["protocol"]["compare_year"] == 2024
    yc = e["year_compare"]
    assert (yc["selected_on_year"], yc["compare_year"]) == (2014, 2024)
    assert yc["setting"] == {"scale": e["chosen"]["scale"], "threshold": e["chosen"]["threshold"]}
    assert yc["by_year"]["2014"] == {"tune": e["tune"], "holdout": e["holdout"], "overall": e["overall"]}
    assert set(yc["by_year"]["2024"]) == {"tune", "holdout", "overall"}
    # existing_absent_in_2014: 参照（縁を除く・20 m² 以上）の棟の数。割合は 棟数 / 全体
    a = e["existing_absent_in_2014"]
    assert a["params"]["min_area_m2"] == 20.0 and a["setting"] == yc["setting"]
    assert a["overall"]["n_buildings"] == a["tune"]["n_buildings"] + a["holdout"]["n_buildings"] > 0
    assert a["overall"]["absent"] + a["overall"]["present"] <= a["overall"]["n_buildings"]
    assert a["overall"]["absent_share"] == pytest.approx(a["overall"]["absent"] / a["overall"]["n_buildings"], abs=1e-4)
    # excluded_edge_detail は excluded_edge_objects の内訳
    d = e["excluded_edge_detail"]["overall"]
    assert sum(d["reference"].values()) == e["excluded_edge_objects"]["reference"]
    assert sum(d["prediction"].values()) == e["excluded_edge_objects"]["prediction"]
    # 参照の素性（読み込んだ建物の属性の集計）は、合成の XML の値から作る。実データ向けの ADR の引用は付かない
    v = e["reference_detail"]["vintage"]
    assert v["lf_span_from"] == {"2018-10-01": e["reference_detail"]["buildings_loaded_in_range"]}
    assert any("参照の版の素性（事実" in n and "2018-10-01" in n for n in e["notes"])
    assert not any("参照の時期（推定。独立の確認" in n for n in e["notes"])
    assert any("参照の時期（推定）" in n and "FP" in n and "FN" in n for n in e["notes"])


def test_reference_notes_separate_facts_from_estimates():
    uniform = {"gml_id_prefix": {"K17": 74929}, "lf_span_from": {"2018-10-01": 74929}, "dev_date": {"2018-10-02": 74929}}
    real = run_postprocess.reference_notes(uniform, 74929, "real")
    assert len(real) == 2
    assert "事実" in real[0] and "K17 が 74,929 棟" in real[0] and "2018-10-01 が 74,929 棟" in real[0] and "2018-10-02 が 74,929 棟" in real[0]
    assert "建物ごとの日付の違いは無い" in real[0] and "配布の版の日付にすぎず" in real[0]
    assert "推定" in real[1] and "独立の確認はしていない" in real[1] and "0001-data-candidates.md" in real[1]
    assert len(run_postprocess.reference_notes(uniform, 74929, "synthetic")) == 1  # ADR の引用は実データだけ
    mixed = {**uniform, "dev_date": {"2018-10-02": 3, "2019-01-05": 2, "2019-02-01": 2, "2019-03-01": 1, "2019-04-01": 1}}
    text = run_postprocess.reference_notes(mixed, 9, "real")[0]
    assert "ほか 2 種" in text and "建物ごとの日付の違いは無い" not in text and "値が複数ある" in text


def test_synthetic_run_is_reproducible(synth, tmp_path):
    again = make_synthetic_run.make_synthetic_run(tmp_path, created=CREATED)
    for name in ("candidates.geojson", "buildings_2024.geojson", "eval.json", "run.json", "areas.json"):
        assert (tmp_path / "run1" / "out" / name).read_text(encoding="utf-8") == (synth["out"] / name).read_text(encoding="utf-8"), name
    assert again["summary"]["candidates"] == 7


def test_postprocess_can_be_rerun_on_existing_input(synth, tmp_path):
    out = tmp_path / "other_out"
    summary = run_postprocess.run_postprocess(synth["root"], out_dir=out, created=CREATED, log=lambda m: None)
    assert summary["candidates"] == 7 and (out / "run.json").is_file()
    assert (out / "candidates.geojson").read_text(encoding="utf-8") == (synth["out"] / "candidates.geojson").read_text(encoding="utf-8")


def _copy_input(synth, tmp_path):
    dst = tmp_path / "in"
    shutil.copytree(synth["root"], dst, ignore=shutil.ignore_patterns("out"))
    return dst


def _assert_fallback_names(areas):
    for a in areas:
        assert a["name"] == f"地区 {a['x']}-{a['y']}" and a["name_source"] == "fallback"
        assert a["ward"] == "区不明" and a["municipality"] is None
        assert all(isinstance(a[k], str) and a[k] for k in ("name", "ward"))  # 画面は null を扱わない


def test_fallback_names_without_geocode_json(synth, tmp_path):
    dst = _copy_input(synth, tmp_path)
    (dst / "run1" / "geocode.json").unlink()
    run_postprocess.run_postprocess(dst, log=lambda m: None)
    areas = json.loads((dst / "run1" / "out" / "areas.json").read_text(encoding="utf-8"))
    assert len(areas) == 2
    _assert_fallback_names(areas)
    notes = json.loads((dst / "run1" / "out" / "run.json").read_text(encoding="utf-8"))["notes"]
    assert "代わりの名前" in notes and "2/2" in notes  # 代わりの名前を使ったことを記録に残す


def test_unexpected_geocode_responses_give_fallback_names(synth, tmp_path):
    dst = _copy_input(synth, tmp_path)
    ids = [t["id"] for t in json.loads((dst / "run1" / "colab" / "meta.json").read_text(encoding="utf-8"))["tiles"]]
    (dst / "run1" / "geocode.json").write_text(json.dumps({ids[0]: {"unexpected": 1}, ids[1]: [1, 2]}), encoding="utf-8")
    run_postprocess.run_postprocess(dst, log=lambda m: None)
    _assert_fallback_names(json.loads((dst / "run1" / "out" / "areas.json").read_text(encoding="utf-8")))


def test_partial_geocode_json_only_replaces_the_missing_area(synth, tmp_path):
    dst = _copy_input(synth, tmp_path)
    ids = [t["id"] for t in json.loads((dst / "run1" / "colab" / "meta.json").read_text(encoding="utf-8"))["tiles"]]
    geo_path = dst / "run1" / "geocode.json"
    full = json.loads(geo_path.read_text(encoding="utf-8"))
    geo_path.write_text(json.dumps({ids[0]: full[ids[0]]}), encoding="utf-8")  # 2 枚目の応答が欠けた
    run_postprocess.run_postprocess(dst, log=lambda m: None)
    first, second = json.loads((dst / "run1" / "out" / "areas.json").read_text(encoding="utf-8"))
    assert first["name_source"] == "synthetic" and "合成" in first["name"] and first["ward"] == "中央区"
    _assert_fallback_names([second])


def test_html_in_a_geocode_name_never_reaches_areas_json(synth, tmp_path):
    dst = _copy_input(synth, tmp_path)
    ids = [t["id"] for t in json.loads((dst / "run1" / "colab" / "meta.json").read_text(encoding="utf-8"))["tiles"]]
    evil = "<img src=x onerror=alert(document.domain)>"
    (dst / "run1" / "geocode.json").write_text(
        json.dumps({ids[0]: {"results": {"muniCd": "43101", "lv01Nm": evil}}, ids[1]: {"results": {"muniCd": "43102", "lv01Nm": "a\nb" + "あ" * 100}}}),
        encoding="utf-8",
    )
    run_postprocess.run_postprocess(dst, log=lambda m: None)
    text = (dst / "run1" / "out" / "areas.json").read_text(encoding="utf-8")
    assert "<" not in text and "onerror" not in text
    first, second = json.loads(text)
    assert first["name"] == f"地区 {first['x']}-{first['y']}" and first["ward"] == "中央区"  # 区は固定の表から取れるので残る
    assert second["name"] == f"地区 {second['x']}-{second['y']}" and second["ward"] == "東区"


def test_lone_surrogate_in_a_geocode_name_does_not_break_the_run(synth, tmp_path):
    dst = _copy_input(synth, tmp_path)
    ids = [t["id"] for t in json.loads((dst / "run1" / "colab" / "meta.json").read_text(encoding="utf-8"))["tiles"]]
    (dst / "run1" / "geocode.json").write_text(
        json.dumps({ids[0]: {"results": {"muniCd": "43101", "lv01Nm": "a\ud800b"}}, ids[1]: {"results": {"muniCd": "43102", "lv01Nm": "水前寺"}}}),
        encoding="utf-8",
    )
    run_postprocess.run_postprocess(dst, log=lambda m: None)  # UTF-8 で書けない文字が areas.json に届くと、ここで落ちる
    first, second = json.loads((dst / "run1" / "out" / "areas.json").read_text(encoding="utf-8"))
    assert first["name_source"] == "fallback" and second["name"] == "水前寺"


def test_kiban_default_depends_on_kind_not_on_folder_presence(synth, tmp_path, monkeypatch):
    root = synth["root"]
    assert run_postprocess.default_kiban_dir("synthetic", root) == root / "kiban"
    assert run_postprocess.default_kiban_dir("real", root) == run_postprocess.DEFAULT_KIBAN_DIR
    # 実データの run（kind=real）の置き場に kiban/ があっても、そちらへ静かに切り替わらない
    dst = _copy_input(synth, tmp_path)
    meta_path = dst / "run1" / "colab" / "meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    meta["kind"] = "real"
    meta_path.write_text(json.dumps(meta), encoding="utf-8")
    assert (dst / "kiban").is_dir()
    absent = tmp_path / "no_such_kiban"
    monkeypatch.setattr(run_postprocess, "DEFAULT_KIBAN_DIR", absent)
    with pytest.raises(FileNotFoundError, match="no_such_kiban"):
        run_postprocess.run_postprocess(dst, log=lambda m: None)
    # 明示すれば使える
    run_postprocess.run_postprocess(dst, kiban_dir=dst / "kiban", log=lambda m: None)
    assert json.loads((dst / "run1" / "out" / "run.json").read_text(encoding="utf-8"))["kind"] == "real"


def test_kind_conflict_is_refused(synth, tmp_path):
    with pytest.raises(ValueError, match="kind"):
        run_postprocess.run_postprocess(synth["root"], kind="real", out_dir=tmp_path / "o", log=lambda m: None)
    assert run_postprocess.resolve_kind({}, None) == "real"
    assert run_postprocess.resolve_kind({}, "synthetic") == "synthetic"
    assert run_postprocess.resolve_kind({"kind": "synthetic"}, "synthetic") == "synthetic"
    with pytest.raises(ValueError):
        run_postprocess.resolve_kind({"kind": "demo"}, None)
    assert run_postprocess.default_run_id("real", "run1") == "run1"
    assert run_postprocess.default_run_id("synthetic", "run1") == "synthetic-run1"


def test_tile_with_incomplete_arrays_is_skipped_with_a_note(synth, tmp_path):
    dst = _copy_input(synth, tmp_path)
    colab = dst / "run1" / "colab"
    meta = json.loads((colab / "meta.json").read_text(encoding="utf-8"))
    x0, y0 = meta["tiles"][0]["x"], meta["tiles"][0]["y"]
    x_new = x0 + 10
    for f in list(colab.glob(f"prob_*_{x0}_{y0}_s*.npy")):
        shutil.copy(f, colab / f.name.replace(f"_{x0}_{y0}_", f"_{x_new}_{y0}_"))
    (colab / f"prob_2024_{x_new}_{y0}_s150.npy").unlink()  # 3 枚目のタイルは、1 つ欠ける
    meta["tiles"].append({"z": 18, "x": x_new, "y": y0, "id": tilemath.area_id(18, x_new, y0)})
    (colab / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    run_postprocess.run_postprocess(dst, log=lambda m: None)
    out = dst / "run1" / "out"
    assert len(json.loads((out / "areas.json").read_text(encoding="utf-8"))) == 2  # 欠けたタイルは地区にならない
    assert tilemath.area_id(18, x_new, y0) in json.loads((out / "run.json").read_text(encoding="utf-8"))["notes"]
    assert (out / "candidates.geojson").read_text(encoding="utf-8") == (synth["out"] / "candidates.geojson").read_text(encoding="utf-8")


def test_fewer_than_two_usable_tiles_is_an_error(synth, tmp_path):
    dst = _copy_input(synth, tmp_path)
    next((dst / "run1" / "colab").glob("prob_2024_*_s150.npy")).unlink()
    with pytest.raises(RuntimeError):  # 2 枚のうち 1 枚が欠けると、調整用と評価用に分けられない
        run_postprocess.run_postprocess(dst, log=lambda m: None)


def test_missing_kiban_folder_is_an_error(synth, tmp_path):
    with pytest.raises(FileNotFoundError):
        run_postprocess.run_postprocess(synth["root"], kiban_dir=tmp_path / "none", out_dir=tmp_path / "o", log=lambda m: None)


def test_cli_main_runs(synth, tmp_path, capsys):
    out = tmp_path / "cli_out"
    code = run_postprocess.main(["--data-root", str(synth["root"]), "--out", str(out), "--created", CREATED, "--new-p90-max", "0.5"])
    assert code == 0
    printed = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert printed["kind"] == "synthetic" and printed["candidates"] == 7
    run = json.loads((out / "run.json").read_text(encoding="utf-8"))
    assert run["params"]["diff"]["new_p90_max"] == 0.5  # 閾値は引数で変えられ、run.json に残る
    # p90 の上限を 0.5 に緩めると、A_unc（2014 の確率が 0.25 前後）が新規側に入る
    classes = [f["properties"]["class"] for f in json.loads((out / "candidates.geojson").read_text(encoding="utf-8"))["features"]]
    assert classes.count("confirmed_new") == 4


def test_make_synthetic_run_cli_without_postprocess(tmp_path, capsys):
    assert make_synthetic_run.main([str(tmp_path / "s"), "--no-postprocess"]) == 0
    assert (tmp_path / "s" / "run1" / "colab" / "meta.json").is_file() and not (tmp_path / "s" / "run1" / "out").exists()
