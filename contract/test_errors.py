"""エラーの形と、存在しない経路・許されないメソッド。構成 main。
エラーはすべて JSON の `{error:{code,message}}`（422 は details も付く）。入力値そのものは応答に出さない。"""

from __future__ import annotations

import pytest

from support.checks import assert_error, assert_validation_error


@pytest.mark.parametrize("path", ["/api/nothing", "/api/candidates/c-1-2-3/nothing", "/nothing", "/", "/openapi-not-here.json"])
def test_unknown_route_is_404_with_the_error_shape(api, path):
    assert_error(api.get(path), 404, "not_found", "見つかりません")


@pytest.mark.parametrize("method, path", [
    ("POST", "/api/areas"),
    ("POST", "/api/candidates"),
    ("POST", "/api/candidates.geojson"),
    ("POST", "/api/health"),
    ("POST", "/api/metrics"),
    ("POST", "/api/me"),
    ("GET", "/api/chat"),
    ("PUT", "/api/areas"),
    ("DELETE", "/api/candidates/c-1-2-3"),
    ("PATCH", "/api/health"),
])
def test_method_not_allowed_is_405_with_the_error_shape(api, method, path):
    assert_error(api.request(method, path), 405, "method_not_allowed", "このメソッドは使えません")


def test_validation_error_names_the_parameter_and_never_echoes_the_input(api):
    resp = api.get("/api/candidates", params={"limit": "SECRET-TOKEN-123"})
    err = assert_validation_error(resp, "query", "limit")
    assert "SECRET-TOKEN-123" not in resp.text
    assert err["message"] == "引数が不正です（query.limit）"


def test_every_error_is_json_even_for_a_binary_looking_path(api):
    assert_error(api.get("/api/%FF%FE"), 404, "not_found")
