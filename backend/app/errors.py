"""エラーの形（{error:{code,message}}）と、FastAPI への登録。"""

from __future__ import annotations

import logging

import psycopg
import psycopg_pool
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

log = logging.getLogger("townscan")

_STATUS_CODES = {
    400: "bad_request",
    404: "not_found",
    405: "method_not_allowed",
    422: "validation_error",
    503: "unavailable",
}
_STATUS_MESSAGES = {
    404: "見つかりません",
    405: "このメソッドは使えません",
}


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def error_body(code: str, message: str, **extra) -> dict:
    return {"error": {"code": code, "message": message, **extra}}


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError):
        return JSONResponse(error_body(exc.code, exc.message), status_code=exc.status)

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_: Request, exc: StarletteHTTPException):
        code = _STATUS_CODES.get(exc.status_code, "error")
        message = _STATUS_MESSAGES.get(exc.status_code) or str(exc.detail)
        return JSONResponse(error_body(code, message), status_code=exc.status_code)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_: Request, exc: RequestValidationError):
        # 入力値そのものは返さない（場所と理由だけ）
        details = [
            {"loc": [str(p) for p in e.get("loc", ())], "msg": str(e.get("msg", ""))} for e in exc.errors()
        ]
        where = ".".join(details[0]["loc"]) if details else ""
        message = f"引数が不正です（{where}）" if where else "引数が不正です"
        return JSONResponse(error_body("validation_error", message, details=details), status_code=422)

    @app.exception_handler(psycopg.OperationalError)
    @app.exception_handler(psycopg_pool.PoolTimeout)
    async def _db_unavailable(_: Request, exc: Exception):
        log.error("DB に接続できません: %s", type(exc).__name__)
        return JSONResponse(
            error_body("db_unavailable", "データベースに接続できません。しばらくしてから再試行してください"),
            status_code=503,
        )

    @app.exception_handler(Exception)
    async def _unexpected(_: Request, exc: Exception):
        log.exception("想定外のエラー")
        return JSONResponse(error_body("internal_error", "サーバー内部のエラーです"), status_code=500)
