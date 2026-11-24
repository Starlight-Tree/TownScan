"""2 時点の差分と 3 分類（仕様 §5）。

入口: 2023 年の建物の塊 c のうち、基盤地図情報（2018-10 版）に載っていないもの（ov_kiban < kiban_ov_max）。
  面積が min_area_m2 未満は捨てる。次に、タイルの縁に接するものは uncertain（reason=edge）。
  それ以外は 2018 年の確率で確かめる:
    existing_omission : ov_2018 >= omission_ov_2018_min（旧写真に既にある。建物データの描き漏れ。モデルが両年で同じ誤検出をした場合も入る）
    confirmed_new     : ov_2018 <= new_ov_2018_max かつ prob_2018_p90 < new_p90_max（2018 のモデルが c の範囲に何も見ていない）
    uncertain         : 上のどちらでもない（reason=ambiguous）
閾値は未検証の初期値（手ラベルが無い）。run.json の params に残す。
根拠の数字は丸めた値で分類する（出力した evidence から分類を再現できるように）。
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from collections.abc import Sequence
from typing import NamedTuple

import numpy as np
from shapely.ops import unary_union

from . import geo, tilemath, vectorize

CLASS_NEW = "confirmed_new"
CLASS_OMISSION = "existing_omission"
CLASS_UNCERTAIN = "uncertain"
CLASSES = (CLASS_NEW, CLASS_OMISSION, CLASS_UNCERTAIN)
REASONS = ("new_absent_2018", "present_2018", "ambiguous", "edge", "small")

# 候補にならない（捨てる）理由。candidates.geojson には出ない
DROP_IN_KIBAN = "in_kiban"
DROP_SMALL = "small"


@dataclass(frozen=True)
class DiffParams:
    kiban_ov_max: float = 0.25  # ov_kiban がこれ未満なら、建物データに載っていないとみなす（入口）
    min_area_m2: float = 20.0  # これ未満は捨てる
    omission_ov_2018_min: float = 0.5  # ov_2018 がこれ以上 → existing_omission
    new_ov_2018_max: float = 0.10  # ov_2018 がこれ以下 かつ
    new_p90_max: float = 0.20  # prob_2018_p90 がこれ未満 → confirmed_new

    def to_dict(self) -> dict:
        return asdict(self)


class Decision(NamedTuple):
    cls: str | None  # None = 候補にしない
    reason: str


def classify(
    *,
    area_m2: float,
    ov_kiban: float,
    ov_2018: float,
    prob_2018_p90: float,
    edge_touch: bool,
    params: DiffParams = DiffParams(),
) -> Decision:
    """根拠の数字から分類を決める（純粋な関数）。cls が None のときは候補にしない（reason が捨てる理由）。"""
    if ov_kiban >= params.kiban_ov_max:
        return Decision(None, DROP_IN_KIBAN)
    if area_m2 < params.min_area_m2:
        return Decision(None, DROP_SMALL)
    if edge_touch:
        return Decision(CLASS_UNCERTAIN, "edge")
    if ov_2018 >= params.omission_ov_2018_min:
        return Decision(CLASS_OMISSION, "present_2018")
    if ov_2018 <= params.new_ov_2018_max and prob_2018_p90 < params.new_p90_max:
        return Decision(CLASS_NEW, "new_absent_2018")
    return Decision(CLASS_UNCERTAIN, "ambiguous")


def overlap_fraction(geom, cover) -> float:
    """geom の面積のうち、cover が覆う割合（0〜1）。同じ座標系のジオメトリを渡す。"""
    if cover is None or cover.is_empty or geom.is_empty or geom.area <= 0:
        return 0.0
    return float(min(1.0, geom.intersection(cover).area / geom.area))


def cover_of(geoms_6670: Sequence):
    """ジオメトリ群の和（なければ None）。壊れたものは直してから足す。"""
    fixed = [g for g in (geo.polygonal(g) for g in geoms_6670) if g is not None]
    return unary_union(fixed) if fixed else None


def evidence_vs_2018(geom_6670, geom_merc, cover_2018, prob_2018: np.ndarray, z: int, x: int, y: int) -> tuple[float, float]:
    """塊 1 つの、2018 年側の根拠 (ov_2018, prob_2018_p90)。丸めた値（分類はこの値で決める）。

    build_candidates と、評価の診断（既存の建物が 2018 年の抽出でどう見えるか）が同じ計算を使うために、ここに 1 つだけ置く。
    cover_2018 は cover_of(2018 年の建物の geom_6670)、prob_2018 は vectorize.as_prob_array を通した配列。
    """
    ov_2018 = round(overlap_fraction(geom_6670, cover_2018), 4)
    vals = vectorize.values_in_polygon_merc(prob_2018, geom_merc, z, x, y)
    p90 = round(float(np.percentile(vals, 90)), 4) if vals.size else 0.0
    return ov_2018, p90


def build_candidates(
    z: int,
    x: int,
    y: int,
    buildings_2023: Sequence[vectorize.Building],
    buildings_2018: Sequence[vectorize.Building],
    prob_2018: np.ndarray,
    kiban_lonlat: Sequence,
    params: DiffParams = DiffParams(),
) -> tuple[list[dict], dict]:
    """地区 1 つの候補。戻り値は (候補のリスト, 数え上げ)。候補は {"geometry": lon/lat のポリゴン, "properties": {...}}。

    id は number_candidates で振る。prob_2018 は 2018 年の確率の配列（建物を取り出した倍率と同じもの）。
    """
    cover_kiban = cover_of([geo.lonlat_to_6670_geom(g) for g in kiban_lonlat])
    cover_2018 = cover_of([b.geom_6670 for b in buildings_2018])
    p2018 = vectorize.as_prob_array(prob_2018)
    stats = {"buildings_2023": len(buildings_2023), "in_kiban": 0, "dropped_small": 0, "candidates": 0, **{c: 0 for c in CLASSES}}

    cands = []
    for b in buildings_2023:
        ov_kiban = round(overlap_fraction(b.geom_6670, cover_kiban), 4)
        ov_2018, p90 = evidence_vs_2018(b.geom_6670, b.geom_merc, cover_2018, p2018, z, x, y)
        area = round(b.area_m2, 2)
        d = classify(
            area_m2=area, ov_kiban=ov_kiban, ov_2018=ov_2018, prob_2018_p90=p90, edge_touch=b.edge_touch, params=params
        )
        if d.cls is None:
            stats["in_kiban" if d.reason == DROP_IN_KIBAN else "dropped_small"] += 1
            continue
        minx, miny, maxx, maxy = b.geom_lonlat.bounds
        c = b.geom_lonlat.centroid
        cands.append(
            {
                "geometry": b.geom_lonlat,
                "properties": {
                    "area_id": tilemath.area_id(z, x, y),
                    "class": d.cls,
                    "area_m2": area,
                    "bbox": [round(minx, 7), round(miny, 7), round(maxx, 7), round(maxy, 7)],
                    "centroid": [round(c.x, 7), round(c.y, 7)],
                    "evidence": {
                        "prob_2023_mean": round(b.prob_mean, 4),
                        "ov_2018": ov_2018,
                        "prob_2018_p90": p90,
                        "ov_kiban": ov_kiban,
                        "edge_touch": bool(b.edge_touch),
                    },
                    "reason": d.reason,
                },
            }
        )
        stats[d.cls] += 1
    stats["candidates"] = len(cands)
    return cands, stats


def number_candidates(x: int, y: int, cands: list[dict]) -> list[dict]:
    """面積の大きい順（同じなら位置の順）に並べ、id = c-{x}-{y}-{n}（n は 1 から）を振る。"""
    ordered = sorted(cands, key=lambda c: (-c["properties"]["area_m2"], *c["properties"]["centroid"]))
    for n, c in enumerate(ordered, start=1):
        c["id"] = f"c-{x}-{y}-{n}"
    return ordered
