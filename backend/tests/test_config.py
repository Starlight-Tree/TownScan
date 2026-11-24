"""設定: 環境変数・LLM_PROVIDER の検査。DB は要らない。"""

from __future__ import annotations

import logging

import pytest
from fastapi.testclient import TestClient

from app.config import AuthConfig, ConfigError, Settings
from app.main import create_app


def test_from_env_requires_database_url():
    with pytest.raises(ConfigError, match="DATABASE_URL"):
        Settings.from_env({})


def test_from_env_defaults():
    s = Settings.from_env({"DATABASE_URL": "postgresql://u:pw@db/x"})
    assert s.llm_provider == "mock" and str(s.tiles_dir) == "/data/townscan/tiles"


def test_repr_hides_the_database_url():
    assert "pw-secret" not in repr(Settings(database_url="postgresql://u:pw-secret@db/x"))


@pytest.mark.parametrize("provider", ["openai", "anthropic", "GEMINI", "MOCK", ""])
def test_unsupported_provider_fails_at_startup(provider):
    with pytest.raises(ConfigError, match="LLM_PROVIDER"):
        create_app(Settings(database_url="postgresql://u:p@db/x", llm_provider=provider))


def test_mock_provider_is_accepted():
    Settings(database_url="postgresql://u:p@db/x", llm_provider="mock").validate()


# ---- 実 LLM（Gemini。任意）。キーは .env に自分で書く。値は、エラー・repr・ログに出さない ----

DB_ENV = {"DATABASE_URL": "postgresql://u:pw@db/x"}


def test_llm_defaults_to_mock_without_gemini_settings():
    s = Settings.from_env(DB_ENV)
    assert s.llm_provider == "mock" and s.gemini_api_key == "" and s.gemini_model == "gemini-3.5-flash-lite"
    assert create_app(s).state.llm is None  # 既定は模擬モデル（実 LLM の窓口は作らない）


@pytest.mark.parametrize("key", ["", "   "])
def test_gemini_without_a_key_fails_at_startup_with_a_clear_japanese_message(key):
    s = Settings.from_env({**DB_ENV, "LLM_PROVIDER": "gemini", "GEMINI_API_KEY": key})
    with pytest.raises(ConfigError, match="GEMINI_API_KEY を .env に書いてください"):
        create_app(s)


def test_gemini_without_the_key_variable_at_all_fails_at_startup():
    with pytest.raises(ConfigError, match="GEMINI_API_KEY"):
        create_app(Settings.from_env({**DB_ENV, "LLM_PROVIDER": "gemini"}))


def test_a_set_gemini_key_is_accepted_and_never_shown():
    secret = "AIzaSyDUMMY-key_for-test0123456789abcd"
    s = Settings.from_env({**DB_ENV, "LLM_PROVIDER": " gemini ", "GEMINI_API_KEY": f" {secret}\n", "GEMINI_MODEL": " gemini-x.y "})
    s.validate()
    assert s.gemini_api_key == secret and s.gemini_model == "gemini-x.y"
    assert secret not in repr(s) and secret not in str(s)
    app = create_app(s)
    assert secret not in repr(app.state.llm) and app.state.llm.model == "gemini-x.y"


@pytest.mark.parametrize("bad_key", ["has space", "tab\there", "日本語のキー", "line1\nline2"])
def test_a_malformed_gemini_key_fails_without_echoing_it(bad_key):
    s = Settings.from_env({**DB_ENV, "LLM_PROVIDER": "gemini", "GEMINI_API_KEY": bad_key})
    with pytest.raises(ConfigError) as exc:
        s.validate()
    assert "GEMINI_API_KEY" in str(exc.value)
    assert bad_key.strip() not in str(exc.value) and bad_key not in str(exc.value)


@pytest.mark.parametrize("bad_model", ["a/b", "../x", "m?key=1", "m:generateContent", "-lead", "x" * 80])
def test_a_malformed_gemini_model_name_fails_at_startup(bad_model):
    s = Settings(database_url="postgresql://u:p@db/x", llm_provider="gemini", gemini_api_key="k", gemini_model=bad_model)
    with pytest.raises(ConfigError, match="GEMINI_MODEL"):
        s.validate()


