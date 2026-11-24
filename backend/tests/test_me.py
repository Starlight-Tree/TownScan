"""GET /api/me（ログイン中の人を返す入口）と、ログインを要求しないほかの入口。JWT の検証そのものは test_jwt_auth.py。
Better Auth の代わりに、テストの中で作った鍵と JWKS を使う（conftest の me_client・jwks_fetches）。"""

from __future__ import annotations

import time

import pytest

import jwt_tokens
from app import jwt_auth
from jwt_tokens import make_token

NOT_LOGGED_IN = {"error": {"code": "unauthorized", "message": "ログインしてください"}}


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def assert_not_logged_in(resp):
    assert resp.status_code == 401, resp.text
    assert resp.json() == NOT_LOGGED_IN  # 固定の文だけ（理由・例外の文字列は無い）
    assert resp.headers["www-authenticate"] == "Bearer"
    assert resp.headers["cache-control"] == "no-store"


# ---- 正常 ----


def test_me_returns_the_identity(me_client):
    resp = me_client.get("/api/me", headers=bearer(make_token()))
    assert resp.status_code == 200, resp.text
    assert resp.json() == {
        "sub": jwt_tokens.DEFAULT_SUB,
        "email": "tanaka@example.com",
        "name": "田中 太郎",
        "picture": "https://lh3.googleusercontent.com/a/test",
    }
    assert resp.headers["cache-control"] == "no-store"
    assert resp.headers["content-type"].startswith("application/json")


def test_me_missing_claims_are_null(me_client):
    resp = me_client.get("/api/me", headers=bearer(make_token(email=None, name=None, picture=None)))
    assert resp.status_code == 200
    assert resp.json() == {"sub": jwt_tokens.DEFAULT_SUB, "email": None, "name": None, "picture": None}


def test_me_scheme_is_case_insensitive(me_client):
    assert me_client.get("/api/me", headers={"Authorization": f"bearer {make_token()}"}).status_code == 200


def test_me_does_not_need_the_database(me_client):
    me_client.app.state.pool.close()
    assert me_client.get("/api/me", headers=bearer(make_token())).status_code == 200


def test_me_is_documented_in_openapi(me_client):
    assert "/api/me" in me_client.get("/api/openapi.json").json()["paths"]


# ---- 401 ----


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"Authorization": ""},
        {"Authorization": "Basic abc"},
        {"Authorization": "Token abc"},
        {"Authorization": "Bearer"},
        {"Authorization": "Bearer "},
        {"Authorization": "Bearer a b"},  # 形が違う（トークンが 2 つ）
        {"Authorization": "Bearer not-a-jwt"},
        {"Authorization": "Bearer " + "a" * 9000},
    ],
)
def test_missing_or_malformed_authorization_is_401(me_client, headers, jwks_fetches):
    assert_not_logged_in(me_client.get("/api/me", headers=headers))


def test_a_valid_token_in_a_different_scheme_is_401(me_client):
    assert_not_logged_in(me_client.get("/api/me", headers={"Authorization": f"Basic {make_token()}"}))


@pytest.mark.parametrize(
    "token",
    [
        pytest.param(lambda: make_token(exp=int(time.time()) - 3600), id="expired"),
        pytest.param(lambda: make_token(aud="docunavi"), id="wrong-aud"),
        pytest.param(lambda: make_token(iss="http://evil.example"), id="wrong-iss"),
        pytest.param(lambda: make_token(key=jwt_tokens.OTHER_PRIVATE_KEY), id="other-key"),
        pytest.param(lambda: make_token(kid="unknown-kid"), id="unknown-kid"),
        pytest.param(lambda: make_token(kid=None), id="no-kid"),
        pytest.param(lambda: make_token(sub=None), id="no-sub"),
        pytest.param(jwt_tokens.make_unsigned_token, id="alg-none"),
        pytest.param(jwt_tokens.make_hs256_token, id="hs256-forgery"),
        pytest.param(lambda: make_token(key=jwt_tokens.RSA_PRIVATE_KEY, alg="RS256"), id="rs256"),
    ],
)
def test_bad_tokens_are_401_with_a_fixed_message(me_client, token):
    assert_not_logged_in(me_client.get("/api/me", headers=bearer(token())))


