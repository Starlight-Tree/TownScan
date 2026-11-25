"""ログインの表（pipeline/sql/auth.sql）。何度流しても同じ・既存のボリュームにも入る・既存の行を消さない・失敗したら止まる。
使い捨てのデータベースを作って確かめる（TEST_DATABASE_URL の Postgres。CREATE DATABASE の権限が要る）。"""

from __future__ import annotations

import re
import uuid
from pathlib import Path

import psycopg
import pytest
from psycopg import sql
from psycopg.conninfo import make_conninfo

from pipeline import db
from pipeline.db import AUTH_SCHEMA_PATH, SCHEMA_PATH, apply_schema

AUTH_TABLES = ["auth_account", "auth_jwks", "auth_session", "auth_user", "auth_verification"]

# (列, 型, NULL を許すか)。JobNavi の 0004_better_auth.sql（Better Auth 1.7.18 の getMigrations）と同じ形
EXPECTED_COLUMNS = {
    "auth_user": [
        ("id", "text", "NO"),
        ("name", "text", "NO"),
        ("email", "text", "NO"),
        ("emailVerified", "boolean", "NO"),
        ("image", "text", "YES"),
        ("createdAt", "timestamp with time zone", "NO"),
        ("updatedAt", "timestamp with time zone", "NO"),
        ("lastName", "text", "YES"),
        ("firstName", "text", "YES"),
    ],
    "auth_session": [
        ("id", "text", "NO"),
        ("expiresAt", "timestamp with time zone", "NO"),
        ("token", "text", "NO"),
        ("createdAt", "timestamp with time zone", "NO"),
        ("updatedAt", "timestamp with time zone", "NO"),
        ("ipAddress", "text", "YES"),
        ("userAgent", "text", "YES"),
        ("userId", "text", "NO"),
    ],
    "auth_account": [
        ("id", "text", "NO"),
        ("accountId", "text", "NO"),
        ("providerId", "text", "NO"),
        ("userId", "text", "NO"),
        ("accessToken", "text", "YES"),
        ("refreshToken", "text", "YES"),
        ("idToken", "text", "YES"),
        ("accessTokenExpiresAt", "timestamp with time zone", "YES"),
        ("refreshTokenExpiresAt", "timestamp with time zone", "YES"),
        ("scope", "text", "YES"),
        ("password", "text", "YES"),
        ("createdAt", "timestamp with time zone", "NO"),
        ("updatedAt", "timestamp with time zone", "NO"),
    ],
    "auth_verification": [
        ("id", "text", "NO"),
        ("identifier", "text", "NO"),
        ("value", "text", "NO"),
        ("expiresAt", "timestamp with time zone", "NO"),
        ("createdAt", "timestamp with time zone", "NO"),
        ("updatedAt", "timestamp with time zone", "NO"),
    ],
    "auth_jwks": [
        ("id", "text", "NO"),
        ("publicKey", "text", "NO"),
        ("privateKey", "text", "NO"),
        ("createdAt", "timestamp with time zone", "NO"),
        ("expiresAt", "timestamp with time zone", "YES"),
        ("alg", "text", "YES"),
        ("crv", "text", "YES"),
    ],
}


@pytest.fixture
def scratch_url(db_url):
    """空の使い捨てデータベース（テストが終わったら消す）。"""
    name = f"townscan_scratch_{uuid.uuid4().hex[:10]}"
    with psycopg.connect(db_url, autocommit=True) as admin:
        try:
            admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
        except psycopg.errors.InsufficientPrivilege:
            pytest.skip("CREATE DATABASE の権限が無いため、使い捨てデータベースを作れません（scripts/test-loader.sh では作れます）")
        try:
            yield make_conninfo(db_url, dbname=name)
        finally:
            admin.execute(sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(name)))


@pytest.fixture
def scratch(scratch_url):
    with psycopg.connect(scratch_url, autocommit=True) as c:
        yield c


