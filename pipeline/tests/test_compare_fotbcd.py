"""モデルの比較（pipeline/compare_fotbcd.py。仕様 §6.1）。期待値は、矩形の座標から手で数えた値。

座標は組の画素（512 px・0.2 m/px）。48 px の正方形は 2304 画素。
"""

from __future__ import annotations

import hashlib
import json

import numpy as np
import pytest

from pipeline import compare_fotbcd as cmp
from pipeline import evaluate_fotbcd as ev

from .test_fotbcd import doc, pair, prob, write_tar

BUILDING = (40, 40, 88, 88)
SHIFTED = (64, 40, 112, 88)  # 右へ半分ずらした矩形
AREA = 48 * 48
OVERLAP = {"13": ("000000001",)}


def save_probs(directory, keys, rects, sizes):
    directory.mkdir(parents=True, exist_ok=True)
    for key in keys:
        for side in ("before", "after"):
            for size in sizes:
                np.save(ev.prob_path(directory, key, side, size), prob(rects, size=size).astype(np.float16))
    return directory


def make_inputs(tmp_path, name="val-000000.tar"):
    """組 0（県 92）と組 2（県 29）を比べ、組 1（県 13）は外す。good は正解どおり、half は半分ずれた予測。"""
    footprints = [("UNCHANGED", BUILDING)]
    docs = {"000000000": doc(footprints), "000000001": doc(footprints, dep="13"), "000000002": doc(footprints, dep="29")}
    tar = write_tar(tmp_path / name, docs)
    kept = ["000000000", "000000002"]
    models = {
        "good": save_probs(tmp_path / "good", kept, [BUILDING], [256, 320, 512]),
        "half": save_probs(tmp_path / "half", kept, [SHIFTED], [512]),
    }
    return tar, models


def run(tar, models):
    return cmp.compare(tar, models, overlap=OVERLAP, log=lambda _: None)


def test_truth_mask_takes_pixels_whose_center_is_inside():
    refs = pair([("NEW", BUILDING), ("NEW", (200.4, 300, 202.6, 302))]).footprints
    mask = cmp.truth_mask(refs)
    assert mask[40:88, 40:88].all()
    assert mask[300:302, 200:203].all()  # 中心 200.5・201.5・202.5 が 200.4〜202.6 の中
    assert int(mask.sum()) == AREA + 6


def test_truth_mask_reaches_the_patch_border():
    mask = cmp.truth_mask(pair([("NEW", (0, 0, 512, 512))]).footprints)
    assert mask.all()


def test_upsample_keeps_flat_areas_and_leaves_512_untouched():
    full = prob([BUILDING])
    assert cmp.upsample(full) is full
    up = cmp.upsample(prob([BUILDING], size=256))
    assert up.shape == (512, 512)
    assert up[64, 64] == pytest.approx(0.9)
    assert up[200, 200] == 0


def test_overlapping_pairs_are_removed_from_every_model(tmp_path):
    result = run(*make_inputs(tmp_path))
    assert result["dataset"]["pairs"] == 2
    assert result["dataset"]["excluded_keys"] == ["000000001"]
    assert result["used_for_tuning"] is True
    for model in result["models"].values():
        assert sorted(model["objects"]["by_dep"]) == sorted(model["pixels"]["by_dep"]) == ["29", "92"]


def test_pixel_and_object_metrics_by_hand(tmp_path):
    result = run(*make_inputs(tmp_path))
    good, half = result["models"]["good"], result["models"]["half"]
    # 2 組 × 前後 = 4 枚
    assert {k: good["pixels"]["overall"][k] for k in ("tp", "fp", "fn")} == {"tp": 4 * AREA, "fp": 0, "fn": 0}
    assert {k: half["pixels"]["overall"][k] for k in ("tp", "fp", "fn")} == {"tp": 2 * AREA, "fp": 2 * AREA, "fn": 2 * AREA}
    assert half["pixels"]["overall"]["iou"] == 0.3333
    assert half["pixels"]["by_dep"]["92"]["tp"] == AREA
    assert good["objects"]["overall"]["extraction"]["after"]["f1"] == 1.0
    assert half["objects"]["overall"]["extraction"]["after"]["f1"] == 0.0


