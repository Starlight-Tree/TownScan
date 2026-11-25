"""pipeline の出力（docs/spec-prototype.md §4.1・§4.2）を DB へ読み込むローダー。

使い方: python -m pipeline.load --run <out ディレクトリ> [--check]
  - 読み込む前にすべてのファイルを検査し、足りない・壊れている・仕様と合わないときは、日本語のメッセージで止まる（DB は変えない）。
  - 書き込みは 1 つのトランザクション。同じ run_id を入れ直すと置き換える（冪等）。途中で失敗したら、元の状態のまま。
  - --check: 検査だけして DB には触れない。
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import psycopg
from psycopg.types.json import Jsonb

from .db import apply_schema

REQUIRED_FILES = (
    "run.json",
    "areas.json",
    "buildings_2018.geojson",
    "buildings_2023.geojson",
    "candidates.geojson",
    "eval.json",
)
BUILDING_YEARS = (2018, 2023)
CLASSES = ("confirmed_new", "existing_omission", "uncertain")
REASONS = ("new_absent_2018", "present_2018", "ambiguous", "edge", "small")
RUN_KINDS = ("real", "synthetic")
EVIDENCE_NUMBERS = ("prob_2023_mean", "ov_2018", "prob_2018_p90", "ov_kiban")  # 仕様 §4.2。edge_touch は真偽値

_RUN_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_AREA_ID_RE = re.compile(r"^z(\d+)-(\d+)-(\d+)$")
_CAND_ID_RE = re.compile(r"^c-\d+-\d+-\d+$")
# run.json の created にタイムゾーンが無いときは日本時間として扱う（開発環境の TZ が Asia/Tokyo のため）
_JST = timezone(timedelta(hours=9))
_MAX_PROBLEMS_SHOWN = 10


class LoadError(Exception):
    """入力が足りない・壊れている・仕様と合わない。メッセージは日本語でそのまま表示する。"""


class _Problems:
    """1 つのファイルの問題を集めて、最後にまとめて出す（最初の 1 件で止めず、直す手間を減らす）。"""

    def __init__(self, filename: str):
        self.filename = filename
        self.items: list[str] = []
        self.total = 0

    def add(self, where: str, message: str) -> None:
        self.total += 1
        if len(self.items) < _MAX_PROBLEMS_SHOWN:
            self.items.append(f"{where}: {message}")

    def raise_if_any(self) -> None:
        if not self.total:
            return
        lines = [f"{self.filename} が仕様（docs/spec-prototype.md §4）と合いません:"]
        lines += [f"  - {item}" for item in self.items]
        if self.total > len(self.items):
            lines.append(f"  （ほか {self.total - len(self.items)} 件）")
        raise LoadError("\n".join(lines))


def _is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _reject_constant(name: str):
    raise ValueError(f"{name} は JSON では使えません")


def _read_json(path: Path) -> Any:
    if not path.is_file():
        raise LoadError(f"必要なファイルがありません: {path}（pipeline の出力ディレクトリ（out）を指定しているか確認してください）")
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        raise LoadError(f"UTF-8 として読めません: {path.name}") from None
    try:
        return json.loads(text, parse_constant=_reject_constant)
    except json.JSONDecodeError as exc:
        raise LoadError(f"JSON として読めません: {path.name}（{exc.lineno} 行 {exc.colno} 列: {exc.msg}）") from None
    except ValueError as exc:
        raise LoadError(f"JSON の値が不正です: {path.name}（{exc}）") from None


# ---- 検査の部品 ----

def _check_position(pos: Any) -> bool:
    return (
        isinstance(pos, list)
        and len(pos) >= 2
        and _is_num(pos[0])
        and _is_num(pos[1])
        and -180 <= pos[0] <= 180
        and -90 <= pos[1] <= 90
    )


def _check_geometry(geom: Any, allowed: tuple[str, ...], where: str, pr: _Problems) -> None:
    if not isinstance(geom, dict) or geom.get("type") not in allowed:
        pr.add(where, f"geometry は {' / '.join(allowed)} である必要があります")
        return
    coords = geom.get("coordinates")
    polygons = [coords] if geom["type"] == "Polygon" else coords
    ok = isinstance(polygons, list) and len(polygons) > 0
    for poly in polygons if ok else ():
        # poly = リングの配列。各リングは閉じた lon/lat の列（4 点以上）
        if not (isinstance(poly, list) and poly):
            ok = False
            break
        if not all(isinstance(r, list) and len(r) >= 4 and all(_check_position(p) for p in r) for r in poly):
            ok = False
            break
    if not ok:
        pr.add(where, "geometry の座標が不正です（lon/lat の数値の組、4 点以上のリング）")


def _num_field(obj: dict, key: str, where: str, pr: _Problems, *, nullable: bool = False, minimum: float | None = None):
    v = obj.get(key)
    if v is None and nullable:
        return None
    if not _is_num(v):
        pr.add(f"{where}.{key}", "数値である必要があります")
        return None
    if minimum is not None and v < minimum:
        pr.add(f"{where}.{key}", f"{minimum} 以上である必要があります")
    return float(v)


def _bbox_field(obj: dict, key: str, where: str, pr: _Problems) -> list[float] | None:
    v = obj.get(key)
    if not (isinstance(v, list) and len(v) == 4 and all(_is_num(n) for n in v)):
        pr.add(f"{where}.{key}", "[西, 南, 東, 北] の数値 4 つである必要があります")
        return None
    w, s, e, n = (float(i) for i in v)
    if not (w < e and s < n):
        pr.add(f"{where}.{key}", "西 < 東 かつ 南 < 北 である必要があります")
        return None
    return [w, s, e, n]


def _pair_field(obj: dict, key: str, where: str, pr: _Problems) -> list[float] | None:
    v = obj.get(key)
    if not (isinstance(v, list) and len(v) == 2 and all(_is_num(n) for n in v)):
        pr.add(f"{where}.{key}", "[経度, 緯度] の数値 2 つである必要があります")
        return None
    return [float(v[0]), float(v[1])]


# ---- 読み込み結果 ----

@dataclass
class ParsedRun:
    run_id: str
    kind: str
    created_at: datetime
    model: str | None
    params: dict
    notes: str | None
    areas: list[tuple]
    buildings: list[tuple]
    candidates: list[tuple]
    metrics: dict
    counts: dict[str, int] = field(default_factory=dict)


def _parse_run(raw: Any) -> dict:
    pr = _Problems("run.json")
    if not isinstance(raw, dict):
        pr.add("(全体)", "オブジェクトである必要があります")
        pr.raise_if_any()
    run_id = raw.get("run_id")
    if not (isinstance(run_id, str) and _RUN_ID_RE.match(run_id)):
        pr.add("run_id", "英数字・ . _ - だけの 64 文字以内の文字列である必要があります")
    kind = raw.get("kind")
    if kind not in RUN_KINDS:
        pr.add("kind", f"{' か '.join(RUN_KINDS)} のどちらかである必要があります（合成データと実データを取り違えないため、省略できません）")
    created = raw.get("created")
    created_at = None
    if isinstance(created, str):
        try:
            created_at = datetime.fromisoformat(created)
            if created_at.tzinfo is None:
                created_at = created_at.replace(tzinfo=_JST)
        except ValueError:
            pr.add("created", "ISO 8601 の日時である必要があります（例: 2026-11-24T12:00:00+09:00）")
    else:
        pr.add("created", "ISO 8601 の日時である必要があります")
    model = raw.get("model")
    if model is not None and not isinstance(model, str):
        pr.add("model", "文字列である必要があります")
    params = raw.get("params", {})
    if not isinstance(params, dict):
        pr.add("params", "オブジェクトである必要があります")
    notes = raw.get("notes")
    if isinstance(notes, list) and all(isinstance(n, str) for n in notes):
        notes = "\n".join(notes)
    elif notes is not None and not isinstance(notes, str):
        pr.add("notes", "文字列または文字列の配列である必要があります")
    pr.raise_if_any()
    return {
        "run_id": run_id,
        "kind": kind,
        "created_at": created_at,
        "model": model,
        "params": params,
        "notes": notes,
    }


def _parse_areas(raw: Any, run_id: str) -> tuple[list[tuple], set[str]]:
    pr = _Problems("areas.json")
    if not isinstance(raw, list) or not raw:
        pr.add("(全体)", "地区の配列（1 件以上）である必要があります")
        pr.raise_if_any()
    rows: list[tuple] = []
    seen: set[str] = set()
    for i, a in enumerate(raw):
        where = f"[{i}]"
        if not isinstance(a, dict):
            pr.add(where, "オブジェクトである必要があります")
            continue
        aid = a.get("id")
        m = _AREA_ID_RE.match(aid) if isinstance(aid, str) else None
        if not m:
            pr.add(f"{where}.id", "z{z}-{x}-{y}（例: z18-226000-107000）の形である必要があります")
            continue
        if aid in seen:
            pr.add(f"{where}.id", f"{aid} が重複しています")
        seen.add(aid)
        z, x, y = (a.get(k) for k in ("z", "x", "y"))
        if not all(_is_int(v) for v in (z, x, y)):
            pr.add(where, "z・x・y は整数である必要があります")
            continue
        if (z, x, y) != tuple(int(g) for g in m.groups()):
            pr.add(f"{where}.id", "id と z・x・y が一致しません")
        bbox = _bbox_field(a, "bbox", where, pr)
        centroid = _pair_field(a, "centroid", where, pr)
        texts = []
        for key in ("name", "ward", "municipality", "name_source"):
            v = a.get(key)
            if v is not None and not isinstance(v, str):
                pr.add(f"{where}.{key}", "文字列か null である必要があります")
                v = None
            texts.append(v)
        if bbox and centroid:
            rows.append((run_id, aid, z, x, y, *bbox, *centroid, *texts))
    pr.raise_if_any()
    return rows, seen


def _parse_features(raw: Any, pr: _Problems) -> list[dict]:
    if not (isinstance(raw, dict) and raw.get("type") == "FeatureCollection" and isinstance(raw.get("features"), list)):
        pr.add("(全体)", "FeatureCollection である必要があります")
        pr.raise_if_any()
    return raw["features"]


def _parse_buildings(raw: Any, year: int, run_id: str, area_ids: set[str]) -> list[tuple]:
    filename = f"buildings_{year}.geojson"
    pr = _Problems(filename)
    rows: list[tuple] = []
    for i, f in enumerate(_parse_features(raw, pr)):
        where = f"features[{i}]"
        if not isinstance(f, dict) or not isinstance(f.get("properties"), dict):
            pr.add(where, "properties を持つ Feature である必要があります")
            continue
        props = f["properties"]
        _check_geometry(f.get("geometry"), ("Polygon", "MultiPolygon"), f"{where}.geometry", pr)
        area_id = props.get("area_id")
        if not isinstance(area_id, str) or area_id not in area_ids:
            pr.add(f"{where}.properties.area_id", f"areas.json に無い地区です: {area_id!r}")
        area_m2 = _num_field(props, "area_m2", f"{where}.properties", pr, minimum=0)
        prob_mean = _num_field(props, "prob_mean", f"{where}.properties", pr, nullable=True)
        if not pr.total:
            rows.append((run_id, area_id, year, area_m2, prob_mean, Jsonb(f["geometry"])))
    pr.raise_if_any()
    return rows


def _parse_candidates(raw: Any, run_id: str, area_ids: set[str]) -> list[tuple]:
    pr = _Problems("candidates.geojson")
    rows: list[tuple] = []
    seen: set[str] = set()
    for i, f in enumerate(_parse_features(raw, pr)):
        where = f"features[{i}]"
        if not isinstance(f, dict) or not isinstance(f.get("properties"), dict):
            pr.add(where, "properties を持つ Feature である必要があります")
            continue
        props = f["properties"]
        cid = f.get("id")
        if not (isinstance(cid, str) and _CAND_ID_RE.match(cid)):
            pr.add(f"{where}.id", "c-{x}-{y}-{n}（例: c-226000-107000-1）の形である必要があります")
        elif cid in seen:
            pr.add(f"{where}.id", f"{cid} が重複しています")
        else:
            seen.add(cid)
        _check_geometry(f.get("geometry"), ("Polygon",), f"{where}.geometry", pr)
        pw = f"{where}.properties"
        area_id = props.get("area_id")
        if not isinstance(area_id, str) or area_id not in area_ids:
            pr.add(f"{pw}.area_id", f"areas.json に無い地区です: {area_id!r}")
        cls = props.get("class")
        if cls not in CLASSES:
            pr.add(f"{pw}.class", f"{' / '.join(CLASSES)} のいずれかである必要があります（実際: {cls!r}）")
        reason = props.get("reason")
        if reason not in REASONS:
            pr.add(f"{pw}.reason", f"{' / '.join(REASONS)} のいずれかである必要があります（実際: {reason!r}）")
        area_m2 = _num_field(props, "area_m2", pw, pr, minimum=0)
        bbox = _bbox_field(props, "bbox", pw, pr)
        centroid = _pair_field(props, "centroid", pw, pr)
        evidence = props.get("evidence")
        if not isinstance(evidence, dict):
            pr.add(f"{pw}.evidence", "オブジェクトである必要があります")
        else:
            for key in EVIDENCE_NUMBERS:
                if not _is_num(evidence.get(key)):
                    pr.add(f"{pw}.evidence.{key}", "数値である必要があります")
            if not isinstance(evidence.get("edge_touch"), bool):
                pr.add(f"{pw}.evidence.edge_touch", "真偽値（true / false）である必要があります")
        if not pr.total:
            rows.append((cid, run_id, area_id, cls, area_m2, *bbox, *centroid, Jsonb(f["geometry"]), Jsonb(evidence), reason))
    pr.raise_if_any()
    return rows


def read_run_dir(out_dir: str | os.PathLike) -> ParsedRun:
    """出力ディレクトリを読み、すべて検査する。DB には触れない。"""
    base = Path(out_dir)
    if not base.is_dir():
        raise LoadError(f"ディレクトリがありません: {base}")
    raw = {name: _read_json(base / name) for name in REQUIRED_FILES}

    run = _parse_run(raw["run.json"])
    areas, area_ids = _parse_areas(raw["areas.json"], run["run_id"])
    buildings: list[tuple] = []
    for year in BUILDING_YEARS:
        buildings += _parse_buildings(raw[f"buildings_{year}.geojson"], year, run["run_id"], area_ids)
    candidates = _parse_candidates(raw["candidates.geojson"], run["run_id"], area_ids)
    if not isinstance(raw["eval.json"], dict):
        raise LoadError("eval.json が仕様と合いません: オブジェクトである必要があります")

    parsed = ParsedRun(areas=areas, buildings=buildings, candidates=candidates, metrics=raw["eval.json"], **run)
    parsed.counts = {"areas": len(areas), "buildings": len(buildings), "candidates": len(candidates)}
    return parsed


# ---- 書き込み ----

def _insert_run(conn: psycopg.Connection, r: ParsedRun) -> None:
    conn.execute(
        "INSERT INTO runs (run_id, kind, created_at, model, params, notes) VALUES (%s, %s, %s, %s, %s, %s)",
        (r.run_id, r.kind, r.created_at, r.model, Jsonb(r.params), r.notes),
    )


def _insert_areas(conn: psycopg.Connection, r: ParsedRun) -> None:
    with conn.cursor() as cur:
        cur.executemany(
            "INSERT INTO areas (run_id, id, z, x, y, west, south, east, north, centroid_lon, centroid_lat,"
            " name, ward, municipality, name_source) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
            r.areas,
        )


def _insert_buildings(conn: psycopg.Connection, r: ParsedRun) -> None:
    with conn.cursor() as cur:
        cur.executemany(
            "INSERT INTO buildings (run_id, area_id, year, area_m2, prob_mean, geom) VALUES (%s, %s, %s, %s, %s, %s)",
            r.buildings,
        )


def _insert_candidates(conn: psycopg.Connection, r: ParsedRun) -> None:
    with conn.cursor() as cur:
        cur.executemany(
            "INSERT INTO candidates (id, run_id, area_id, class, area_m2, west, south, east, north,"
            " centroid_lon, centroid_lat, geom, evidence, reason)"
            " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
            r.candidates,
        )


def _insert_metrics(conn: psycopg.Connection, r: ParsedRun) -> None:
    conn.execute("INSERT INTO metrics (run_id, body) VALUES (%s, %s)", (r.run_id, Jsonb(r.metrics)))


def write_run(conn: psycopg.Connection, r: ParsedRun) -> dict[str, int]:
    """同じ run_id を置き換える。1 つのトランザクション（途中で失敗したら元のまま）。"""
    with conn.transaction():
        # 子の表は ON DELETE CASCADE で一緒に消える
        conn.execute("DELETE FROM runs WHERE run_id = %s", (r.run_id,))
        _insert_run(conn, r)
        _insert_areas(conn, r)
        _insert_buildings(conn, r)
        _insert_candidates(conn, r)
        _insert_metrics(conn, r)
    return dict(r.counts)


def write_to_database(database_url: str, parsed: ParsedRun) -> None:
    with psycopg.connect(database_url, autocommit=True) as conn:
        apply_schema(conn)
        write_run(conn, parsed)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m pipeline.load", description="pipeline の出力を DB へ読み込む（冪等）")
    ap.add_argument("--run", required=True, metavar="OUT_DIR", help="pipeline の出力ディレクトリ（run.json などがある場所）")
    ap.add_argument("--check", action="store_true", help="ファイルの検査だけ行い、DB には触れない")
    args = ap.parse_args(argv)
    try:
        parsed = read_run_dir(args.run)  # 先にファイルを検査する（DB の設定が無くても、ファイルの誤りは分かるように）
        if args.check:
            verb = "検査に合格しました（DB には書いていません）"
        else:
            url = os.environ.get("DATABASE_URL", "").strip()
            if not url:
                raise LoadError("環境変数 DATABASE_URL が未設定です")
            write_to_database(url, parsed)
            verb = "読み込みました"
    except LoadError as exc:
        print(f"エラー: {exc}", file=sys.stderr)
        return 1
    except psycopg.OperationalError as exc:
        print(f"エラー: DB に接続できません（{type(exc).__name__}）。DATABASE_URL と db の起動を確認してください", file=sys.stderr)
        return 1
    c = parsed.counts
    print(
        f"{verb}: run_id={parsed.run_id} kind={parsed.kind} "
        f"地区 {c['areas']}・建物 {c['buildings']}・候補 {c['candidates']}"
    )
    if parsed.kind == "synthetic":
        print("注意: これは合成データ（テスト用）です。実データではありません。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
