"""ローダー用の DB の部品: スキーマの適用。SQL は自前（`sql/`）。値は必ずパラメータで渡す。"""

from __future__ import annotations

from pathlib import Path

import psycopg

SQL_DIR = Path(__file__).resolve().parent / "sql"
SCHEMA_PATH = SQL_DIR / "schema.sql"
# ログイン（web 側の Better Auth）の表。web が読み書きする。schema.sql と同じく、何度流しても同じ（IF NOT EXISTS）
AUTH_SCHEMA_PATH = SQL_DIR / "auth.sql"
# 適用する順。同じトランザクションで流す（途中で失敗したら、どちらも入らない）
SCHEMA_PATHS = (SCHEMA_PATH, AUTH_SCHEMA_PATH)
# 同時に流れても（api の起動とローダー）スキーマ適用が競合しないための鍵（Go の API の schema.go と同じ値）
_SCHEMA_LOCK_KEY = 704_218_001


def apply_schema(conn: psycopg.Connection) -> None:
    """schema.sql と auth.sql を、1 つのトランザクションで流す。どちらも冪等（既存の表・行は変えない）なので、すでにあるボリュームにも流してよい。
    SQL の誤りは例外のまま出す。"""
    sqls = [path.read_text(encoding="utf-8") for path in SCHEMA_PATHS]
    with conn.transaction():
        conn.execute("SELECT pg_advisory_xact_lock(%s)", (_SCHEMA_LOCK_KEY,))
        for sql in sqls:
            conn.execute(sql)
