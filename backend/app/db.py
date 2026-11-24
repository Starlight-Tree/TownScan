"""DB 接続（psycopg 3・同期）とスキーマの適用。SQL は自前。値は必ずパラメータで渡す。"""

from __future__ import annotations

import logging
import time
from pathlib import Path

import psycopg
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool, PoolTimeout

log = logging.getLogger("townscan")

DB_DIR = Path(__file__).resolve().parent.parent / "db"
SCHEMA_PATH = DB_DIR / "schema.sql"
# ログイン（web 側の Better Auth）の表。api が作り、web が読み書きする。schema.sql と同じく、何度流しても同じ（IF NOT EXISTS）
AUTH_SCHEMA_PATH = DB_DIR / "auth.sql"
# 適用する順。同じトランザクションで流す（途中で失敗したら、どちらも入らない）
SCHEMA_PATHS = (SCHEMA_PATH, AUTH_SCHEMA_PATH)
# 同時に流れても（api の起動とローダー）スキーマ適用が競合しないための鍵
_SCHEMA_LOCK_KEY = 704_218_001


def make_pool(database_url: str, timeout: float = 10) -> ConnectionPool:
    return ConnectionPool(
        database_url,
        min_size=1,
        max_size=4,
        timeout=timeout,
        open=False,
        check=ConnectionPool.check_connection,
        # 読み取り中心なので autocommit。複数文の更新はローダーが自分で transaction を張る
        kwargs={"autocommit": True, "row_factory": dict_row},
    )


def apply_schema(conn: psycopg.Connection) -> None:
    """schema.sql と auth.sql を、1 つのトランザクションで流す。どちらも冪等（既存の表・行は変えない）なので、すでにあるボリュームにも、起動のたびに流してよい。
    SQL の誤りは例外のまま出す（起動を止める）。"""
    sqls = [path.read_text(encoding="utf-8") for path in SCHEMA_PATHS]
    with conn.transaction():
        conn.execute("SELECT pg_advisory_xact_lock(%s)", (_SCHEMA_LOCK_KEY,))
        for sql in sqls:
            conn.execute(sql)


def wait_and_apply_schema(pool: ConnectionPool, attempts: int = 20, delay: float = 1.5) -> None:
    """DB がまだ起きていないときに備えて、数回やり直す（compose では healthy を待つが、念のため）。"""
    last: Exception | None = None
    for i in range(attempts):
        try:
            with pool.connection() as conn:
                apply_schema(conn)
            return
        except (psycopg.OperationalError, PoolTimeout) as exc:  # 接続できないときだけやり直す（SQL の誤りは即座に失敗させる）
            last = exc
            log.warning("スキーマの適用に失敗（%d/%d）: %s", i + 1, attempts, type(exc).__name__)
            time.sleep(delay)
    raise RuntimeError(f"DB に接続してスキーマを適用できませんでした: {type(last).__name__}")
