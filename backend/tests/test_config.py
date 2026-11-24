"""設定: 環境変数・LLM_PROVIDER の検査。DB は要らない。"""

from __future__ import annotations

import pytest

from app.config import ConfigError, Settings
from app.main import create_app


def test_from_env_requires_database_url():
    with pytest.raises(ConfigError, match="DATABASE_URL"):
        Settings.from_env({})


def test_from_env_defaults():
    s = Settings.from_env({"DATABASE_URL": "postgresql://u:pw@db/x"})
    assert s.llm_provider == "mock" and str(s.tiles_dir) == "/data/townscan/tiles"


def test_repr_hides_the_database_url():
    assert "pw-secret" not in repr(Settings(database_url="postgresql://u:pw-secret@db/x"))


@pytest.mark.parametrize("provider", ["openai", "anthropic", "gemini", "MOCK", ""])
def test_non_mock_provider_fails_at_startup(provider):
    with pytest.raises(ConfigError, match="LLM_PROVIDER"):
        create_app(Settings(database_url="postgresql://u:p@db/x", llm_provider=provider))


def test_mock_provider_is_accepted():
    Settings(database_url="postgresql://u:p@db/x", llm_provider="mock").validate()


def test_startup_gives_up_with_a_clear_error_when_db_is_unreachable():
    from app.db import make_pool, wait_and_apply_schema

    pool = make_pool("postgresql://u:p@127.0.0.1:1/none?connect_timeout=1", timeout=0.3)
    pool.open()
    try:
        with pytest.raises(RuntimeError, match="DB に接続してスキーマを適用できませんでした"):
            wait_and_apply_schema(pool, attempts=2, delay=0)
    finally:
        pool.close()
