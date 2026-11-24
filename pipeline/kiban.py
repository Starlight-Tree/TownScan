"""基盤地図情報（FG-GML）の BldA（建築物）を読む。依存は標準ライブラリと numpy・shapely だけ。

XML パーサーを使わず、`<BldA ...>〜</BldA>` の塊を順に切り出し、正規表現で輪（posList）を取る。理由: 1 ファイルが 90 MB 級で、
全体を木にすると Docker VM のメモリー（空き約 0.5 GB）に収まらないため。ファイルは塊ごとに読み、範囲（bbox）に入るものだけを残す。
座標は「緯度 経度」の順（JGD2011。posList の並び）。出力は shapely（経度, 緯度）。
壊れた塊（数値でない・点が足りない・範囲外の座標）は、止めずに数えて飛ばす（LoadStats）。
"""

from __future__ import annotations

import codecs
import glob
import os
import re
from collections import Counter
from dataclasses import dataclass, field
from collections.abc import Iterable, Iterator

import numpy as np
from shapely.geometry import Polygon

from . import geo

_START = "<BldA "
_END = "</BldA>"
_ID_RE = re.compile(r'gml:id="([^"]*)"')
_FID_RE = re.compile(r"<fid>([^<]*)</fid>")
_TYPE_RE = re.compile(r"<type>([^<]*)</type>")
_LF_SPAN_FR_RE = re.compile(r"<lfSpanFr[^>]*>\s*<gml:timePosition>([^<]*)</gml:timePosition>")
_DEV_DATE_RE = re.compile(r"<devDate[^>]*>\s*<gml:timePosition>([^<]*)</gml:timePosition>")
_EXTERIOR_RE = re.compile(r"<gml:exterior>(.*?)</gml:exterior>", re.S)
_INTERIOR_RE = re.compile(r"<gml:interior>(.*?)</gml:interior>", re.S)
_POSLIST_RE = re.compile(r"<gml:posList[^>]*>([^<]*)</gml:posList>", re.S)


NO_VALUE = "(無し)"


@dataclass
class KibanBuilding:
    gml_id: str
    fid: str
    type: str
    geometry: Polygon  # lon/lat
    lf_span_from: str = ""  # <lfSpanFr> の日付（無ければ ""）。版の素性を確かめるために読む
    dev_date: str = ""  # <devDate> の日付（無ければ ""）


@dataclass
class LoadStats:
    blocks: int = 0  # 読んだ <BldA> の塊の数
    parsed: int = 0
    kept: int = 0  # bbox に入って返した数
    skipped: Counter = field(default_factory=Counter)  # 理由 → 数
    # 返した建物（kept）の版の素性。属性 → 値 → 棟数。値が無いものは "(無し)"
    vintage: dict = field(default_factory=lambda: {"gml_id_prefix": Counter(), "lf_span_from": Counter(), "dev_date": Counter()})

    def as_dict(self) -> dict:
        return {"blocks": self.blocks, "parsed": self.parsed, "kept": self.kept, "skipped": dict(self.skipped)}

    def vintage_dict(self) -> dict:
        """返した建物の版の素性（属性 → {値: 棟数}。多い順）。as_dict とは別（run.json の形を変えないため）。"""
        return {k: dict(c.most_common()) for k, c in self.vintage.items()}

    def count_vintage(self, b: "KibanBuilding") -> None:
        prefix = b.gml_id.split("_", 1)[0] if "_" in b.gml_id else ""  # gml:id は K17_<メッシュ><連番>_<番号> の形。接頭辞だけ数える
        for key, value in (("gml_id_prefix", prefix), ("lf_span_from", b.lf_span_from), ("dev_date", b.dev_date)):
            self.vintage[key][value or NO_VALUE] += 1


def find_xml_files(source) -> list[str]:
    """フォルダ（または 1 つのファイル・ファイルのリスト）から BldA の XML を探す。メタデータ（fmdid*.xml）は除く。"""
    if isinstance(source, (list, tuple)):
        return [str(p) for p in source]
    source = str(source)
    if os.path.isfile(source):
        return [source]
    files = sorted(glob.glob(os.path.join(source, "*BldA*.xml")))
    if not files:
        files = sorted(glob.glob(os.path.join(source, "**", "*BldA*.xml"), recursive=True))
    return files


