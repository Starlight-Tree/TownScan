import json

import numpy as np
import pytest

from pipeline import colabio


def save(colab, year, x, y, scale, fill=0.1):
    n = int(round(256 * scale))
    np.save(colabio.prob_path(colab, year, x, y, scale), np.full((n, n), fill, dtype=np.float16))


def test_scale_key_and_path(tmp_path):
    assert [colabio.scale_key(s) for s in (1.0, 1.5, 2.0)] == ["s100", "s150", "s200"]
    assert colabio.prob_path(tmp_path, 2014, 1, 2, 1.5).name == "prob_2014_1_2_s150.npy"


def test_load_prob_returns_float32_and_checks_shape(tmp_path):
    save(tmp_path, 2014, 1, 2, 1.5, fill=0.25)
    a = colabio.load_prob(tmp_path, 2014, 1, 2, 1.5)
    assert a.dtype == np.float32 and a.shape == (384, 384) and a[0, 0] == 0.25
    np.save(colabio.prob_path(tmp_path, 2014, 1, 2, 2.0), np.zeros((256, 256), dtype=np.float16))  # 倍率と大きさが合わない
    with pytest.raises(ValueError):
        colabio.load_prob(tmp_path, 2014, 1, 2, 2.0)
    with pytest.raises(FileNotFoundError):
        colabio.load_prob(tmp_path, 2024, 1, 2, 1.0)


def test_has_all_probs(tmp_path):
    for yr in colabio.YEARS:
        for s in colabio.SCALES:
            save(tmp_path, yr, 5, 6, s)
    assert colabio.has_all_probs(tmp_path, colabio.YEARS, 5, 6, colabio.SCALES)
    colabio.prob_path(tmp_path, 2024, 5, 6, 1.5).unlink()
    assert not colabio.has_all_probs(tmp_path, colabio.YEARS, 5, 6, colabio.SCALES)


def test_tiles_from_inference_meta_year_records_keep_first_seen_order(tmp_path):
    """推論スクリプトの meta_infer.json は、タイル × 年の記録。タイルの並びは初出順（年で重複しない）。"""
    colab = tmp_path / "colab"
    colab.mkdir()
    recs = [{"year": yr, "x": x, "y": y, "fetched": True} for (x, y) in [(30, 4), (10, 9), (20, 1)] for yr in (2014, 2024)]
    (colab / "meta_infer.json").write_text(json.dumps({"tiles": recs}), encoding="utf-8")
    assert colabio.read_tiles(colab) == [(18, 30, 4), (18, 10, 9), (18, 20, 1)]


@pytest.mark.parametrize(
    "tiles",
    [
        [{"z": 18, "x": 3, "y": 4}, {"z": 18, "x": 1, "y": 2}],
        [[3, 4], [1, 2]],
        [[18, 3, 4], [18, 1, 2]],
        ["z18-3-4", "z18-1-2"],
        ["3_4", "1-2"],
    ],
)
def test_tiles_entry_forms(tmp_path, tiles):
    (tmp_path / "meta.json").write_text(json.dumps({"tiles": tiles + ["壊れた", None, 5]}), encoding="utf-8")
    assert colabio.read_tiles(tmp_path) == [(18, 3, 4), (18, 1, 2)]


def test_tiles_fallback_to_run_tiles_json_then_file_scan(tmp_path):
    run = tmp_path / "run1"
    colab = run / "colab"
    colab.mkdir(parents=True)
    save(colab, 2014, 7, 1, 1.0)
    save(colab, 2014, 3, 2, 1.0)
    # meta も tiles.json も無い → ファイル名から。並びは (y, x) の順
    assert colabio.read_tiles(colab, run) == [(18, 7, 1), (18, 3, 2)]
    (run / "tiles.json").write_text(json.dumps([{"z": 18, "x": 3, "y": 2}, {"z": 18, "x": 7, "y": 1}]), encoding="utf-8")
    assert colabio.read_tiles(colab, run) == [(18, 3, 2), (18, 7, 1)]  # tiles.json があればその順
    (colab / "meta.json").write_text(json.dumps({"tiles": [{"x": 9, "y": 9}]}), encoding="utf-8")
    assert colabio.read_tiles(colab, run) == [(18, 9, 9)]  # meta が最優先


def test_read_meta_merges_and_ignores_broken_files(tmp_path):
    (tmp_path / "meta_setup.json").write_text(json.dumps({"model": "org/name", "torch": "2.x"}), encoding="utf-8")
    (tmp_path / "meta_infer.json").write_text("{broken", encoding="utf-8")
    meta = colabio.read_meta(tmp_path)
    assert meta == {"model": "org/name", "torch": "2.x"} and colabio.model_name(meta) == "org/name"
    (tmp_path / "meta.json").write_text(json.dumps({"kind": "synthetic", "tiles": [1], "fetch_log": []}), encoding="utf-8")
    meta = colabio.read_meta(tmp_path)
    assert meta["kind"] == "synthetic" and "tiles" not in colabio.colab_summary(meta)
    assert colabio.read_meta(tmp_path / "nothing") == {}


@pytest.mark.parametrize("model, expected", [({"name": "a/b"}, "a/b"), ({"id": "x"}, "x"), ({}, "unknown"), (None, "unknown"), (3, "unknown")])
def test_model_name_variants(model, expected):
    assert colabio.model_name({"model": model}) == expected