def auth_shape(conn) -> dict:
    """auth_ の表の形（列・索引・制約）。2 回流したあとに、同じかを比べる。"""
    columns = conn.execute(
        "SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns"
        " WHERE table_schema = 'public' AND table_name LIKE 'auth\\_%' ORDER BY table_name, ordinal_position"
    ).fetchall()
    indexes = conn.execute(
        "SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename LIKE 'auth\\_%' ORDER BY 1, 2"
    ).fetchall()
    constraints = conn.execute(
        "SELECT conrelid::regclass::text, conname, pg_get_constraintdef(oid) FROM pg_constraint"
        " WHERE connamespace = 'public'::regnamespace AND conrelid::regclass::text LIKE 'auth\\_%' ORDER BY 1, 2"
    ).fetchall()
    return {"columns": columns, "indexes": indexes, "constraints": constraints}


def table_names(conn) -> list[str]:
    rows = conn.execute("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1").fetchall()
    return [r[0] for r in rows]


def test_auth_sql_creates_the_better_auth_tables_in_the_same_shape_as_jobnavi(scratch):
    apply_schema(scratch)
    for table, expected in EXPECTED_COLUMNS.items():
        rows = scratch.execute(
            "SELECT column_name, data_type, is_nullable FROM information_schema.columns"
            " WHERE table_schema = 'public' AND table_name = %s ORDER BY ordinal_position",
            (table,),
        ).fetchall()
        assert rows == expected, table
    assert sorted(t for t in table_names(scratch) if t.startswith("auth_")) == AUTH_TABLES
    constraints = {(r[0], r[2]) for r in auth_shape(scratch)["constraints"]}
    assert ("auth_user", "UNIQUE (email)") in constraints
    assert ("auth_session", "UNIQUE (token)") in constraints
    assert ("auth_session", 'FOREIGN KEY ("userId") REFERENCES auth_user(id) ON DELETE CASCADE') in constraints
    assert ("auth_account", 'FOREIGN KEY ("userId") REFERENCES auth_user(id) ON DELETE CASCADE') in constraints
    index_names = {r[1] for r in auth_shape(scratch)["indexes"]}
    assert {"auth_session_userid_idx", "auth_account_userid_idx", "auth_verification_identifier_idx"} <= index_names


def test_applying_twice_gives_the_same_shape(scratch):
    apply_schema(scratch)
    first = auth_shape(scratch)
    tables_first = table_names(scratch)
    apply_schema(scratch)
    apply_schema(scratch)
    assert auth_shape(scratch) == first
    assert table_names(scratch) == tables_first
    assert first["columns"]  # 空の比較で通っていないこと


def test_auth_sql_alone_is_idempotent_and_has_no_destructive_statements(scratch):
    text = AUTH_SCHEMA_PATH.read_text(encoding="utf-8")
    statements = "\n".join(line for line in text.splitlines() if not line.strip().startswith("--"))
    # 表を足すだけ（ON DELETE CASCADE は、外部キーの指定なので対象外）
    assert not re.search(r"\b(DROP|TRUNCATE|ALTER\s+TABLE|UPDATE|DELETE\s+FROM|INSERT)\b", statements, re.IGNORECASE)
    scratch.execute(text)
    first = auth_shape(scratch)
    scratch.execute(text)  # schema.sql が無くても、単独で 2 回流せる
    assert auth_shape(scratch) == first


def test_existing_volume_without_auth_tables_gets_them_and_keeps_its_data(scratch):
    # すでにあるボリューム（auth.sql ができる前の schema.sql だけが入った DB）を再現する
    scratch.execute(SCHEMA_PATH.read_text(encoding="utf-8"))
    assert not [t for t in table_names(scratch) if t.startswith("auth_")]
    scratch.execute("INSERT INTO runs (run_id, kind, created_at) VALUES ('keep-me', 'real', now())")
    apply_schema(scratch)  # api の起動で流れる処理
    assert sorted(t for t in table_names(scratch) if t.startswith("auth_")) == AUTH_TABLES
    assert scratch.execute("SELECT run_id FROM runs").fetchall() == [("keep-me",)]


