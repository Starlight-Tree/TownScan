"""エンドポイント（正常系・404・422・503・エラーの形・SQL インジェクション）。"""

from __future__ import annotations

from datetime import datetime

import psycopg
import pytest

from app import queries

A1, A2, A3 = "z18-226249-105759", "z18-226250-105759", "z18-226249-105760"
BIGGEST_NEW = "c-226250-105759-1"  # 503.8 m²
CLASSES = {"confirmed_new", "existing_omission", "uncertain"}


def assert_error(resp, status: int, code: str | None = None):
    assert resp.status_code == status, resp.text
    body = resp.json()
    assert set(body) == {"error"}, body
    assert isinstance(body["error"]["message"], str) and body["error"]["message"]
    if code:
        assert body["error"]["code"] == code
    return body["error"]


# ---- health ----

def test_health(client):
    j = client.get("/api/health").json()
    assert j["status"] == "ok" and j["db"] == "ok" and j["llm"] == "mock"
    assert j["run"]["run_id"] == "synthetic-test" and j["run"]["kind"] == "synthetic"
    assert datetime.fromisoformat(j["run"]["created_at"]) == datetime.fromisoformat("2026-11-24T12:00:00+09:00")
    assert j["counts"] == {"areas": 3, "candidates": 9, "buildings": 24}


def test_health_without_data_is_still_ok(empty_client):
    j = empty_client.get("/api/health").json()
    assert j["status"] == "ok" and j["run"] is None
    assert j["counts"] == {"areas": 0, "candidates": 0, "buildings": 0}


def test_health_reports_db_down_with_503(client):
    client.app.state.pool.close()
    r = client.get("/api/health")
    assert r.status_code == 503
    assert r.json()["status"] == "error" and r.json()["db"] == "error"


# ---- areas ----

def test_areas(client):
    items = client.get("/api/areas").json()
    assert [a["id"] for a in items] == [A1, A2, A3]
    a = items[0]
    assert {"id", "name", "ward", "bbox", "centroid", "counts"} <= set(a)
    assert a["name"] == "合成町" and a["ward"] == "中央区"
    assert len(a["bbox"]) == 4 and len(a["centroid"]) == 2
    assert set(a["counts"]) == CLASSES | {"total"}
    assert sum(x["counts"]["total"] for x in items) == 9
    assert all(x["counts"]["total"] == sum(x["counts"][k] for k in CLASSES) for x in items)


# ---- candidates ----

def test_candidates_default_order_and_total(client):
    j = client.get("/api/candidates").json()
    assert j["total"] == 9 and len(j["items"]) == 9
    areas = [i["area_m2"] for i in j["items"]]
    assert areas == sorted(areas, reverse=True)
    item = j["items"][0]
    assert item["id"] == BIGGEST_NEW and item["class"] == "confirmed_new" and item["area_name"] == "試験町"
    assert {"id", "area_id", "area_name", "class", "area_m2", "bbox", "centroid", "reason"} <= set(item)


def test_candidates_filters(client):
    assert client.get("/api/candidates", params={"cls": "confirmed_new"}).json()["total"] == 4
    assert client.get("/api/candidates", params={"area_id": A1}).json()["total"] == 3
    j = client.get("/api/candidates", params={"area_id": A2, "cls": "confirmed_new"}).json()
    assert j["total"] == 2 and {i["area_id"] for i in j["items"]} == {A2}
    assert client.get("/api/candidates", params={"area_id": "z18-1-1"}).json() == {"total": 0, "items": []}


def test_candidates_paging_and_sort(client):
    page = client.get("/api/candidates", params={"limit": 2, "offset": 1}).json()
    full = client.get("/api/candidates").json()["items"]
    assert page["total"] == 9 and [i["id"] for i in page["items"]] == [i["id"] for i in full[1:3]]
    asc = client.get("/api/candidates", params={"sort": "area_asc"}).json()["items"]
    assert [i["area_m2"] for i in asc] == sorted(i["area_m2"] for i in asc)
    assert client.get("/api/candidates", params={"offset": 100}).json() == {"total": 9, "items": []}


@pytest.mark.parametrize("params", [
    {"cls": "bogus"}, {"limit": 0}, {"limit": 501}, {"limit": "x"}, {"offset": -1}, {"sort": "bogus"},
    {"area_id": "nope"}, {"area_id": "z18-1-1' OR '1'='1"},
])
def test_candidates_bad_arguments_are_422(client, params):
    assert_error(client.get("/api/candidates", params=params), 422, "validation_error")