# ---- 503 ----


def test_not_configured_is_503(client):
    # `client` は、ログインを設定していない API（AUTH_* が無い）
    resp = client.get("/api/me", headers=bearer(make_token()))
    assert resp.status_code == 503
    assert resp.json() == {"error": {"code": "unavailable", "message": "Google でのログインは、まだ設定されていません"}}
    assert resp.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("headers", [{}, {"Authorization": "Basic abc"}, {"Authorization": "Bearer not-a-jwt"}])
def test_not_configured_is_503_before_looking_at_the_token(client, headers):
    # 設定が無いときは、トークンの有無・形を見る前に 503（仕様 §4.4）。ログインできない環境で、401（もう一度ログインを）と誤解させない
    resp = client.get("/api/me", headers=headers)
    assert resp.status_code == 503
    assert resp.json()["error"]["code"] == "unavailable"
    assert "www-authenticate" not in resp.headers


def test_not_configured_leaves_the_other_endpoints_working(client):
    for path in ("/api/health", "/api/areas", "/api/candidates", "/api/metrics"):
        assert client.get(path).status_code == 200, path


def test_jwks_unreachable_is_503_without_leaking_details(me_client, monkeypatch, caplog):
    secret = "connect ECONNREFUSED 10.0.0.5:3000 http://web:3000/api/auth/jwks"

    def fail(url: str):
        raise OSError(secret)

    monkeypatch.setattr(jwt_auth, "fetch_jwks_document", fail)
    token = make_token()
    with caplog.at_level("DEBUG", logger="townscan"):
        resp = me_client.get("/api/me", headers=bearer(token))
    assert resp.status_code == 503
    assert resp.json() == {
        "error": {"code": "unavailable", "message": "ログインを確認できませんでした。しばらくしてから、もう一度お試しください"}
    }
    assert resp.headers["cache-control"] == "no-store"
    for leaked in ("ECONNREFUSED", "10.0.0.5", "OSError", "web:3000"):
        assert leaked not in resp.text
    # ログにも、URL・例外の文字列・トークンは出ない
    assert "10.0.0.5" not in caplog.text and token not in caplog.text


def test_jwks_failure_only_affects_me(me_client, monkeypatch):
    def fail(url: str):
        raise TimeoutError

    monkeypatch.setattr(jwt_auth, "fetch_jwks_document", fail)
    assert me_client.get("/api/me", headers=bearer(make_token())).status_code == 503
    for path in ("/api/health", "/api/areas", "/api/metrics"):
        assert me_client.get(path).status_code == 200, path


# ---- ほかの入口は、ログインを要求しない ----

CHAT = {"messages": [{"role": "user", "content": "こんにちは"}]}


@pytest.mark.parametrize("headers", [{}, {"Authorization": "Bearer garbage"}, {"Authorization": "Basic x"}])
def test_other_endpoints_never_require_or_check_login(me_client, headers):
    # ログインなしでも、不正な Authorization が付いていても、今まどおり使える
    for path in ("/api/health", "/api/areas", "/api/candidates", "/api/candidates.geojson", "/api/metrics"):
        assert me_client.get(path, headers=headers).status_code == 200, path
    assert me_client.post("/api/chat", json=CHAT, headers=headers).status_code == 200


def test_other_endpoints_do_not_fetch_the_jwks(me_client, jwks_fetches):
    me_client.get("/api/areas", headers=bearer(make_token()))
    me_client.post("/api/chat", json=CHAT, headers=bearer(make_token()))
    assert jwks_fetches == []  # 鍵を取りに行くのは /api/me だけ


def test_me_rejects_other_methods(me_client):
    resp = me_client.post("/api/me", headers=bearer(make_token()))
    assert resp.status_code == 405
    assert set(resp.json()) == {"error"}
