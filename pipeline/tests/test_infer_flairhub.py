"""FLAIR-HUB の推論スクリプト（pipeline/colab/infer_flairhub.py）。モデルは偽物で、torch も GPU も通信も使わない。

偽の推論は、正規化を戻した「赤の値を、建物の確率にする」。黒い画像に白い矩形を描くと、そこが建物になる。
"""

from __future__ import annotations

import itertools
import json
import sys
import tarfile

import numpy as np
import pytest
from PIL import Image

from pipeline import evaluate_fotbcd as ev
from pipeline.colab import infer_flairhub as flair
from pipeline.colab import infer_fotbcd as inf

from .test_infer_fotbcd import make_tar, png

ARRAYS = 2 * 2  # 組 × 前後（条件ごと）
TOTAL = ARRAYS * 2  # × 条件


def red(batch):
    return np.clip((batch[..., 0] * flair.STD[0] + flair.MEAN[0]) / 255, 0, 1)


def infer_all(tmp_path):
    tar = make_tar(tmp_path / "val-000000.tar")
    out = tmp_path / "out"
    result = flair.run_infer(tar, out, red)
    flair.write_meta(out, {"device": "fake"}, result["total"])
    return tar, out, result


def one_image(tmp_path, data, low_px):
    path = tmp_path / "one.tar"
    tar = make_tar(path, images={"000000000.before.png": data})
    with tarfile.open(tar, "r:") as tf:
        return flair.load_image(tf, inf.image_members(tf)[("000000000", "before")], low_px)


def test_colab_source_loads_the_shared_script_first(monkeypatch):
    monkeypatch.delitem(sys.modules, "infer_fotbcd", raising=False)
    code = compile(flair.colab_source("unknown"), "colab", "exec")  # from __future__ があると、ここで落ちる
    try:
        with pytest.raises(ValueError, match="PART"):
            exec(code, {"__name__": "__main__"})
        assert sys.modules["infer_fotbcd"].DATASET == inf.DATASET
    finally:
        sys.modules.pop("infer_fotbcd", None)


@pytest.mark.parametrize("low_px", flair.CONDITIONS.values())
def test_inputs_are_normalized_from_0_255(tmp_path, low_px):
    white = one_image(tmp_path, png([(0, 0, 512, 512)]), low_px)
    assert white.shape == (512, 512, 3) and white.dtype == np.float32
    expected = (255 - np.array(flair.MEAN)) / np.array(flair.STD)
    np.testing.assert_allclose(white[0, 0], expected, rtol=1e-6)


def test_lowres_loses_detail_and_native_keeps_it(tmp_path):
    stripes = png([(x, 0, x + 1, 512) for x in range(0, 512, 2)])  # 1 px 幅の縦じま
    native = one_image(tmp_path, stripes, None)
    lowres = one_image(tmp_path, stripes, flair.CONDITIONS["lowres"])
    assert np.ptp(native[256, :, 0]) == pytest.approx(255 / flair.STD[0], rel=1e-5)
    assert np.ptp(lowres[256, 16:-16, 0]) < 0.1 * np.ptp(native[256, :, 0])


def test_resize_is_bicubic_down_and_up(tmp_path):
    data = png([(101, 57, 230, 190)])
    got = one_image(tmp_path, data, 256)
    (tmp_path / "a.png").write_bytes(data)
    img = Image.open(tmp_path / "a.png").convert("RGB").resize((256, 256), Image.BICUBIC).resize((512, 512), Image.BICUBIC)
    np.testing.assert_allclose(got * np.array(flair.STD) + np.array(flair.MEAN), np.asarray(img), atol=1e-3)


def test_each_condition_is_readable_by_the_evaluator(tmp_path, monkeypatch):
    # meta.json には本物の tar のハッシュが入るので、偽の tar のものに差し替える（違う tar は、評価が止める）
    monkeypatch.setitem(inf.DATASET, "sha256", inf.sha256_file(make_tar(tmp_path / "val-000000.tar")))
    tar, out, result = infer_all(tmp_path)
    assert (result["done"], result["remaining"], result["total"]) == (TOTAL, 0, TOTAL)
    for condition in flair.CONDITIONS:
        scored = ev.evaluate_split(tar, out / condition, "val", fixed=(1.0, 0.4), log=lambda _: None)
        assert scored["inference"]["condition"] == condition
        assert scored["inference"]["arrays"] == ARRAYS


def test_a_run_over_the_budget_stops_and_resumes(tmp_path):
    tar = make_tar(tmp_path / "val-000000.tar")
    out = tmp_path / "out"
    clock = itertools.count(step=100).__next__
    first = flair.run_infer(tar, out, red, batch=3, budget_s=50, clock=clock)
    assert (first["done"], first["remaining"]) == (3, TOTAL - 3)
    second = flair.run_infer(tar, out, red, batch=3)
    assert (second["done"], second["remaining"]) == (TOTAL - 3, 0)
    assert sum(1 for _ in out.glob("*/*.npy")) == TOTAL


@pytest.mark.parametrize("bad", [lambda x: x[..., 0], lambda x: np.zeros(x.shape[:2])])
def test_broken_predictions_are_not_saved(tmp_path, bad):
    tar = make_tar(tmp_path / "val-000000.tar")
    out = tmp_path / "out"
    with pytest.raises(ValueError, match="推論の出力"):
        flair.run_infer(tar, out, bad)
    assert not list(out.glob("*/*.npy"))


def test_pack_and_unpack_each_condition(tmp_path):
    _, out, _ = infer_all(tmp_path)
    manifests = flair.pack(out, tmp_path / "pack")
    assert set(manifests) == set(flair.CONDITIONS)
    for condition in flair.CONDITIONS:
        dest = tmp_path / "unpacked" / condition
        assert inf.unpack(tmp_path / "pack" / condition, dest) == ARRAYS + 1
        assert json.loads((dest / "meta.json").read_text(encoding="utf-8"))["condition"] == condition


def keys():
    return [prefix + "x.weight" for prefix in flair.STATE_PREFIXES.values()]


def test_state_dict_is_split_and_unused_weights_are_dropped():
    state = dict.fromkeys([*keys(), "model.fusion_handler.conv_f.0.weight", "criterion.AERIAL_LABEL-COSIA.weight"], 1)
    parts = flair.split_state_dict(state)
    assert {name: list(part) for name, part in parts.items()} == {name: ["x.weight"] for name in flair.STATE_PREFIXES}


@pytest.mark.parametrize("state", [[*keys(), "model.aux_decoders.y"], keys()[:2]])
def test_unexpected_or_missing_weights_stop(state):
    with pytest.raises(ValueError, match="重みの名前"):
        flair.split_state_dict(dict.fromkeys(state, 1))
