"""ローダー（app.load）: 検査・冪等性・置き換え・ロールバック・日本語のエラー。"""

from __future__ import annotations

import json
from datetime import timedelta

import psycopg
import pytest

from app import load, queries
from app.db import apply_schema
from app.load import LoadError, main, read_run_dir, write_run
from conftest import FIXTURE_RUN

TABLES = ("runs", "areas", "buildings", "candidates", "metrics")


def counts(conn) -> dict[str, int]:
    return {t: conn.execute(f"SELECT count(*) AS n FROM {t}").fetchone()["n"] for t in TABLES}


def edit_json(path, fn):
    data = json.loads(path.read_text(encoding="utf-8"))
    fn(data)
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


# ---- DB なし（ファイルの検査） ----

def test_fixture_is_valid_and_counts():
    parsed = read_run_dir(FIXTURE_RUN)
    assert parsed.kind == "synthetic"
    assert parsed.counts == {"areas": 3, "buildings": 24, "candidates": 9}


def test_missing_file_is_reported_in_japanese(fixture_run):
    (fixture_run / "buildings_2018.geojson").unlink()
    with pytest.raises(LoadError, match=r"必要なファイルがありません.*buildings_2018\.geojson"):
        read_run_dir(fixture_run)


def test_missing_directory(tmp_path):
    with pytest.raises(LoadError, match="ディレクトリがありません"):
        read_run_dir(tmp_path / "nothing")


def test_broken_json(fixture_run):
    (fixture_run / "areas.json").write_text("[{", encoding="utf-8")
    with pytest.raises(LoadError, match=r"JSON として読めません: areas\.json"):
        read_run_dir(fixture_run)


def test_empty_file(fixture_run):
    (fixture_run / "eval.json").write_text("", encoding="utf-8")
    with pytest.raises(LoadError, match=r"JSON として読めません: eval\.json"):
        read_run_dir(fixture_run)


def test_nan_is_rejected(fixture_run):
    text = (fixture_run / "eval.json").read_text(encoding="utf-8").replace('"f1": 0.76', '"f1": NaN')
    (fixture_run / "eval.json").write_text(text, encoding="utf-8")
    with pytest.raises(LoadError, match="NaN"):
        read_run_dir(fixture_run)


def test_bad_class_names_the_file_and_field(fixture_run):
    edit_json(fixture_run / "candidates.geojson", lambda d: d["features"][0]["properties"].update({"class": "確定"}))
    with pytest.raises(LoadError) as e:
        read_run_dir(fixture_run)
    msg = str(e.value)
    assert "candidates.geojson" in msg and "features[0].properties.class" in msg and "confirmed_new" in msg


def test_unknown_area_in_candidates(fixture_run):
    edit_json(fixture_run / "candidates.geojson", lambda d: d["features"][0]["properties"].update({"area_id": "z18-1-1"}))
    with pytest.raises(LoadError, match="areas.json に無い地区"):
        read_run_dir(fixture_run)


def test_unknown_area_in_buildings(fixture_run):
    edit_json(fixture_run / "buildings_2023.geojson", lambda d: d["features"][0]["properties"].update({"area_id": "z18-1-1"}))
    with pytest.raises(LoadError, match=r"(?s)buildings_2023\.geojson.*areas.json に無い地区"):
        read_run_dir(fixture_run)


def test_evidence_must_have_the_contract_keys(fixture_run):
    edit_json(fixture_run / "candidates.geojson", lambda d: d["features"][0]["properties"]["evidence"].pop("ov_kiban"))
    with pytest.raises(LoadError, match=r"evidence\.ov_kiban"):
        read_run_dir(fixture_run)


def test_evidence_edge_touch_must_be_boolean(fixture_run):
    edit_json(fixture_run / "candidates.geojson", lambda d: d["features"][0]["properties"]["evidence"].update({"edge_touch": 1}))
    with pytest.raises(LoadError, match=r"evidence\.edge_touch"):
        read_run_dir(fixture_run)


def test_non_string_area_id_is_a_clear_error_not_a_crash(fixture_run):
    edit_json(fixture_run / "candidates.geojson", lambda d: d["features"][0]["properties"].update({"area_id": ["x"]}))
    with pytest.raises(LoadError, match="areas.json に無い地区"):
        read_run_dir(fixture_run)
    edit_json(fixture_run / "buildings_2018.geojson", lambda d: d["features"][0]["properties"].update({"area_id": {"a": 1}}))
    with pytest.raises(LoadError, match="areas.json に無い地区"):
        read_run_dir(fixture_run)


