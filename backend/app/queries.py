"""読み取り用の SQL。値は必ずパラメータ（%s）で渡す。SQL の文字列に入るのは、このファイルの固定の断片だけ。"""

from __future__ import annotations

from typing import Any

import psycopg

CLASS_KEYS = ("confirmed_new", "existing_omission", "uncertain")
CLASS_LABELS = {
    "confirmed_new": "新規出現（旧写真に無い）",
    "existing_omission": "既存の描き漏れ（旧写真に既にある）",
    "uncertain": "判定保留",
}
# 並び順は許可リスト。利用者の値を SQL に入れない。
SORTS = {
    "area_desc": "c.area_m2 DESC, c.id ASC",
    "area_asc": "c.area_m2 ASC, c.id ASC",
}

_SUMMARY_COLUMNS = (
    "c.id, c.area_id, a.name AS area_name, a.ward, c.class, c.area_m2,"
    " c.west, c.south, c.east, c.north, c.centroid_lon, c.centroid_lat, c.reason"
)
_FROM_CANDIDATES = "FROM candidates c JOIN areas a ON a.run_id = c.run_id AND a.id = c.area_id"


def current_run(conn: psycopg.Connection) -> dict | None:
    """表示する現在の run = 最新の created_at（同時刻なら run_id の大きい方）。"""
    return conn.execute(
        "SELECT run_id, kind, created_at, model, params, notes FROM runs ORDER BY created_at DESC, run_id DESC LIMIT 1"
    ).fetchone()


def run_counts(conn: psycopg.Connection, run_id: str) -> dict[str, int]:
    row = conn.execute(
        "SELECT (SELECT count(*) FROM areas WHERE run_id = %(r)s) AS areas,"
        " (SELECT count(*) FROM candidates WHERE run_id = %(r)s) AS candidates,"
        " (SELECT count(*) FROM buildings WHERE run_id = %(r)s) AS buildings",
        {"r": run_id},
    ).fetchone()
    return {"areas": row["areas"], "candidates": row["candidates"], "buildings": row["buildings"]}


def _area_item(r: dict) -> dict:
    return {
        "id": r["id"],
        # 地区名の取得に失敗した地区でも、画面が文字列として扱えるように埋める（名前→id、区→空）
        "name": r["name"] or r["id"],
        "ward": r["ward"] or "",
        "municipality": r["municipality"],
        "bbox": [r["west"], r["south"], r["east"], r["north"]],
        "centroid": [r["centroid_lon"], r["centroid_lat"]],
        "counts": {
            "confirmed_new": r["confirmed_new"],
            "existing_omission": r["existing_omission"],
            "uncertain": r["uncertain"],
            "total": r["total"],
        },
    }


def list_areas(conn: psycopg.Connection, run_id: str, area_ids: list[str] | None = None) -> list[dict]:
    where, params = "a.run_id = %s", [run_id]
    if area_ids is not None:
        where += " AND a.id = ANY(%s)"
        params.append(area_ids)
    rows = conn.execute(
        "SELECT a.id, a.name, a.ward, a.municipality, a.west, a.south, a.east, a.north,"
        " a.centroid_lon, a.centroid_lat,"
        " count(c.id) FILTER (WHERE c.class = 'confirmed_new') AS confirmed_new,"
        " count(c.id) FILTER (WHERE c.class = 'existing_omission') AS existing_omission,"
        " count(c.id) FILTER (WHERE c.class = 'uncertain') AS uncertain,"
        " count(c.id) AS total"
        " FROM areas a LEFT JOIN candidates c ON c.run_id = a.run_id AND c.area_id = a.id"
        f" WHERE {where} GROUP BY a.run_id, a.id ORDER BY a.y, a.x",
        params,
    ).fetchall()
    return [_area_item(r) for r in rows]


def _filters(run_id: str, area_ids: list[str] | None, cls: str | None) -> tuple[str, list[Any]]:
    where, params = ["c.run_id = %s"], [run_id]
    if area_ids is not None:
        where.append("c.area_id = ANY(%s)")
        params.append(area_ids)
    if cls is not None:
        where.append("c.class = %s")
        params.append(cls)
    return " AND ".join(where), params


