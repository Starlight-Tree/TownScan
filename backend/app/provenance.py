"""結果の出どころ（Provenance）。仕様 §4.5: { source, photo_years, model, metric?, run_id, run_kind, note? }"""

from __future__ import annotations

PHOTO_YEARS = [2018, 2023]

SOURCE_CANDIDATES = "国土地理院 空中写真（年度別 2018・2023 年）から建物を抽出し、2 時点を比較した結果"
SOURCE_ACCURACY = "基盤地図情報（2018-10 版）を参照にした、2018 年の写真での建物抽出の評価"

NOTE_SYNTHETIC = "合成データ（テスト用）です。実データではありません。"
NOTE_UNVERIFIED = "分類の閾値は未検証の初期値です。結果は候補で、確定ではありません。"


def provenance(run: dict, *, source: str = SOURCE_CANDIDATES, photo_years: list[int] | None = None,
               metric: str | None = None, note: str | None = None) -> dict:
    notes = []
    if run["kind"] == "synthetic":
        notes.append(NOTE_SYNTHETIC)
    if note:
        notes.append(note)
    out = {
        "source": source,
        "photo_years": list(PHOTO_YEARS if photo_years is None else photo_years),
        "model": run.get("model") or "不明",
        "run_id": run["run_id"],
        "run_kind": run["kind"],
    }
    if metric:
        out["metric"] = metric
    if notes:
        out["note"] = " ".join(notes)
    return out
