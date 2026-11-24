"""FastAPI アプリの組み立て。uvicorn は `uvicorn --factory app.main:create_app` で起動する。"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from .chat.tools import build_default_registry
from .config import Settings
from .db import make_pool, wait_and_apply_schema
from .errors import register_error_handlers
from .routes import router

log = logging.getLogger("townscan")


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    settings.validate()  # LLM_PROVIDER が mock 以外なら、ここで止まる

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
    register_error_handlers(app)
    app.include_router(router)
    return app
