"""エンドポイント（仕様 §4.4）。接頭辞は /api。"""

from __future__ import annotations

import logging
from typing import Iterator, Literal

import psycopg
from fastapi import APIRouter, Depends, Query, Request
from fastapi import Path as PathParam
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from . import queries
from .auth import NO_STORE_HEADERS, current_identity
from .chat import service as chat_service
from .chat.gemini_model import LLM_UNAVAILABLE_MESSAGE, LlmUnavailable
from .chat.tools import image_url
from .errors import ApiError
from .explanations import explanation
from .imaging import DEFAULT_SIZE, MAX_SIZE, MIN_SIZE, YEARS, TileUnavailable, render_candidate_image, tile_file
from .jwt_auth import Identity
from .provenance import SOURCE_ACCURACY, provenance

log = logging.getLogger("townscan")
router = APIRouter()

AREA_ID_PATTERN = r"^z[0-9]{1,2}-[0-9]{1,7}-[0-9]{1,7}$"
CANDIDATE_ID_PATTERN = r"^c-[0-9]{1,7}-[0-9]{1,7}-[0-9]{1,7}$"
ClassKey = Literal["confirmed_new", "existing_omission", "uncertain"]


def get_conn(request: Request) -> Iterator[psycopg.Connection]:
    with request.app.state.pool.connection() as conn:
        yield conn


def require_run(conn: psycopg.Connection) -> dict:
    run = queries.current_run(conn)
    if run is None:
        raise ApiError(503, "no_data", "データが読み込まれていません。python -m app.load で pipeline の出力を読み込んでください")
    return run


def _run_info(run: dict) -> dict:
    return {"run_id": run["run_id"], "kind": run["kind"], "created_at": run["created_at"].isoformat()}


@router.get("/api/health")
def health(request: Request):
    settings = request.app.state.settings
    body = {
        "status": "ok",
        "db": "ok",
        "llm": settings.llm_provider,
        "run": None,
        "counts": {"areas": 0, "candidates": 0, "buildings": 0},
    }
    if settings.llm_provider == "gemini":
        body["llm_model"] = settings.gemini_model  # モデル名は出してよい（キーは出さない）
    try:
        with request.app.state.pool.connection() as conn:
            run = queries.current_run(conn)
            if run is not None:
                body["run"] = _run_info(run)
                body["counts"] = queries.run_counts(conn, run["run_id"])
    except Exception as exc:  # noqa: BLE001 - ヘルスチェックは、原因を問わず「DB が使えない」と返す
        log.error("health: DB に届きません: %s", type(exc).__name__)
        body.update(status="error", db="error")
        return JSONResponse(body, status_code=503)
    return body


@router.get("/api/me")
def me(identity: Identity = Depends(current_identity)):
    """ログイン中の人（Bearer の JWT を検証した結果）。無い・不正・期限切れは 401、認証が未設定・鍵を取れないときは 503。
    アカウントのロジックの受け口で、ほかの入口はログインを要求しない。DB は使わない。"""
    return JSONResponse(identity.as_dict(), headers=NO_STORE_HEADERS)


@router.get("/api/areas")
def areas(conn: psycopg.Connection = Depends(get_conn)):
    run = require_run(conn)
    return queries.list_areas(conn, run["run_id"])


@router.get("/api/candidates")
def candidates(
    area_id: str | None = Query(None, pattern=AREA_ID_PATTERN),
    cls: ClassKey | None = None,
    sort: Literal["area_desc", "area_asc"] = "area_desc",
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0, le=1_000_000),
    conn: psycopg.Connection = Depends(get_conn),
):
    run = require_run(conn)
    total, items = queries.list_candidates(
        conn, run["run_id"], [area_id] if area_id else None, cls, sort, limit, offset
    )
    return {"total": total, "items": items}


@router.get("/api/candidates.geojson")
def candidates_geojson(
    area_id: str | None = Query(None, pattern=AREA_ID_PATTERN),
    cls: ClassKey | None = None,
    conn: psycopg.Connection = Depends(get_conn),
):
    run = require_run(conn)
    features = queries.candidate_features(conn, run["run_id"], [area_id] if area_id else None, cls)
    return JSONResponse({"type": "FeatureCollection", "features": features}, media_type="application/geo+json")


