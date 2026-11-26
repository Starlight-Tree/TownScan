"""アプリの地区の写真に FLAIR-HUB をかけるスクリプト（pipeline/colab/infer_flairhub_app.py。仕様 §4.1）。

モデルとタイルの取得は偽物で、torch も GPU も通信も使わない。偽の推論は、正規化を戻した「赤の値を、建物の確率にする」。
黒い写真に白い矩形を描くと、そこが建物になる。
"""

from __future__ import annotations

import io
import json
import sys

import numpy as np
import pytest
from PIL import Image, ImageDraw

from pipeline import colabio, run_postprocess
from pipeline.colab import infer_flairhub as flair
from pipeline.colab import infer_flairhub_app as app

TILES = [{"x": 132739, "y": 90287}, {"x": 132672, "y": 90168}]  # 番号の順ではない（渡した順が残ることを見る）
COUNT = len(TILES) * len(app.YEARS)


def photo(rects=(), size=256):
    img = Image.new("RGB", (size, size))
    draw = ImageDraw.Draw(img)
    for x0, y0, x1, y1 in rects:
        draw.rectangle((x0, y0, x1 - 1, y1 - 1), fill=(255, 255, 255))
    buffer = io.BytesIO()
    img.save(buffer, format="PNG")
    return buffer.getvalue()


def fake_fetch(url):
    """2024 年の写真にだけ、白い正方形（40 px 四方。約 15.7 m 四方）がある。"""
    return photo([(100, 100, 140, 140)] if "ORTHOPHOTOS2024" in url else [])


def red(batch):
    return np.clip((batch[..., 0] * flair.STD[0] + flair.MEAN[0]) / 255, 0, 1)


def infer_all(out, **kwargs):
    kwargs = {"fetch": fake_fetch, "sleep": lambda _: None, **kwargs}
    records = app.run_infer(TILES, out, kwargs.pop("predict", red), **kwargs)
    app.write_meta(out, {"device": "fake"}, records)
    return records


def test_tile_url_names_the_layer_of_each_year():
    old, new = app.tile_url(2014, 5, 7), app.tile_url(2024, 5, 7)
    assert "LAYER=ORTHOIMAGERY.ORTHOPHOTOS2014&" in old and "TILEMATRIXSET=PM_0_18&" in old
    assert "LAYER=ORTHOIMAGERY.ORTHOPHOTOS2024&" in new and "TILEMATRIXSET=PM_6_19&" in new
    assert old.endswith("TILEMATRIX=18&TILEROW=7&TILECOL=5")


def test_tiles_are_requested_with_a_generic_client_name(monkeypatch):
    seen = []

    def opened(request, timeout):
        seen.append(request.get_header("User-agent"))
        return io.BytesIO(b"data")

    monkeypatch.setattr(app.urllib.request, "urlopen", opened)
    assert app.fetch_tile("https://example.invalid/tile") == b"data"
    assert seen == ["research-client/1.0"]


def test_input_is_the_bicubic_double_normalized_from_0_255():
    data = photo([(31, 57, 98, 130)])
    got = app.model_input(Image.open(io.BytesIO(data)).convert("RGB"))
    assert got.shape == (512, 512, 3) and got.dtype == np.float32
    want = Image.open(io.BytesIO(data)).convert("RGB").resize((512, 512), Image.BICUBIC)
    np.testing.assert_allclose(got * np.array(flair.STD) + np.array(flair.MEAN), np.asarray(want), atol=1e-3)


def test_each_tile_and_year_is_saved_in_the_given_order(tmp_path):
    waits = []
    records = infer_all(tmp_path, sleep=waits.append)
    assert [(r["x"], r["year"]) for r in records] == [(132739, 2014), (132739, 2024), (132672, 2014), (132672, 2024)]
    assert waits == [app.INTERVAL_S] * COUNT
    prob = np.load(tmp_path / "prob_2024_132739_90287_s200.npy")
    assert prob.shape == (512, 512) and prob.dtype == np.float16
    assert prob[240, 240] == 1 and prob[20, 20] == 0
    saved = np.asarray(Image.open(tmp_path / "tile_2024_132739_90287.png"))
    np.testing.assert_array_equal(saved, np.asarray(Image.open(io.BytesIO(photo([(100, 100, 140, 140)])))))