def iter_blocks(path: str, chunk_size: int = 1 << 22) -> Iterator[str]:
    """ファイルを chunk_size バイトずつ読み、<BldA ...>〜</BldA> の塊を 1 つずつ返す（塊が境界をまたいでもよい）。"""
    decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
    buf = ""
    with open(path, "rb") as f:
        while True:
            raw = f.read(chunk_size)
            buf += decoder.decode(raw, final=not raw)
            while True:
                start = buf.find(_START)
                if start < 0:
                    buf = buf[-(len(_START) - 1) :]  # 開始タグが境界で割れている場合に備える
                    break
                end = buf.find(_END, start)
                if end < 0:
                    buf = buf[start:]
                    break
                end += len(_END)
                yield buf[start:end]
                buf = buf[end:]
            if not raw:
                return


def _parse_ring(pos_text: str):
    """posList の文字列 → (経度, 緯度) の配列 (N, 2)。壊れていれば ValueError。"""
    try:
        nums = np.array(pos_text.split(), dtype=float)
    except ValueError:
        raise ValueError("数値でない") from None
    if nums.size == 0 or nums.size % 2:
        raise ValueError("座標の数が偶数でない")
    if not np.all(np.isfinite(nums)):
        raise ValueError("数値でない")
    lat, lon = nums[0::2], nums[1::2]
    if not (np.all(np.abs(lat) <= 90) and np.all(np.abs(lon) <= 180)):
        raise ValueError("緯度・経度の範囲外")
    return np.column_stack([lon, lat])


def _ring_from(section: str):
    """exterior / interior の中身（posList が複数あれば、つないで 1 つの輪にする）。"""
    pieces = [_parse_ring(t) for t in _POSLIST_RE.findall(section)]
    if not pieces:
        raise ValueError("posList が無い")
    ring = pieces[0]
    for nxt in pieces[1:]:
        ring = np.vstack([ring, nxt[1:] if np.allclose(ring[-1], nxt[0]) else nxt])
    if len(ring) < 3 or len(np.unique(ring, axis=0)) < 3:
        raise ValueError("点が足りない")
    return ring


def parse_block(block: str) -> KibanBuilding:
    """<BldA> の塊 1 つ → KibanBuilding。壊れていれば ValueError（理由つき）。"""
    ext = _EXTERIOR_RE.search(block)
    if not ext:
        raise ValueError("exterior が無い")
    shell = _ring_from(ext.group(1))
    holes = []
    for m in _INTERIOR_RE.finditer(block):
        try:
            holes.append(_ring_from(m.group(1)))
        except ValueError:
            continue  # 壊れた穴は無視する（外形は生かす）
    poly = Polygon(shell, holes)
    fixed = geo.polygonal(poly)
    if fixed is None:
        raise ValueError("面積が 0")
    geom = geo.largest_polygon(fixed)
    gid = _ID_RE.search(block)
    fid = _FID_RE.search(block)
    typ = _TYPE_RE.search(block)
    lf = _LF_SPAN_FR_RE.search(block)
    dev = _DEV_DATE_RE.search(block)
    return KibanBuilding(
        gml_id=gid.group(1) if gid else "",
        fid=fid.group(1).strip() if fid else "",
        type=typ.group(1).strip() if typ else "",
        geometry=geom,
        lf_span_from=lf.group(1).strip() if lf else "",
        dev_date=dev.group(1).strip() if dev else "",
    )


def iter_buildings(
    source, bbox: tuple[float, float, float, float] | None = None, *, stats: LoadStats | None = None, chunk_size: int = 1 << 22
) -> Iterator[KibanBuilding]:
    """建物を 1 棟ずつ返す。bbox = (west, south, east, north)（lon/lat）。建物の外接矩形が重なるものだけを返す。"""
    stats = stats if stats is not None else LoadStats()
    for path in find_xml_files(source):
        for block in iter_blocks(path, chunk_size):
            stats.blocks += 1
            try:
                b = parse_block(block)
            except ValueError as e:
                stats.skipped[str(e)] += 1
                continue
            stats.parsed += 1
            if bbox is not None:
                minx, miny, maxx, maxy = b.geometry.bounds
                if maxx < bbox[0] or minx > bbox[2] or maxy < bbox[1] or miny > bbox[3]:
                    continue
            stats.kept += 1
            stats.count_vintage(b)
            yield b


def load_buildings(source, bbox=None, *, stats: LoadStats | None = None, chunk_size: int = 1 << 22) -> list[KibanBuilding]:
    return list(iter_buildings(source, bbox, stats=stats, chunk_size=chunk_size))


def union_bbox(bboxes: Iterable[tuple[float, float, float, float]], pad: float = 0.0) -> tuple[float, float, float, float]:
    """複数の bbox を囲む bbox（pad 度だけ広げる）。"""
    bs = list(bboxes)
    if not bs:
        raise ValueError("bbox が空")
    return (min(b[0] for b in bs) - pad, min(b[1] for b in bs) - pad, max(b[2] for b in bs) + pad, max(b[3] for b in bs) + pad)
