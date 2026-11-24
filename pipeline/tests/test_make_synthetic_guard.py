"""make_synthetic_run が、実データのある出力先を上書きしないことの確認（外部通信なし。実データの置き場には書かない）。"""

import json
import shutil

import numpy as np
import pytest

from pipeline import colabio, make_synthetic_run, run_postprocess

KIBAN_REAL_NAME = "FG-GML-493040-BldA-20181001-0001.xml"


def snapshot(root):
    """root の下のファイルの内容（相対パス → バイト列）。上書き・追加・削除の検出に使う。"""
    return {str(p.relative_to(root)): p.read_bytes() for p in sorted(root.rglob("*")) if p.is_file()}


@pytest.fixture
def fake_real(tmp_path, monkeypatch):
    """実データの置き場に見立てた場所（Colab の実出力・取得済みの geocode.json・基盤地図情報の写真タイル）。本物の data/townscan には触れない。"""
    root = tmp_path / "townscan"
    colab = root / "run1" / "colab"
    colab.mkdir(parents=True)
    (colab / "meta_setup.json").write_text(json.dumps({"model": "real-model", "device": "T4"}), encoding="utf-8")
    (colab / "meta_infer.json").write_text(
        json.dumps({"normalization": "0-1", "tiles": [{"year": 2018, "x": 226274, "y": 105752}, {"year": 2023, "x": 226266, "y": 105755}]}),
        encoding="utf-8",
    )
    for year in colabio.YEARS:
        for x, y in ((226274, 105752), (226266, 105755)):
            for s in colabio.SCALES:
                np.save(colabio.prob_path(colab, year, x, y, s), np.zeros((int(256 * s),) * 2, dtype=np.float16))
    (root / "run1" / "geocode.json").write_text(json.dumps({"z18-226274-105752": {"results": {"muniCd": "43101", "lv01Nm": "実在の町"}}}), encoding="utf-8")
    monkeypatch.setattr(run_postprocess, "DEFAULT_DATA_ROOT", root)
    return root


def test_the_real_data_root_itself_is_refused_without_writing():
    # 本物の既定の置き場。確認だけで、何も作らない
    with pytest.raises(make_synthetic_run.UnsafeOutputError, match="実データの置き場"):
        make_synthetic_run.check_output_dir(run_postprocess.DEFAULT_DATA_ROOT)


def test_real_root_is_refused_even_with_dots_or_a_symlink(fake_real, tmp_path):
    before = snapshot(fake_real)
    link = tmp_path / "link"
    link.symlink_to(fake_real, target_is_directory=True)
    for alias in (fake_real / "run1" / "..", link, tmp_path / "x" / ".." / "townscan"):
        with pytest.raises(make_synthetic_run.UnsafeOutputError):
            make_synthetic_run.make_synthetic_run(alias, postprocess=False)
    assert snapshot(fake_real) == before and not (fake_real / "kiban").exists()


def test_real_colab_output_is_not_replaced_even_in_a_subfolder_root(fake_real):
    """実データの run1/colab を持つ root（上の置き場でなくても）は、tiles・geocode.json・meta.json を書き換えられない。"""
    other = fake_real.parent / "other_root"
    shutil.copytree(fake_real, other)
    before = snapshot(other)
    tiles_before = colabio.read_tiles(other / "run1" / "colab", other / "run1")
    with pytest.raises(make_synthetic_run.UnsafeOutputError, match="合成と確かめられない"):
        make_synthetic_run.make_synthetic_run(other, postprocess=False)
    assert snapshot(other) == before  # 1 バイトも変わらない（meta.json・geocode.json・kiban/ を作らない）
    assert colabio.read_tiles(other / "run1" / "colab", other / "run1") == tiles_before
    assert colabio.read_meta(other / "run1" / "colab").get("kind") is None


def test_real_data_in_the_default_synthetic_folder_is_not_touched_either(fake_real):
    inside = fake_real / "synthetic"
    (inside / "run1" / "colab").mkdir(parents=True)
    (inside / "run1" / "colab" / "meta.json").write_text(json.dumps({"kind": "real", "tiles": []}), encoding="utf-8")
    before = snapshot(inside)
    with pytest.raises(make_synthetic_run.UnsafeOutputError):
        make_synthetic_run.make_synthetic_run(inside, postprocess=False)
    assert snapshot(inside) == before