def test_wrong_tile_size_stops(tmp_path):
    with pytest.raises(ValueError, match="タイルの大きさ"):
        app.run_infer(TILES, tmp_path, red, fetch=lambda _: photo(size=512), sleep=lambda _: None)
    assert not list(tmp_path.glob("*.npy"))


def test_failed_fetch_stops_after_waiting(tmp_path):
    waits = []

    def broken(url):
        raise OSError("down")

    with pytest.raises(OSError):
        app.run_infer(TILES, tmp_path, red, fetch=broken, sleep=waits.append)
    assert waits == [app.INTERVAL_S]


@pytest.mark.parametrize("bad", [lambda x: x[..., 0], lambda x: np.full(x.shape[:3], np.nan), lambda x: x[0, ..., 0]])
def test_broken_predictions_are_not_saved(tmp_path, bad):
    with pytest.raises(ValueError, match="推論の出力"):
        app.run_infer(TILES, tmp_path, bad, fetch=fake_fetch, sleep=lambda _: None)
    assert not list(tmp_path.glob("*.npy"))


def test_no_tiles_is_an_error(tmp_path):
    with pytest.raises(ValueError, match="TILES"):
        app.run_infer([], tmp_path, red)


def test_postprocess_reads_the_output(tmp_path):
    run_dir = tmp_path / "fr2"
    infer_all(run_dir / "colab")
    assert colabio.read_tiles(run_dir / "colab", run_dir) == [(18, t["x"], t["y"]) for t in TILES]
    assert colabio.model_name(colabio.read_meta(run_dir / "colab")) == flair.MODEL["repo"]
    summary = run_postprocess.run_postprocess(tmp_path, "fr2", fixed=(2.0, 0.6), log=lambda _: None)
    assert (summary["run_id"], summary["areas"]) == ("fr2", 2)
    assert (summary["buildings_2014"], summary["buildings_2024"], summary["candidates"]) == (0, 2, 2)
    run_json = json.loads((run_dir / "out" / "run.json").read_text(encoding="utf-8"))
    assert run_json["model"] == flair.MODEL["repo"]
    assert (run_json["params"]["scale"], run_json["params"]["threshold"]) == (2.0, 0.6)
    assert "tiles" not in run_json["params"]["colab"]


def test_pack_and_unpack_give_back_the_same_files(tmp_path):
    out = tmp_path / "out"
    infer_all(out)
    (out / "stray.txt").write_text("x", encoding="utf-8")  # 想定しない名前は詰めない
    manifest = app.pack(out, tmp_path / "pack")
    assert manifest["files_total"] == COUNT * 2 + 1
    assert app.cli(["unpack", str(tmp_path / "pack"), str(tmp_path / "back")]) == 0
    names = sorted(p.name for p in (tmp_path / "back").iterdir())
    assert names == sorted(p.name for p in out.iterdir() if p.name != "stray.txt")
    assert all((tmp_path / "back" / n).read_bytes() == (out / n).read_bytes() for n in names)
    with pytest.raises(FileExistsError):
        app.unpack(tmp_path / "pack", tmp_path / "back")
    assert app.cli([]) == 2


def test_pack_needs_finished_and_complete_outputs(tmp_path):
    out = tmp_path / "out"
    app.run_infer(TILES, out, red, fetch=fake_fetch, sleep=lambda _: None)
    with pytest.raises(ValueError, match="meta.json"):
        app.pack(out, tmp_path / "pack")
    infer_all(out)
    (out / "tile_2014_132739_90287.png").unlink()
    with pytest.raises(ValueError, match="出力の数"):
        app.pack(out, tmp_path / "pack")


def test_colab_source_loads_the_shared_scripts_first(monkeypatch):
    for name in ("infer_fotbcd", "infer_flairhub"):
        monkeypatch.delitem(sys.modules, name, raising=False)
    code = compile(app.colab_source("unknown", [{**TILES[0], "val_new": 7}]), "colab", "exec")
    scope = {"__name__": "__main__"}
    try:
        with pytest.raises(ValueError, match="PART"):
            exec(code, scope)
        assert scope["TILES"] == [TILES[0]]
        assert sys.modules["infer_flairhub"].MODEL == flair.MODEL
        assert scope["flair"] is sys.modules["infer_flairhub"]
    finally:
        for name in ("infer_fotbcd", "infer_flairhub"):
            sys.modules.pop(name, None)
