"""契約の検査が期待する、合成データ（contract/synthetic.py）の中身。

検査が API に入れて読み戻すデータは、scripts/test-contract.sh が `python -m pipeline.load` で入れた合成データの run（kind=synthetic）。
数字・件数は、結果から読まずにここへ決め打ちで書く。導き方（どれも synthetic.py の定義から）:

- 地区 3 つ: タイル (X0, Y0)=(226249, 105759) を基準に、(dx, dy) = (0,0) 合成町・(1,0) 試験町・(0,1) 仮想町。
  並びは北から南・西から東（y、x の昇順）で、A1(合成町)・A2(試験町)・A3(仮想町)。
- 候補 9 つ: 地区ごとに 3 つ。タイル内の画素の箱 (左, 上, 右, 下) が CANDIDATE_DEFS で決まっている（下の PX_BOX）。
  候補 id は `c-{x}-{y}-{n}`。n は、その地区の中で面積の大きい順の連番（合成の面積は画素数で決まる）。
- area_m2 = 画素数 × (地上解像度 m/画素)^2 を 0.1 に丸めた値。地上解像度 = 156543.03392 · cos(緯度) / 2^18（z18）。
  どの地区も約 0.2519 m²/画素なので、画素数から導ける: 2000 画素 → 503.8、1440 → 362.8、1200 → 302.3、300 → 75.6
  （A1・A2 は同じ緯度で同じ値。A3 は緯度が 1 タイル南だが、0.1 に丸めると同じ 75.6）。A3 の 750 → 188.9、480（A2）→ 120.9、400 → 100.8。
- 同じ面積（75.6 が 3 つ）の順は、API の並びの規則（面積の降順、同じなら id の昇順）で決まる。
- 緯度経度は、Web メルカトルのタイル座標（z18）から導く（下の tile_lonlat）。丸めの差を見込んで 1e-6 度（約 0.1 m）の許容で比べる。
- 件数: 2018 年は未検出（confirmed_new）4・2018 年も検出（existing_omission）3・未判定（uncertain。どちらも理由は edge）2、合計 9。建物は 1 地区 8（2018 年 3＋2023 年 5）× 3 = 24。
"""

from __future__ import annotations

import math
from dataclasses import dataclass

Z = 18
RUN_ID = "synthetic-test"
RUN_KIND = "synthetic"
RUN_CREATED_AT = "2026-11-24T12:00:00+09:00"
RUN_MODEL = "synthetic-fixture（モデルなし。合成データ）"
COUNTS = {"areas": 3, "candidates": 9, "buildings": 24}

CLASSES = ("confirmed_new", "existing_omission", "uncertain")
CLASS_LABELS = {
    "confirmed_new": "2018 年は未検出",
    "existing_omission": "2018 年も検出",
    "uncertain": "未判定",
}
# 未判定の候補は、理由で呼び分ける（並びは、返り値の held の順）
HELD_LABELS = {"ambiguous": "要確認", "edge": "端のため未判定"}


def row_label(cls: str, reason: str) -> str:
    """候補 1 件の呼び名。"""
    return HELD_LABELS.get(reason, CLASS_LABELS[cls]) if cls == "uncertain" else CLASS_LABELS[cls]


A1, A2, A3 = "z18-226249-105759", "z18-226250-105759", "z18-226249-105760"

# provenance の固定の文（旧 Python の API の provenance.py。git 履歴 e9a6614）
SOURCE_CANDIDATES = "国土地理院 空中写真（年度別 2018・2023 年）から建物を抽出し、2 時点を比較した結果"
SOURCE_ACCURACY = "基盤地図情報（2018-10 版）を参照にした、2018 年の写真での建物抽出の評価"
NOTE_SYNTHETIC = "合成データ（テスト用）です。実データではありません。"
NOTE_UNVERIFIED_ACCURACY = "数字は 2018 年の写真で測った値。新築の再現率は正解になる新築のデータが無く未測定。分類の閾値は未検証の初期値。"

