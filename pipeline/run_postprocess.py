"""後処理の CLI。Colab の出力から、backend が読む out/ を作る（仕様 §4.1）。外部へは通信しない。

入力: <data-root>/<run>/colab（meta*.json・prob_*.npy）、あれば <data-root>/<run>/geocode.json。
評価するときは、正解の建物データ（GeoJSON。--reference）も要る。無いときは --fixed で倍率・閾値を固定する（精度は未測定）。
地区名が取れない地区（geocode.json が無い・応答が想定外）は、name=「地区 {x}-{y}」・ward=「区不明」・name_source="fallback"（geocode.area_fields）。
出力: <data-root>/<run>/out（run.json・areas.json・buildings_2014.geojson・buildings_2024.geojson・candidates.geojson・eval.json）。
流れ: 評価（2014 年。調整用で倍率・閾値を選ぶ。--fixed なら飛ばす）→ 2 時点の建物ポリゴン → 差分と 3 分類。
"""

from __future__ import annotations

import argparse
import json
import os
from datetime import UTC, datetime
from pathlib import Path
from collections.abc import Callable

from shapely import STRtree
from shapely.geometry import box, mapping
from shapely.geometry.polygon import orient

from . import colabio, diff, evaluate, geo, geocode, reference, tilemath, vectorize

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DATA_ROOT = REPO_ROOT / "data" / "townscan"
KINDS = ("real", "synthetic")
REFERENCE_PAD_DEG = 0.002  # タイルの外の建物も、縁の判定のために少し読む
COMPARE_YEAR = next(y for y in colabio.YEARS if y != evaluate.EVAL_YEAR)  # year_compare で、同じ参照・設定で測るもう一方の年
# 固定の倍率・閾値の、選び方の記録。モデル・倍率・閾値がそろって一致するときだけ eval.json の注記に書く（ほかの値に、この選び方を付けない。ADR 0016）
FIXED_BASIS = {
    ("IGNF/FLAIR-HUB_LC-A_RGB_swinbase-upernet", 2.0, 0.6): (
        "この倍率と閾値は、別の検証用データ（FOTBCD の val。画像を縮小して、このアプリの写真の細かさに近づけた条件）で、"
        "後の写真の建物抽出の物体単位 F1 がいちばん高かった組。"
    ),
}