def count_by_class(conn: psycopg.Connection, run_id: str, area_ids: list[str] | None, cls: str | None) -> dict[str, int]:
    where, params = _filters(run_id, area_ids, cls)
    rows = conn.execute(f"SELECT c.class, count(*) AS n FROM candidates c WHERE {where} GROUP BY c.class", params).fetchall()
    counts = {k: 0 for k in CLASS_KEYS}
    counts.update({r["class"]: r["n"] for r in rows})
    return counts


def _summary(r: dict) -> dict:
    return {
        "id": r["id"],
        "area_id": r["area_id"],
        "area_name": r["area_name"],
        "ward": r["ward"],
        "class": r["class"],
        "area_m2": r["area_m2"],
        "bbox": [r["west"], r["south"], r["east"], r["north"]],
        "centroid": [r["centroid_lon"], r["centroid_lat"]],
        "reason": r["reason"],
    }


def list_candidates(
    conn: psycopg.Connection,
    run_id: str,
    area_ids: list[str] | None = None,
    cls: str | None = None,
    sort: str = "area_desc",
    limit: int = 50,
    offset: int = 0,
) -> tuple[int, list[dict]]:
    order = SORTS[sort]  # 許可リストに無い値は KeyError（呼び出し側で検証済み）
    where, params = _filters(run_id, area_ids, cls)
    total = conn.execute(f"SELECT count(*) AS n FROM candidates c WHERE {where}", params).fetchone()["n"]
    rows = conn.execute(
        f"SELECT {_SUMMARY_COLUMNS} {_FROM_CANDIDATES} WHERE {where} ORDER BY {order} LIMIT %s OFFSET %s",
        [*params, limit, offset],
    ).fetchall()
    return total, [_summary(r) for r in rows]


def candidate_features(conn: psycopg.Connection, run_id: str, area_ids: list[str] | None, cls: str | None) -> list[dict]:
    where, params = _filters(run_id, area_ids, cls)
    rows = conn.execute(
        f"SELECT c.id, c.area_id, c.class, c.area_m2, c.geom FROM candidates c WHERE {where} ORDER BY c.area_m2 DESC, c.id ASC",
        params,
    ).fetchall()
    return [
        {
            "type": "Feature",
            "id": r["id"],
            "geometry": r["geom"],
            "properties": {"id": r["id"], "class": r["class"], "area_m2": r["area_m2"], "area_id": r["area_id"]},
        }
        for r in rows
    ]


def candidate_ids(conn: psycopg.Connection, run_id: str, area_ids: list[str] | None, cls: str | None, limit: int) -> list[str]:
    where, params = _filters(run_id, area_ids, cls)
    rows = conn.execute(
        f"SELECT c.id FROM candidates c WHERE {where} ORDER BY c.area_m2 DESC, c.id ASC LIMIT %s", [*params, limit]
    ).fetchall()
    return [r["id"] for r in rows]


def get_candidate(conn: psycopg.Connection, run_id: str, candidate_id: str) -> dict | None:
    """詳細用。summary の項目に、evidence・geometry と、写真の切り出しに要る地区のタイル番号を足す。"""
    r = conn.execute(
        f"SELECT {_SUMMARY_COLUMNS}, c.evidence, c.geom, a.x AS tile_x, a.y AS tile_y {_FROM_CANDIDATES}"
        " WHERE c.run_id = %s AND c.id = %s",
        (run_id, candidate_id),
    ).fetchone()
    if r is None:
        return None
    item = _summary(r)
    item.update({"evidence": r["evidence"], "geometry": r["geom"], "tile_x": r["tile_x"], "tile_y": r["tile_y"]})
    return item


def get_metrics(conn: psycopg.Connection, run_id: str) -> dict | None:
    row = conn.execute("SELECT body FROM metrics WHERE run_id = %s", (run_id,)).fetchone()
    return None if row is None else row["body"]


def area_union_bbox(conn: psycopg.Connection, run_id: str, area_ids: list[str] | None = None) -> list[float] | None:
    where, params = "run_id = %s", [run_id]
    if area_ids is not None:
        where += " AND id = ANY(%s)"
        params.append(area_ids)
    r = conn.execute(
        f"SELECT min(west) AS w, min(south) AS s, max(east) AS e, max(north) AS n FROM areas WHERE {where}", params
    ).fetchone()
    if r is None or r["w"] is None:
        return None
    return [r["w"], r["s"], r["e"], r["n"]]
