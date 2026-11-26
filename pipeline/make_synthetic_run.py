"""合成データ（テスト用。kind="synthetic"）の入力と、期待どおりの out/ を作る。実データではない。

2 地区（名前は「合成地区A」「合成地区B」）に、建物らしい矩形を人工的に置く。矩形ごとに、2014・2024 年の確率・写真・正解の建物データへの
載り方を決め、3 分類の期待（truth.json）を残す。出力は仕様の契約どおりの形で、backend のローダー・画像切り出しのテストにも使える。
  <out>/tiles/{2014,2024}/{x}_{y}.png        合成の写真（256×256）
  <out>/reference/buildings.geojson           正解の建物データ（GeoJSON。座標は経度・緯度）
  <out>/<run>/colab/                          meta.json・prob_{year}_{x}_{y}_s{100|150|200}.npy
  <out>/<run>/geocode.json                    逆ジオコーダの応答の形（名前は合成と分かるもの）
  <out>/<run>/truth.json                      置いた矩形と、期待する分類
  <out>/<run>/out/                            run_postprocess の出力（run.json の kind は synthetic）
使い方: python -m pipeline.make_synthetic_run [出力先=data/townscan/synthetic] [--no-postprocess]
出力先に実データがあるときは、何も書かずに止まる（check_output_dir）。実データの置き場（data/townscan）そのものも指定できない。
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image

from . import colabio, run_postprocess, tilemath

Z = 18
# (x, y, 名前, 逆ジオコーダの応答の市町村コード)。タイル番号も市町村も、合成の値（写真・確率はすべて合成）
SYNTH_TILES = [(226250, 105770, "合成地区A", "92050"), (226251, 105770, "合成地区B", "92019")]
SEED = 20261124
REFERENCE_FILE = "buildings.geojson"
REFERENCE_MARK = "合成データ（テスト用）"  # 合成の GeoJSON にだけ入れる印。実データと取り違えて上書きしない
BLUR_PX = 2  # 倍率 1 での、確率の縁のぼかし（箱形。モデルの出力のなだらかさの代わり）


@dataclass
class Obj:
    """タイル（256 画素）の画素座標 rect = (x0, y0, x1, y1) に置く矩形。p18・p23 は確率の高さ（None = その年は何も無い）。"""

    name: str
    rect: tuple[int, int, int, int]
    p18: float | None
    p23: float | None
    photo18: bool  # 写真に建物が写っているか
    photo23: bool
    ref_shift: tuple[int, int] | None  # 正解の建物データに載る（ずらす画素数）。None = 載らない
    hole: tuple[int, int, int, int] | None = None
    expect: tuple[str, str] | None = None  # (class, reason)。None = 候補にならない
    role: str = ""


OBJS: dict[str, list[Obj]] = {
    "合成地区A": [
        Obj("A_b1", (30, 30, 60, 55), 0.9, 0.9, True, True, (0, 0), role="両年にあり、建物データにもある（候補にならない）"),
        Obj("A_b2", (100, 40, 130, 70), 0.9, 0.9, True, True, (0, 0), hole=(110, 50, 116, 56), role="中庭つき（穴の読み込みを通す）"),
        Obj("A_new", (160, 100, 190, 125), None, 0.9, False, True, None, expect=("confirmed_new", "new_absent_2014"), role="2024 年だけにある新築"),
        Obj("A_omit", (40, 150, 70, 180), 0.9, 0.9, True, True, None, expect=("existing_omission", "present_2014"), role="両年にあるが建物データに無い（描き漏れ）"),
        Obj("A_unc", (120, 170, 150, 200), 0.25, 0.9, False, True, None, expect=("uncertain", "ambiguous"), role="2014 年の確率が弱く出ている（判定保留）"),
        Obj("A_small", (200, 30, 206, 36), None, 0.9, False, True, None, expect=None, role="面積が 20 m² 未満（捨てる）"),
        Obj("A_edge", (228, 200, 256, 225), None, 0.9, False, True, None, expect=("uncertain", "edge"), role="タイルの縁に接する（右）"),
        Obj("A_gone", (200, 100, 225, 125), None, None, False, False, (0, 0), role="建物データにだけある（評価で取りこぼしになる）"),
    ],
    "合成地区B": [
        Obj("B_b1", (20, 20, 50, 60), 0.9, 0.9, True, True, (2, 1), role="建物データと少しずれている（それでも載っている）"),
        Obj("B_new1", (80, 100, 115, 140), None, 0.9, False, True, None, expect=("confirmed_new", "new_absent_2014"), role="2024 年だけにある（大きい）"),
        Obj("B_new2", (150, 150, 170, 170), None, 0.9, False, True, None, expect=("confirmed_new", "new_absent_2014"), role="2024 年だけにある（小さい）"),
        Obj("B_miss", (200, 200, 225, 225), 0.2, 0.2, True, True, (0, 0), role="モデルが見逃す建物（評価で取りこぼしになる）"),
        Obj("B_edge", (100, 0, 120, 18), 0.9, 0.9, True, True, None, expect=("uncertain", "edge"), role="両年にあり建物データに無いが、縁に接する"),
    ],
}


def _box_blur(a: np.ndarray, r: int) -> np.ndarray:
    if r <= 0:
        return a
    k = 2 * r + 1
    p = np.pad(a, r, mode="edge")
    c = np.vstack([np.zeros((1, p.shape[1])), np.cumsum(p, axis=0)])
    a = (c[k:] - c[:-k]) / k
    c = np.hstack([np.zeros((a.shape[0], 1)), np.cumsum(a, axis=1)])
    return (c[:, k:] - c[:, :-k]) / k


def _rect_mask(rect, n: int, scale: float) -> np.ndarray:
    x0, y0, x1, y1 = rect
    px = (np.arange(n) + 0.5) / scale  # 配列の画素の中心を、タイルの画素座標へ
    cols = (px >= x0) & (px < x1)
    rows = (px >= y0) & (px < y1)
    return np.outer(rows, cols)


def make_prob(objs: list[Obj], year: int, scale: float, rng: np.random.Generator) -> np.ndarray:
    n = int(round(tilemath.TILE_SIZE_PX * scale))
    field = np.zeros((n, n))
    for o in objs:
        v = o.p18 if year == 2014 else o.p23
        if v is None:
            continue
        m = _rect_mask(o.rect, n, scale)
        field[m] = np.maximum(field[m], v)
        if o.hole:
            field[_rect_mask(o.hole, n, scale)] = 0.0
    field = _box_blur(field, int(round(BLUR_PX * scale)))
    field = field + rng.uniform(0.0, 0.06, size=field.shape)
    return np.clip(field, 0.0, 1.0).astype(np.float16)


def make_photo(objs: list[Obj], year: int, rng: np.random.Generator) -> Image.Image:
    n = tilemath.TILE_SIZE_PX
    img = np.empty((n, n, 3), dtype=np.float64)
    img[:] = (112, 128, 96)
    img += rng.normal(0, 4, size=img.shape)
    for o in objs:
        if not (o.photo18 if year == 2014 else o.photo23):
            continue
        m = _rect_mask(o.rect, n, 1.0)
        img[m] = (176, 98, 78)
        if o.hole:
            img[_rect_mask(o.hole, n, 1.0)] = (112, 128, 96)
    return Image.fromarray(np.clip(img, 0, 255).astype(np.uint8), "RGB")


def _ring(z: int, x: int, y: int, rect, shift) -> list[list[float]]:
    x0, y0, x1, y1 = rect
    dx, dy = shift
    pts = [(x0 + dx, y0 + dy), (x1 + dx, y0 + dy), (x1 + dx, y1 + dy), (x0 + dx, y1 + dy), (x0 + dx, y0 + dy)]
    return [[round(float(v), 9) for v in tilemath.pixel_to_lonlat(z, x, y, col, row)] for col, row in pts]


def make_reference_geojson(tiles_objs: list[tuple[int, int, list[Obj]]]) -> str:
    """正解の建物データに載る建物だけを GeoJSON にする。中庭のある建物は、内側の輪（穴）を持つ。"""
    features = []
    for x, y, objs in tiles_objs:
        for o in objs:
            if o.ref_shift is None:
                continue
            rings = [_ring(Z, x, y, o.rect, o.ref_shift)]
            if o.hole:
                rings.append(_ring(Z, x, y, o.hole, o.ref_shift))
            features.append({"type": "Feature", "properties": {"id": f"synthetic-{len(features) + 1}"}, "geometry": {"type": "Polygon", "coordinates": rings}})
    # name を先頭に書く（上書きしてよいかの確認は、ファイルの先頭だけを読む）
    return json.dumps({"name": REFERENCE_MARK, "type": "FeatureCollection", "features": features}, ensure_ascii=False, indent=1) + "\n"


class UnsafeOutputError(ValueError):
    """出力先に実データ（または、合成と確かめられないもの）があるので、書かずに止める。"""


def _is_synthetic_meta(colab_dir: Path) -> bool:
    """colab/ の記録が合成のものだけか。meta.json が kind=synthetic で、実データの meta_setup.json・meta_infer.json が無い。"""
    names = sorted(p.name for p in colab_dir.glob("meta*.json"))
    if names != ["meta.json"]:
        return False
    try:
        meta = json.loads((colab_dir / "meta.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return isinstance(meta, dict) and meta.get("kind") == "synthetic"


def _is_own_reference_file(path: Path) -> bool:
    """この module が書く合成の GeoJSON か（名前と、先頭に入れた印で見る。実データは大きいことがあるので先頭だけ読む）。"""
    if path.name != REFERENCE_FILE:
        return False
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return REFERENCE_MARK in f.read(2000)
    except OSError:
        return False


def check_output_dir(root, run: str = "run1") -> None:
    """出力先を上書きしてよいか確かめる。だめなら UnsafeOutputError（何も書かない）。

    実データの置き場そのもの（data/townscan）は不可。それ以外でも、colab/・geocode.json・truth.json・合成以外の正解の建物データが
    既にあって、colab/ の記録が合成のもの（kind=synthetic）と確かめられなければ不可。空の場所と、前に合成で作った場所は可。
    """
    root = Path(root)
    if not run or Path(run).name != run or run in (".", ".."):
        raise UnsafeOutputError(f"run は単純なフォルダ名にする: {run!r}")
    if root.resolve() == run_postprocess.DEFAULT_DATA_ROOT.resolve():
        raise UnsafeOutputError(
            f"実データの置き場（{run_postprocess.DEFAULT_DATA_ROOT}）には作れない。別の出力先を指定する（既定は {run_postprocess.DEFAULT_DATA_ROOT / 'synthetic'}）"
        )
    run_dir = root / run
    colab_dir = run_dir / "colab"
    found: list[str] = []
    if not _is_synthetic_meta(colab_dir):
        found += [str(p) for p in (*colab_dir.glob("meta*.json"), *colab_dir.glob("prob_*.npy"))]
        found += [str(p) for p in (run_dir / "geocode.json", run_dir / "truth.json") if p.exists()]
        found += [str(p) for p in (root / "tiles").glob("*/*.png")]
    found += [str(f) for f in sorted((root / "reference").glob("*.geojson")) if not _is_own_reference_file(f)]
    if found:
        shown = ", ".join(found[:5]) + (f" ほか {len(found) - 5} 件" if len(found) > 5 else "")
        raise UnsafeOutputError(f"出力先 {root} に、合成と確かめられない既存のファイルがある（上書きしない）。別の出力先を指定する: {shown}")


def make_synthetic_run(root, run: str = "run1", *, postprocess: bool = True, created: str | None = None, seed: int = SEED) -> dict:
    """合成の入力一式（と、postprocess=True なら out/）を root に作る。戻り値は {root, run_dir, truth, summary}。"""
    root = Path(root)
    check_output_dir(root, run)  # 何かを書く前に確かめる
    run_dir = root / run
    colab_dir = run_dir / "colab"
    colab_dir.mkdir(parents=True, exist_ok=True)
    reference_path = root / "reference" / REFERENCE_FILE
    reference_path.parent.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(seed)

    tiles_meta, geocodes, truth, tiles_objs = [], {}, [], []
    for x, y, name, muni in SYNTH_TILES:
        objs = OBJS[name]
        aid = tilemath.area_id(Z, x, y)
        tiles_meta.append({"z": Z, "x": x, "y": y, "id": aid, "name": name})
        geocodes[aid] = {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {"street": name, "citycode": muni}}]}
        tiles_objs.append((x, y, objs))
        for year in colabio.YEARS:
            tdir = root / "tiles" / str(year)
            tdir.mkdir(parents=True, exist_ok=True)
            make_photo(objs, year, rng).save(tdir / f"{x}_{y}.png")
            for s in colabio.SCALES:
                np.save(colabio.prob_path(colab_dir, year, x, y, s), make_prob(objs, year, s, rng))
        for o in objs:
            cx, cy = (o.rect[0] + o.rect[2]) / 2, (o.rect[1] + o.rect[3]) / 2
            lon, lat = tilemath.pixel_to_lonlat(Z, x, y, cx, cy)
            truth.append(
                {
                    "area_id": aid,
                    "name": o.name,
                    "role": o.role,
                    "rect_px": list(o.rect),
                    "center": [lon, lat],
                    "in_reference": o.ref_shift is not None,
                    "photo_2014": o.photo18,
                    "photo_2024": o.photo23,
                    "expected_class": o.expect[0] if o.expect else None,
                    "expected_reason": o.expect[1] if o.expect else None,
                }
            )

    meta = {
        "kind": "synthetic",
        "model": "synthetic-fixture（モデルは使っていない。確率は人工）",
        "normalization": "n/a",
        "scales": {"s100": 256, "s150": 384, "s200": 512},
        "tiles": tiles_meta,
        "note": "合成データ（テスト用）。実データではない。",
    }
    (colab_dir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (run_dir / "geocode.json").write_text(json.dumps(geocodes, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (run_dir / "truth.json").write_text(json.dumps(truth, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    reference_path.write_text(make_reference_geojson(tiles_objs), encoding="utf-8")

    summary = None
    if postprocess:
        summary = run_postprocess.run_postprocess(root, run, reference_path=reference_path, created=created, log=lambda _msg: None)
    return {"root": str(root), "run_dir": str(run_dir), "truth": truth, "summary": summary}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("out", nargs="?", default=str(run_postprocess.DEFAULT_DATA_ROOT / "synthetic"))
    ap.add_argument("--run", default="run1")
    ap.add_argument("--no-postprocess", action="store_true", help="入力だけ作り、out/ は作らない")
    ap.add_argument("--created", default=None)
    a = ap.parse_args(argv)
    try:
        res = make_synthetic_run(a.out, a.run, postprocess=not a.no_postprocess, created=a.created)
    except UnsafeOutputError as e:
        print(f"中止: {e}", file=sys.stderr)
        return 2
    print(json.dumps({"root": res["root"], "summary": res["summary"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