@pytest.mark.parametrize(
    "setup",
    [
        pytest.param(lambda c, r: (c / "meta.json").write_text(json.dumps({"kind": "real"}), encoding="utf-8"), id="meta_kind_real"),
        pytest.param(lambda c, r: (c / "meta.json").write_text(json.dumps({"tiles": []}), encoding="utf-8"), id="meta_without_kind"),
        pytest.param(lambda c, r: (c / "meta.json").write_text("{broken", encoding="utf-8"), id="meta_unreadable"),
        pytest.param(lambda c, r: (c / "meta.json").write_text("[1, 2]", encoding="utf-8"), id="meta_not_object"),
        pytest.param(
            lambda c, r: (
                (c / "meta.json").write_text(json.dumps({"kind": "synthetic"}), encoding="utf-8"),
                (c / "meta_infer.json").write_text("{}", encoding="utf-8"),
            ),
            id="synthetic_meta_mixed_with_real_meta_files",
        ),
        pytest.param(lambda c, r: np.save(c / "prob_2018_1_2_s100.npy", np.zeros((256, 256), dtype=np.float16)), id="prob_only"),
        pytest.param(lambda c, r: (r / "geocode.json").write_text("{}", encoding="utf-8"), id="geocode_only"),
        pytest.param(lambda c, r: (r / "truth.json").write_text("[]", encoding="utf-8"), id="truth_only"),
        pytest.param(
            lambda c, r: ((r.parent / "tiles" / "2018").mkdir(parents=True), (r.parent / "tiles" / "2018" / "1_2.png").write_bytes(b"png")),
            id="tiles_only",
        ),
        pytest.param(
            lambda c, r: ((r.parent / "kiban").mkdir(), (r.parent / "kiban" / KIBAN_REAL_NAME).write_text("<Dataset/>", encoding="utf-8")),
            id="real_looking_kiban_xml",
        ),
        pytest.param(
            lambda c, r: ((r.parent / "kiban").mkdir(), (r.parent / "kiban" / make_synthetic_run.KIBAN_FILE).write_text("<Dataset/>", encoding="utf-8")),
            id="same_name_kiban_without_the_synthetic_mark",
        ),
    ],
)
def test_anything_not_provably_synthetic_stops_the_run(tmp_path, setup):
    root = tmp_path / "r"
    run_dir = root / "run1"
    colab = run_dir / "colab"
    colab.mkdir(parents=True)
    setup(colab, run_dir)
    before = snapshot(root)
    with pytest.raises(make_synthetic_run.UnsafeOutputError):
        make_synthetic_run.make_synthetic_run(root)
    assert snapshot(root) == before


def test_empty_and_new_folders_are_fine(tmp_path):
    for root in (tmp_path / "new", tmp_path / "empty"):
        if root.name == "empty":
            root.mkdir()
        res = make_synthetic_run.make_synthetic_run(root, postprocess=False)
        assert colabio.read_meta(root / "run1" / "colab")["kind"] == "synthetic" and res["root"] == str(root)


def test_a_previous_synthetic_folder_can_be_regenerated(tmp_path):
    root = tmp_path / "s"
    make_synthetic_run.make_synthetic_run(root, created="2026-01-01T00:00:00+00:00")
    first = snapshot(root)
    make_synthetic_run.make_synthetic_run(root, created="2026-01-01T00:00:00+00:00")
    assert snapshot(root) == first  # 同じ入力から同じものができる（再生成で壊れない）


def test_run_name_must_be_a_plain_folder_name(tmp_path):
    for bad in ("", ".", "..", "../x", "a/b"):
        with pytest.raises(make_synthetic_run.UnsafeOutputError):
            make_synthetic_run.make_synthetic_run(tmp_path / "r", bad, postprocess=False)
    assert not (tmp_path / "r").exists() and not (tmp_path / "x").exists()


def test_cli_stops_with_a_message_and_writes_nothing(fake_real, capsys):
    before = snapshot(fake_real)
    assert make_synthetic_run.main([str(fake_real), "--no-postprocess"]) == 2
    captured = capsys.readouterr()
    assert "中止" in captured.err and captured.out == ""  # 成功のときの要約は出さない
    assert snapshot(fake_real) == before


def test_postprocess_reads_the_synthetic_kiban_explicitly(tmp_path):
    """合成の後処理は <root>/kiban を明示して読む（フォルダの有無による暗黙の切り替えに頼らない）。"""
    res = make_synthetic_run.make_synthetic_run(tmp_path / "s", created="2026-01-01T00:00:00+00:00")
    assert res["summary"]["kind"] == "synthetic" and res["summary"]["candidates"] == 7
    run = json.loads((tmp_path / "s" / "run1" / "out" / "run.json").read_text(encoding="utf-8"))
    assert run["params"]["kiban"]["load"]["kept"] > 0
