"""GET /api/candidates（一覧）・/api/candidates.geojson（地図用）: 並び・件数・絞り込み・ページ分け・引数の検証。構成 main。"""

from __future__ import annotations

import pytest

from support import expected
from support.checks import assert_close, assert_error, assert_json, assert_validation_error, is_num

SUMMARY_KEYS = {"id", "area_id", "area_name", "ward", "class", "area_m2", "bbox", "centroid", "reason"}
ALL_IDS_DESC = [c.id for c in expected.CANDIDATES]  # 面積の降順、同じなら id の昇順
ALL_IDS_ASC = [c.id for c in expected.CANDIDATES_ASC]


def ids(body) -> list[str]:
    return [i["id"] for i in body["items"]]


# ---- 一覧 ----

def test_default_list_is_all_candidates_by_area_desc_then_id(api):
    body = assert_json(api.get("/api/candidates"))
    assert set(body) == {"total", "items"}
    assert body["total"] == 9  # 3 地区 x 3 候補
    # 75.6 m² の 3 件（c-226249-105759-3・c-226249-105760-3・c-226250-105759-3）は、同じ面積なので id の昇順
    assert ids(body) == ALL_IDS_DESC


def test_summary_items_have_the_documented_keys_and_values(api):
    items = assert_json(api.get("/api/candidates"))["items"]
    for item, cand in zip(items, expected.CANDIDATES):
        assert set(item) == SUMMARY_KEYS, item
        assert item["id"] == cand.id and item["area_id"] == cand.area_id
        assert item["area_name"] == cand.area.name and item["ward"] == cand.area.ward
        assert item["class"] == cand.cls and item["reason"] == cand.reason
        assert is_num(item["area_m2"]) and item["area_m2"] == cand.area_m2
        assert_close(item["bbox"], cand.bbox)
        assert_close(item["centroid"], cand.centroid)


def test_sort_area_asc_is_the_reverse_by_area_and_still_id_ascending_on_ties(api):
    body = assert_json(api.get("/api/candidates", params={"sort": "area_asc"}))
    assert ids(body) == ALL_IDS_ASC
    assert ids(assert_json(api.get("/api/candidates", params={"sort": "area_desc"}))) == ALL_IDS_DESC


@pytest.mark.parametrize("params, expected_ids", [
    ({"cls": "confirmed_new"}, [c.id for c in expected.CANDIDATES if c.cls == "confirmed_new"]),  # 4 件
    ({"cls": "existing_omission"}, [c.id for c in expected.CANDIDATES if c.cls == "existing_omission"]),  # 3 件
    ({"cls": "uncertain"}, [c.id for c in expected.CANDIDATES if c.cls == "uncertain"]),  # 2 件
    ({"area_id": expected.A1}, [c.id for c in expected.CANDIDATES if c.area_id == expected.A1]),  # 3 件
    ({"area_id": expected.A2, "cls": "confirmed_new"}, ["c-226250-105759-1", "c-226250-105759-3"]),  # 試験町の新規出現 2 件
    ({"area_id": expected.A3, "cls": "uncertain"}, []),  # 仮想町に判定保留は無い
])
def test_filters_by_class_and_area(api, params, expected_ids):
    body = assert_json(api.get("/api/candidates", params=params))
    assert body["total"] == len(expected_ids) and ids(body) == expected_ids


def test_class_totals_are_4_3_2(api):
    # 新規出現 = 合成町 1 + 試験町 2 + 仮想町 1、既存の描き漏れ = 合成町 1 + 仮想町 2、判定保留 = 合成町 1 + 試験町 1
    totals = {k: assert_json(api.get("/api/candidates", params={"cls": k}))["total"] for k in expected.CLASSES}
    assert totals == {"confirmed_new": 4, "existing_omission": 3, "uncertain": 2}


def test_well_formed_unknown_area_is_an_empty_list_not_an_error(api):
    assert assert_json(api.get("/api/candidates", params={"area_id": "z18-1-1"})) == {"total": 0, "items": []}


def test_unknown_query_parameters_are_ignored(api):
    assert api.get("/api/candidates", params={"nothing": "x"}).json() == api.get("/api/candidates").json()


# ---- ページ分け ----

def test_limit_and_offset_cut_the_same_ordered_list_and_total_stays(api):
    page = assert_json(api.get("/api/candidates", params={"limit": 2, "offset": 1}))
    assert page["total"] == 9 and ids(page) == ALL_IDS_DESC[1:3]  # 全体は 9 件のまま、2 番目と 3 番目
    assert ids(assert_json(api.get("/api/candidates", params={"limit": 4, "offset": 8}))) == ALL_IDS_DESC[8:]
    assert assert_json(api.get("/api/candidates", params={"offset": 100})) == {"total": 9, "items": []}