def test_candidates_geojson(client):
    r = client.get("/api/candidates.geojson")
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/geo+json")
    fc = r.json()
    assert fc["type"] == "FeatureCollection" and len(fc["features"]) == 9
    f = fc["features"][0]
    assert f["type"] == "Feature" and f["id"] == f["properties"]["id"] == BIGGEST_NEW
    assert set(f["properties"]) == {"id", "class", "area_m2", "area_id"}
    assert f["geometry"]["type"] == "Polygon"
    assert len(client.get("/api/candidates.geojson", params={"cls": "uncertain"}).json()["features"]) == 2
    assert len(client.get("/api/candidates.geojson", params={"area_id": A3}).json()["features"]) == 3
    assert_error(client.get("/api/candidates.geojson", params={"cls": "x"}), 422)


def test_candidate_detail(client):
    d = client.get(f"/api/candidates/{BIGGEST_NEW}").json()
    assert d["id"] == BIGGEST_NEW and d["class"] == "confirmed_new" and d["reason"] == "new_absent_2018"
    assert d["explanation_key"] == "new_absent_2018" and "2018 年" in d["explanation"]
    assert set(d["evidence"]) >= {"prob_2023_mean", "ov_2018", "prob_2018_p90", "ov_kiban", "edge_touch"}
    assert [i["year"] for i in d["images"]] == [2018, 2023]
    assert d["images"][0]["url"] == f"/api/candidates/{BIGGEST_NEW}/image?year=2018&size=512"
    assert d["geometry"]["type"] == "Polygon"
    p = d["provenance"]
    assert p["run_kind"] == "synthetic" and p["run_id"] == "synthetic-test" and p["photo_years"] == [2018, 2023]
    assert "合成データ" in p["note"]
    assert "tile_x" not in d


def test_candidate_detail_404_and_422(client):
    assert_error(client.get("/api/candidates/c-1-2-3"), 404, "not_found")
    for bad in ("c-1-2", "x", "c-1-2-3'; DROP TABLE candidates;--", "c-a-b-c"):
        assert_error(client.get(f"/api/candidates/{bad}"), 422)
    assert client.get("/api/candidates").json()["total"] == 9  # 表は無事


# ---- metrics ----

def test_metrics(client):
    j = client.get("/api/metrics").json()
    assert j["holdout"]["object"]["f1"] == 0.58 and j["new_building_recall"] is None
    assert j["split"]["holdout"] == [A2, A3]
    assert j["provenance"]["run_kind"] == "synthetic" and j["provenance"]["photo_years"] == [2018]


# ---- エラーの形・データ無し ----

def test_unknown_route_and_method_have_error_shape(client):
    assert_error(client.get("/api/nothing"), 404, "not_found")
    assert_error(client.post("/api/areas"), 405, "method_not_allowed")


@pytest.mark.parametrize("path", ["/api/areas", "/api/candidates", "/api/candidates.geojson", "/api/metrics",
                                  "/api/candidates/c-1-2-3", "/api/candidates/c-1-2-3/image?year=2018"])
def test_no_data_is_503_with_error_shape(empty_client, path):
    assert_error(empty_client.get(path), 503, "no_data")


def test_openapi_is_under_api_prefix(client):
    assert client.get("/api/openapi.json").status_code == 200
    assert client.get("/openapi.json").status_code == 404


def test_unexpected_error_does_not_leak_details(client, monkeypatch):
    def boom(*_a, **_k):
        raise RuntimeError("secret-internal-detail")

    monkeypatch.setattr(queries, "list_areas", boom)
    err = assert_error(client.get("/api/areas"), 500, "internal_error")
    assert "secret" not in err["message"]


def test_db_error_is_503(client, monkeypatch):
    def down(*_a, **_k):
        raise psycopg.OperationalError("connection refused")

    monkeypatch.setattr(queries, "current_run", down)
    assert_error(client.get("/api/areas"), 503, "db_unavailable")


def test_validation_error_does_not_echo_input(client):
    r = client.get("/api/candidates", params={"cls": "SECRET-TOKEN-123"})
    assert r.status_code == 422 and "SECRET-TOKEN-123" not in r.text