def test_each_model_chooses_among_the_scales_it_has(tmp_path):
    result = run(*make_inputs(tmp_path))
    assert result["models"]["good"]["objects"]["protocol"]["scales"] == [0.5, 0.625, 1.0]
    assert result["models"]["half"]["objects"]["protocol"]["scales"] == [1.0]
    assert result["models"]["half"]["objects"]["chosen"] == {
        "scale": 1.0,
        "threshold": 0.5,
        "selected_by": "後の写真の建物の物体単位 F1",
    }
    assert len(result["models"]["good"]["pixels"]["sweep"]) == 3 * len(ev.THRESHOLDS)
    assert len(result["models"]["half"]["pixels"]["sweep"]) == len(ev.THRESHOLDS)


@pytest.mark.parametrize("overlap", [{"13": ("000000009",)}, {"92": ("000000001",)}])
def test_wrong_overlap_list_stops(tmp_path, overlap):
    tar, models = make_inputs(tmp_path)
    with pytest.raises(ValueError, match="外す組"):
        cmp.compare(tar, models, overlap=overlap, log=lambda _: None)


def test_the_fixed_overlap_list_has_11_pairs():
    keys = [k for ks in cmp.OVERLAP_KEYS.values() for k in ks]
    assert {d: len(ks) for d, ks in cmp.OVERLAP_KEYS.items()} == {"13": 8, "29": 1, "92": 2}
    assert len(set(keys)) == 11


def test_partly_missing_scale_stops_instead_of_being_dropped(tmp_path):
    tar, models = make_inputs(tmp_path)
    ev.prob_path(models["good"], "000000002", "after", 320).unlink()
    with pytest.raises(FileNotFoundError, match="320"):
        run(tar, models)


def test_model_without_outputs_stops(tmp_path):
    tar, models = make_inputs(tmp_path)
    with pytest.raises(FileNotFoundError, match="推論の出力が無い"):
        run(tar, {**models, "empty": tmp_path / "empty"})


def test_test_split_is_refused(tmp_path):
    tar, models = make_inputs(tmp_path, name="test-000000.tar")
    with pytest.raises(ValueError, match="val だけ"):
        run(tar, models)


def test_outputs_made_from_another_tar_are_rejected(tmp_path):
    tar, models = make_inputs(tmp_path)
    (models["half"] / "meta.json").write_text(json.dumps({"dataset": {"sha256": "0" * 64}}), encoding="utf-8")
    with pytest.raises(ValueError, match="別の tar"):
        run(tar, models)


def test_command_writes_the_result(tmp_path, monkeypatch, capsys):
    tar, models = make_inputs(tmp_path)
    (models["good"] / "meta.json").write_text(
        json.dumps({"dataset": {"sha256": hashlib.sha256(tar.read_bytes()).hexdigest()}}), encoding="utf-8"
    )
    monkeypatch.setitem(cmp.compare.__kwdefaults__, "overlap", OVERLAP)
    out = tmp_path / "compare.json"
    argv = ["--tar", str(tar), "--out", str(out)]
    for name, directory in models.items():
        argv += ["--model", f"{name}={directory}"]
    assert cmp.main(argv) == 0
    written = json.loads(out.read_text(encoding="utf-8"))
    assert list(written["models"]) == ["good", "half"]
    assert "画素: IoU 0.3333" in capsys.readouterr().out


@pytest.mark.parametrize("extra", [["--model", "x"], ["--model", "a=1", "--model", "a=2"]])
def test_bad_model_argument_is_rejected(tmp_path, extra):
    with pytest.raises(SystemExit):
        cmp.main(["--tar", str(tmp_path / "val-x.tar"), *extra])
