"""FastAPI アプリの組み立て。uvicorn は `uvicorn --factory app.main:create_app` で起動する。"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from .chat.gemini_model import GeminiClient, build_llm_client
from .chat.tools import build_default_registry
from .config import Settings
from .db import make_pool, wait_and_apply_schema
from .errors import register_error_handlers
from .jwt_auth import JwtVerifier
from .routes import router

log = logging.getLogger("townscan")


def create_app(settings: Settings | None = None, llm: GeminiClient | None = None) -> FastAPI:
    """llm は、テストが偽の送信関数を持つ窓口を差し込むための引数。省略すると、設定（LLM_PROVIDER・GEMINI_API_KEY）から作る。"""
    settings = settings or Settings.from_env()
    settings.validate()  # 未対応の LLM_PROVIDER や、gemini なのにキーが無いときは、ここで止まる

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        pool = make_pool(settings.database_url)
        pool.open()
        try:
            wait_and_apply_schema(pool)
            app.state.pool = pool
            yield
        finally:
            pool.close()

    app = FastAPI(
        title="TownScan API",
        version="0.1.0",
        docs_url="/api/docs",
        redoc_url=None,
        openapi_url="/api/openapi.json",
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.registry = build_default_registry()
    # None = 模擬モデル（既定）。gemini のときだけ、実 LLM の窓口（キーはここだけが持つ）
    app.state.llm = llm if llm is not None else build_llm_client(settings)
    # ログインは任意。設定が無ければ None（/api/me だけが 503 になる。ほかの入口は影響を受けない）
    app.state.verifier = JwtVerifier(settings.auth) if settings.auth else None
    register_error_handlers(app)
    app.include_router(router)
    return app
