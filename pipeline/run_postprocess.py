"""後処理の CLI。Colab の出力と基盤地図情報から、backend が読む out/ を作る（仕様 §4.1）。外部へは通信しない。

入力: <data-root>/<run>/colab（meta*.json・prob_*.npy）、基盤地図情報の BldA、あれば <data-root>/<run>/geocode.json。
地区名が取れない地区（geocode.json が無い・応答が想定外）は、name=「地区 {x}-{y}」・ward=「区不明」・name_source="fallback"（geocode.area_fields）。
出力: <data-root>/<run>/out（run.json・areas.json・buildings_2018.geojson・buildings_2023.geojson・candidates.geojson・eval.json）。
流れ: 評価（2018 年。調整用で倍率・閾値を選ぶ）→ 選んだ値で 2 時点の建物ポリゴン → 差分と 3 分類。
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

from . import colabio, diff, evaluate, geo, geocode, kiban, tilemath, vectorize

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DATA_ROOT = REPO_ROOT / "data" / "townscan"
DEFAULT_KIBAN_DIR = REPO_ROOT / "data" / "kiban" / "kmm_20181001"
KINDS = ("real", "synthetic")
KIBAN_LABEL = "基盤地図情報 BldA 2018-10 版"
KIBAN_PAD_DEG = 0.002  # タイルの外の建物も、縁の判定のために少し読む
COMPARE_YEAR = next(y for y in colabio.YEARS if y != evaluate.EVAL_YEAR)  # year_compare で、同じ参照・設定で測るもう一方の年


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


def default_kiban_dir(kind: str, data_root) -> Path:
    """基盤地図情報の既定の置き場。フォルダの有無では切り替えず、kind で決める。

    real は常に実データ（data/kiban/kmm_20181001）。<data-root>/kiban が偶然あっても、実データの評価がそちらへ静かに移らない。
    synthetic は、合成の入力と一緒に作られる <data-root>/kiban（実データの建物で合成の評価をしない）。
    """
    return Path(data_root) / "kiban" if kind == "synthetic" else DEFAULT_KIBAN_DIR


def _read_geocode(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _vintage_text(counts: dict) -> str:
    """{値: 棟数}（多い順）→ 「K17 が 74,929 棟」の並び。値が 4 種を超えるときは上位 3 つとほかの数。"""
    items = list(counts.items())
    shown = ", ".join(f"{v} が {n:,} 棟" for v, n in items[:3])
    return shown + (f"、ほか {len(items) - 3} 種" if len(items) > 3 else "")


def reference_notes(vintage: dict, kept: int, kind: str) -> list[str]:
    """参照（基盤地図情報）の素性の注記。事実（読み込んだ建物の属性の集計）と、推定（ADR の調査の引用）を分ける。

    属性の集計は、読み込んだデータから作る（合成データなら合成の値が出る）。ADR の引用は実データ（kind=real）だけ。
    """
    uniform = all(len(v) == 1 for v in vintage.values())
    notes = [
        f"参照の版の素性（事実。範囲内に読み込んだ建物 {kept:,} 棟の属性の集計）: gml:id の接頭辞は {_vintage_text(vintage['gml_id_prefix'])}、"
        f"lfSpanFr（開始日）は {_vintage_text(vintage['lf_span_from'])}、devDate は {_vintage_text(vintage['dev_date'])}。"
        + (
            "全棟が同じ値で、建物ごとの日付の違いは無い。「2018-10」は配布の版の日付にすぎず、個々の建物がいつの測量・写真に基づくかは、この属性からは分からない。"
            if uniform
            else "値が複数ある（建物ごとの日付の違いがある可能性）。"
        )
    ]
    if kind == "real":
        notes.append(
            "参照の時期（推定。独立の確認はしていない）: docs/decisions/0001-data-candidates.md の調査は、この地域の建物データは 2017-10 の更新のあと"
            "ほぼ止まっていた（版のファイルサイズが 2017-10〜2024-10 でほぼ一定。2018-10 版と 2023-10 版で座標が完全一致する建物が 99.9%）と、"
            "熊本の 2018 年の写真は 2018 年 12 月の簡易空中写真（地理院の撮影範囲の記載）だと記す。これが正しければ、参照は写真より 1 年以上古い。"
            "建物データの更新日と写真の撮影日は、このパイプラインでは確かめていない。"
        )
    return notes


def run_postprocess(
    data_root,
    run: str = "run1",
    *,
    kiban_dir=None,
    out_dir=None,
    kind: str | None = None,
    run_id: str | None = None,
    created: str | None = None,
    diff_params: diff.DiffParams | None = None,
    scales=evaluate.DEFAULT_SCALES,
    thresholds=evaluate.DEFAULT_THRESHOLDS,
    geocode_path=None,
    log: Callable[[str], None] = print,
) -> dict:
    data_root = Path(data_root)
    run_dir = data_root / run
    colab_dir = run_dir / "colab"
    out_dir = Path(out_dir) if out_dir else run_dir / "out"
    diff_params = diff_params or diff.DiffParams()
    geocode_path = Path(geocode_path) if geocode_path else run_dir / "geocode.json"

    meta = colabio.read_meta(colab_dir)
    kind = resolve_kind(meta, kind)
    kiban_dir = default_kiban_dir(kind, data_root) if kiban_dir is None else Path(kiban_dir)
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

    # 2. 基盤地図情報（全タイルの範囲だけを読む）
    files = kiban.find_xml_files(kiban_dir)
    if not files:
        raise FileNotFoundError(f"基盤地図情報の BldA の XML が見つからない: {kiban_dir}")
    bboxes = {t: tilemath.tile_bbox_lonlat(*t) for t in tiles}
    kstats = kiban.LoadStats()
    kb = kiban.load_buildings(files, kiban.union_bbox(bboxes.values(), KIBAN_PAD_DEG), stats=kstats)
    log(f"基盤地図情報: {kstats.blocks} 棟を読み、範囲内 {kstats.kept} 棟（飛ばした {dict(kstats.skipped)}）")
    if kstats.skipped:
        notes.append(f"基盤地図情報で読めずに飛ばした建物: {dict(kstats.skipped)}")
    tree = STRtree([b.geometry for b in kb])
    kiban_in = {t: [kb[int(i)].geometry for i in tree.query(box(*bboxes[t]))] for t in tiles}
    for t in tiles:
        if not kiban_in[t]:
            notes.append(f"{tilemath.area_id(*t)} は基盤地図情報の建物が 0 棟（郊外・水域などで実際に無いこともある。フォルダの取り違えでないか確かめる）")

    # 3. 評価（2018 年）。倍率・閾値の選択は調整用だけ
    references = {t: evaluate.prepare_reference(*t, kiban_in[t]) for t in tiles}
    vintage = kstats.vintage_dict()
    eval_json = evaluate.run_evaluation(
        tiles,
        lambda t, s: colabio.load_prob(colab_dir, evaluate.EVAL_YEAR, t[1], t[2], s),
        references,
        scales=scales,
        thresholds=thresholds,
        reference=f"{KIBAN_LABEL}（{evaluate.EVAL_YEAR} 年の写真と比べる）",
        reference_detail={
            "name": KIBAN_LABEL,
            "files": [Path(f).name for f in files],
            "buildings_loaded_in_range": kstats.kept,
            "photo_year": evaluate.EVAL_YEAR,
            "vintage": vintage,
        },
        reference_notes=reference_notes(vintage, kstats.kept, kind),
        load_prob_compare=lambda t, s: colabio.load_prob(colab_dir, COMPARE_YEAR, t[1], t[2], s),
        compare_year=COMPARE_YEAR,
        diff_params=diff_params,
    )
    scale, threshold = eval_json["chosen"]["scale"], eval_json["chosen"]["threshold"]
    log(f"選んだ値: 倍率 {scale} 閾値 {threshold}（調整用）。評価用の物体単位 F1 = {eval_json['holdout']['object']['f1']}")

    # 4. 選んだ値で 2 時点の建物 → 差分
    geocodes = _read_geocode(geocode_path)
    areas, feats_2018, feats_2023, feats_cand = [], [], [], []
    per_area_stats = {}
    for (z, x, y) in tiles:
        aid = tilemath.area_id(z, x, y)
        p2018 = colabio.load_prob(colab_dir, 2018, x, y, scale)
        p2023 = colabio.load_prob(colab_dir, 2023, x, y, scale)
        b18 = vectorize.vectorize_tile(p2018, z, x, y, threshold=threshold)
        b23 = vectorize.vectorize_tile(p2023, z, x, y, threshold=threshold)
        cands, stats = diff.build_candidates(z, x, y, b23, b18, p2018, kiban_in[(z, x, y)], diff_params)
        cands = diff.number_candidates(x, y, cands)
        stats.update(buildings_2018=len(b18), kiban=len(kiban_in[(z, x, y)]))
        per_area_stats[aid] = stats

        for bs, sink in ((b18, feats_2018), (b23, feats_2023)):
            for b in bs:
                sink.append(
                    _feature(b.geom_lonlat, {"area_id": aid, "area_m2": round(b.area_m2, 2), "prob_mean": round(b.prob_mean, 4)})
                )
        for c in cands:
            feats_cand.append(_feature(c["geometry"], c["properties"], fid=c["id"]))

        info = geocode.area_fields(geocodes.get(aid), aid)  # 取れない地区にも、代わりの name・ward が入る
        if kind == "synthetic" and info["name_source"] == geocode.NAME_SOURCE:
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
        log(f"  {aid}: 建物 2018={len(b18)} 2023={len(b23)} 候補={stats['candidates']} "
            f"(新規={stats[diff.CLASS_NEW]} 描き漏れ={stats[diff.CLASS_OMISSION]} 保留={stats[diff.CLASS_UNCERTAIN]})")

    n_fallback = sum(a["name_source"] == geocode.FALLBACK_SOURCE for a in areas)
    if n_fallback:
        notes.append(f"地区名を取得できず、代わりの名前（地区 x-y）を入れた地区: {n_fallback}/{len(areas)}（geocode.json が無い・応答が想定外・名前が安全でない、のどれか）")
    notes.append("差分の閾値（kiban_ov_max・min_area_m2・omission_ov_2018_min・new_ov_2018_max・new_p90_max）は、手ラベルが無い未検証の初期値。")
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
            "selected_on": "tune",
            "vectorize": {
                "binarize": "prob >= threshold",
                "min_blob_m2": vectorize.DEFAULT_MIN_BLOB_M2,
                "simplify_m": vectorize.DEFAULT_SIMPLIFY_M,
            },
            "diff": diff_params.to_dict(),
            "diff_thresholds_status": "unverified_initial_values",
            "eval": eval_json["protocol"],
            "kiban": {"dataset": KIBAN_LABEL, "load": kstats.as_dict()},
            "colab": colabio.colab_summary(meta),
        },
        "tiles": [tilemath.area_id(*t) for t in tiles],
        "stats": per_area_stats,
        "notes": "\n".join(notes),
    }

    # 5. 書き出し（run.json は最後。ローダーが途中の状態を読まないように）
    _write_json(out_dir / "eval.json", eval_json)
    _write_json(out_dir / "areas.json", areas)
    _write_json(out_dir / "buildings_2018.geojson", _collection(feats_2018), compact=True)
    _write_json(out_dir / "buildings_2023.geojson", _collection(feats_2023), compact=True)
    _write_json(out_dir / "candidates.geojson", _collection(feats_cand), compact=True)
    _write_json(out_dir / "run.json", run_json)
    log(f"書き出し: {out_dir}（候補 {len(feats_cand)} 件: {total_by_class}）")
    return {
        "out_dir": str(out_dir),
        "run_id": run_id,
        "kind": kind,
        "areas": len(areas),
        "buildings_2018": len(feats_2018),
        "buildings_2023": len(feats_2023),
        "candidates": len(feats_cand),
        "by_class": total_by_class,
        "chosen": eval_json["chosen"],
        "holdout": eval_json["holdout"],
        "tune": eval_json["tune"],
    }


def _floats(text: str) -> tuple[float, ...]:
    return tuple(float(t) for t in text.split(",") if t.strip())


def main(argv: list[str] | None = None) -> int:
    d = diff.DiffParams()
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--data-root", default=str(DEFAULT_DATA_ROOT), help="既定 data/townscan")
    ap.add_argument("--run", default="run1")
    ap.add_argument("--kiban", default=None, help="BldA の XML のフォルダ。既定: real は data/kiban/kmm_20181001、synthetic は <data-root>/kiban")
    ap.add_argument("--out", default=None, help="出力先。既定 <data-root>/<run>/out")
    ap.add_argument("--kind", choices=KINDS, default=None, help="meta の kind を上書きはできない（食い違えばエラー）")
    ap.add_argument("--run-id", default=None)
    ap.add_argument("--created", default=None, help="ISO 8601。既定は現在（UTC）")
    ap.add_argument("--geocode", default=None, help="既定 <data-root>/<run>/geocode.json")
    ap.add_argument("--scales", type=_floats, default=evaluate.DEFAULT_SCALES)
    ap.add_argument("--thresholds", type=_floats, default=evaluate.DEFAULT_THRESHOLDS)
    ap.add_argument("--kiban-ov-max", type=float, default=d.kiban_ov_max)
    ap.add_argument("--min-area-m2", type=float, default=d.min_area_m2)
    ap.add_argument("--omission-ov-2018-min", type=float, default=d.omission_ov_2018_min)
    ap.add_argument("--new-ov-2018-max", type=float, default=d.new_ov_2018_max)
    ap.add_argument("--new-p90-max", type=float, default=d.new_p90_max)
    a = ap.parse_args(argv)
    summary = run_postprocess(
        a.data_root,
        a.run,
        kiban_dir=a.kiban,
        out_dir=a.out,
        kind=a.kind,
        run_id=a.run_id,
        created=a.created,
        scales=a.scales,
        thresholds=a.thresholds,
        geocode_path=a.geocode,
        diff_params=diff.DiffParams(a.kiban_ov_max, a.min_area_m2, a.omission_ov_2018_min, a.new_ov_2018_max, a.new_p90_max),
    )
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