def test_startup_gives_up_with_a_clear_error_when_db_is_unreachable():
    from app.db import make_pool, wait_and_apply_schema

    pool = make_pool("postgresql://u:p@127.0.0.1:1/none?connect_timeout=1", timeout=0.3)
    pool.open()
    try:
        with pytest.raises(RuntimeError, match="DB に接続してスキーマを適用できませんでした"):
            wait_and_apply_schema(pool, attempts=2, delay=0)
    finally:
        pool.close()


# ---- ログイン（AUTH_ISSUER・AUTH_AUDIENCE・AUTH_JWKS_URL）。任意の機能で、足りなければ未設定として動く ----

DB = {"DATABASE_URL": "postgresql://u:pw@db/x"}


def test_auth_is_off_by_default():
    assert Settings.from_env(DB).auth is None
    assert create_app(Settings.from_env(DB)).state.verifier is None


@pytest.mark.parametrize(
    "env",
    [
        {"AUTH_ISSUER": "http://localhost:3500"},  # JWKS の URL が無い
        {"AUTH_JWKS_URL": "http://web:3000/api/auth/jwks"},  # 発行元が無い
        {"AUTH_ISSUER": "  ", "AUTH_JWKS_URL": ""},
        {"AUTH_AUDIENCE": "townscan"},
    ],
)
def test_auth_needs_both_issuer_and_jwks_url(env):
    assert Settings.from_env({**DB, **env}).auth is None


def test_auth_from_env_defaults_the_audience_to_townscan():
    s = Settings.from_env({**DB, "AUTH_ISSUER": "http://localhost:3500", "AUTH_JWKS_URL": "http://web:3000/api/auth/jwks"})
    assert s.auth == AuthConfig(issuer="http://localhost:3500", jwks_url="http://web:3000/api/auth/jwks", audience="townscan")
    assert create_app(s).state.verifier is not None


def test_auth_from_env_reads_audience_and_strips_trailing_slashes():
    s = Settings.from_env(
        {**DB, "AUTH_ISSUER": " https://townscan.example/ ", "AUTH_JWKS_URL": "https://townscan.example/api/auth/jwks/", "AUTH_AUDIENCE": " other "}
    )
    assert s.auth == AuthConfig(issuer="https://townscan.example", jwks_url="https://townscan.example/api/auth/jwks", audience="other")


# 形が不正な URL は、起動を止めない（以前は ConfigError で止めていた。compose は web の BETTER_AUTH_URL と同じ値を AUTH_ISSUER へ渡すので、
# BETTER_AUTH_URL の書き間違い 1 つで api が落ち続け、web も api の healthy を待つため、チャット・地図まで使えなくなっていた。仕様 §2.1）。
# 代わりに、変数名だけを警告に出し、検証を無効にする（/api/me が 503）。値は出さない（URL にユーザー名・パスワードが入りうる）。
BAD_URLS = [
    "ftp://web/jwks",
    "file:///etc/passwd",
    "web:3000/jwks",
    "localhost:3500",  # BETTER_AUTH_URL に、http:// を付け忘れた値
    "http://",
    "javascript:alert(1)",
    "http://[::1",  # urlsplit 自体が ValueError を出す形
    "http://web:99999/jwks",  # ポートが範囲外（urlsplit は port を読むまで気づかない）
    "http://web:abc/jwks",
    "ftp://admin:secret-marker@web/jwks",
]


def _auth_warnings(caplog) -> list[logging.LogRecord]:
    return [r for r in caplog.records if r.name == "townscan" and r.levelno == logging.WARNING]


@pytest.mark.parametrize("name", ["AUTH_ISSUER", "AUTH_JWKS_URL"])
@pytest.mark.parametrize("bad", BAD_URLS)
def test_malformed_auth_urls_turn_login_off_without_stopping_startup(name, bad, caplog):
    env = {**DB, "AUTH_ISSUER": "http://localhost:3500", "AUTH_JWKS_URL": "http://web:3000/api/auth/jwks", name: bad}
    with caplog.at_level(logging.WARNING, logger="townscan"):
        s = Settings.from_env(env)  # ConfigError にならない
    # 警告は 1 行。出すのは変数名だけで、値（と、その一部）は出さない
    warnings = _auth_warnings(caplog)
    assert len(warnings) == 1
    assert name in warnings[0].getMessage()
    assert bad not in caplog.text and "secret-marker" not in caplog.text

    assert s.auth is None
    s.validate()  # 起動の検査にも通る
    assert create_app(s).state.verifier is None  # 検証は無効（/api/me は 503）