def test_reapplying_keeps_existing_login_rows(scratch):
    apply_schema(scratch)
    scratch.execute(
        'INSERT INTO auth_user ("id", "name", "email", "emailVerified") VALUES (\'u1\', \'田中\', \'tanaka@example.com\', true)'
    )
    scratch.execute(
        'INSERT INTO auth_session ("id", "expiresAt", "token", "updatedAt", "userId")'
        " VALUES ('s1', now() + interval '1 day', 'tok', now(), 'u1')"
    )
    scratch.execute(
        'INSERT INTO auth_jwks ("id", "publicKey", "privateKey", "createdAt") VALUES (\'k1\', \'pub\', \'enc-private\', now())'
    )
    apply_schema(scratch)
    assert scratch.execute('SELECT "id", "name" FROM auth_user').fetchall() == [("u1", "田中")]
    assert scratch.execute('SELECT "id" FROM auth_session').fetchall() == [("s1",)]
    assert scratch.execute('SELECT "privateKey" FROM auth_jwks').fetchall() == [("enc-private",)]


def test_deleting_a_user_removes_their_sessions_and_accounts(scratch):
    apply_schema(scratch)
    scratch.execute('INSERT INTO auth_user ("id", "name", "email", "emailVerified") VALUES (\'u1\', \'n\', \'a@example.com\', true)')
    scratch.execute(
        'INSERT INTO auth_session ("id", "expiresAt", "token", "updatedAt", "userId") VALUES (\'s1\', now(), \'t\', now(), \'u1\')'
    )
    scratch.execute(
        'INSERT INTO auth_account ("id", "accountId", "providerId", "userId", "updatedAt") VALUES (\'a1\', \'g1\', \'google\', \'u1\', now())'
    )
    scratch.execute("DELETE FROM auth_user")
    assert scratch.execute("SELECT count(*) FROM auth_session").fetchone() == (0,)
    assert scratch.execute("SELECT count(*) FROM auth_account").fetchone() == (0,)


def test_email_is_unique(scratch):
    apply_schema(scratch)
    insert = 'INSERT INTO auth_user ("id", "name", "email", "emailVerified") VALUES (%s, \'n\', \'dup@example.com\', true)'
    scratch.execute(insert, ("u1",))
    with pytest.raises(psycopg.errors.UniqueViolation):
        scratch.execute(insert, ("u2",))


def test_a_sql_error_stops_and_leaves_nothing_behind(scratch_url, tmp_path, monkeypatch):
    bad = tmp_path / "bad.sql"
    bad.write_text("CREATE TABLE auth_half_done (id text);\nTHIS IS NOT SQL;\n", encoding="utf-8")
    monkeypatch.setattr(db, "SCHEMA_PATHS", (SCHEMA_PATH, bad))
    with psycopg.connect(scratch_url, autocommit=True) as c:
        # SQL の誤りは、そのまま出て止まる
        with pytest.raises(psycopg.errors.SyntaxError):
            apply_schema(c)
        # 1 つのトランザクションなので、途中まで作った表も、schema.sql の表も残らない
        assert table_names(c) == []


def test_concurrent_applies_do_not_conflict(scratch_url):
    # api（Go）の起動とローダーが同時に流れても、アドバイザリロックで直列になる
    import threading

    errors: list[Exception] = []

    def run():
        try:
            with psycopg.connect(scratch_url, autocommit=True) as c:
                apply_schema(c)
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [threading.Thread(target=run) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)
    assert errors == []
    with psycopg.connect(scratch_url) as c:
        assert sorted(t for t in table_names(c) if t.startswith("auth_")) == AUTH_TABLES
