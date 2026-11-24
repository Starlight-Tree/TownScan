"""チャットのツール: 登録表（ToolRegistry）と、組み込みのツール。

ツールは「名前・説明・引数の JSON Schema・ハンドラ」を持つ。後から GEE の道具を足すときは、
`registry.register(Tool(...))` を 1 回呼ぶだけ（模擬モデルの規則と、結果の文章化の関数を足す）。
数字・件数・座標は、ここ（DB の結果）からだけ出る。LLM に書かせない。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Callable
from urllib.parse import urlencode

import psycopg

from .. import queries
from ..provenance import SOURCE_ACCURACY, provenance
from ..queries import CLASS_KEYS, CLASS_LABELS

log = logging.getLogger("townscan")

REFUSAL_REASONS = ("out_of_scope", "no_photo_period", "not_implemented", "no_data")
DEFAULT_SUGGESTIONS = [
    "新規出現の候補は何件ありますか？",
    "地区ごとに候補数を比べてください",
    "一番大きい新規出現の写真を見せてください",
    "このアプリの精度は？",
]
MAX_LIST_LIMIT = 50
MAX_FOCUS_IDS = 5000  # 地図に渡す候補 ID の上限（応答の大きさの保険。超えたら、件数は実数のまま「上位 N 件」と明示する）
IMAGE_SIZE = 512


class ToolError(Exception):
    """ツールが続けられないとき。refusal の結果にして返す。"""

    def __init__(self, reason: str, message: str, suggestions: list[str] | None = None):
        super().__init__(message)
        self.reason = reason
        self.message = message
        self.suggestions = suggestions


@dataclass
class ToolContext:
    conn: psycopg.Connection
    run: dict
    areas: list[dict]  # queries.list_areas の結果（この要求の間だけ使う）

    def provenance(self, **kw) -> dict:
        return provenance(self.run, **kw)

    def area_by_id(self, area_id: str) -> dict | None:
        return next((a for a in self.areas if a["id"] == area_id), None)


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    parameters: dict[str, Any]  # JSON Schema。実 LLM に渡す tool 定義にそのまま使える形
    handler: Callable[[ToolContext, dict[str, Any]], dict[str, Any]]


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, Tool] = {}

    def register(self, tool: Tool) -> None:
        if tool.name in self._tools:
            raise ValueError(f"ツール {tool.name!r} は既に登録されています")
        self._tools[tool.name] = tool

    def names(self) -> list[str]:
        return list(self._tools)

    def get(self, name: str) -> Tool | None:
        return self._tools.get(name)

    def llm_schemas(self) -> list[dict[str, Any]]:
        return [{"name": t.name, "description": t.description, "input_schema": t.parameters} for t in self._tools.values()]

    def call(self, ctx: ToolContext, name: str, args: dict[str, Any]) -> dict[str, Any]:
        tool = self._tools.get(name)
        if tool is None:
            return refusal("out_of_scope", "その操作はできません。", DEFAULT_SUGGESTIONS)
        try:
            return tool.handler(ctx, args)
        except ToolError as exc:
            return refusal(exc.reason, exc.message, exc.suggestions)


# ---- 部品 ----

def refusal(reason: str, message: str, suggestions: list[str] | None = None) -> dict:
    if reason not in REFUSAL_REASONS:
        raise ValueError(f"不明な reason: {reason!r}")
    return {
        "type": "refusal",
        "reason": reason,
        "message": message,
        "suggestions": list(DEFAULT_SUGGESTIONS if suggestions is None else suggestions),
    }


def _ward_names(args: dict) -> list[str]:
    """引数 ward（1 つ）と wards（複数）から、区名の一覧を作る（重複は除く）。文字列でない値は不正な引数。"""
    raw: list[Any] = []
    if args.get("ward") not in (None, ""):
        raw.append(args["ward"])
    wards = args.get("wards")
    if wards not in (None, "", []):
        raw.extend(wards if isinstance(wards, list) else [wards])
    if any(not isinstance(w, str) or not w for w in raw):
        raise ToolError("out_of_scope", "区の指定が正しくありません。")
    return list(dict.fromkeys(raw))


def _resolve_areas(ctx: ToolContext, args: dict) -> tuple[list[str] | None, str]:
    """引数（area_ids / area_id / ward / wards）から、地区の id の一覧（None = 全地区）と、表示用の名前を作る。"""
    ids: list[str] | None = None
    if args.get("area_ids"):
        ids = list(args["area_ids"])
    elif args.get("area_id"):
        ids = [args["area_id"]]
    wards = _ward_names(args)
    if ids is None and wards:
        by_ward = {w: [a["id"] for a in ctx.areas if a["ward"] == w] for w in wards}
        missing = [w for w, found in by_ward.items() if not found]
        if missing:
            raise ToolError("no_data", f"「{'・'.join(missing)}」の地区はありません。")
        ids = [i for found in by_ward.values() for i in found]  # 複数の区は、地区の和集合
    if ids is None:
        return None, "全地区"
    known = {a["id"] for a in ctx.areas}
    unknown = [i for i in ids if i not in known]
    if unknown:
        raise ToolError("no_data", "指定の地区が見つかりません。")
    ids = sorted(set(ids))
    if wards:
        return ids, "・".join(wards)
    names = [ctx.area_by_id(i)["name"] or i for i in ids]
    label = "・".join(names[:3]) + ("ほか" if len(names) > 3 else "")
    return ids, label


def _clean_cls(args: dict) -> str | None:
    cls = args.get("cls")
    if cls in (None, ""):
        return None
    if cls not in CLASS_KEYS:
        raise ToolError("out_of_scope", "その分類はありません。")
    return cls


def _filter_info(ids: list[str] | None, cls: str | None, scope: str) -> dict:
    info: dict[str, Any] = {}
    if ids is not None and len(ids) == 1:
        info["area_id"] = ids[0]
    elif ids is not None:
        info["area_ids"] = ids
    if cls is not None:
        info["cls"] = cls
    info["scope"] = scope  # 表示用の名前（仕様の filter に足した項目）
    return info


def image_url(candidate_id: str, year: int, size: int = IMAGE_SIZE) -> str:
    return f"/api/candidates/{candidate_id}/image?{urlencode({'year': year, 'size': size})}"


# ---- ツール ----

def count_candidates(ctx: ToolContext, args: dict) -> dict:
    ids, scope = _resolve_areas(ctx, args)
    cls = _clean_cls(args)
    counts = queries.count_by_class(ctx.conn, ctx.run["run_id"], ids, cls)
    keys = [cls] if cls else list(CLASS_KEYS)
    breakdown = [{"key": k, "label": CLASS_LABELS[k], "value": counts[k]} for k in keys]
    title = f"「{CLASS_LABELS[cls]}」の件数（{scope}）" if cls else f"新規出現候補の件数（{scope}）"
    return {
        "type": "count",
        "title": title,
        "total": sum(b["value"] for b in breakdown),
        "breakdown": breakdown,
        "filter": _filter_info(ids, cls, scope),
        "provenance": ctx.provenance(),
    }


def list_candidates(ctx: ToolContext, args: dict) -> dict:
    ids, scope = _resolve_areas(ctx, args)
    cls = _clean_cls(args)
    limit = args.get("limit", 10)
    if isinstance(limit, bool) or not isinstance(limit, int):
        limit = 10
    limit = min(max(limit, 1), MAX_LIST_LIMIT)
    total, items = queries.list_candidates(ctx.conn, ctx.run["run_id"], ids, cls, "area_desc", limit, 0)
    rows = [
        {"id": c["id"], "area": c["area_name"] or c["area_id"], "class": CLASS_LABELS[c["class"]], "area_m2": c["area_m2"]}
        for c in items
    ]
    suffix = f"「{CLASS_LABELS[cls]}」" if cls else "新規出現候補"
    return {
        "type": "table",
        "title": f"{suffix}の一覧（{scope}・面積の大きい順）",
        "columns": [
            {"key": "id", "label": "候補 ID"},
            {"key": "area", "label": "地区"},
            {"key": "class", "label": "分類"},
            {"key": "area_m2", "label": "面積（m²）"},
        ],
        "rows": rows,
        "total": total,
        "shown": len(rows),
        "provenance": ctx.provenance(),
        "filter": _filter_info(ids, cls, scope),
    }


def compare_areas(ctx: ToolContext, args: dict) -> dict:
    ids, scope = _resolve_areas(ctx, args)
    cls = _clean_cls(args)
    areas = queries.list_areas(ctx.conn, ctx.run["run_id"], ids)
    key = cls or "total"
    areas.sort(key=lambda a: (-a["counts"][key], a["name"] or a["id"]))
    items = [{"area_id": a["id"], "name": a["name"] or a["id"], "ward": a["ward"], "counts": a["counts"]} for a in areas]
    by = f"「{CLASS_LABELS[cls]}」" if cls else "候補の合計"
    return {
        "type": "compare",
        "title": f"地区ごとの比較（{scope}・{by}の多い順）",
        "items": items,
        "sort_key": key,
        "provenance": ctx.provenance(),
        "filter": _filter_info(ids, cls, scope),
    }


def _pick_candidate(ctx: ToolContext, args: dict) -> dict:
    run_id = ctx.run["run_id"]
    cid = args.get("candidate_id")
    if cid:
        cand = queries.get_candidate(ctx.conn, run_id, cid) if isinstance(cid, str) else None
        if cand is None:
            raise ToolError("no_data", "その候補は見つかりません。")
        return cand
    ids, _ = _resolve_areas(ctx, args)
    cls = _clean_cls(args)
    # 分類の指定が無いときは、主役の「新規出現」を先に探し、無ければ全分類から選ぶ
    for try_cls in ([cls] if cls else ["confirmed_new", None]):
        _, items = queries.list_candidates(ctx.conn, run_id, ids, try_cls, "area_desc", 1, 0)
        if items:
            return queries.get_candidate(ctx.conn, run_id, items[0]["id"])
    raise ToolError("no_data", "該当する候補がありません。")


def show_candidate(ctx: ToolContext, args: dict) -> dict:
    cand = _pick_candidate(ctx, args)
    area_name = cand["area_name"] or cand["area_id"]
    caption = (
        f"{area_name}・{CLASS_LABELS[cand['class']]}・面積 約 {cand['area_m2']:.0f} m²。"
        "輪郭は機械が抽出した範囲で、確定ではありません。"
    )
    return {
        "type": "detection_image",
        "title": f"候補 {cand['id']} の写真（2018 年と 2023 年）",
        "candidate_id": cand["id"],
        "class": cand["class"],
        "images": [{"year": y, "url": image_url(cand["id"], y)} for y in (2018, 2023)],
        "caption": caption,
        "provenance": ctx.provenance(),
    }


def focus_map(ctx: ToolContext, args: dict) -> dict:
    run_id = ctx.run["run_id"]
    cid = args.get("candidate_id")
    if cid:
        cand = queries.get_candidate(ctx.conn, run_id, cid) if isinstance(cid, str) else None
        if cand is None:
            raise ToolError("no_data", "その候補は見つかりません。")
        return {
            "type": "map_focus",
            "title": f"候補 {cand['id']} を地図で表示",
            "bbox": cand["bbox"],
            "candidate_ids": [cand["id"]],
            "provenance": ctx.provenance(),
        }
    ids, scope = _resolve_areas(ctx, args)
    cls = _clean_cls(args)
    cand_ids = queries.candidate_ids(ctx.conn, run_id, ids, cls, MAX_FOCUS_IDS)
    bbox = queries.area_union_bbox(ctx.conn, run_id, ids)
    if bbox is None:
        raise ToolError("no_data", "地図に出せる地区がありません。")
    # 件数は、地図に渡す ID の数ではなく、DB の実数（仕様 E6: DB の件数 = UI の件数）。ID を上限で切ったときは、そう書く
    counts = queries.count_by_class(ctx.conn, run_id, ids, cls)
    total = counts[cls] if cls else sum(counts.values())
    what = f"「{CLASS_LABELS[cls]}」" if cls else "候補"
    if len(cand_ids) < total:
        title = f"{scope}の{what} {total} 件のうち、面積の大きい上位 {len(cand_ids)} 件を地図で表示"
    else:
        title = f"{scope}の{what} {total} 件を地図で表示"
    return {
        "type": "map_focus",
        "title": title,
        "bbox": bbox,
        "candidate_ids": cand_ids,
        "provenance": ctx.provenance(),
    }


def _pick(d: Any, *path: str) -> Any:
    for key in path:
        if not isinstance(d, dict):
            return None
        d = d.get(key)
    return d


def _first_present(d: Any, base: tuple[str, ...], names: tuple[str, ...]) -> float | None:
    for name in names:
        v = _pick(d, *base, name)
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            return float(v)
    return None


def _eval_year(body: Any) -> int:
    """精度を測った写真の年。評価ファイルに無ければ 2018（選んだ設定は 2018 年の抽出で決めている）。"""
    for path in (("year_compare", "selected_on_year"), ("protocol", "year")):
        v = _pick(body, *path)
        if isinstance(v, int) and not isinstance(v, bool):
            return v
    return 2018


def get_accuracy(ctx: ToolContext, args: dict) -> dict:
    body = queries.get_metrics(ctx.conn, ctx.run["run_id"])
    if body is None:
        raise ToolError("no_data", "評価の結果が読み込まれていません。")
    holdout_n = len(_pick(body, "split", "holdout") or [])
    tune_n = len(_pick(body, "split", "tune") or [])
    held = f"評価用 {holdout_n} 地区" if holdout_n else "評価用の地区"
    tuned = f"調整用 {tune_n} 地区" if tune_n else "調整用の地区"
    missing = "評価ファイルに値がありません"
    year = _eval_year(body)
    yr = f"{year} 年の写真"

    def metric(key: str, label: str, base: tuple[str, ...], names: tuple[str, ...], note: str) -> dict:
        v = _first_present(body, base, names)
        return {"key": key, "label": label, "value": v, "note": note if v is not None else missing}

    metrics = [
        metric("holdout_object_f1", f"物体単位 F1（評価用・{yr}）", ("holdout", "object"), ("f1",),
               f"{held}。IoU 0.5 以上の 1 対 1 対応。タイルの縁に接する物体は除く"),
        metric("holdout_object_precision", f"建物の抽出の適合率・物体単位（評価用・{yr}）", ("holdout", "object"), ("precision",), held),
        metric("holdout_object_recall", f"建物の抽出の再現率・物体単位（評価用・{yr}。基盤地図情報に対する値）", ("holdout", "object"), ("recall",), held),
        metric("holdout_pixel_iou", f"画素 IoU（評価用・{yr}）", ("holdout", "pixel"), ("iou",), held),
        metric("holdout_pixel_f1", f"画素 F1（評価用・{yr}）", ("holdout", "pixel"), ("f1",), held),
        metric("tune_object_f1", f"物体単位 F1（調整用・{yr}）", ("tune", "object"), ("f1",),
               f"{tuned}。倍率と閾値を選ぶのに使ったので、参考値"),
    ]
    metrics.append({
        "key": "new_building_recall",
        "label": "新築の再現率",
        "value": _first_present(body, (), ("new_building_recall",)),
        "note": "未測定（手ラベルが無いため）。建物の抽出の再現率とは別の値" if body.get("new_building_recall") is None else "手ラベルによる値",
    })
    chosen = body.get("chosen") if isinstance(body.get("chosen"), dict) else {}
    for k, label in (("scale", "選んだ倍率"), ("threshold", "選んだ閾値")):
        v = chosen.get(k)
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            metrics.append({"key": f"chosen_{k}", "label": label, "value": float(v), "note": "調整用の地区だけで選んだ値"})
    return {
        "type": "accuracy",
        "title": "このアプリの精度（建物抽出の実測）",
        "metrics": metrics,
        "provenance": ctx.provenance(
            source=SOURCE_ACCURACY,
            photo_years=[year],
            metric="物体単位 F1・画素 IoU",
            note=f"数字は {year} 年の写真で測った値。新築の再現率は手ラベルが無く未測定。分類の閾値は未検証の初期値。",
        ),
    }


def show_help(ctx: ToolContext, args: dict) -> dict:
    examples = [
        ("新規出現の候補は何件ありますか？", "件数と分類ごとの内訳"),
        ("地区ごとに候補数を比べてください", "地区の比較"),
        ("面積の大きい候補を一覧で見せてください", "候補の一覧（表）"),
        ("一番大きい新規出現の写真を見せてください", "2018 年と 2023 年の写真の見比べ"),
        ("その地図での位置は？", "地図で場所を示す"),
        ("このアプリの精度は？", "実測した精度の数字"),
    ]
    return {
        "type": "table",
        "title": "このアプリでできること（聞き方の例）",
        "columns": [{"key": "example", "label": "聞き方の例"}, {"key": "result", "label": "返ってくるもの"}],
        "rows": [{"example": q, "result": r} for q, r in examples],
        "total": len(examples),
        "shown": len(examples),
        "provenance": ctx.provenance(note="結果はすべて、写真から機械が見つけた候補です。"),
    }


def refuse(ctx: ToolContext, args: dict) -> dict:
    reason = args.get("reason")
    if reason not in REFUSAL_REASONS:
        reason = "out_of_scope"
    return refusal(reason, str(args.get("message") or "その質問には答えられません。"), args.get("suggestions"))


_AREA_PROPS = {
    "area_ids": {"type": "array", "items": {"type": "string"}, "description": "地区の id（z18-x-y）の配列。省略すると全地区"},
    "ward": {"type": "string", "description": "区名（中央区・東区・西区・南区・北区）。area_ids の代わりに使える"},
    "wards": {"type": "array", "items": {"type": "string"}, "description": "区名の配列（2 つ以上の区をまとめて見るとき）。その区の地区の和集合"},
}
_CLS_PROP = {"type": "string", "enum": list(CLASS_KEYS), "description": "分類。省略すると全分類"}


def build_default_registry() -> ToolRegistry:
    r = ToolRegistry()
    r.register(Tool("count_candidates", "新規出現候補の件数（分類ごとの内訳つき）を返す",
                    {"type": "object", "properties": {**_AREA_PROPS, "cls": _CLS_PROP}}, count_candidates))
    r.register(Tool("list_candidates", "候補を面積の大きい順に表で返す",
                    {"type": "object", "properties": {**_AREA_PROPS, "cls": _CLS_PROP,
                                                      "limit": {"type": "integer", "minimum": 1, "maximum": MAX_LIST_LIMIT}}},
                    list_candidates))
    r.register(Tool("compare_areas", "地区ごとの候補数を比べる",
                    {"type": "object", "properties": {**_AREA_PROPS, "cls": _CLS_PROP}}, compare_areas))
    r.register(Tool("show_candidate", "候補 1 棟の 2018・2023 年の写真（輪郭つき）を返す。id を省略すると条件に合う最大の候補",
                    {"type": "object", "properties": {"candidate_id": {"type": "string"}, **_AREA_PROPS, "cls": _CLS_PROP}},
                    show_candidate))
    r.register(Tool("get_accuracy", "実測した建物抽出の精度（評価用・調整用）を返す",
                    {"type": "object", "properties": {}}, get_accuracy))
    r.register(Tool("focus_map", "地図を地区・候補に合わせる",
                    {"type": "object", "properties": {"candidate_id": {"type": "string"}, **_AREA_PROPS, "cls": _CLS_PROP}},
                    focus_map))
    r.register(Tool("show_help", "このアプリでできることと、聞き方の例を返す",
                    {"type": "object", "properties": {}}, show_help))
    r.register(Tool("refuse", "範囲外の質問を断る",
                    {"type": "object", "properties": {"reason": {"type": "string", "enum": list(REFUSAL_REASONS)},
                                                      "message": {"type": "string"}}, "required": ["reason"]},
                    refuse))
    return r
