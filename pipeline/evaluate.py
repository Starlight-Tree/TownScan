"""建物抽出の評価（仕様 §6）。参照は正解の建物データ（読み込みは reference.py）、予測は 2014 年の写真の確率。

- 指標: 画素の IoU・適合率・再現率・F1、物体単位の F1（IoU >= 0.5 の 1 対 1 対応。IoU の大きい順に貪欲に結ぶ）。
- タイルの縁に接する物体は、参照・予測の両方から外す（切れた建物の不利を避ける）。さらに、外した物体と自分の面積の半分以上が
  重なる「反対側」の物体も外す（縁の手前で止まった予測の相手の参照・縁まで届いて隣と合体した予測の中の参照が、片側だけ残らないように）。
  外した物体を起点にした 1 段だけで、重なりで外した物体からさらに外すことはしない。外した数も記録する（縁に接する数と重なりで外した数を分けて）。
  画素の指標では、外した物体の画素を、その物体の側の配列から除く（反対側の配列で、半分未満しか重ならない物体の画素は残る）。
- 並び順の前半（調整用）で倍率・閾値を選び、後半（評価用）と全体は、選んだ値のままの結果を別に報告する。
- 画素の数え方: 予測の配列と同じ格子（256×倍率）に参照を塗って数える。
- 追加の診断（eval.json の任意項目。選択には使わない）: year_compare（同じ参照・同じ設定で別の年の写真を測る）・
  existing_absent_in_2014（既存の建物のうち、2014 年の抽出が何も見ていないものの割合）。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from collections.abc import Callable, Sequence

import numpy as np
from rasterio.features import rasterize
from shapely import STRtree
from shapely.geometry import box
from shapely.ops import unary_union

from . import diff, geo, tilemath, vectorize

IOU_MATCH = 0.5
EDGE_OVERLAP_MIN = 0.5  # 外した物体と、自分の面積のこの割合以上が重なる反対側の物体も外す
DEFAULT_SCALES = (1.0, 1.5, 2.0)
DEFAULT_THRESHOLDS = (0.3, 0.4, 0.5, 0.6, 0.7)
EVAL_YEAR = 2014

TileKey = tuple[int, int, int]


@dataclass
class Reference:
    """タイル 1 枚の参照（EPSG:3857）。縁に接する建物は polys から外し、edge_polys に持つ（予測側の縁との対称な除外に使う）。"""

    polys: list
    n_total: int  # タイルと交わる建物の数
    n_edge: int  # うち、縁に接する（外した）数
    edge_polys: list = field(default_factory=list)  # 縁に接する建物（n_edge 個）


def prepare_reference(z: int, x: int, y: int, geoms_lonlat: Sequence) -> Reference:
    tile_box = box(*tilemath.tile_bounds_3857(z, x, y))
    boundary = tile_box.boundary
    polys, edge_polys, n_total, n_edge = [], [], 0, 0
    for g in geoms_lonlat:
        m = geo.lonlat_to_merc_geom(g)
        if not m.intersects(tile_box):
            continue
        n_total += 1
        if m.intersects(boundary):
            n_edge += 1
            edge_polys.append(m)
        else:
            polys.append(m)
    return Reference(polys=polys, n_total=n_total, n_edge=n_edge, edge_polys=edge_polys)


@dataclass
class Counts:
    px_tp: int = 0
    px_fp: int = 0
    px_fn: int = 0
    obj_tp: int = 0
    obj_fp: int = 0
    obj_fn: int = 0
    n_ref: int = 0  # 縁を除いた参照の物体数
    n_pred: int = 0  # 縁を除いた予測の物体数
    excl_ref: int = 0  # 外した参照の数（縁に接する数 + 重なりで外した数）
    excl_pred: int = 0  # 外した予測の数（同上）
    excl_ref_overlap: int = 0  # うち、縁で外した予測と重なって外した参照
    excl_pred_overlap: int = 0  # うち、縁で外した参照と重なって外した予測

    def __add__(self, o: "Counts") -> "Counts":
        return Counts(*(getattr(self, f) + getattr(o, f) for f in self.__dataclass_fields__))


def pixel_counts(pred: np.ndarray, ref: np.ndarray) -> tuple[int, int, int]:
    """(tp, fp, fn)。どちらも bool の同じ形の配列。"""
    pred, ref = pred.astype(bool), ref.astype(bool)
    tp = int(np.count_nonzero(pred & ref))
    return tp, int(np.count_nonzero(pred)) - tp, int(np.count_nonzero(ref)) - tp


def match_objects(pred_polys: Sequence, ref_polys: Sequence, iou_min: float = IOU_MATCH) -> int:
    """IoU >= iou_min の 1 対 1 対応の数（IoU の大きい順に貪欲）。"""
    if not len(pred_polys) or not len(ref_polys):
        return 0
    tree = STRtree(list(ref_polys))
    pairs = []
    for i, p in enumerate(pred_polys):
        for j in tree.query(p):
            g = ref_polys[int(j)]
            inter = p.intersection(g).area
            if inter <= 0:
                continue
            iou = inter / (p.area + g.area - inter)
            if iou >= iou_min - 1e-12:
                pairs.append((-iou, i, int(j)))
    pairs.sort()
    used_p, used_g, tp = set(), set(), 0
    for _, i, j in pairs:
        if i in used_p or j in used_g:
            continue
        used_p.add(i)
        used_g.add(j)
        tp += 1
    return tp


def rasterize_polys(polys: Sequence, z: int, x: int, y: int, size: int) -> np.ndarray:
    if not len(polys):
        return np.zeros((size, size), dtype=bool)
    return rasterize(
        [(g, 1) for g in polys], out_shape=(size, size), transform=tilemath.tile_transform(z, x, y, size), fill=0, dtype="uint8"
    ).astype(bool)


def overlapping(own: Sequence, others: Sequence, min_frac: float = EDGE_OVERLAP_MIN) -> set[int]:
    """own のうち、自分の面積の min_frac 以上が others（の和）と重なるものの番号。同じ座標系のポリゴンを渡す。"""
    if not len(own) or not len(others):
        return set()
    tree = STRtree(list(others))
    out = set()
    for i, g in enumerate(own):
        if g.area <= 0:
            continue
        near = [others[int(j)] for j in tree.query(g)]
        if near and g.intersection(unary_union(near)).area / g.area >= min_frac - 1e-12:
            out.add(i)
    return out


def evaluate_tile(
    prob,
    z: int,
    x: int,
    y: int,
    reference: Reference,
    *,
    threshold: float,
    min_blob_m2: float = vectorize.DEFAULT_MIN_BLOB_M2,
    simplify_m: float = vectorize.DEFAULT_SIMPLIFY_M,
    iou_min: float = IOU_MATCH,
) -> Counts:
    p = vectorize.as_prob_array(prob)
    size = p.shape[0]
    extracted = vectorize.extract(p, z, x, y, threshold=threshold, min_blob_m2=min_blob_m2)
    mask, comps = extracted
    buildings = vectorize.vectorize_tile(p, z, x, y, simplify_m=simplify_m, min_blob_m2=min_blob_m2, extracted=extracted)

    # 縁の除外は左右で対称にする: 縁に接する物体を外し、さらに、外した物体と自分の面積の半分以上が重なる反対側の物体も外す
    inner = [b for b in buildings if not b.edge_touch]
    drop_pred = overlapping([b.geom_merc for b in inner], reference.edge_polys)
    drop_ref = overlapping(reference.polys, [b.geom_merc for b in buildings if b.edge_touch])
    pred_polys = [b.geom_merc for i, b in enumerate(inner) if i not in drop_pred]
    ref_polys = [g for j, g in enumerate(reference.polys) if j not in drop_ref]

    # 画素: 外した物体の画素は、その物体の側の配列から除く（棟と画素は、同じ決定で扱う）
    pred_mask = vectorize.mask_without_edge(comps, mask.shape, skip={b.comp_index for i, b in enumerate(inner) if i in drop_pred})
    ref_mask = rasterize_polys(ref_polys, z, x, y, size)
    tp, fp, fn = pixel_counts(pred_mask, ref_mask)

    otp = match_objects(pred_polys, ref_polys, iou_min)
    return Counts(
        px_tp=tp,
        px_fp=fp,
        px_fn=fn,
        obj_tp=otp,
        obj_fp=len(pred_polys) - otp,
        obj_fn=len(ref_polys) - otp,
        n_ref=len(ref_polys),
        n_pred=len(pred_polys),
        excl_ref=reference.n_edge + len(drop_ref),
        excl_pred=len(buildings) - len(pred_polys),
        excl_ref_overlap=len(drop_ref),
        excl_pred_overlap=len(drop_pred),
    )


def reference_vs_2014(
    prob,
    z: int,
    x: int,
    y: int,
    reference: Reference,
    *,
    threshold: float,
    params: diff.DiffParams,
    min_blob_m2: float = vectorize.DEFAULT_MIN_BLOB_M2,
    simplify_m: float = vectorize.DEFAULT_SIMPLIFY_M,
) -> dict[str, int]:
    """正解の建物データにある既存の建物（面積 params.min_area_m2 以上・縁に接しない）を、差分の判定にそのままかける。

    2014 年の抽出が何も見ていない（confirmed_new の 2014 側の条件）棟数 absent と、半分以上覆う（existing_omission の条件）棟数 present。
    diff.classify に ov_kiban=0（建物データに載っていない塊とみなす）を渡すので、判定の式は差分と同じ。
    """
    p = vectorize.as_prob_array(prob)
    b18 = vectorize.vectorize_tile(p, z, x, y, threshold=threshold, min_blob_m2=min_blob_m2, simplify_m=simplify_m)
    cover_2014 = diff.cover_of([b.geom_m for b in b18])
    n = absent = present = 0
    for g_merc in reference.polys:
        g_m = geo.lonlat_to_metric_geom(geo.merc_to_lonlat_geom(g_merc))
        ov_2014, p90 = diff.evidence_vs_2014(g_m, g_merc, cover_2014, p, z, x, y)
        d = diff.classify(
            area_m2=round(g_m.area, 2), ov_kiban=0.0, ov_2014=ov_2014, prob_2014_p90=p90, edge_touch=False, params=params
        )
        if d.cls is None:  # 面積が小さい
            continue
        n += 1
        absent += d.cls == diff.CLASS_NEW
        present += d.cls == diff.CLASS_OMISSION
    return {"n": n, "absent": absent, "present": present}


def _ratio(num: float, den: float):
    return None if den == 0 else round(num / den, 4)


def pixel_metrics(tp: int, fp: int, fn: int) -> dict:
    return {
        "iou": _ratio(tp, tp + fp + fn),
        "precision": _ratio(tp, tp + fp),
        "recall": _ratio(tp, tp + fn),
        "f1": _ratio(2 * tp, 2 * tp + fp + fn),
        "tp": tp,
        "fp": fp,
        "fn": fn,
    }


def object_metrics(tp: int, fp: int, fn: int) -> dict:
    return {
        "f1": _ratio(2 * tp, 2 * tp + fp + fn),
        "precision": _ratio(tp, tp + fp),
        "recall": _ratio(tp, tp + fn),
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "n_ref": tp + fn,  # 縁を除いた参照の物体数
        "n_pred": tp + fp,
    }


def metrics_from_counts(c: Counts) -> dict:
    return {"pixel": pixel_metrics(c.px_tp, c.px_fp, c.px_fn), "object": object_metrics(c.obj_tp, c.obj_fp, c.obj_fn)}


def split_tiles(tiles: Sequence) -> tuple[list, list]:
    """並び順の前半（調整用）と後半（評価用）。12 枚なら 6 枚ずつ。"""
    half = len(tiles) // 2
    return list(tiles[:half]), list(tiles[half:])


def choose_setting(sweep: Sequence[dict]) -> dict:
    """物体単位 F1（調整用）が最大の行。同点は 画素 F1 → 倍率が小さい → 閾値が 0.5 に近い → 閾値が小さい。"""

    def key(r):
        f1o = -1.0 if r["tune_object_f1"] is None else r["tune_object_f1"]
        f1p = -1.0 if r["tune_pixel_f1"] is None else r["tune_pixel_f1"]
        return (-round(f1o, 6), -round(f1p, 6), r["scale"], round(abs(r["threshold"] - 0.5), 6), r["threshold"])

    return min(sweep, key=key)


def run_evaluation(
    tiles: Sequence[TileKey],
    load_prob: Callable[[TileKey, float], np.ndarray],
    references: dict[TileKey, Reference],
    *,
    scales: Sequence[float] = DEFAULT_SCALES,
    thresholds: Sequence[float] = DEFAULT_THRESHOLDS,
    min_blob_m2: float = vectorize.DEFAULT_MIN_BLOB_M2,
    simplify_m: float = vectorize.DEFAULT_SIMPLIFY_M,
    reference: str = "",
    reference_detail: dict | None = None,
    reference_notes: Sequence[str] = (),
    extra_notes: Sequence[str] = (),
    load_prob_compare: Callable[[TileKey, float], np.ndarray] | None = None,
    compare_year: int | None = None,
    diff_params: diff.DiffParams | None = None,
) -> dict:
    """評価の全体（eval.json の本体）。load_prob(タイル, 倍率) は 2014 年の確率の配列を返す。

    load_prob_compare と compare_year を渡すと、同じ参照・同じ設定（2014 年の調整用で選んだ倍率・閾値）で、その年の写真の抽出も測る
    （year_compare。選択には使わない）。diff_params は existing_absent_in_2014 の判定に使う（既定は DiffParams の既定値）。
    reference_notes は、参照の素性についての注記（呼び出し側が、読み込んだデータから作る）。
    """
    tiles = list(tiles)
    tune, holdout = split_tiles(tiles)
    if not tune or not holdout:
        raise ValueError(f"評価には 2 枚以上のタイルが要る（調整用と評価用に分けるため）: {len(tiles)} 枚")
    if (load_prob_compare is None) != (compare_year is None):
        raise ValueError("load_prob_compare と compare_year は、両方渡すか両方省く")
    if compare_year is not None and compare_year == EVAL_YEAR:
        raise ValueError(f"compare_year は評価の年（{EVAL_YEAR}）とは別の年にする")
    diff_params = diff_params or diff.DiffParams()

    def run_one(keys, scale, threshold, probs):
        total = Counts()
        for k in keys:
            total += evaluate_tile(
                probs[k], *k, references[k], threshold=threshold, min_blob_m2=min_blob_m2, simplify_m=simplify_m
            )
        return total

    sweep = []
    for scale in scales:
        probs = {k: load_prob(k, scale) for k in tune}
        for thr in thresholds:
            m = metrics_from_counts(run_one(tune, scale, thr, probs))
            sweep.append(
                {
                    "scale": scale,
                    "threshold": thr,
                    "tune_object_f1": m["object"]["f1"],
                    "tune_object_precision": m["object"]["precision"],
                    "tune_object_recall": m["object"]["recall"],
                    "tune_pixel_iou": m["pixel"]["iou"],
                    "tune_pixel_f1": m["pixel"]["f1"],
                }
            )
    best = choose_setting(sweep)
    chosen = {"scale": best["scale"], "threshold": best["threshold"], "selected_by": "調整用タイルの物体単位 F1"}

    per_tile: dict[TileKey, Counts] = {}
    per_tile_compare: dict[TileKey, Counts] = {}
    absence: dict[TileKey, dict[str, int]] = {}
    for k in tiles:
        p = load_prob(k, chosen["scale"])
        per_tile[k] = run_one([k], chosen["scale"], chosen["threshold"], {k: p})
        absence[k] = reference_vs_2014(
            p, *k, references[k], threshold=chosen["threshold"], params=diff_params, min_blob_m2=min_blob_m2, simplify_m=simplify_m
        )
        if load_prob_compare is not None:
            per_tile_compare[k] = run_one([k], chosen["scale"], chosen["threshold"], {k: load_prob_compare(k, chosen["scale"])})

    def total_of(keys, counts=per_tile) -> Counts:
        out = Counts()
        for k in keys:
            out += counts[k]
        return out

    def excluded(keys) -> dict:
        t = total_of(keys)
        return {"reference": t.excl_ref, "prediction": t.excl_pred}

    def excluded_detail(keys) -> dict:
        t = total_of(keys)
        return {
            "reference": {"touching_edge": t.excl_ref - t.excl_ref_overlap, "overlapping_excluded_prediction": t.excl_ref_overlap},
            "prediction": {"touching_edge": t.excl_pred - t.excl_pred_overlap, "overlapping_excluded_reference": t.excl_pred_overlap},
        }

    def by_split(counts) -> dict:
        return {
            "tune": metrics_from_counts(total_of(tune, counts)),
            "holdout": metrics_from_counts(total_of(holdout, counts)),
            "overall": metrics_from_counts(total_of(tiles, counts)),
        }

    def absence_of(keys) -> dict:
        n = sum(absence[k]["n"] for k in keys)
        a = sum(absence[k]["absent"] for k in keys)
        pr = sum(absence[k]["present"] for k in keys)
        return {"n_buildings": n, "absent": a, "absent_share": _ratio(a, n), "present": pr, "present_share": _ratio(pr, n)}

    split_of = {k: ("tune" if k in tune else "holdout") for k in tiles}
    # 表で読みやすいよう、地区ごとの行は平らにする（入れ子にしない）
    per_area = []
    for k in tiles:
        m = metrics_from_counts(per_tile[k])
        per_area.append(
            {
                "area_id": tilemath.area_id(*k),
                "split": split_of[k],
                "pixel_iou": m["pixel"]["iou"],
                "pixel_f1": m["pixel"]["f1"],
                "object_f1": m["object"]["f1"],
                "object_precision": m["object"]["precision"],
                "object_recall": m["object"]["recall"],
                "n_ref": m["object"]["n_ref"],
                "n_pred": m["object"]["n_pred"],
                "excluded_ref": per_tile[k].excl_ref,
                "excluded_pred": per_tile[k].excl_pred,
            }
        )

    notes = [
        "参照の時期（推定）: 参照の建物データは、写真（2014 年）より古い可能性がある。写真にあって参照に無い建物（参照より後にできた建物）は予測の誤検出（FP）に、"
        "参照に残っていて写真では取り壊されている建物は見逃し（FN）に数えられる。このため、物体単位の適合率は、モデルの適合率ではなく、"
        "モデルの精度と参照の完全性が混ざった値である（この 2 つを分けて測れる正解データが無い）。",
        *reference_notes,
        "タイルの縁に接する物体は、参照・予測の両方から外した。さらに、外した物体と自分の面積の半分以上が重なる反対側の物体も外した"
        "（縁の手前で止まった予測の相手の参照、縁まで届いて隣と合体した予測の中の参照が、片側だけ残るのを防ぐ。外した物体を起点にした 1 段だけ）。"
        "画素の指標では、外した物体の画素を、その物体の側の配列から除いた。外した数は excluded_edge_objects（縁に接する数と重なりで外した数の内訳は excluded_edge_detail）。",
        "倍率・閾値は調整用のタイルだけで選んだ（物体単位 F1 が最大。同点は画素 F1 → 倍率が小さい順 → 閾値が 0.5 に近い順）。評価用と全体は、選んだ値のままの結果。",
        "物体単位は IoU >= 0.5 の 1 対 1 対応（IoU の大きい順に貪欲に対応づける）。画素の指標は、予測の配列と同じ格子（256×倍率）で数えた。",
        f"標本は {len(tiles)} 地区（z18 のタイル 1 枚ずつ）だけ。地域全体の精度ではない。",
        "新築の再現率は、正解になる新築のデータが無いので未測定（new_building_recall = null）。",
    ]
    if compare_year is not None:
        notes.append(
            f"year_compare: 同じ参照・同じ設定（倍率 {chosen['scale']}・閾値 {chosen['threshold']}。{EVAL_YEAR} 年の調整用で選んだ値のまま）で、"
            f"{compare_year} 年の写真の抽出も測った。参照は同じものなので、{compare_year} 年の写真にだけ写る建物（参照より後の新築）は誤検出に数えられる。"
            f"{compare_year} 年の指標が {EVAL_YEAR} 年より低ければ、参照の古さと整合する。ただし、原因はこれだけでは分けられない"
            "（写真の撮影条件・解像度・季節・モデルの得意不得意も混ざる）。選択には使っていない。"
        )
    notes.append(
        f"existing_absent_in_2014: 正解の建物データにある既存の建物（面積 {diff_params.min_area_m2:g} m² 以上・縁に接しない）のうち、"
        f"{EVAL_YEAR} 年の抽出が何も見ていない（差分の confirmed_new の {EVAL_YEAR} 年側の条件: ov_2014 <= {diff_params.new_ov_2014_max:g} かつ "
        f"prob_2014_p90 < {diff_params.new_p90_max:g}。diff の関数をそのまま使って判定）棟の数と割合（absent）、"
        f"ov_2014 >= {diff_params.omission_ov_2014_min:g}（{EVAL_YEAR} 年の抽出が半分以上を覆う）の棟の数と割合（present）。"
        "既存の建物が差分の「新規出現」の条件を満たしてしまう割合の目安で、正解データの代わりにはならない"
        "（absent には、モデルの見逃しと、写真の時点で取り壊し済みの参照の建物の両方が入り、分けられない。写真で既存の建物が見えるかは確かめていない）。"
    )
    no_ref = [tilemath.area_id(*k) for k in tiles if per_tile[k].n_ref == 0]
    if no_ref:
        notes.append(f"縁を除いた参照の建物が 0 の地区（その地区の再現率・物体単位 F1 は定義できず null）: {', '.join(no_ref)}")
    notes.extend(extra_notes)

    protocol = {
        "year": EVAL_YEAR,
        "iou_match": IOU_MATCH,
        "matching": "greedy one-to-one by IoU",
        "min_blob_m2": min_blob_m2,
        "simplify_m": simplify_m,
        "scales": list(scales),
        "thresholds": list(thresholds),
        "edge_overlap_min": EDGE_OVERLAP_MIN,
    }
    result = {
        "reference": reference,
        "reference_detail": reference_detail or {},
        "split": {"tune": [tilemath.area_id(*k) for k in tune], "holdout": [tilemath.area_id(*k) for k in holdout]},
        "protocol": protocol,
        "sweep": sweep,
        "chosen": chosen,
        "holdout": metrics_from_counts(total_of(holdout)),
        "tune": metrics_from_counts(total_of(tune)),
        "overall": metrics_from_counts(total_of(tiles)),
        "per_area": per_area,
        "excluded_edge_objects": excluded(tiles),  # 外した数（参照・予測）。平らな辞書（画面がそのまま表示する）
        "excluded_edge_by_split": {"tune": excluded(tune), "holdout": excluded(holdout)},
        "excluded_edge_detail": {"overall": excluded_detail(tiles), "tune": excluded_detail(tune), "holdout": excluded_detail(holdout)},
        "existing_absent_in_2014": {
            "setting": {"scale": chosen["scale"], "threshold": chosen["threshold"]},
            "params": diff_params.to_dict(),
            "overall": absence_of(tiles),
            "tune": absence_of(tune),
            "holdout": absence_of(holdout),
        },
        "new_building_recall": None,
        "notes": notes,
    }
    if compare_year is not None:
        protocol["compare_year"] = compare_year
        result["year_compare"] = {
            "selected_on_year": EVAL_YEAR,
            "compare_year": compare_year,
            "setting": {"scale": chosen["scale"], "threshold": chosen["threshold"]},
            "by_year": {str(EVAL_YEAR): by_split(per_tile), str(compare_year): by_split(per_tile_compare)},
        }
    return result