def _write_json(path: Path, obj, *, compact: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    text = json.dumps(obj, ensure_ascii=False, separators=(",", ":")) if compact else json.dumps(obj, ensure_ascii=False, indent=2)
    tmp.write_text(text + "\n", encoding="utf-8")
    os.replace(tmp, path)


def _feature(geom_lonlat, properties: dict, fid: str | None = None) -> dict:
    g = geo.round_coords(geom_lonlat, 7)
    if g.geom_type == "Polygon":
        g = orient(g, 1.0)
    f = {"type": "Feature", "geometry": mapping(g), "properties": properties}
    if fid is not None:
        f["id"] = fid
    return f


def _collection(features: list[dict]) -> dict:
    return {"type": "FeatureCollection", "features": features}


def resolve_kind(meta: dict, kind: str | None) -> str:
    """meta.json の kind と引数の kind を突き合わせる。どちらも無ければ real。食い違いは止める（合成と実データを取り違えない）。"""
    from_meta = meta.get("kind")
    for k in (from_meta, kind):
        if k is not None and k not in KINDS:
            raise ValueError(f"kind は {KINDS} のどれか: {k!r}")
    if from_meta and kind and from_meta != kind:
        raise ValueError(f"meta の kind={from_meta!r} と引数の kind={kind!r} が違う")
    return from_meta or kind or "real"


def default_run_id(kind: str, run: str) -> str:
    """real は run のフォルダ名のまま。synthetic は接頭辞をつけて、実データと同じ run_id にならないようにする。"""
    return run if kind == "real" else f"{kind}-{run}"


def _read_geocode(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def unmeasured_eval(scale: float, threshold: float, model: str | None = None) -> dict:
    """精度を測っていない解析結果の eval.json。数字の項目は書かない（画面と回答は「未測定」を出す）。"""
    notes = [
        "建物の抽出と新築の精度は、まだ測っていない。",
        f"倍率 {scale}・閾値 {threshold} は固定の値で、このアプリの写真では確かめていない。",
    ]
    basis = FIXED_BASIS.get((model, scale, threshold))
    if basis:
        notes.append(basis)
    return {
        "reference": None,
        "chosen": {"scale": scale, "threshold": threshold, "selected_by": "fixed"},
        "protocol": {"year": colabio.YEARS[-1]},
        "new_building_recall": None,
        "notes": notes,
    }


def run_postprocess(
    data_root,
    run: str = "run1",
    *,
    reference_path=None,
    out_dir=None,
    kind: str | None = None,
    run_id: str | None = None,
    created: str | None = None,
    diff_params: diff.DiffParams | None = None,
    scales=evaluate.DEFAULT_SCALES,
    thresholds=evaluate.DEFAULT_THRESHOLDS,
    geocode_path=None,
    fixed: tuple[float, float] | None = None,
    log: Callable[[str], None] = print,
) -> dict:
    """fixed=(倍率, 閾値) を渡すと、正解の建物データを使わない（精度は未測定。差分は写真だけで行う。ADR 0015）。

    fixed を渡さないときは reference_path（正解の建物の GeoJSON）が要る。既定の置き場は持たない（意図しないデータで評価しない）。
    """
    if fixed is None and reference_path is None:
        raise ValueError("正解の建物データ（--reference）か、固定の値（--fixed 倍率,閾値）のどちらかが要る")
    data_root = Path(data_root)
    run_dir = data_root / run
    colab_dir = run_dir / "colab"
    out_dir = Path(out_dir) if out_dir else run_dir / "out"
    diff_params = diff_params or diff.DiffParams(drop_present_before=fixed is not None)
    geocode_path = Path(geocode_path) if geocode_path else run_dir / "geocode.json"

    meta = colabio.read_meta(colab_dir)
    kind = resolve_kind(meta, kind)
    if fixed is not None:
        scales = (fixed[0],)
    run_id = run_id or default_run_id(kind, run)
    created = created or datetime.now(UTC).isoformat(timespec="seconds")
    notes: list[str] = []
    if kind == "synthetic":
        notes.append("合成データ（テスト用）。実際の写真・モデルの結果ではない。")

    # 1. 処理するタイル（2 年・全倍率の確率の配列がそろうもの。並び順は meta の順）
    all_tiles = colabio.read_tiles(colab_dir, run_dir)
    tiles = [t for t in all_tiles if colabio.has_all_probs(colab_dir, colabio.YEARS, t[1], t[2], scales)]
    skipped = [tilemath.area_id(*t) for t in all_tiles if t not in tiles]
    if skipped:
        notes.append(f"確率の配列がそろわず除いたタイル: {', '.join(skipped)}")
    if len(tiles) < 2:
        raise RuntimeError(f"処理できるタイルが 2 枚未満: {len(tiles)}（入力 {colab_dir}）")
    log(f"タイル {len(tiles)} 枚（入力 {len(all_tiles)}）。kind={kind} run_id={run_id}")

    if fixed is not None:
        # 2・3. 正解の建物データは使わない。倍率と閾値は固定で、精度は未測定
        reference_in = {t: [] for t in tiles}
        ref_stats = None
        eval_json = unmeasured_eval(*fixed, model=colabio.model_name(meta))
        scale, threshold = fixed
        log(f"正解の建物データなし。倍率 {scale} 閾値 {threshold}（固定の値）。精度は未測定")
    else:
        # 2. 正解の建物データ（全タイルの範囲だけを使う）
        reference_path = Path(reference_path)
        bboxes = {t: tilemath.tile_bbox_lonlat(*t) for t in tiles}
        ref_stats = reference.LoadStats()
        buildings = reference.load_buildings(reference_path, reference.union_bbox(bboxes.values(), REFERENCE_PAD_DEG), stats=ref_stats)
        log(f"正解の建物データ: {ref_stats.features} 件を読み、範囲内 {ref_stats.kept} 棟（飛ばした {dict(ref_stats.skipped)}）")
        if not buildings:
            raise ValueError(
                f"解析する範囲に、正解の建物が 1 棟も無い（座標が経度・緯度か、地域が合っているかを確かめる。飛ばした理由: {dict(ref_stats.skipped)}）: {reference_path}"
            )
        if ref_stats.skipped:
            notes.append(f"正解の建物データで読めずに飛ばした地物: {dict(ref_stats.skipped)}")
        tree = STRtree(buildings)
        reference_in = {t: [buildings[int(i)] for i in tree.query(box(*bboxes[t]))] for t in tiles}
        for t in tiles:
            if not reference_in[t]:
                notes.append(f"{tilemath.area_id(*t)} は正解の建物が 0 棟（郊外・水域などで実際に無いこともある。データの取り違えでないか確かめる）")

        # 3. 評価（2014 年）。倍率・閾値の選択は調整用だけ
        references = {t: evaluate.prepare_reference(*t, reference_in[t]) for t in tiles}
        label = ("合成データの建物" if kind == "synthetic" else "正解の建物データ") + f"（{reference_path.name}）"
        eval_json = evaluate.run_evaluation(
            tiles,
            lambda t, s: colabio.load_prob(colab_dir, evaluate.EVAL_YEAR, t[1], t[2], s),
            references,
            scales=scales,
            thresholds=thresholds,
            reference=f"{label}（{evaluate.EVAL_YEAR} 年の写真と比べる）",
            reference_detail={
                "name": label,
                "files": [reference_path.name],
                "buildings_loaded_in_range": ref_stats.kept,
                "photo_year": evaluate.EVAL_YEAR,
            },
            reference_notes=["正解の建物データが、いつの測量・写真に基づくかは、このパイプラインでは確かめていない。"],
            load_prob_compare=lambda t, s: colabio.load_prob(colab_dir, COMPARE_YEAR, t[1], t[2], s),
            compare_year=COMPARE_YEAR,
            diff_params=diff_params,
        )
        scale, threshold = eval_json["chosen"]["scale"], eval_json["chosen"]["threshold"]
        log(f"選んだ値: 倍率 {scale} 閾値 {threshold}（調整用）。評価用の物体単位 F1 = {eval_json['holdout']['object']['f1']}")

    # 4. 選んだ値で 2 時点の建物 → 差分
    geocodes = _read_geocode(geocode_path)
    areas, feats_2014, feats_2024, feats_cand = [], [], [], []
    per_area_stats = {}
    for (z, x, y) in tiles:
        aid = tilemath.area_id(z, x, y)
        p2014 = colabio.load_prob(colab_dir, 2014, x, y, scale)
        p2024 = colabio.load_prob(colab_dir, 2024, x, y, scale)
        b18 = vectorize.vectorize_tile(p2014, z, x, y, threshold=threshold)
        b23 = vectorize.vectorize_tile(p2024, z, x, y, threshold=threshold)
        cands, stats = diff.build_candidates(z, x, y, b23, b18, p2014, reference_in[(z, x, y)], diff_params)
        cands = diff.number_candidates(x, y, cands)
        stats.update(buildings_2014=len(b18), reference=len(reference_in[(z, x, y)]))
        per_area_stats[aid] = stats

        for bs, sink in ((b18, feats_2014), (b23, feats_2024)):
            for b in bs:
                sink.append(
                    _feature(b.geom_lonlat, {"area_id": aid, "area_m2": round(b.area_m2, 2), "prob_mean": round(b.prob_mean, 4)})
                )
        for c in cands:
            feats_cand.append(_feature(c["geometry"], c["properties"], fid=c["id"]))

        info = geocode.area_fields(geocodes.get(aid), aid)  # 取れない地区にも、代わりの name・ward が入る
        if kind == "synthetic" and info["name_source"] == geocode.NAME_SOURCE:  # 合成の応答は、実の応答と区別する
            info["name_source"] = "synthetic"
        west, south, east, north = tilemath.tile_bbox_lonlat(z, x, y)
        lon, lat = tilemath.tile_center_lonlat(z, x, y)
        areas.append(
            {
                "id": aid,
                "z": z,
                "x": x,
                "y": y,
                "bbox": [round(west, 7), round(south, 7), round(east, 7), round(north, 7)],
                "centroid": [round(lon, 7), round(lat, 7)],
                **info,
            }
        )
        log(f"  {aid}: 建物 2014={len(b18)} 2024={len(b23)} 候補={stats['candidates']} "
            f"(新規={stats[diff.CLASS_NEW]} 描き漏れ={stats[diff.CLASS_OMISSION]} 保留={stats[diff.CLASS_UNCERTAIN]})")

    seen_names: dict[str, int] = {}
    for a in areas:  # 同じ通り名の地区は、2 つ目から番号を付けて区別する
        seen_names[a["name"]] = seen_names.get(a["name"], 0) + 1
        if seen_names[a["name"]] > 1:
            a["name"] = f"{a['name']} その{seen_names[a['name']]}"
    n_fallback = sum(a["name_source"] == geocode.FALLBACK_SOURCE for a in areas)
    if n_fallback:
        notes.append(f"地区名を取得できず、代わりの名前（地区 x-y）を入れた地区: {n_fallback}/{len(areas)}（geocode.json が無い・応答が想定外・名前が安全でない、のどれか）")
    notes.append("差分の閾値（kiban_ov_max・min_area_m2・omission_ov_2014_min・new_ov_2014_max・new_p90_max）は、正解データで確かめていない未検証の初期値。")
    total_by_class = {c: sum(s[c] for s in per_area_stats.values()) for c in diff.CLASSES}
    run_json = {
        "run_id": run_id,
        "kind": kind,
        "created": created,
        "model": colabio.model_name(meta),
        "params": {
            "z": tiles[0][0],
            "scale": scale,
            "threshold": threshold,
            "selected_on": "tune" if fixed is None else "fixed",
            "vectorize": {
                "binarize": "prob >= threshold",
                "min_blob_m2": vectorize.DEFAULT_MIN_BLOB_M2,
                "simplify_m": vectorize.DEFAULT_SIMPLIFY_M,
            },
            "diff": diff_params.to_dict(),
            "diff_thresholds_status": "unverified_initial_values",
            "eval": eval_json["protocol"],
            "reference": {"file": Path(reference_path).name, "load": ref_stats.as_dict()} if ref_stats else None,
            "colab": colabio.colab_summary(meta),
        },
        "tiles": [tilemath.area_id(*t) for t in tiles],
        "stats": per_area_stats,
        "notes": "\n".join(notes),
    }

    # 5. 書き出し（run.json は最後。ローダーが途中の状態を読まないように）
    _write_json(out_dir / "eval.json", eval_json)
    _write_json(out_dir / "areas.json", areas)
    _write_json(out_dir / "buildings_2014.geojson", _collection(feats_2014), compact=True)
    _write_json(out_dir / "buildings_2024.geojson", _collection(feats_2024), compact=True)
    _write_json(out_dir / "candidates.geojson", _collection(feats_cand), compact=True)
    _write_json(out_dir / "run.json", run_json)
    log(f"書き出し: {out_dir}（候補 {len(feats_cand)} 件: {total_by_class}）")
    return {
        "out_dir": str(out_dir),
        "run_id": run_id,
        "kind": kind,
        "areas": len(areas),
        "buildings_2014": len(feats_2014),
        "buildings_2024": len(feats_2024),
        "candidates": len(feats_cand),
        "by_class": total_by_class,
        "chosen": eval_json["chosen"],
        "holdout": eval_json.get("holdout"),
        "tune": eval_json.get("tune"),
    }


def _floats(text: str) -> tuple[float, ...]:
    return tuple(float(t) for t in text.split(",") if t.strip())


def main(argv: list[str] | None = None) -> int:
    d = diff.DiffParams()
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--data-root", default=str(DEFAULT_DATA_ROOT), help="既定 data/townscan")
    ap.add_argument("--run", default="fr2")
    ap.add_argument("--reference", default=None, help="評価の正解にする建物の GeoJSON（経度・緯度）。--fixed を付けないときは必須")
    ap.add_argument("--out", default=None, help="出力先。既定 <data-root>/<run>/out")
    ap.add_argument("--kind", choices=KINDS, default=None, help="meta の kind を上書きはできない（食い違えばエラー）")
    ap.add_argument("--run-id", default=None)
    ap.add_argument("--created", default=None, help="ISO 8601。既定は現在（UTC）")
    ap.add_argument("--geocode", default=None, help="既定 <data-root>/<run>/geocode.json")
    ap.add_argument("--scales", type=_floats, default=evaluate.DEFAULT_SCALES)
    ap.add_argument("--thresholds", type=_floats, default=evaluate.DEFAULT_THRESHOLDS)
    ap.add_argument("--fixed", type=_floats, default=None, metavar="倍率,閾値", help="正解の建物データを使わず、この値で候補を作る（精度は未測定）")
    ap.add_argument("--kiban-ov-max", type=float, default=d.kiban_ov_max)
    ap.add_argument("--min-area-m2", type=float, default=d.min_area_m2)
    ap.add_argument("--omission-ov-2014-min", type=float, default=d.omission_ov_2014_min)
    ap.add_argument("--new-ov-2014-max", type=float, default=d.new_ov_2014_max)
    ap.add_argument("--new-p90-max", type=float, default=d.new_p90_max)
    a = ap.parse_args(argv)
    summary = run_postprocess(
        a.data_root,
        a.run,
        reference_path=a.reference,
        out_dir=a.out,
        kind=a.kind,
        run_id=a.run_id,
        created=a.created,
        scales=a.scales,
        thresholds=a.thresholds,
        geocode_path=a.geocode,
        fixed=a.fixed,
        diff_params=diff.DiffParams(a.kiban_ov_max, a.min_area_m2, a.omission_ov_2014_min, a.new_ov_2014_max, a.new_p90_max, a.fixed is not None),
    )
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