def test_wrong_top_level_types(fixture_run):
    (fixture_run / "areas.json").write_text("{}", encoding="utf-8")
    with pytest.raises(LoadError, match="areas.json"):
        read_run_dir(fixture_run)


def test_duplicate_candidate_id(fixture_run):
    def dup(d):
        d["features"][1]["id"] = d["features"][0]["id"]

    edit_json(fixture_run / "candidates.geojson", dup)
    with pytest.raises(LoadError, match="重複"):
        read_run_dir(fixture_run)


def test_bad_candidate_id_format(fixture_run):
    edit_json(fixture_run / "candidates.geojson", lambda d: d["features"][0].update({"id": "../etc/passwd"}))
    with pytest.raises(LoadError, match=r"c-\{x\}-\{y\}-\{n\}"):
        read_run_dir(fixture_run)


def test_bad_kind_is_required(fixture_run):
    edit_json(fixture_run / "run.json", lambda d: d.update({"kind": "fake"}))
    with pytest.raises(LoadError, match="kind"):
        read_run_dir(fixture_run)
    edit_json(fixture_run / "run.json", lambda d: d.pop("kind"))
    with pytest.raises(LoadError, match="kind"):
        read_run_dir(fixture_run)


def test_run_id_with_sql_is_rejected(fixture_run):
    edit_json(fixture_run / "run.json", lambda d: d.update({"run_id": "x'; DROP TABLE runs;--"}))
    with pytest.raises(LoadError, match="run_id"):
        read_run_dir(fixture_run)


def test_geometry_out_of_range(fixture_run):
    edit_json(fixture_run / "candidates.geojson",
              lambda d: d["features"][0]["geometry"]["coordinates"][0].__setitem__(0, [999, 0]))
    with pytest.raises(LoadError, match="座標が不正"):
        read_run_dir(fixture_run)


def test_area_id_must_match_xyz(fixture_run):
    edit_json(fixture_run / "areas.json", lambda d: d[0].update({"x": 1}))
    with pytest.raises(LoadError, match="一致しません"):
        read_run_dir(fixture_run)


def test_many_problems_are_summarised(fixture_run):
    def break_all(d):
        for f in d["features"]:
            f["properties"].update({"class": "x", "reason": "y"})

    edit_json(fixture_run / "candidates.geojson", break_all)
    with pytest.raises(LoadError) as e:
        read_run_dir(fixture_run)
    assert "ほか 8 件" in str(e.value)  # 18 件の問題のうち、最初の 10 件と残りの件数を出す


def test_naive_created_is_treated_as_jst(fixture_run):
    edit_json(fixture_run / "run.json", lambda d: d.update({"created": "2026-11-24T12:00:00"}))
    assert read_run_dir(fixture_run).created_at.utcoffset() == timedelta(hours=9)


def test_notes_list_is_joined(fixture_run):
    edit_json(fixture_run / "run.json", lambda d: d.update({"notes": ["一", "二"]}))
    assert read_run_dir(fixture_run).notes == "一\n二"


def test_cli_reports_error_and_returns_1(tmp_path, capsys):
    assert main(["--run", str(tmp_path / "none")]) == 1
    assert "エラー: ディレクトリがありません" in capsys.readouterr().err


