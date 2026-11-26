"""データがまだ 1 件も読み込まれていないとき（構成 empty: 表はあるが、run が 0 件）と、DB が止まっているとき（構成 dbdown）の応答。

- empty: ヘルスは 200（run は null・件数は 0）。データを読む入口は 503 `no_data`（引数の検証 422 が先）。チャットは 200 で、`no_data` の断りを返す。
- dbdown: DB に届かない。ヘルスは 503（status・db が error）、データを読む入口は 503 `db_unavailable`、DB を使わない `/api/me` は影響を受けない。
"""

from __future__ import annotations

import pytest

from support.chat import ask
from support.checks import assert_error, assert_json, assert_validation_error
from support.fakes import bearer, make_token

NO_DATA_PATHS = [
    "/api/areas",
    "/api/candidates",
    "/api/candidates.geojson",
    "/api/metrics",
    "/api/candidates/c-1-2-3",
    "/api/candidates/c-1-2-3/image?year=2014",
]
DB_DOWN_TIMEOUT = 45.0  # 接続の待ちの上限（実装の 10 秒前後）を見込む


# ---- empty ----

@pytest.mark.variant("empty")
def test_health_is_ok_without_data(api):
    body = assert_json(api.get("/api/health"))
    assert body == {"status": "ok", "db": "ok", "llm": "mock", "run": None, "counts": {"areas": 0, "candidates": 0, "buildings": 0}}


@pytest.mark.variant("empty")
@pytest.mark.parametrize("path", NO_DATA_PATHS)
def test_endpoints_that_read_data_are_503_no_data(api, path):
    assert_error(api.get(path), 503, "no_data")


@pytest.mark.variant("empty")
def test_validation_comes_before_the_no_data_check(api):
    assert_validation_error(api.get("/api/candidates", params={"limit": 0}), "query", "limit")
    assert_validation_error(api.get("/api/candidates/c-1-2-3/image", params={"year": 1999}), "query", "year")
    assert_validation_error(api.get("/api/candidates/nope"), "path", "candidate_id")


@pytest.mark.variant("empty")
def test_chat_answers_with_a_no_data_refusal(api):
    m = ask(api, "候補は何件？")
    assert m["tool_calls"] == [{"name": "refuse", "args": {"reason": "no_data"}}]
    (r,) = m["results"]
    assert r["type"] == "refusal" and r["reason"] == "no_data" and r["suggestions"] == []
    assert m["content"] == r["message"] and r["message"]  # 「データがまだ読み込まれていません」という趣旨の文（読み込み方の案内を含む）


@pytest.mark.variant("empty")
def test_chat_input_is_still_validated_without_data(api):
    assert_validation_error(api.post("/api/chat", json={"messages": []}), "body")


@pytest.mark.variant("empty")
def test_routes_that_do_not_exist_are_still_404(api):
    assert_error(api.get("/api/nothing"), 404, "not_found")
    assert_error(api.post("/api/areas"), 405, "method_not_allowed")


# ---- dbdown ----

@pytest.mark.variant("dbdown")
def test_health_is_503_when_the_database_is_down(api):
    resp = api.get("/api/health", timeout=DB_DOWN_TIMEOUT)
    assert resp.status == 503, resp
    assert resp.json() == {"status": "error", "db": "error", "llm": "mock", "run": None, "counts": {"areas": 0, "candidates": 0, "buildings": 0}}


@pytest.mark.variant("dbdown")
def test_endpoints_that_read_data_are_503_db_unavailable(api):
    resp = api.get("/api/areas", timeout=DB_DOWN_TIMEOUT)
    assert_error(resp, 503, "db_unavailable", "データベースに接続できません。しばらくしてから再試行してください")
    for leaked in ("postgresql", "psycopg", "townscan-contract", "Traceback", "5432"):
        assert leaked not in resp.text, leaked


@pytest.mark.variant("dbdown")
def test_me_does_not_need_the_database(api, jwks):
    resp = api.get("/api/me", headers=bearer(make_token()), timeout=DB_DOWN_TIMEOUT)
    assert resp.status == 200 and resp.json()["sub"] == "ba_user_0000000001"