def test_both_malformed_auth_urls_are_named_in_one_warning(caplog):
    with caplog.at_level(logging.WARNING, logger="townscan"):
        s = Settings.from_env({**DB, "AUTH_ISSUER": "localhost:3500", "AUTH_JWKS_URL": "web:3000/jwks"})
    assert s.auth is None
    warnings = _auth_warnings(caplog)
    assert len(warnings) == 1
    assert "AUTH_ISSUER" in warnings[0].getMessage() and "AUTH_JWKS_URL" in warnings[0].getMessage()
    assert "localhost:3500" not in caplog.text and "web:3000" not in caplog.text


@pytest.mark.parametrize(
    "env",
    [
        {},
        {"AUTH_ISSUER": "http://localhost:3500"},  # JWKS の URL が無いのは、設定ミスではなく未設定。静かに無効
        {"AUTH_ISSUER": "  ", "AUTH_JWKS_URL": ""},
    ],
)
def test_unset_auth_urls_log_nothing(env, caplog):
    with caplog.at_level(logging.WARNING, logger="townscan"):
        assert Settings.from_env({**DB, **env}).auth is None
    assert _auth_warnings(caplog) == []


def test_valid_auth_urls_log_nothing(caplog):
    with caplog.at_level(logging.WARNING, logger="townscan"):
        s = Settings.from_env({**DB, "AUTH_ISSUER": "http://localhost:3500", "AUTH_JWKS_URL": "http://web:3000/api/auth/jwks"})
    assert s.auth is not None
    assert _auth_warnings(caplog) == []


@pytest.mark.parametrize("audience", ["", "   ", "x" * 500, "http://not a url", "日本語の対象"])
def test_audience_never_stops_startup(audience):
    # AUTH_AUDIENCE は形の検査が無い（JWT の aud と比べるだけの文字列）。空・空白だけなら既定の townscan
    env = {**DB, "AUTH_ISSUER": "http://localhost:3500", "AUTH_JWKS_URL": "http://web:3000/api/auth/jwks", "AUTH_AUDIENCE": audience}
    s = Settings.from_env(env)
    assert s.auth is not None and s.auth.audience == (audience.strip() or "townscan")


def test_the_database_url_is_still_required_even_when_login_is_misconfigured():
    # 起動を止めなくなったのは、ログインの任意の設定（AUTH_*）の形の不正だけ。DB の接続先が無いのは、これまでどおり起動時のエラー
    with pytest.raises(ConfigError, match="DATABASE_URL"):
        Settings.from_env({"AUTH_ISSUER": "localhost:3500", "AUTH_JWKS_URL": "web:3000/jwks"})


def test_a_misspelled_better_auth_url_leaves_every_other_endpoint_working(db_url, tiles_dir, conn, loaded):
    """実際に起きた形: compose が BETTER_AUTH_URL（例: localhost:3500）をそのまま AUTH_ISSUER に渡した api。
    起動でき、/api/me だけが 503 で、チャット・地図・一覧は動く。"""
    settings = Settings.from_env(
        {
            "DATABASE_URL": db_url,
            "TILES_DIR": str(tiles_dir),
            "AUTH_ISSUER": "localhost:3500",
            "AUTH_AUDIENCE": "townscan",
            "AUTH_JWKS_URL": "http://web:3000/api/auth/jwks",
        }
    )
    with TestClient(create_app(settings), raise_server_exceptions=False) as client:
        me = client.get("/api/me", headers={"Authorization": "Bearer not-a-jwt"})
        assert me.status_code == 503
        assert me.json()["error"]["code"] == "unavailable"
        for path in ("/api/health", "/api/areas", "/api/candidates", "/api/metrics"):
            assert client.get(path).status_code == 200, path
        chat = client.post("/api/chat", json={"messages": [{"role": "user", "content": "候補は何件？"}]})
        assert chat.status_code == 200, chat.text