# 候補の説明文（旧 Python の API の explanations.py。git 履歴 e9a6614。reason ごとの固定文）
EXPLANATIONS = {
    "new_absent_2018": "2023 年の写真では建物を検出し、2018 年の写真では検出していません。前からある建物の場合もあるので、写真で確かめてください。",
    "present_2018": "2018 年の写真にも既に建物があります。建物データ（基盤地図情報）の描き漏れの可能性が高く、新築とは限りません。",
    "edge": "写真（タイル）の端に接していて建物が切れている可能性があるため、分けていません。面積は実際より小さい場合があります。",
}

# 分類ごとの証拠（synthetic.py の EVIDENCE。edge_touch は候補ごと）
EVIDENCE = {
    "confirmed_new": {"prob_2023_mean": 0.91, "ov_2018": 0.02, "prob_2018_p90": 0.05, "ov_kiban": 0.0},
    "existing_omission": {"prob_2023_mean": 0.88, "ov_2018": 0.83, "prob_2018_p90": 0.77, "ov_kiban": 0.05},
    "uncertain": {"prob_2023_mean": 0.74, "ov_2018": 0.30, "prob_2018_p90": 0.40, "ov_kiban": 0.10},
}


def tile_lonlat(x: int, y: int, px: float, py: float) -> tuple[float, float]:
    """z18 のタイル (x, y) の中の画素 (px, py)（256 x 256、左上が原点）の経度・緯度。Web メルカトル。"""
    n = 2**Z
    lon = (x + px / 256) / n * 360.0 - 180.0
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + py / 256) / n))))
    return lon, lat


@dataclass(frozen=True)
class Area:
    id: str
    x: int
    y: int
    name: str
    ward: str
    municipality: str
    counts: dict[str, int]  # 分類ごと + total

    @property
    def bbox(self) -> list[float]:  # [西, 南, 東, 北]
        west, north = tile_lonlat(self.x, self.y, 0, 0)
        east, south = tile_lonlat(self.x, self.y, 256, 256)
        return [west, south, east, north]

    @property
    def centroid(self) -> list[float]:
        b = self.bbox
        return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]


AREAS = [
    Area(A1, 226249, 105759, "合成町", "中央区", "43101", {"confirmed_new": 1, "existing_omission": 1, "uncertain": 1, "total": 3}),
    Area(A2, 226250, 105759, "試験町", "中央区", "43101", {"confirmed_new": 2, "existing_omission": 0, "uncertain": 1, "total": 3}),
    Area(A3, 226249, 105760, "仮想町", "東区", "43102", {"confirmed_new": 1, "existing_omission": 2, "uncertain": 0, "total": 3}),
]
AREA_BY_ID = {a.id: a for a in AREAS}


@dataclass(frozen=True)
class Candidate:
    id: str
    area_id: str
    cls: str
    reason: str
    edge_touch: bool
    px_box: tuple[int, int, int, int]  # タイル内の画素 (左, 上, 右, 下)。synthetic.py の CANDIDATE_DEFS
    area_m2: float

    @property
    def area(self) -> Area:
        return AREA_BY_ID[self.area_id]

    @property
    def ring(self) -> list[list[float]]:
        l, t, r, b = self.px_box
        a = self.area
        return [list(tile_lonlat(a.x, a.y, px, py)) for px, py in ((l, t), (r, t), (r, b), (l, b), (l, t))]

    @property
    def bbox(self) -> list[float]:
        lons, lats = [p[0] for p in self.ring], [p[1] for p in self.ring]
        return [min(lons), min(lats), max(lons), max(lats)]

    @property
    def centroid(self) -> list[float]:
        b = self.bbox
        return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]

    @property
    def evidence(self) -> dict:
        return {**EVIDENCE[self.cls], "edge_touch": self.edge_touch}