def test_cli_check_does_not_need_db(capsys, monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    assert main(["--run", str(FIXTURE_RUN), "--check"]) == 0
    out = capsys.readouterr().out
    assert "検査に合格" in out and "合成データ" in out


def test_cli_without_database_url(monkeypatch, capsys):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    assert main(["--run", str(FIXTURE_RUN)]) == 1
    assert "DATABASE_URL" in capsys.readouterr().err


# ---- DB あり ----

def test_load_writes_all_tables(conn):
    write_run(conn, read_run_dir(FIXTURE_RUN))
    assert counts(conn) == {"runs": 1, "areas": 3, "buildings": 24, "candidates": 9, "metrics": 1}
    run = queries.current_run(conn)
    assert run["run_id"] == "synthetic-test" and run["kind"] == "synthetic"
    assert run["notes"] == "合成データ（テスト用）。実データではない"


def test_load_is_idempotent(conn):
    parsed = read_run_dir(FIXTURE_RUN)
    write_run(conn, parsed)
    first = counts(conn)
    ids_first = [r["id"] for r in conn.execute("SELECT id FROM candidates ORDER BY id").fetchall()]
    write_run(conn, parsed)
    write_run(conn, parsed)
    assert counts(conn) == first
    assert [r["id"] for r in conn.execute("SELECT id FROM candidates ORDER BY id").fetchall()] == ids_first


def test_reload_replaces_the_run(conn, fixture_run):
    write_run(conn, read_run_dir(fixture_run))
    edit_json(fixture_run / "candidates.geojson", lambda d: d["features"].pop(0))
    write_run(conn, read_run_dir(fixture_run))
    assert counts(conn)["candidates"] == 8
    assert counts(conn)["runs"] == 1


def test_failure_in_the_middle_rolls_back_to_the_previous_state(conn, monkeypatch, fixture_run):
    write_run(conn, read_run_dir(fixture_run))
    before = counts(conn)
    edit_json(fixture_run / "candidates.geojson", lambda d: d["features"].pop(0))

    def boom(*_a, **_k):
        raise RuntimeError("途中で失敗")

    monkeypatch.setattr(load, "_insert_candidates", boom)
    with pytest.raises(RuntimeError):
        write_run(conn, read_run_dir(fixture_run))
    assert counts(conn) == before  # 古い run が消えていない


def test_latest_created_run_is_current(conn, fixture_run):
    write_run(conn, read_run_dir(FIXTURE_RUN))
    edit_json(fixture_run / "run.json", lambda d: d.update({"run_id": "synthetic-newer", "created": "2026-11-25T09:00:00+09:00"}))
    write_run(conn, read_run_dir(fixture_run))
    assert counts(conn)["runs"] == 2
    assert queries.current_run(conn)["run_id"] == "synthetic-newer"
    # 同じ id の地区・候補が 2 つの run に共存できる（主キーが (run_id, id)）
    assert counts(conn)["candidates"] == 18


def test_quotes_and_sql_in_values_are_stored_verbatim(conn, fixture_run):
    nasty = "O'Hara'); DROP TABLE areas; --"
    edit_json(fixture_run / "areas.json", lambda d: d[0].update({"name": nasty}))
    write_run(conn, read_run_dir(fixture_run))
    assert counts(conn)["areas"] == 3
    assert conn.execute("SELECT name FROM areas WHERE name = %s", (nasty,)).fetchone()["name"] == nasty


def test_area_without_a_name_gets_a_string_name_in_the_api(conn, fixture_run):
    edit_json(fixture_run / "areas.json", lambda d: d[0].update({"name": None, "ward": None}))
    write_run(conn, read_run_dir(fixture_run))
    a = queries.list_areas(conn, "synthetic-test")[0]
    assert a["name"] == a["id"] and a["ward"] == ""


def test_cli_loads_into_db(conn, db_url, monkeypatch, capsys):
    monkeypatch.setenv("DATABASE_URL", db_url)
    assert main(["--run", str(FIXTURE_RUN)]) == 0
    assert "読み込みました" in capsys.readouterr().out
    assert counts(conn)["candidates"] == 9


def test_cli_db_unreachable(monkeypatch, capsys):
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@127.0.0.1:1/none?connect_timeout=2")
    assert main(["--run", str(FIXTURE_RUN)]) == 1
    assert "DB に接続できません" in capsys.readouterr().err


def test_schema_can_be_applied_repeatedly(conn):
    apply_schema(conn)
    apply_schema(conn)


def test_class_check_constraint(conn, loaded):
    with pytest.raises(psycopg.errors.CheckViolation):
        conn.execute(
            "INSERT INTO candidates (id, run_id, area_id, class, area_m2, west, south, east, north,"
            " centroid_lon, centroid_lat, geom, evidence, reason)"
            " SELECT 'c-1-1-1', run_id, id, 'bogus', 1, 0, 0, 1, 1, 0, 0, '{}', '{}', 'edge' FROM areas LIMIT 1"
        )


def test_committed_fixture_matches_the_generator(tmp_path):
    """tests/fixtures/synthetic_run は synthetic.py の出力そのもの（手で直したら、ここで落ちる）。"""
    import synthetic

    synthetic.write_run(tmp_path)
    names = sorted(p.name for p in tmp_path.iterdir())
    assert names == sorted(p.name for p in FIXTURE_RUN.iterdir())
    for name in names:
        assert (tmp_path / name).read_text(encoding="utf-8") == (FIXTURE_RUN / name).read_text(encoding="utf-8"), name
