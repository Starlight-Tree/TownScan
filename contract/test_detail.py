"""GET /api/candidates/{id}（詳細）と GET /api/metrics（精度）。構成 main。"""

from __future__ import annotations

from urllib.parse import quote

import pytest

from support import expected
from support.checks import assert_close, assert_error, assert_json, assert_validation_error

DETAIL_KEYS = {
    "id", "area_id", "area_name", "ward", "class", "area_m2", "bbox", "centroid", "reason",  # 一覧の項目と同じ
    "evidence", "geometry", "explanation_key", "explanation", "images", "provenance",
}


@pytest.mark.parametrize("cand", expected.CANDIDATES, ids=lambda c: c.id)
def test_detail_of_every_candidate(api, cand):
    d = assert_json(api.get(f"/api/candidates/{cand.id}"))
    # 写真の切り出しに使う地区のタイル番号（tile_x・tile_y）は内部の値で、応答に出ない
    assert set(d) == DETAIL_KEYS, set(d) ^ DETAIL_KEYS
    assert (d["id"], d["area_id"], d["area_name"], d["ward"]) == (cand.id, cand.area_id, cand.area.name, cand.area.ward)
    assert (d["class"], d["reason"], d["area_m2"]) == (cand.cls, cand.reason, cand.area_m2)
    assert_close(d["bbox"], cand.bbox)
    assert_close(d["centroid"], cand.centroid)
    assert d["evidence"] == cand.evidence
    assert d["geometry"]["type"] == "Polygon"
    assert_close(d["geometry"]["coordinates"], [cand.ring])


@pytest.mark.parametrize("cand", expected.CANDIDATES, ids=lambda c: c.id)
def test_detail_explanation_is_the_fixed_text_for_the_reason(api, cand):
    d = assert_json(api.get(f"/api/candidates/{cand.id}"))
    assert d["explanation_key"] == cand.reason
    assert d["explanation"] == expected.EXPLANATIONS[cand.reason]


def test_detail_lists_both_photo_years_with_image_urls(api):
    cid = expected.BIGGEST_NEW
    d = assert_json(api.get(f"/api/candidates/{cid}"))
    assert d["images"] == [
        {"year": 2014, "url": f"/api/candidates/{cid}/image?year=2014&size=512"},
        {"year": 2024, "url": f"/api/candidates/{cid}/image?year=2024&size=512"},
    ]


def test_detail_provenance_names_the_run_and_flags_synthetic_data(api):
    p = assert_json(api.get(f"/api/candidates/{expected.BIGGEST_NEW}"))["provenance"]
    assert p == {
        "source": expected.SOURCE_CANDIDATES,
        "photo_years": [2014, 2024],
        "model": expected.RUN_MODEL,
        "run_id": expected.RUN_ID,
        "run_kind": "synthetic",
        "note": expected.NOTE_SYNTHETIC,  # 合成データの run には、必ずこの注意が付く
    }


def test_unknown_candidate_is_404(api):
    assert_error(api.get("/api/candidates/c-1-2-3"), 404, "not_found", "候補が見つかりません")


@pytest.mark.parametrize("bad", ["c-1-2", "x", "c-a-b-c", "c-1-2-3x", "c-12345678-1-1", "C-1-2-3", "c-1-2-3'; DROP TABLE candidates;--"])
def test_malformed_candidate_id_is_422_naming_the_path_parameter(api, bad):
    assert_validation_error(api.get(f"/api/candidates/{quote(bad, safe='')}"), "path", "candidate_id")
    assert assert_json(api.get("/api/candidates"))["total"] == 9  # 表は無事


def test_candidate_detail_only_allows_get(api):
    assert_error(api.post(f"/api/candidates/{expected.BIGGEST_NEW}"), 405, "method_not_allowed")


# ---- /api/metrics ----

def test_metrics_is_the_eval_file_plus_provenance(api):
    body = assert_json(api.get("/api/metrics"))
    provenance = body.pop("provenance")
    assert body == expected.EVAL  # 評価ファイル（eval.json）の中身がそのまま。新築の再現率は未測定の null
    assert body["new_building_recall"] is None
    assert provenance == {
        "source": expected.SOURCE_ACCURACY,
        "photo_years": [2014],  # 精度は 2014 年の写真で測った値
        "model": expected.RUN_MODEL,
        "run_id": expected.RUN_ID,
        "run_kind": "synthetic",
        "metric": "物体単位 F1・画素 IoU",
        "note": f"{expected.NOTE_SYNTHETIC} {expected.NOTE_UNVERIFIED_ACCURACY}",
    }


def test_metrics_only_allows_get(api):
    assert_error(api.post("/api/metrics"), 405, "method_not_allowed")
