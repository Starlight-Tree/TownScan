"""FOTBCD で、建物の抽出と新築の候補を測る CLI（仕様 §6.1。指標の定義は ADR 0015）。外部へは通信しない。

保存した推論の結果（確率の配列）から、コマンド 1 つで同じ数字を出す。建物の取り出し・除外の重なり・対応づけ・分類は、
アプリの後処理と同じ関数を使う（vectorize・evaluate・diff）。
"""

from __future__ import annotations

import argparse
import hashlib
import json
from collections import Counter
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from shapely import affinity

from . import diff, evaluate, fotbcd, geo, vectorize

REPO_ROOT = Path(__file__).resolve().parents[1]
SCALE_SIZES = {0.5: 256, 0.625: 320, 1.0: 512}  # 倍率 → モデルの入力の一辺（32 の倍数）
THRESHOLDS = (0.3, 0.4, 0.5, 0.6, 0.7)
MIN_BLOB_M2 = vectorize.DEFAULT_MIN_BLOB_M2
# アプリの単純化 0.3 m は Web メルカトルの長さで、県 92 の地上では約 0.2 m。ここは地上の m で計る
SIMPLIFY_M = 0.2
DIFF_PARAMS = diff.DiffParams(drop_present_before=True)  # アプリの候補の作り方と同じ
SPLITS = ("val", "test")
EXCLUDE_KINDS = ("edge", "small", "overlap")

LoadProb = Callable[[str, str, int], np.ndarray]  # (組の番号, "before"|"after", 一辺) → 確率の配列


@dataclass(frozen=True)
class Predicted:
    geom: object  # shapely の Polygon（組の中の m。fotbcd.Footprint と同じ座標）
    area_m2: float
    edge_touch: bool


def predict_buildings(prob: np.ndarray, threshold: float) -> list[Predicted]:
    """確率の配列（組の全体） → 建物のポリゴン（m）。手順は vectorize.vectorize_tile と同じ。"""
    p = vectorize.as_prob_array(prob)
    res = fotbcd.PATCH_M / p.shape[0]
    min_px = max(1, int(round(MIN_BLOB_M2 / (res * res))))
    out = []
    for comp in vectorize.components(vectorize.clean_mask(p >= threshold, min_px)):
        g = affinity.scale(comp.polygon, res, res, origin=(0, 0)).simplify(SIMPLIFY_M, preserve_topology=True)
        g = geo.largest_polygon(geo.polygonal(g))
        if g is not None:
            out.append(Predicted(g, float(g.area), comp.edge_touch))
    return out


def _seed_kind(item, area_m2: float) -> str | None:
    """それ自体が除外になる理由。縁と小ささの両方に当たるものは edge。"""
    if item.edge_touch:
        return "edge"
    return "small" if round(area_m2, 2) < DIFF_PARAMS.min_area_m2 else None


def _drop(own: Sequence, own_kinds: list, other_seeds: Sequence) -> tuple[list, Counter]:
    open_items = [item for item, kind in zip(own, own_kinds) if kind is None]
    covered = evaluate.overlapping([i.geom for i in open_items], [s.geom for s in other_seeds])
    kept = [item for n, item in enumerate(open_items) if n not in covered]
    counts = Counter(kind for kind in own_kinds if kind is not None)
    counts["overlap"] = len(covered)
    return kept, counts


def exclude(refs: Sequence[fotbcd.Footprint], preds: Sequence[Predicted]):
    """正解と予測で対称な除外。戻り値は (残した正解, 残した予測, 正解の除外の数, 予測の除外の数)。

    1. 組の端に接するもの・20 m² 未満のものを、両方から外す。
    2. 1 で外したものと、自分の面積の半分以上が重なる反対側のものも外す（1 段だけ。2 で外したものからは広げない）。
    """
    ref_kinds = [_seed_kind(r, r.geom.area) for r in refs]
    pred_kinds = [_seed_kind(p, p.area_m2) for p in preds]
    kept_refs, ref_counts = _drop(refs, ref_kinds, [p for p, k in zip(preds, pred_kinds) if k])
    kept_preds, pred_counts = _drop(preds, pred_kinds, [r for r, k in zip(refs, ref_kinds) if k])
    return kept_refs, kept_preds, ref_counts, pred_counts