def test_paging_applies_after_the_filter(api):
    page = assert_json(api.get("/api/candidates", params={"cls": "confirmed_new", "limit": 1, "offset": 1}))
    assert page["total"] == 4 and ids(page) == ["c-226249-105759-2"]  # 新規出現の 2 番目（302.3 m²）


@pytest.mark.parametrize("params", [{"limit": 1}, {"limit": 500}, {"offset": 0}, {"offset": 1_000_000}])
def test_limits_at_the_boundary_are_accepted(api, params):
    assert_json(api.get("/api/candidates", params=params))


# ---- 引数の検証（422） ----

@pytest.mark.parametrize("params, loc", [
    ({"cls": "bogus"}, "cls"),
    ({"cls": ""}, "cls"),
    ({"limit": 0}, "limit"),
    ({"limit": 501}, "limit"),
    ({"limit": "x"}, "limit"),
    ({"limit": 1.5}, "limit"),
    ({"offset": -1}, "offset"),
    ({"offset": 1_000_001}, "offset"),
    ({"sort": "bogus"}, "sort"),
    ({"sort": "AREA_DESC"}, "sort"),
    ({"area_id": "nope"}, "area_id"),
    ({"area_id": "z18-1-1' OR '1'='1"}, "area_id"),
    ({"area_id": "z18-12345678-1"}, "area_id"),  # 桁の上限（7 桁）を 1 つ超える
    ({"area_id": "z100-1-1"}, "area_id"),  # z は 2 桁まで
    ({"area_id": "c-1-2-3"}, "area_id"),
    ({"area_id": "z18-1-1\n"}, "area_id"),  # 末尾の改行を通さない
    ({"area_id": "z18-１-１"}, "area_id"),  # 全角の数字は数字ではない（半角の 0-9 だけ）
])
def test_bad_arguments_are_422_naming_the_query_parameter(api, params, loc):
    assert_validation_error(api.get("/api/candidates", params=params), "query", loc)


def test_validation_error_does_not_echo_the_input(api):
    resp = api.get("/api/candidates", params={"cls": "SECRET-TOKEN-123"})
    assert_validation_error(resp, "query", "cls")
    assert "SECRET-TOKEN-123" not in resp.text


def test_candidates_only_allows_get(api):
    assert_error(api.post("/api/candidates"), 405, "method_not_allowed")


# ---- 地図用 GeoJSON ----

def assert_geojson(resp):
    assert resp.status == 200 and resp.content_type.startswith("application/geo+json"), resp
    return resp.json()


def test_geojson_is_a_feature_collection_in_the_same_order(api):
    fc = assert_geojson(api.get("/api/candidates.geojson"))
    assert set(fc) == {"type", "features"} and fc["type"] == "FeatureCollection"
    assert [f["id"] for f in fc["features"]] == ALL_IDS_DESC
    for feature, cand in zip(fc["features"], expected.CANDIDATES):
        assert set(feature) == {"type", "id", "geometry", "properties"}
        assert feature["type"] == "Feature" and feature["id"] == cand.id
        assert feature["properties"] == {"id": cand.id, "class": cand.cls, "area_m2": cand.area_m2, "area_id": cand.area_id, "reason": cand.reason}
        assert feature["geometry"]["type"] == "Polygon"
        assert_close(feature["geometry"]["coordinates"], [cand.ring])  # 外周 1 つ・5 点（閉じている）


# 判定保留は合成町 1 + 試験町 1 = 2、仮想町は 3 候補、合成町の新規出現は 1、地区が無ければ 0
@pytest.mark.parametrize("params, count", [({"cls": "uncertain"}, 2), ({"area_id": expected.A3}, 3), ({"area_id": expected.A1, "cls": "confirmed_new"}, 1), ({"area_id": "z18-1-1"}, 0)])
def test_geojson_filters(api, params, count):
    assert len(assert_geojson(api.get("/api/candidates.geojson", params=params))["features"]) == count


@pytest.mark.parametrize("params, loc", [({"cls": "x"}, "cls"), ({"area_id": "nope"}, "area_id")])
def test_geojson_bad_arguments_are_422(api, params, loc):
    assert_validation_error(api.get("/api/candidates.geojson", params=params), "query", loc)
