"""Colab の出力（data/townscan/<run>/colab）の読み込み。

meta は meta.json があればそれ、無ければ meta_setup.json と meta_infer.json（推論スクリプトが書くもの）を合わせたもの。
タイルの並び順（評価の前半・後半の分け方に使う）は、meta の tiles の初出順 → <run>/tiles.json → prob ファイル名の順、の優先で決める。
確率の配列: prob_{year}_{x}_{y}_s{100|150|200}.npy（float16。256×倍率 の正方形）。
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import numpy as np

from . import tilemath

SCALES = (1.0, 1.5, 2.0)
YEARS = (2018, 2023)
_PROB_RE = re.compile(r"^prob_(\d{4})_(\d+)_(\d+)_s(\d+)\.npy$")
_STR_TILE_RE = re.compile(r"^(?:z(\d+)-)?(\d+)[-_](\d+)$")


def scale_key(scale: float) -> str:
    return f"s{int(round(scale * 100))}"


def prob_path(colab_dir, year: int, x: int, y: int, scale: float) -> Path:
    return Path(colab_dir) / f"prob_{year}_{x}_{y}_{scale_key(scale)}.npy"


def load_prob(colab_dir, year: int, x: int, y: int, scale: float) -> np.ndarray:
    """確率の配列（float32、(H, W)）。大きさが 256×倍率 でなければ ValueError。"""
    a = np.load(prob_path(colab_dir, year, x, y, scale), allow_pickle=False)
    expect = int(round(tilemath.TILE_SIZE_PX * scale))
    if a.ndim != 2 or a.shape != (expect, expect):
        raise ValueError(f"配列の大きさが違う: {a.shape}（期待 {expect}×{expect}）year={year} x={x} y={y} scale={scale}")
    return a.astype(np.float32)


def has_all_probs(colab_dir, years, x: int, y: int, scales) -> bool:
    return all(prob_path(colab_dir, yr, x, y, s).exists() for yr in years for s in scales)


def _read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def read_meta(colab_dir) -> dict:
    """meta.json（無ければ meta_setup.json + meta_infer.json）を辞書で返す。どれも無ければ空。"""
    colab_dir = Path(colab_dir)
    meta: dict = {}
    for name in ("meta_setup.json", "meta_infer.json", "meta.json"):
        part = _read_json(colab_dir / name)
        if isinstance(part, dict):
            meta.update(part)
    return meta


def model_name(meta: dict) -> str:
    m = meta.get("model")
    if isinstance(m, str) and m:
        return m
    if isinstance(m, dict):
        for k in ("name", "id", "repo"):
            if isinstance(m.get(k), str) and m[k]:
                return m[k]
    return "unknown"


def colab_summary(meta: dict) -> dict:
    """run.json の params に残す、Colab の記録（タイルの一覧・取得ログは除く）。"""
    drop = {"tiles", "fetch_log"}
    return {k: v for k, v in meta.items() if k not in drop}


def _parse_tile(entry, default_z: int = tilemath.DEFAULT_Z):
    """tiles の 1 要素 → (z, x, y)。年ごとの記録（{year, x, y, ...}）・タイル辞書・[x, y]・"z18-x-y" を受ける。"""
    try:
        if isinstance(entry, dict):
            return int(entry.get("z", default_z)), int(entry["x"]), int(entry["y"])
        if isinstance(entry, str):
            m = _STR_TILE_RE.match(entry.strip())
            if m:
                return int(m.group(1) or default_z), int(m.group(2)), int(m.group(3))
            return None
        if isinstance(entry, (list, tuple)) and len(entry) == 2:
            return default_z, int(entry[0]), int(entry[1])
        if isinstance(entry, (list, tuple)) and len(entry) == 3:
            return int(entry[0]), int(entry[1]), int(entry[2])
    except (KeyError, TypeError, ValueError):
        return None
    return None


def _unique_in_order(entries) -> list[tuple[int, int, int]]:
    seen, out = set(), []
    for e in entries or []:
        t = _parse_tile(e)
        if t and t not in seen:
            seen.add(t)
            out.append(t)
    return out


def read_tiles(colab_dir, run_dir=None) -> list[tuple[int, int, int]]:
    """処理するタイル (z, x, y) の一覧（並び順に意味がある）。"""
    colab_dir = Path(colab_dir)
    run_dir = Path(run_dir) if run_dir else colab_dir.parent
    meta = read_meta(colab_dir)
    tiles = _unique_in_order(meta.get("tiles"))
    if tiles:
        return tiles
    listed = _read_json(run_dir / "tiles.json")
    tiles = _unique_in_order(listed if isinstance(listed, list) else None)
    if tiles:
        return tiles
    found = []
    for p in sorted(colab_dir.glob("prob_*.npy")):
        m = _PROB_RE.match(p.name)
        if m:
            found.append((tilemath.DEFAULT_Z, int(m.group(2)), int(m.group(3))))
    return sorted(set(found), key=lambda t: (t[2], t[1]))
