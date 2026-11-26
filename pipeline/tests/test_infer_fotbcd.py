"""val の推論スクリプト（pipeline/colab/infer_fotbcd.py）。モデルは偽物で、GPU も通信も使わない。

偽の推論は「赤の値を、建物の確率にする」。黒い画像に白い矩形を描くと、そこが建物になる。
"""

from __future__ import annotations

import hashlib
import io
import itertools
import json
import tarfile
from pathlib import Path

import numpy as np
import pytest
from PIL import Image, ImageDraw

from pipeline import evaluate_fotbcd as ev
from pipeline import fotbcd
from pipeline.colab import infer_fotbcd as inf

from .test_fotbcd import N1, U1, doc, write_tar

TOTAL = 2 * 2 * 3  # 組 × 前後 × 大きさ


def png(rects=(), size=512):
    img = Image.new("RGB", (size, size))
    for x0, y0, x1, y1 in rects:
        ImageDraw.Draw(img).rectangle((x0, y0, x1 - 1, y1 - 1), fill=(255, 255, 255))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def make_tar(path, **kwargs):
    docs = {"000000000": doc([("NEW", N1), ("UNCHANGED", U1)]), "000000001": doc([], dep="13")}
    images = {
        "000000000.before.png": png([U1]),
        "000000000.after.png": png([U1, N1]),
        "000000001.before.png": png(),
        "000000001.after.png": png(),
    }
    return write_tar(path, docs, extra={**images, **kwargs.pop("images", {})}, **kwargs)


def red(batch):
    return batch[..., 0]


def infer_all(tmp_path):
    tar = make_tar(tmp_path / "val-000000.tar")
    out = tmp_path / "out"
    result = inf.run_infer(tar, out, red)
    inf.write_meta(out, {"device": "fake"}, result["total"])
    return tar, out, result


def files_of(folder):
    return {p.name: p.read_bytes() for p in Path(folder).iterdir()}


def test_constants_match_the_evaluator():
    assert inf.SIZES == tuple(ev.SCALE_SIZES.values())
    assert (inf.SIDES, inf.IMAGE_PX) == (fotbcd.SIDES, fotbcd.SIZE_PX)
    for side in inf.SIDES:
        for size in inf.SIZES:
            assert inf.output_name("000000001", side, size) == ev.prob_path("x", "000000001", side, size).name


def test_script_still_runs_after_the_runner_prepends_lines():
    source = Path(inf.__file__).read_text(encoding="utf-8")
    code = compile('PART = "unknown"\n' + source, "infer_fotbcd", "exec")  # from __future__ があると、ここで落ちる
    with pytest.raises(ValueError, match="PART"):
        exec(code, {"__name__": "__main__"})


def test_inputs_are_resized_and_scaled_to_0_1(tmp_path):
    seen = []

    def spy(batch):
        seen.append(batch.copy())
        return red(batch)

    inf.run_infer(make_tar(tmp_path / "val-000000.tar"), tmp_path / "out", spy)
    assert [b.shape for b in seen] == [(4, s, s, 3) for s in inf.SIZES]  # 大きさごとに束ねる
    full = seen[2][0]  # 512・組 0 の after
    assert full.dtype == np.float32
    assert (full[40, 40, 0], full[100, 100, 0]) == (1.0, 0.0)


def test_outputs_are_the_input_of_the_evaluator(tmp_path, monkeypatch):
    tar, out, result = infer_all(tmp_path)
    assert (result["done"], result["remaining"], result["total"]) == (TOTAL, 0, TOTAL)
    assert ev.missing_probs(out, fotbcd.read_pairs(tar), inf.SIZES) == []
    assert np.load(out / "000000000_after_256.npy").dtype == np.float16
    # この tar は val そのものではないので、そのままでは評価が止まる
    with pytest.raises(ValueError, match="別の tar"):
        ev.evaluate_split(tar, out, "val", log=lambda _: None)
    monkeypatch.setitem(inf.DATASET, "sha256", inf.sha256_file(tar))
    inf.write_meta(out, {"device": "fake"}, result["total"])
    r = ev.evaluate_split(tar, out, "val", log=lambda _: None)
    new = r["overall"]["new_building"]
    assert (new["n_ref"], new["n_pred"], new["tp"]) == (1, 1, 1)
    assert (r["inference"]["device"], r["inference"]["arrays"]) == ("fake", TOTAL)