# 面積の降順（同じ面積は id の昇順）。この並びが、API の既定の並び（sort=area_desc）。
# 画素の箱 → 画素数（幅 x 高さ）: 50x40=2000, 40x36=1440, 40x30=1200, 30x25=750, 24x20=480, 20x20=400, 20x15=300（3 つ）
CANDIDATES = [
    Candidate("c-226250-105759-1", A2, "confirmed_new", "new_absent_2018", False, (60, 60, 110, 100), 503.8),
    Candidate("c-226249-105759-1", A1, "uncertain", "edge", True, (216, 200, 256, 236), 362.8),
    Candidate("c-226249-105759-2", A1, "confirmed_new", "new_absent_2018", False, (100, 100, 140, 130), 302.3),
    Candidate("c-226249-105760-1", A3, "existing_omission", "present_2018", False, (90, 90, 120, 115), 188.9),
    Candidate("c-226250-105759-2", A2, "uncertain", "edge", True, (0, 10, 24, 30), 120.9),
    Candidate("c-226249-105760-2", A3, "existing_omission", "present_2018", False, (10, 200, 30, 220), 100.8),
    Candidate("c-226249-105759-3", A1, "existing_omission", "present_2018", False, (30, 40, 50, 55), 75.6),
    Candidate("c-226249-105760-3", A3, "confirmed_new", "new_absent_2018", False, (140, 30, 160, 45), 75.6),
    Candidate("c-226250-105759-3", A2, "confirmed_new", "new_absent_2018", False, (150, 150, 170, 165), 75.6),
]
CANDIDATE_BY_ID = {c.id: c for c in CANDIDATES}
BIGGEST_NEW = "c-226250-105759-1"  # 503.8 m²。分類は新規出現で、全体で最大
BIGGEST_NEW_IN_A1 = "c-226249-105759-2"  # 302.3 m²。A1（合成町）の新規出現

# 面積の昇順（同じ面積は id の昇順）= area_asc
CANDIDATES_ASC = sorted(CANDIDATES, key=lambda c: (c.area_m2, c.id))
# 地図用 GeoJSON の並びも、面積の降順・同じなら id の昇順（sort=area_desc と同じ）

# 評価（eval.json）。synthetic.py の eval_json()（合成の値で、実測ではない）。/api/metrics はこれに provenance を足したもの
EVAL = {
    "reference": "合成データ（基盤地図情報ではない）",
    "split": {"tune": [A1], "holdout": [A2, A3]},
    "sweep": [
        {"scale": 1.0, "threshold": 0.5, "tune_object_f1": 0.5},
        {"scale": 1.5, "threshold": 0.5, "tune_object_f1": 0.6},
    ],
    "chosen": {"scale": 1.5, "threshold": 0.5},
    "holdout": {
        "pixel": {"iou": 0.61, "precision": 0.78, "recall": 0.74, "f1": 0.76},
        "object": {"f1": 0.58, "precision": 0.62, "recall": 0.55},
    },
    "tune": {
        "pixel": {"iou": 0.66, "precision": 0.8, "recall": 0.79, "f1": 0.79},
        "object": {"f1": 0.6, "precision": 0.64, "recall": 0.57},
    },
    "per_area": [{"area_id": i, "object_f1": 0.5} for i in (A1, A2, A3)],
    "excluded_edge_objects": 4,
    "new_building_recall": None,
    "notes": ["合成データ（テスト用）の値で、実測ではない"],
}

# 写真タイル（scripts/test-contract.sh が置く。contract/prepare_data.py）。R=列・G=行（タイル内の位置が画素から分かる）、B=年（2018→50、2023→200）。
# どの候補の写真も、A1 は両年とも読める。A2 の 2018 年は「ファイルが無い」、A3 の 2018 年は「壊れたファイル」、
# A3 の 2023 年は「TILES_DIR の外を指すシンボリックリンク」（読んではいけない）。この 3 つは、画像の 404（tile_not_found）の検査に使う。
TILE_BLUE = {2018: 50, 2023: 200}
TILE_FAULTS = {
    (A2, 2018): "missing",
    (A3, 2018): "corrupt",
    (A3, 2023): "symlink_outside",
}
