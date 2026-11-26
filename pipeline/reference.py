"""評価の正解にする建物の読み込み（GeoJSON の FeatureCollection。座標は経度・緯度）。

地物 1 つを建物 1 棟にする。MultiPolygon は、面積が最大の面だけを使う。
壊れた地物（読めない・面でない・面積が 0・経度緯度の範囲外）は、止めずに数えて飛ばす（LoadStats）。
投影座標（m）のままのデータは、全部が範囲外になって 1 棟も返らない（呼び出し側が止める）。
"""

from __future__ import annotations

import json
from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import shapely
from shapely.geometry import Polygon, shape

from . import geo


@dataclass
class LoadStats:
    features: int = 0  # 読んだ地物の数
    kept: int = 0  # bbox に入って返した数
    skipped: Counter = field(default_factory=Counter)  # 理由 → 数

    def as_dict(self) -> dict:
        return {"features": self.features, "kept": self.kept, "skipped": dict(self.skipped)}


def _building(feature) -> Polygon:
    """地物 1 つ → 建物の面。使えなければ ValueError（理由つき）。"""
    try:
        geom = shape(feature["geometry"])
    except Exception as e:  # 壊れ方はさまざま（項目が無い・型が違う・座標が足りない）
        raise ValueError("geometry を読めない") from e
    if geom.geom_type not in ("Polygon", "MultiPolygon"):
        raise ValueError("面でない")
    if geom.is_empty:
        raise ValueError("面積が 0")
    west, south, east, north = geom.bounds
    # bounds は途中の NaN を無視するので、座標が全部有限の数かを別に確かめる
    if not (np.isfinite(shapely.get_coordinates(geom)).all() and -180 <= west <= east <= 180 and -90 <= south <= north <= 90):
        raise ValueError("経度・緯度の範囲外")
    fixed = geo.polygonal(geom)
    if fixed is None:
        raise ValueError("面積が 0")
    return geo.largest_polygon(fixed)


def load_buildings(path, bbox: tuple[float, float, float, float] | None = None, *, stats: LoadStats | None = None) -> list[Polygon]:
    """建物の面の一覧。bbox = (west, south, east, north) を渡すと、外接矩形が重なるものだけを返す。"""
    stats = stats if stats is not None else LoadStats()
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except ValueError as e:
        raise ValueError(f"正解の建物データを JSON として読めない: {path}") from e
    features = data.get("features") if isinstance(data, dict) else None
    if not isinstance(features, list):
        raise ValueError(f"正解の建物データが GeoJSON の FeatureCollection でない: {path}")
    out = []
    for feature in features:
        stats.features += 1
        try:
            poly = _building(feature)
        except ValueError as e:
            stats.skipped[str(e)] += 1
            continue
        if bbox is not None:
            west, south, east, north = poly.bounds
            if east < bbox[0] or west > bbox[2] or north < bbox[1] or south > bbox[3]:
                continue
        stats.kept += 1
        out.append(poly)
    return out


def union_bbox(bboxes: Iterable[tuple[float, float, float, float]], pad: float = 0.0) -> tuple[float, float, float, float]:
    """複数の bbox を囲む bbox（pad 度だけ広げる）。"""
    bs = list(bboxes)
    if not bs:
        raise ValueError("bbox が空")
    return (min(b[0] for b in bs) - pad, min(b[1] for b in bs) - pad, max(b[2] for b in bs) + pad, max(b[3] for b in bs) + pad)