def test_infer_resumes_after_the_time_budget_without_repeating(tmp_path):
    tar, out = make_tar(tmp_path / "val-000000.tar"), tmp_path / "out"
    calls = []

    def count(batch):
        calls.append(len(batch))
        return red(batch)

    ticks = itertools.count(0, 100)  # 時計を見るたびに 100 秒進む
    first = inf.run_infer(tar, out, count, batch=1, budget_s=240, clock=lambda: next(ticks))
    assert (first["done"], first["remaining"]) == (3, TOTAL - 3)
    one = inf.run_infer(tar, out, count, batch=1, budget_s=0)
    assert (one["done"], one["remaining"]) == (1, TOTAL - 4)  # 上限が 0 でも、1 束は進む
    rest = inf.run_infer(tar, out, count, batch=1)
    assert (rest["done"], rest["remaining"]) == (TOTAL - 4, 0)
    assert sum(calls) == TOTAL
    assert inf.run_infer(tar, out, count)["done"] == 0


@pytest.mark.parametrize("bad", [lambda b: b[..., 0][:, :-1], lambda b: b[..., 0] + 1.5, lambda b: b[..., 0] * np.nan])
def test_broken_model_output_saves_nothing(tmp_path, bad):
    with pytest.raises(ValueError):
        inf.run_infer(make_tar(tmp_path / "val-000000.tar"), tmp_path / "out", bad)
    assert list((tmp_path / "out").iterdir()) == []


@pytest.mark.parametrize("kwargs", [{"skip": ("000000001.after.png",)}, {"images": {"000000000.before.png": png(size=256)}}])
def test_unexpected_images_stop(tmp_path, kwargs):
    with pytest.raises(ValueError):
        inf.run_infer(make_tar(tmp_path / "val-000000.tar", **kwargs), tmp_path / "out", red)


def test_download_keeps_only_a_file_with_the_expected_size_and_hash(tmp_path):
    source = tmp_path / "source"
    source.write_bytes(b"weights")
    want = {"nbytes": 7, "sha256": hashlib.sha256(b"weights").hexdigest()}
    with pytest.raises(ValueError, match="ハッシュ"):
        inf.download(source.as_uri(), tmp_path / "bad", nbytes=7, sha256="0" * 64)
    assert not (tmp_path / "bad").exists()
    assert inf.download(source.as_uri(), tmp_path / "ok", **want) is True
    assert (tmp_path / "ok").read_bytes() == b"weights"
    assert inf.download("file:///no/such/file", tmp_path / "ok", **want) is False  # 合うものがあれば取得しない


def test_pack_and_unpack_give_back_the_same_files(tmp_path, capsys):
    _, out, _ = infer_all(tmp_path)
    manifest = inf.pack(out, tmp_path / "pack", max_bytes=1_000_000)
    assert len(manifest["parts"]) > 1
    assert manifest["files_total"] == TOTAL + 1 == sum(p["files"] for p in manifest["parts"])
    assert inf.cli(["unpack", str(tmp_path / "pack"), str(tmp_path / "probs")]) == 0
    assert files_of(tmp_path / "probs") == files_of(out)
    with pytest.raises(FileExistsError):
        inf.unpack(tmp_path / "pack", tmp_path / "probs")
    assert inf.cli([]) == 2


def test_pack_stops_when_inference_is_not_finished(tmp_path):
    out = tmp_path / "out"
    inf.run_infer(make_tar(tmp_path / "val-000000.tar"), out, red, batch=1, budget_s=0)
    with pytest.raises(ValueError, match="meta.json"):
        inf.pack(out, tmp_path / "pack")
    inf.write_meta(out, {}, TOTAL)
    with pytest.raises(ValueError, match="出力の数"):
        inf.pack(out, tmp_path / "pack")


def test_a_corrupted_part_extracts_nothing(tmp_path):
    _, out, _ = infer_all(tmp_path)
    manifest = inf.pack(out, tmp_path / "pack", max_bytes=1_000_000)
    last = tmp_path / "pack" / manifest["parts"][-1]["name"]
    data = bytearray(last.read_bytes())
    data[600] ^= 1
    last.write_bytes(bytes(data))
    with pytest.raises(ValueError, match="ハッシュ"):
        inf.unpack(tmp_path / "pack", tmp_path / "probs")
    assert not (tmp_path / "probs").exists()


@pytest.mark.parametrize("name", ["../000000000_after_256.npy", "notes.txt"])
def test_unexpected_member_extracts_nothing(tmp_path, name):
    pack_dir = tmp_path / "pack"
    pack_dir.mkdir()
    part = pack_dir / "fotbcd_probs_00.tar"
    with tarfile.open(part, "w") as tf:
        info = tarfile.TarInfo(name)
        info.size = 1
        tf.addfile(info, io.BytesIO(b"x"))
    entry = {"name": part.name, "bytes": part.stat().st_size, "sha256": inf.sha256_file(part), "files": 1}
    (pack_dir / "manifest.json").write_text(json.dumps({"files_total": 1, "parts": [entry]}), encoding="utf-8")
    with pytest.raises(ValueError, match="想定しない"):
        inf.unpack(pack_dir, tmp_path / "probs")
    assert not (tmp_path / "probs").exists() and not (tmp_path / "000000000_after_256.npy").exists()
