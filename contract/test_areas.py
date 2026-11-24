"""GET /api/areas: 地区の一覧（並び・キーと型・件数）。構成 main。"""

from __future__ import annotations

from support import expected
from support.checks import assert_close, assert_error, assert_json, is_num

AREA_KEYS = {"id", "name", "ward", "municipality", "bbox", "centroid", "counts"}


def test_areas_are_listed_north_to_south_then_west_to_east(api):
    items = assert_json(api.get("/api/areas"))
    assert isinstance(items, list)
    # y（北→南）の昇順、同じ y なら x（西→東）の昇順 = 合成町 (x0,y0)・試験町 (x0+1,y0)・仮想町 (x0,y0+1)
    assert [a["id"] for a in items] == [expected.A1, expected.A2, expected.A3]


def test_each_area_has_the_documented_keys_and_values(api):
    items = assert_json(api.get("/api/areas"))
    for item, area in zip(items, expected.AREAS):
        assert set(item) == AREA_KEYS, item
        assert item["id"] == area.id
        assert (item["name"], item["ward"], item["municipality"]) == (area.name, area.ward, area.municipality)
        assert_close(item["bbox"], area.bbox)  # [西, 南, 東, 北]
        assert_close(item["centroid"], area.centroid)  # [経度, 緯度]
        assert item["bbox"][0] < item["bbox"][2] and item["bbox"][1] < item["bbox"][3]
        assert all(is_num(v) for v in item["bbox"] + item["centroid"])


def test_area_counts_are_per_class_and_add_up(api):
    items = assert_json(api.get("/api/areas"))
    for item, area in zip(items, expected.AREAS):
        counts = item["counts"]
        assert set(counts) == {*expected.CLASSES, "total"}
        assert counts == area.counts
        assert all(isinstance(v, int) and not isinstance(v, bool) for v in counts.values())
        assert counts["total"] == sum(counts[k] for k in expected.CLASSES)
    assert sum(a["counts"]["total"] for a in items) == expected.COUNTS["candidates"]  # 9


def test_areas_do_not_depend_on_the_authorization_header(api):
    base = api.get("/api/areas").json()
    for headers in ({"Authorization": "Bearer garbage"}, {"Authorization": "Basic x"}):
        assert api.get("/api/areas", headers=headers).json() == base


def test_areas_only_allows_get(api):
    assert_error(api.post("/api/areas"), 405, "method_not_allowed", "このメソッドは使えません")