def side_counts(side: str, refs: Sequence[fotbcd.Footprint], preds: Sequence[Predicted]):
    """1 組の片側の抽出。戻り値は (数, 残した正解, 残した予測)。数のキーは "{side}.tp" など。"""
    kept_refs, kept_preds, ref_ex, pred_ex = exclude(refs, preds)
    tp = evaluate.match_objects([p.geom for p in kept_preds], [r.geom for r in kept_refs])
    c = Counter({f"{side}.tp": tp, f"{side}.fp": len(kept_preds) - tp, f"{side}.fn": len(kept_refs) - tp})
    for kind in EXCLUDE_KINDS:
        c[f"{side}.excluded.reference.{kind}"] = ref_ex[kind]
        c[f"{side}.excluded.prediction.{kind}"] = pred_ex[kind]
    return c, kept_refs, kept_preds


def classify_after(pred: Predicted, cover_before, prob_before: np.ndarray) -> str | None:
    """後の写真の建物 1 つの分類（diff.classify）。None は候補にしない（前の写真でも検出した）。

    cover_before は、前の写真の建物の全部（除外の前）の和。端に接するものは除外で消えているので、edge_touch は常に False。
    """
    res = fotbcd.PATCH_M / prob_before.shape[0]
    poly_px = affinity.scale(pred.geom, 1 / res, 1 / res, origin=(0, 0))
    return diff.classify(
        area_m2=round(pred.area_m2, 2),
        ov_kiban=0.0,  # 差し引く建物データは使わない
        ov_2014=round(diff.overlap_fraction(pred.geom, cover_before), 4),
        prob_2014_p90=diff.p90_of(vectorize.values_covering_px(prob_before, poly_px)),
        edge_touch=False,
        params=DIFF_PARAMS,
    ).cls


def pair_counts(pair: fotbcd.Pair, prob_before: np.ndarray, prob_after: np.ndarray, threshold: float) -> Counter:
    """1 組の、両側の抽出と、新築の候補の数。"""
    p0 = vectorize.as_prob_array(prob_before)
    before_preds = predict_buildings(p0, threshold)
    counts, _, _ = side_counts("before", pair.refs("before"), before_preds)
    after, kept_refs, kept_preds = side_counts("after", pair.refs("after"), predict_buildings(prob_after, threshold))
    counts.update(after)

    cover_before = diff.cover_of([p.geom for p in before_preds])
    classes = [(p, classify_after(p, cover_before, p0)) for p in kept_preds]
    new_refs = [r.geom for r in kept_refs if r.label == "NEW"]
    new = [p.geom for p, c in classes if c == diff.CLASS_NEW]
    new_or_uncertain = [p.geom for p, c in classes if c in (diff.CLASS_NEW, diff.CLASS_UNCERTAIN)]
    counts.update(
        {
            "new.n_ref": len(new_refs),
            "new.n_pred": len(new),
            "new.tp": evaluate.match_objects(new, new_refs),
            "new.unc.n_pred": len(new_or_uncertain),
            "new.unc.tp": evaluate.match_objects(new_or_uncertain, new_refs),
        }
    )
    return counts


def _f1(tp: int, fp: int, fn: int) -> float:
    return -1.0 if tp + fp + fn == 0 else 2 * tp / (2 * tp + fp + fn)


def choose_setting(totals: dict[tuple[float, float], Counter]) -> tuple[float, float]:
    """後の写真の建物の物体単位 F1（丸める前の値）が最大の設定。同点は 倍率が小さい → 閾値が 0.5 に近い → 閾値が小さい。"""

    def key(setting):
        scale, threshold = setting
        c = totals[setting]
        return (-_f1(c["after.tp"], c["after.fp"], c["after.fn"]), scale, round(abs(threshold - 0.5), 6), threshold)

    return min(totals, key=key)


