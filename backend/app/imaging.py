"""候補の写真の切り出し。地理院の z18 タイル（256x256）から、候補の外接矩形＋余白を切り出して輪郭を描く。

安全のための決まり（テストで確かめる）:
  - year は許可リスト（2018・2023）だけ。タイルのパスは、DB の整数 x・y と許可済みの year からだけ作る。
  - 解決したパス（シンボリックリンクを辿った先）が TILES_DIR の外なら、読まない。
  - 切り出しはタイルの外へ出ない（正方形のまま、タイルの内側へずらす）。
"""

from __future__ import annotations

import io
import math
from pathlib import Path

from PIL import Image, ImageDraw

YEARS = (2018, 2023)
TILE_Z = 18
MARGIN_M = 20.0
MIN_SIDE_PX = 32  # 小さい候補でも、周囲が分かる大きさにする（z18 の約 19 m）
MIN_SIZE = 64
MAX_SIZE = 1024
DEFAULT_SIZE = 512

# 輪郭の色と線種（色だけに頼らない）
CLASS_STYLE = {
    "confirmed_new": {"color": (230, 70, 30), "dash": None},  # 実線
    "existing_omission": {"color": (30, 110, 230), "dash": (14, 7)},  # 破線
    "uncertain": {"color": (245, 190, 0), "dash": (3, 7)},  # 点線
}
_M_PER_DEG_LAT = 111_320.0


class TileUnavailable(Exception):
    """タイルが無い・読めない・許可された場所の外。呼び出し側は 404 にする。"""


def tile_file(tiles_dir: Path, year: int, x: int, y: int) -> Path:
    """タイルのパス。year・x・y を検証し、TILES_DIR の外を指すものは拒否する。"""
    if isinstance(year, bool) or year not in YEARS:
        raise TileUnavailable("対応していない年です")
    limit = 2**TILE_Z
    if any(isinstance(v, bool) or not isinstance(v, int) or not 0 <= v < limit for v in (x, y)):
        raise TileUnavailable("タイル番号が不正です")
    base = Path(tiles_dir).resolve()
    path = (base / str(year) / f"{x}_{y}.png").resolve()
    if not path.is_relative_to(base):
        raise TileUnavailable("許可された場所の外です")
    if not path.is_file():
        raise TileUnavailable("この年の写真がありません")
    return path


def lonlat_to_tile_px(lon: float, lat: float, x: int, y: int, tile_px: int = 256, z: int = TILE_Z) -> tuple[float, float]:
    """lon/lat を、タイル (z, x, y) の中のピクセル座標（左上が原点。範囲外の値にもなりうる）にする。"""
    n = 2**z
    fx = (lon + 180.0) / 360.0 * n
    lat_rad = math.radians(lat)
    fy = (1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n
    return (fx - x) * tile_px, (fy - y) * tile_px


def crop_box(bbox: list[float], x: int, y: int, tile_px: int = 256, margin_m: float = MARGIN_M) -> tuple[int, int, int, int]:
    """bbox（[西, 南, 東, 北]）＋余白を覆う、タイル内の正方形 (left, top, right, bottom)。"""
    w, s, e, n = bbox
    lat_c = (s + n) / 2.0
    d_lat = margin_m / _M_PER_DEG_LAT
    d_lon = margin_m / (_M_PER_DEG_LAT * max(math.cos(math.radians(lat_c)), 1e-6))
    x0, y0 = lonlat_to_tile_px(w - d_lon, n + d_lat, x, y, tile_px)
    x1, y1 = lonlat_to_tile_px(e + d_lon, s - d_lat, x, y, tile_px)
    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    scale = tile_px / 256
    side = min(max(abs(x1 - x0), abs(y1 - y0), MIN_SIDE_PX * scale), float(tile_px))
    left = min(max(cx - side / 2.0, 0.0), tile_px - side)
    top = min(max(cy - side / 2.0, 0.0), tile_px - side)
    l, t = int(math.floor(left)), int(math.floor(top))
    r, b = min(tile_px, int(math.ceil(left + side))), min(tile_px, int(math.ceil(top + side)))
    return l, t, r, b


def _dashed(draw: ImageDraw.ImageDraw, pts: list[tuple[float, float]], color, width: int, dash: tuple[int, int] | None) -> None:
    if dash is None:
        draw.line(pts, fill=color, width=width, joint="curve")
        return
    on, off = dash
    phase, drawing = 0.0, True
    for (ax, ay), (bx, by) in zip(pts, pts[1:]):
        seg = math.hypot(bx - ax, by - ay)
        if seg == 0:
            continue
        pos = 0.0
        while pos < seg:
            span = min((on if drawing else off) - phase, seg - pos)
            if drawing:
                p0 = (ax + (bx - ax) * pos / seg, ay + (by - ay) * pos / seg)
                p1 = (ax + (bx - ax) * (pos + span) / seg, ay + (by - ay) * (pos + span) / seg)
                draw.line([p0, p1], fill=color, width=width)
            pos += span
            phase += span
            if phase >= (on if drawing else off) - 1e-9:
                drawing, phase = not drawing, 0.0


def render_candidate_image(tile_path: Path, x: int, y: int, bbox: list[float], geometry: dict, cls: str, size: int) -> bytes:
    """切り出した写真（size x size の PNG）に、候補の輪郭を描く。"""
    try:
        with Image.open(tile_path) as src:
            tile = src.convert("RGB")
    except (OSError, Image.DecompressionBombError) as exc:
        raise TileUnavailable("写真を読めません") from exc
    tile_px = tile.width
    left, top, right, bottom = crop_box(bbox, x, y, tile_px)
    crop = tile.crop((left, top, right, bottom)).resize((size, size), Image.Resampling.BICUBIC)

    draw = ImageDraw.Draw(crop)
    style = CLASS_STYLE.get(cls, CLASS_STYLE["uncertain"])
    sx, sy = size / (right - left), size / (bottom - top)
    for ring in geometry.get("coordinates", [])[:1]:  # 外周だけ
        pts = []
        for lon, lat in ring:
            px, py = lonlat_to_tile_px(lon, lat, x, y, tile_px)
            pts.append(((px - left) * sx, (py - top) * sy))
        if len(pts) >= 2:
            draw.line(pts, fill=(255, 255, 255), width=7, joint="curve")  # 白い縁取り（暗い写真でも見える）
            _dashed(draw, pts, style["color"], 4, style["dash"])

    out = io.BytesIO()
    crop.save(out, format="PNG")
    return out.getvalue()
