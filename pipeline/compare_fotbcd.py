"""FOTBCD の val で、複数のモデルの推論の結果を、同じ組・同じ指標で比べる CLI（仕様 §6.1）。外部へは通信しない。

建物ごとの指標は evaluate_fotbcd と同じ計算で、ここで足すのは、重なる組を外すことと、画素の指標。
test は扱わない（方式と閾値を決めたあとに 1 回だけ。ADR 0015）。
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path

import numpy as np
import shapely
from PIL import Image

from . import evaluate, evaluate_fotbcd as ev, fotbcd

# FLAIR-HUB（IGNF/FLAIR-HUB の分割の列 split_flairhub）の学習・検証のパッチと、地理座標で重なる val の組。
# 県 → tar の中の番号。2026-11-27 に照合した。FLAIR-HUB の学習に含まれる場所で、FLAIR-HUB を有利に測らないために外す
OVERLAP_KEYS = {
    "13": ("000000141", "000000245", "000000297", "000000503", "000000555", "000000568", "000000658", "000000954"),
    "29": ("000000172",),
    "92": ("000000439", "000000529"),
}

PixelTotals = dict[tuple[float, float], dict[str, Counter]]  # (倍率, 閾値) → 県 → 画素の数


def drop_overlap(pairs: Sequence[fotbcd.Pair], overlap: Mapping[str, Sequence[str]]) -> list[fotbcd.Pair]:
    """外す組を除く。番号が tar に無いか、県が違えば、別の tar とみなして止める。"""
    dep_of = {p.key: p.dep for p in pairs}
    wrong = sorted(key for dep, keys in overlap.items() for key in keys if dep_of.get(key) != dep)
    if wrong:
        raise ValueError(f"外す組が tar に無いか、県が違う: {', '.join(wrong)}")
    dropped = {key for keys in overlap.values() for key in keys}
    return [p for p in pairs if p.key not in dropped]


def available_scales(probs_dir, pairs: Sequence[fotbcd.Pair]) -> list[float]:
    """全部の組の配列がある倍率。一部だけある倍率があれば、途中で切れた出力とみなして止める。"""
    scales = []
    for scale, size in ev.SCALE_SIZES.items():
        missing = ev.missing_probs(probs_dir, pairs, [size])
        if not missing:
            scales.append(scale)
        elif len(missing) < len(pairs) * len(fotbcd.SIDES):
            raise FileNotFoundError(
                f"大きさ {size} の推論の出力が {len(missing)} 個足りない（例: {', '.join(missing[:3])}）: {probs_dir}"
            )
    if not scales:
        raise FileNotFoundError(f"推論の出力が無い: {probs_dir}")
    return scales


def truth_mask(refs: Sequence[fotbcd.Footprint]) -> np.ndarray:
    """正解の画素（512×512）。画素の中心が枠の中なら True。"""
    mask = np.zeros((fotbcd.SIZE_PX, fotbcd.SIZE_PX), dtype=bool)
    centers = (np.arange(fotbcd.SIZE_PX) + 0.5) * fotbcd.GSD_M
    for ref in refs:
        minx, miny, maxx, maxy = ref.geom.bounds
        x0, x1 = np.searchsorted(centers, (minx, maxx))
        y0, y1 = np.searchsorted(centers, (miny, maxy))
        xs, ys = np.meshgrid(centers[x0:x1], centers[y0:y1])
        mask[y0:y1, x0:x1] |= shapely.contains_xy(ref.geom, xs, ys)
    return mask


def upsample(prob: np.ndarray) -> np.ndarray:
    """確率の配列を 512 px へ（PIL の双一次）。"""
    if prob.shape[0] == fotbcd.SIZE_PX:
        return prob
    image = Image.fromarray(prob.astype(np.float32))
    return np.asarray(image.resize((fotbcd.SIZE_PX, fotbcd.SIZE_PX), Image.BILINEAR))


def pixel_totals(
    pairs: Sequence[fotbcd.Pair], load_prob: ev.LoadProb, scales: Sequence[float], thresholds: Sequence[float]
) -> PixelTotals:
    """設定と県ごとの、画素の tp・fp・fn（前後の合計。除外と小さい塊の除去はしない）。"""
    deps = sorted({p.dep for p in pairs})
    totals = {(s, t): {d: Counter() for d in deps} for s in scales for t in thresholds}
    for pair in pairs:
        for side in fotbcd.SIDES:
            truth = truth_mask(pair.refs(side))
            n_truth = int(np.count_nonzero(truth))
            for scale in scales:
                prob = upsample(load_prob(pair.key, side, ev.SCALE_SIZES[scale]))
                for threshold in thresholds:
                    pred = prob >= threshold
                    tp = int(np.count_nonzero(pred & truth))
                    totals[(scale, threshold)][pair.dep].update(
                        {"tp": tp, "fp": int(np.count_nonzero(pred)) - tp, "fn": n_truth - tp}
                    )
    return totals


def _pixel_metrics(counts: Sequence[Counter]) -> dict:
    total = Counter()
    for c in counts:
        total.update(c)
    return evaluate.pixel_metrics(total["tp"], total["fp"], total["fn"])


def pixel_report(totals: PixelTotals, chosen: tuple[float, float]) -> dict:
    sweep = [
        {"scale": scale, "threshold": threshold, **_pixel_metrics(list(by_dep.values()))}
        for (scale, threshold), by_dep in totals.items()
    ]
    return {
        "sweep": sweep,
        "overall": _pixel_metrics(list(totals[chosen].values())),
        "by_dep": {dep: _pixel_metrics([c]) for dep, c in totals[chosen].items()},
    }


def compare(
    tar_path,
    models: Mapping[str, object],
    *,
    overlap: Mapping[str, Sequence[str]] = OVERLAP_KEYS,
    log: Callable[[str], None] = print,
) -> dict:
    """models は 名前 → 推論の出力のフォルダ。全部のモデルの入力を確かめてから、計算を始める。"""
    tar_path = Path(tar_path)
    if not tar_path.name.startswith("val-"):
        raise ValueError(f"比較は val だけ（test は、方式と閾値を決めたあとに 1 回だけ）: {tar_path.name}")
    all_pairs = fotbcd.read_pairs(tar_path)
    pairs = drop_overlap(all_pairs, overlap)
    sha256 = ev._sha256(tar_path)
    inputs = {name: (available_scales(d, pairs), ev.load_meta(d, sha256)) for name, d in models.items()}
    log(f"val: {len(all_pairs)} 組のうち {len(pairs)} 組で比べる")

    results = {}
    for name, probs_dir in models.items():
        scales, meta = inputs[name]

        def load_prob(key, side, size, probs_dir=probs_dir):
            return ev.load_prob_file(probs_dir, key, side, size)

        objects = ev.run_evaluation(pairs, load_prob, scales=scales, log=lambda m: log(f"{name}: {m}"))
        chosen = (objects["chosen"]["scale"], objects["chosen"]["threshold"])
        pixels = pixel_report(pixel_totals(pairs, load_prob, scales, ev.THRESHOLDS), chosen)
        log(f"{name}: 画素を数えた")
        results[name] = {"objects": objects, "pixels": pixels, "inference": meta}

    return {
        "dataset": {
            "name": "FOTBCD",
            "split": "val",
            "file": tar_path.name,
            "sha256": sha256,
            "pairs": len(pairs),
            "excluded_keys": sorted(key for keys in overlap.values() for key in keys),
        },
        "used_for_tuning": True,
        "models": results,
        "notes": [
            "調整に使ったデータの値。倍率と閾値は、モデルごとに、この同じ組で選んだ。",
            "選べる倍率の数は、推論の出力があるものだけで、モデルによって違う。",
            "外した組は、FLAIR-HUB の学習・検証の場所と重なる組。ほかの学習データ（FLAIR-INC など）との重なりは確かめていない。",
            "画素の指標は前後の合計で、除外と小さい塊の除去をしていない。",
        ],
    }


def summary_lines(result: dict) -> list[str]:
    lines = []
    for name, m in result["models"].items():
        chosen, overall, px = m["objects"]["chosen"], m["objects"]["overall"], m["pixels"]
        extraction, new = overall["extraction"], overall["new_building"]
        by_dep = " / ".join(f"{d} {v['iou']}" for d, v in px["by_dep"].items())
        f1_by_dep = " / ".join(f"{d} {v['extraction']['after']['f1']}" for d, v in m["objects"]["by_dep"].items())
        lines.append(
            f"{name}（倍率 {chosen['scale']}・閾値 {chosen['threshold']}）\n"
            f"  画素: IoU {px['overall']['iou']}・精度 {px['overall']['precision']}・再現率 {px['overall']['recall']}（県の IoU: {by_dep}）\n"
            f"  建物の F1: 前 {extraction['before']['f1']} / 後 {extraction['after']['f1']}"
            f"（県の後: {f1_by_dep}）\n"
            f"  新築: 再現率 {new['recall']}・精度 {new['precision']}（{new['tp']}/{new['n_ref']} 件・候補 {new['n_pred']}）"
        )
    return lines


def _model_arg(text: str) -> tuple[str, str]:
    name, sep, directory = text.partition("=")
    if not (name and sep and directory):
        raise argparse.ArgumentTypeError(f"--model は 名前=フォルダ: {text!r}")
    return name, directory


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--tar", required=True, help="FOTBCD の val の tar")
    ap.add_argument("--model", type=_model_arg, action="append", required=True, metavar="名前=フォルダ")
    ap.add_argument("--out", default=None, help="既定 data/fr/compare_val.json")
    a = ap.parse_args(argv)
    models = dict(a.model)
    if len(models) != len(a.model):
        ap.error("--model の名前が重なっている")
    result = compare(a.tar, models)
    out = Path(a.out) if a.out else ev.REPO_ROOT / "data" / "fr" / "compare_val.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"書き出し: {out}")
    print("\n".join(summary_lines(result)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
