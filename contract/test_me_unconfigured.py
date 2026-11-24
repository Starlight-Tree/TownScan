"""GET /api/me: ログインの設定が無い・不正なとき（構成 noauth・badauth）と、JWKS に届かないとき（構成 jwksdown）。

- noauth: AUTH_ISSUER・AUTH_JWKS_URL が無い。badauth: AUTH_ISSUER が http(s) の URL でない（例: BETTER_AUTH_URL を `localhost:3500` と書いた。
  compose.yaml はその値をそのまま渡す）。どちらも API は起動し（起動のたびに落ちると、画面がチャット・地図まで使えなくなる）、
  `/api/me` だけが 503（JWT の有無・形を見る前に返す。401 と取り違えさせない）。ほかの入口は影響を受けない（test_auth_independence.py）。
- jwksdown: 設定はあるが、JWKS を取りに行けず、前に取れた鍵も無い。検証できないので 503。鍵を使わずに断れるもの（Authorization が無い・形が違う・alg が違う）は、これまでどおり 401。
"""

from __future__ import annotations

import pytest

from support import fakes
from support.checks import assert_json
from support.fakes import bearer, make_token

NOT_CONFIGURED = {"error": {"code": "unavailable", "message": "Google でのログインは、まだ設定されていません"}}
CANNOT_VERIFY = {"error": {"code": "unavailable", "message": "ログインを確認できませんでした。しばらくしてから、もう一度お試しください"}}
NOT_LOGGED_IN = {"error": {"code": "unauthorized", "message": "ログインしてください"}}


# ---- 設定が無い・不正 ----

@pytest.mark.variant("noauth", "badauth")
@pytest.mark.parametrize("headers", [
    pytest.param({}, id="no-header"),
    pytest.param({"Authorization": "Basic abc"}, id="basic"),
    pytest.param({"Authorization": "Bearer not-a-jwt"}, id="garbage-token"),
    pytest.param(None, id="valid-looking-token"),
])
def test_not_configured_is_503_before_looking_at_the_token(api, jwks, headers):
    resp = api.get("/api/me", headers=bearer(make_token()) if headers is None else headers)
    assert resp.status == 503, resp
    assert resp.json() == NOT_CONFIGURED
    assert resp.header("cache-control") == "no-store"
    assert resp.header("www-authenticate") is None  # 「もう一度ログインを」と誤解させない
    assert resp.content_type.startswith("application/json")


@pytest.mark.variant("noauth", "badauth")
def test_not_configured_does_not_try_to_fetch_the_jwks(api, jwks):
    api.get("/api/me", headers=bearer(make_token()))
    assert jwks.hits == []  # badauth は JWKS の URL が正しいが、発行元が不正なので、検証を無効にして取りに行かない


# ---- JWKS に届かない ----

@pytest.mark.variant("jwksdown")
def test_a_token_that_needs_the_key_is_503_without_leaking_details(api, jwks):
    for _ in range(2):  # 失敗のあとの短い間は、取りに行かず即 503（web が落ちていても、待たせない）
        resp = api.get("/api/me", headers=bearer(make_token()))
        assert resp.status == 503, resp
        assert resp.json() == CANNOT_VERIFY
        assert resp.header("cache-control") == "no-store"
        for leaked in ("refused", "ECONNREFUSED", "127.0.0.1", "jwks", "OSError", "URLError", "Traceback"):
            assert leaked not in resp.text, leaked


@pytest.mark.variant("jwksdown")
@pytest.mark.parametrize("headers", [
    pytest.param({}, id="no-header"),
    pytest.param({"Authorization": "Bearer not-a-jwt"}, id="garbage-token"),
    pytest.param(None, id="alg-none"),
])
def test_what_can_be_refused_without_a_key_is_still_401(api, jwks, headers):
    resp = api.get("/api/me", headers=bearer(fakes.make_unsigned_token()) if headers is None else headers)
    assert resp.status == 401, resp
    assert resp.json() == NOT_LOGGED_IN
    assert resp.header("www-authenticate") == "Bearer"


@pytest.mark.variant("jwksdown")
def test_the_jwks_failure_only_affects_me(api):
    for path in ("/api/health", "/api/areas", "/api/metrics", "/api/candidates"):
        assert_json(api.get(path))
