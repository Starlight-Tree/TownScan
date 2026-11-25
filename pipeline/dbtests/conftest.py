"""ローダーの DB のテストの共通部品。DB を使うテストは、環境変数 TEST_DATABASE_URL（使い捨ての Postgres）が無いと skip する。
1 つのコマンドで再現するには: scripts/test-loader.sh"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

import psycopg
import pytest
from psycopg.rows import dict_row

from pipeline.db import apply_schema
from pipeline.load import read_run_dir, write_run

# 合成データの生成（contract/synthetic.py）を import できるようにする
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "contract"))

FIXTURE_RUN = Path(__file__).parent / "fixtures" / "synthetic_run"


@pytest.fixture(scope="session")
def db_url() -> str:
    url = os.environ.get("TEST_DATABASE_URL", "").strip()
    if not url:
        pytest.skip("TEST_DATABASE_URL が未設定のため DB のテストを飛ばします（scripts/test-loader.sh で実行してください）")
    with psycopg.connect(url, autocommit=True) as c:
        apply_schema(c)
    return url


@pytest.fixture
def conn(db_url):
    """テストごとに空の DB（表は残し、行を消す）。"""
    with psycopg.connect(db_url, autocommit=True, row_factory=dict_row) as c:
        c.execute("TRUNCATE runs CASCADE")
        yield c


@pytest.fixture
def fixture_run(tmp_path) -> Path:
    """合成データの写し（テストが壊してよい）。"""
    dst = tmp_path / "out"
    shutil.copytree(FIXTURE_RUN, dst)
    return dst


@pytest.fixture
def loaded(conn):
    parsed = read_run_dir(FIXTURE_RUN)
    write_run(conn, parsed)
    return parsed