def _summary(pairs: Sequence[fotbcd.Pair], c: Counter) -> dict:
    ratio = evaluate._ratio
    years = Counter((p.before_year, p.after_year) for p in pairs)
    return {
        "pairs": len(pairs),
        "years": [{"before": b, "after": a, "pairs": n} for (b, a), n in sorted(years.items())],
        "extraction": {s: evaluate.object_metrics(c[f"{s}.tp"], c[f"{s}.fp"], c[f"{s}.fn"]) for s in fotbcd.SIDES},
        "new_building": {
            "recall": ratio(c["new.tp"], c["new.n_ref"]),
            "precision": ratio(c["new.tp"], c["new.n_pred"]),
            "tp": c["new.tp"],
            "n_ref": c["new.n_ref"],
            "n_pred": c["new.n_pred"],
            "with_uncertain": {
                "recall": ratio(c["new.unc.tp"], c["new.n_ref"]),
                "tp": c["new.unc.tp"],
                "n_pred": c["new.unc.n_pred"],
            },
        },
        "excluded": {
            s: {who: {k: c[f"{s}.excluded.{who}.{k}"] for k in EXCLUDE_KINDS} for who in ("reference", "prediction")}
            for s in fotbcd.SIDES
        },
    }


def run_evaluation(
    pairs: Sequence[fotbcd.Pair],
    load_prob: LoadProb,
    *,
    fixed: tuple[float, float] | None = None,
    log: Callable[[str], None] = lambda _: None,
) -> dict:
    """設定を後の写真の抽出だけで選び（fixed があれば選ばない）、選んだ値でだけ、前の写真と新築の指標を出す。"""
    scales = [fixed[0]] if fixed else list(SCALE_SIZES)
    thresholds = [fixed[1]] if fixed else list(THRESHOLDS)
    totals = {(s, t): Counter() for s in scales for t in thresholds}
    for scale in scales:
        for pair in pairs:
            prob = load_prob(pair.key, "after", SCALE_SIZES[scale])
            for thr in thresholds:
                counts, _, _ = side_counts("after", pair.refs("after"), predict_buildings(prob, thr))
                totals[(scale, thr)].update(counts)
        log(f"倍率 {scale}: 後の写真の抽出を {len(pairs)} 組で数えた")

    sweep = []
    for (scale, thr), c in totals.items():
        m = evaluate.object_metrics(c["after.tp"], c["after.fp"], c["after.fn"])
        sweep.append(
            {
                "scale": scale,
                "threshold": thr,
                "after_object_f1": m["f1"],
                "after_object_precision": m["precision"],
                "after_object_recall": m["recall"],
            }
        )
    scale, threshold = choose_setting(totals)
    log(f"設定: 倍率 {scale}・閾値 {threshold}")

    per_pair = []
    for pair in pairs:
        size = SCALE_SIZES[scale]
        per_pair.append(pair_counts(pair, load_prob(pair.key, "before", size), load_prob(pair.key, "after", size), threshold))

    def total_of(dep: str | None) -> dict:
        chosen = [(p, c) for p, c in zip(pairs, per_pair) if dep is None or p.dep == dep]
        total = Counter()
        for _, c in chosen:
            total.update(c)
        return _summary([p for p, _ in chosen], total)

    return {
        "protocol": {
            "iou_match": evaluate.IOU_MATCH,
            "matching": "greedy one-to-one by IoU",
            "edge_overlap_min": evaluate.EDGE_OVERLAP_MIN,
            "min_area_m2": DIFF_PARAMS.min_area_m2,
            "min_blob_m2": MIN_BLOB_M2,
            "simplify_m": SIMPLIFY_M,
            "scales": scales,
            "thresholds": thresholds,
            "diff": DIFF_PARAMS.to_dict(),
        },
        "sweep": sweep,
        "chosen": {
            "scale": scale,
            "threshold": threshold,
            "selected_by": "fixed" if fixed else "後の写真の建物の物体単位 F1",
        },
        "overall": total_of(None),
        "by_dep": {dep: total_of(dep) for dep in sorted({p.dep for p in pairs})},
    }


def prob_path(probs_dir, key: str, side: str, size: int) -> Path:
    return Path(probs_dir) / f"{key}_{side}_{size}.npy"


def load_prob_file(probs_dir, key: str, side: str, size: int) -> np.ndarray:
    """確率の配列。大きさが違う・0〜1 の外や NaN があるときは、壊れた推論として止める。"""
    path = prob_path(probs_dir, key, side, size)
    a = np.load(path, allow_pickle=False)
    if a.shape != (size, size):
        raise ValueError(f"配列の大きさが違う: {a.shape}（期待 {size}×{size}）: {path.name}")
    a = a.astype(np.float32)
    if not (np.isfinite(a).all() and a.min() >= 0 and a.max() <= 1):
        raise ValueError(f"確率が 0〜1 の外か、NaN がある: {path.name}")
    return a