def _load_candidate(conn: psycopg.Connection, run: dict, candidate_id: str) -> dict:
    cand = queries.get_candidate(conn, run["run_id"], candidate_id)
    if cand is None:
        raise ApiError(404, "not_found", "候補が見つかりません")
    return cand


@router.get("/api/candidates/{candidate_id}")
def candidate_detail(
    candidate_id: str = PathParam(pattern=CANDIDATE_ID_PATTERN),
    conn: psycopg.Connection = Depends(get_conn),
):
    run = require_run(conn)
    cand = _load_candidate(conn, run, candidate_id)
    detail = {k: v for k, v in cand.items() if k not in ("tile_x", "tile_y")}
    detail.update(
        explanation_key=cand["reason"],
        explanation=explanation(cand["reason"]),
        images=[{"year": y, "url": image_url(cand["id"], y)} for y in YEARS],
        provenance=provenance(run),
    )
    return detail


@router.get("/api/candidates/{candidate_id}/image")
def candidate_image(
    request: Request,
    candidate_id: str = PathParam(pattern=CANDIDATE_ID_PATTERN),
    year: Literal["2018", "2023"] = Query(..., description="写真の年（2018 か 2023）。許可リストの文字列だけ"),
    size: int = Query(DEFAULT_SIZE, ge=MIN_SIZE, le=MAX_SIZE),
    conn: psycopg.Connection = Depends(get_conn),
):
    year_int = int(year)  # Literal で許可リストの 2 つの文字列だけが来る
    run = require_run(conn)
    cand = _load_candidate(conn, run, candidate_id)
    try:
        path = tile_file(request.app.state.settings.tiles_dir, year_int, cand["tile_x"], cand["tile_y"])
        png = render_candidate_image(path, cand["tile_x"], cand["tile_y"], cand["bbox"], cand["geometry"], cand["class"], size)
    except TileUnavailable as exc:
        raise ApiError(404, "tile_not_found", f"{year_int} 年の写真を用意できません（{exc}）") from None
    return Response(png, media_type="image/png", headers={"Cache-Control": "private, max-age=60"})


@router.get("/api/metrics")
def metrics(conn: psycopg.Connection = Depends(get_conn)):
    run = require_run(conn)
    body = queries.get_metrics(conn, run["run_id"])
    if body is None:
        raise ApiError(404, "not_found", "評価の結果がありません")
    prov = provenance(
        run,
        source=SOURCE_ACCURACY,
        photo_years=[2018],
        metric="物体単位 F1・画素 IoU",
        note="数字は 2018 年の写真で測った値。新築の再現率は手ラベルが無く未測定。分類の閾値は未検証の初期値。",
    )
    return {**body, "provenance": prov}


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=2000)


# 受け付ける件数の上限。frontend は会話の全履歴を送るので、往復が増えても弾かない（弾くと、その会話は二度と進まない）。
# 返答に使うのは末尾の chat/service.CONTEXT_MESSAGES 件だけ
MAX_CHAT_MESSAGES = 500


class ChatRequest(BaseModel):
    messages: list[ChatMessage] = Field(
        min_length=1,
        max_length=MAX_CHAT_MESSAGES,
        description=f"会話（古い順）。最後は user のメッセージ。{MAX_CHAT_MESSAGES} 件まで受け付け、文脈に使うのは末尾 {chat_service.CONTEXT_MESSAGES} 件だけ",
    )


@router.post("/api/chat")
def chat(body: ChatRequest, request: Request, conn: psycopg.Connection = Depends(get_conn)):
    last = body.messages[-1]
    if last.role != "user" or not last.content.strip():
        raise ApiError(422, "validation_error", "最後のメッセージは、空でない user のメッセージである必要があります")
    messages = [m.model_dump() for m in body.messages]
    try:
        return chat_service.answer(conn, request.app.state.registry, messages, request.app.state.llm)
    except LlmUnavailable as exc:
        # 実 LLM が使えないとき。模擬には切り替えない。ログと応答に出すのは、失敗の種類・HTTP のステータス・Google の理由の定数だけ
        # （キー・URL・応答の本文は入れない）。frontend は {error:{code,message}} の message を「送信できませんでした」に出して、再送を出す
        log.warning("LLM が応答できませんでした: 種別=%s HTTP=%s 理由=%s", exc.kind, exc.status, exc.reason)
        raise ApiError(502, "llm_unavailable", LLM_UNAVAILABLE_MESSAGE) from None
