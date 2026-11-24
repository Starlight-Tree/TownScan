"""テストの共通部品。DB を使うテストは、環境変数 TEST_DATABASE_URL（使い捨ての Postgres）が無いと skip する。
1 つのコマンドで再現するには: scripts/test-backend.sh"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg.rows import dict_row

import jwt_tokens
import synthetic
from app import jwt_auth
from app.config import AuthConfig, Settings
from app.db import apply_schema
from app.load import read_run_dir, write_run
from app.main import create_app

FIXTURE_RUN = Path(__file__).parent / "fixtures" / "synthetic_run"


@pytest.fixture(scope="session")
def db_url() -> str:
    url = os.environ.get("TEST_DATABASE_URL", "").strip()
    if not url:
        pytest.skip("TEST_DATABASE_URL が未設定のため DB のテストを飛ばします（scripts/test-backend.sh で実行してください）")
    with psycopg.connect(url, autocommit=True) as c:
        apply_schema(c)
    return url


@pytest.fixture
def conn(db_url):
    """テストごとに空の DB（表は残し、行を消す）。"""
    with psycopg.connect(db_url, autocommit=True, row_factory=dict_row) as c:
        c.execute("TRUNCATE runs CASCADE")
        yield c


@pytest.fixture(scope="session")
def tiles_dir(tmp_path_factory) -> Path:
    d = tmp_path_factory.mktemp("tiles")
    synthetic.write_tiles(d)
    return d


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


def make_client(db_url: str, tiles: Path, auth: AuthConfig | None = None) -> TestClient:
    app = create_app(Settings(database_url=db_url, tiles_dir=tiles, auth=auth))
    return TestClient(app, raise_server_exceptions=False)


@pytest.fixture
def client(db_url, tiles_dir, conn, loaded):
    """合成データを読み込んだ API。"""
    with make_client(db_url, tiles_dir) as c:
        yield c


@pytest.fixture
def empty_client(db_url, tiles_dir, conn):
    """データが 1 件も無い API。"""
    with make_client(db_url, tiles_dir) as c:
        yield c


@pytest.fixture
def auth_config() -> AuthConfig:
    """テスト用のログイン設定（jwt_tokens の発行元・JWKS の URL・対象）。"""
    return AuthConfig(issuer=jwt_tokens.ISSUER, jwks_url=jwt_tokens.JWKS_URL, audience=jwt_tokens.AUDIENCE)


@pytest.fixture
def jwks_fetches(monkeypatch) -> list[str]:
    """画面のサーバー（Better Auth）の代わり。JWKS の取得を、テスト用の鍵を返す関数に差し替える（取りに行った URL が、返すリストに残る）。"""
    fetches: list[str] = []

    def fake_fetch(url: str) -> dict:
        fetches.append(url)
        return jwt_tokens.jwks_document()

    monkeypatch.setattr(jwt_auth, "fetch_jwks_document", fake_fetch)
    return fetches


@pytest.fixture
def me_client(db_url, tiles_dir, conn, loaded, auth_config, jwks_fetches):
    """ログインを設定した API（合成データつき。JWKS はテスト用の鍵）。"""
    with make_client(db_url, tiles_dir, auth=auth_config) as c:
        yield c