def missing_probs(probs_dir, pairs: Sequence[fotbcd.Pair], sizes: Sequence[int]) -> list[str]:
    paths = (prob_path(probs_dir, p.key, side, size) for p in pairs for side in fotbcd.SIDES for size in sizes)
    return [path.name for path in paths if not path.is_file()]


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while block := f.read(1 << 20):
            h.update(block)
    return h.hexdigest()


def _notes(split: str) -> list[str]:
    notes = [
        "配布ページによると、人が選んで確認した組で、無作為の標本ではない。県や地区の全体の実力ではない。",
        "組の端に接する建物と 20 m² 未満の建物は、正解と予測の両方から外した（それと半分以上重なる反対側も外した）。",
    ]
    if split == "val":
        notes.insert(0, "調整に使ったデータの値。val は、倍率と閾値の選択と、アプリの地区選びに使った。")
    return notes


def evaluate_split(tar_path, probs_dir, split: str, *, fixed=None, log: Callable[[str], None] = print) -> dict:
    """tar と推論の出力から、出力の JSON（仕様 §6.1）を作る。"""
    tar_path = Path(tar_path)
    if split not in SPLITS:
        raise ValueError(f"split は {SPLITS} のどれか: {split!r}")
    if not tar_path.name.startswith(f"{split}-"):
        raise ValueError(f"tar の名前が、分割 {split} で始まらない（分割の取り違えを防ぐ）: {tar_path.name}")
    if split == "test" and fixed is None:
        raise ValueError("test は --fixed 倍率,閾値 が必須（test の結果で設定を選ばない。ADR 0015）")
    if fixed is not None:
        if len(fixed) != 2 or fixed[0] not in SCALE_SIZES or not 0 < fixed[1] < 1:
            raise ValueError(f"--fixed は 倍率（{', '.join(map(str, SCALE_SIZES))}）と閾値（0〜1）: {fixed}")
    pairs = fotbcd.read_pairs(tar_path)
    sizes = [SCALE_SIZES[fixed[0]]] if fixed else list(SCALE_SIZES.values())
    missing = missing_probs(probs_dir, pairs, sizes)
    if missing:
        raise FileNotFoundError(f"推論の出力が {len(missing)} 個足りない（例: {', '.join(missing[:3])}）: {probs_dir}")
    footprints = Counter(f.label for p in pairs for f in p.footprints)
    log(f"{split}: {len(pairs)} 組・枠 {sum(footprints.values())}")
    result = {
        "dataset": {
            "name": "FOTBCD",
            "split": split,
            "file": tar_path.name,
            "sha256": _sha256(tar_path),
            "pairs": len(pairs),
            "footprints": {label: footprints[label] for label in fotbcd.LABELS},
        },
        "used_for_tuning": split == "val",
        **run_evaluation(pairs, lambda k, s, n: load_prob_file(probs_dir, k, s, n), fixed=fixed, log=log),
        "notes": _notes(split),
    }
    meta = Path(probs_dir) / "meta.json"
    if meta.is_file():
        result["inference"] = json.loads(meta.read_text(encoding="utf-8"))
    return result


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--split", choices=SPLITS, required=True)
    ap.add_argument("--tar", required=True, help="FOTBCD の tar（例: data/fr/download/val-000000.tar）")
    ap.add_argument("--probs", required=True, help="推論の出力のフォルダ")
    ap.add_argument("--out", default=None, help="既定 data/fr/eval_{split}.json")
    ap.add_argument(
        "--fixed", type=lambda t: tuple(float(v) for v in t.split(",")), default=None, metavar="倍率,閾値", help="設定を選ばず、この値で測る"
    )
    a = ap.parse_args(argv)
    result = evaluate_split(a.tar, a.probs, a.split, fixed=a.fixed)
    out = Path(a.out) if a.out else REPO_ROOT / "data" / "fr" / f"eval_{a.split}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    o = result["overall"]
    print(
        f"書き出し: {out}\n"
        f"建物の抽出の物体単位 F1: 前 {o['extraction']['before']['f1']} / 後 {o['extraction']['after']['f1']}\n"
        f"新築の再現率 {o['new_building']['recall']}・精度 {o['new_building']['precision']}"
        f"（未判定も含めた再現率 {o['new_building']['with_uncertain']['recall']}）"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
