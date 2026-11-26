"""FOTBCD（前後 2 時点の空中写真と、建物の枠の組）の読み込み（仕様 §6.1。データの条件は ADR 0015）。

tar を展開せずに JSON だけを読む（画像の中身は読まない）。枠の座標は、組の中の地上の m（左上が原点。x は右、y は下）に直す。
形が違うものは、読み飛ばさずに ValueError にする（数が黙って減ると、指標が変わる）。
"""

from __future__ import annotations

import json
import math
import re
import tarfile
from dataclasses import dataclass

from shapely import affinity
from shapely.geometry import Polygon

from . import geo

SIZE_PX = 512
GSD_M = 0.2
PATCH_M = SIZE_PX * GSD_M  # 102.4 m
EPSG = 2154
LABELS = ("UNCHANGED", "DEMOLISHED", "NEW")
SIDES = ("before", "after")
SIDE_LABELS = {"before": ("UNCHANGED", "DEMOLISHED"), "after": ("UNCHANGED", "NEW")}  # その写真に写る建物
EDGE_TOL_PX = 1e-6  # 枠は組の端でちょうど 0 か 512 に切られている（座標の丸めの誤差だけを許す）
_MEMBER_RE = re.compile(r"^(\d{9})\.(before\.png|after\.png|json)$")
_PARTS = ("before.png", "after.png", "json")


@dataclass(frozen=True)
class Footprint:
    label: str
    geom: object  # shapely の Polygon / MultiPolygon（組の中の m）
    edge_touch: bool


@dataclass(frozen=True)
class Pair:
    key: str  # tar の中の番号（9 桁）
    dep: str  # 県
    before_year: str
    after_year: str
    footprints: tuple[Footprint, ...]

    def refs(self, side: str) -> list[Footprint]:
        """その側の写真に写る建物の枠。"""
        return [f for f in self.footprints if f.label in SIDE_LABELS[side]]


def _footprint(annotation: dict, names: dict) -> Footprint:
    label = names[annotation["category_id"]]
    rings = annotation["segmentation"]
    if not isinstance(rings, list) or len(rings) != 1:
        raise ValueError("segmentation は輪が 1 本のリストであること")
    ring = rings[0]
    if len(ring) < 6 or len(ring) % 2:
        raise ValueError(f"輪の座標の数が違う: {len(ring)}")
    if not all(math.isfinite(v) and -EDGE_TOL_PX <= v <= SIZE_PX + EDGE_TOL_PX for v in ring):
        raise ValueError("輪の座標が 0〜512 の外")
    polygon = geo.polygonal(Polygon(zip(ring[0::2], ring[1::2])))
    if polygon is None:
        raise ValueError("面積の無い枠")
    minx, miny, maxx, maxy = polygon.bounds
    edge = minx <= EDGE_TOL_PX or miny <= EDGE_TOL_PX or maxx >= SIZE_PX - EDGE_TOL_PX or maxy >= SIZE_PX - EDGE_TOL_PX
    return Footprint(label, affinity.scale(polygon, GSD_M, GSD_M, origin=(0, 0)), bool(edge))


def parse_pair(key: str, doc: dict) -> Pair:
    """1 組の JSON → Pair。形が違えば、組の番号を付けた ValueError。"""
    try:
        image = doc["image"]
        if (image["width"], image["height"], image["epsg"]) != (SIZE_PX, SIZE_PX, EPSG):
            raise ValueError(f"画像の大きさか座標系が違う: {image['width']}×{image['height']} EPSG:{image['epsg']}")
        b = image["patch_bounds"]
        if any(abs(side - PATCH_M) > 0.01 for side in (b["maxx"] - b["minx"], b["maxy"] - b["miny"])):
            raise ValueError(f"範囲が {PATCH_M} m 四方でない: {b}")
        names = {c["id"]: c["name"] for c in doc["categories"]}
        unknown = sorted(set(names.values()) - set(LABELS))
        if unknown:
            raise ValueError(f"知らない分類: {unknown}")
        return Pair(
            key=key,
            dep=str(image["dep"]),
            before_year=str(image["before_year"]),
            after_year=str(image["after_year"]),
            footprints=tuple(_footprint(a, names) for a in doc["annotations"]),
        )
    except (KeyError, TypeError, ValueError) as e:
        raise ValueError(f"FOTBCD の組 {key} を読めない: {type(e).__name__}: {e}") from e


def read_pairs(tar_path) -> list[Pair]:
    """tar の全部の組を、番号の順で返す。1 組は before.png・after.png・json の 3 つ。"""
    parts: dict[str, set[str]] = {}
    pairs: dict[str, Pair] = {}
    with tarfile.open(tar_path, "r:") as tf:
        for member in tf:
            if member.isdir():
                continue
            m = _MEMBER_RE.match(member.name)
            if not member.isfile() or not m:
                raise ValueError(f"FOTBCD の tar に、想定しないものがある: {member.name!r}")
            key, part = m.groups()
            if part in parts.setdefault(key, set()):
                raise ValueError(f"同じ名前が 2 回ある: {member.name}")
            parts[key].add(part)
            if part == "json":
                pairs[key] = parse_pair(key, json.load(tf.extractfile(member)))
    incomplete = sorted(k for k, v in parts.items() if v != set(_PARTS))
    if incomplete:
        raise ValueError(f"3 つがそろわない組が {len(incomplete)} 件: {', '.join(incomplete[:5])}")
    if not pairs:
        raise ValueError(f"組が 1 つも無い: {tar_path}")
    return [pairs[k] for k in sorted(pairs)]
