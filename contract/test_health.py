"""GET /api/health: 状態・走っているモデル・現在の run・件数。構成 main（合成データあり・LLM は模擬・DB は動いている）。
データ無し（empty）・DB が止まっているとき（dbdown）は test_no_data.py・test_db_down.py。"""

from __future__ import annotations

from support import expected
from support.checks import assert_json, same_instant


def test_health_reports_ok_with_the_loaded_run(api):
    body = assert_json(api.get("/api/health"))
    # llm_model は gemini のときだけ付く（模擬には無い）。キー（GEMINI_API_KEY）は、どのキーにも出ない
    assert set(body) == {"status", "db", "llm", "run", "counts"}
    assert body["status"] == "ok" and body["db"] == "ok" and body["llm"] == "mock"
    run = body["run"]
    assert set(run) == {"run_id", "kind", "created_at"}
    assert run["run_id"] == expected.RUN_ID and run["kind"] == expected.RUN_KIND
    # run.json の created は 2026-11-24T12:00:00+09:00。表記（+09:00 か Z か）は問わず、同じ時刻の ISO 8601（タイムゾーンつき）
    assert same_instant(run["created_at"], expected.RUN_CREATED_AT), run
    assert body["counts"] == expected.COUNTS


def test_health_ignores_the_authorization_header(api):
    base = api.get("/api/health").json()
    assert api.get("/api/health", headers={"Authorization": "Bearer garbage"}).json() == base
