"""地区名: IGN の逆ジオコーダの応答 → 地区名・市町村名。

純粋な関数（build_area_name）と、取得用の関数（fetch_reverse_geocode・fetch_all）に分ける。
**取得は外部通信なので、メインが承認の範囲で実行する。このモジュールのテスト・後処理は通信しない。**
応答の形式（GeoJSON）: {"features": [{"properties": {"street": "...", "citycode": "92050", "city": "Nanterre"}}]}。
想定と違う応答は、例外を投げず name を None にする。
外部 API の応答は信用しない: 名前が長すぎる・`<>&"` や制御文字を含むときは取得できなかったものとして扱う（画面側が HTML として解釈しても注入にならないように）。
フランス語の通り名の ' は、画面で安全な ’ に置き換える。
画面は name・ward を必ず文字列として使うので、後処理（run_postprocess）は area_fields で、取れなかった地区に代わりの名前を入れる。
取得の例: python -m pipeline.geocode --run-dir data/townscan/fr1   → <run-dir>/geocode.json（{area_id: 応答}）
"""

from __future__ import annotations

import argparse
import json
import re
import time
import unicodedata
import urllib.parse
import urllib.request
from pathlib import Path
from collections.abc import Callable

from . import tilemath

ENDPOINT = "https://data.geopf.fr/geocodage/reverse"
USER_AGENT = "townscan-prototype/0.1 (personal learning project)"
NAME_SOURCE = "ign_reverse_geocoder"

# 県 92 の選んだ地区の市町村（INSEE コード → カタカナ）。無いコードは、応答の市町村名をそのまま使う
COMMUNES_JA = {
    "92019": "シャトネ・マラブリー", "92020": "シャティヨン", "92023": "クラマール", "92032": "フォントネー・オ・ローズ",
    "92048": "ムードン", "92050": "ナンテール", "92060": "ル・プレシ・ロバンソン", "92063": "リュエイユ・マルメゾン",
}
DEPARTMENT = "オー・ド・セーヌ県"

MAX_NAME_LEN = 40  # 通り名・市町村名として長すぎるものは、応答の異常として捨てる
_UNSAFE_CHARS = frozenset("<>&\"'")
FALLBACK_SOURCE = "fallback"  # name_source: name は逆ジオコーダの応答ではなく、地区 id から作った代わりの名前
FALLBACK_WARD = "区不明"


def _text(value) -> str | None:
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        return None
    s = str(value).strip()
    return s or None


def _is_safe_name(name: str) -> bool:
    if len(name) > MAX_NAME_LEN:
        return False
    for ch in name:
        cat = unicodedata.category(ch)
        # C* = 制御文字・書式文字（RLO など）・孤立サロゲート・私用領域・未割り当て。Zl・Zp = 行・段落の区切り
        if ch in _UNSAFE_CHARS or cat[0] == "C" or cat in ("Zl", "Zp"):
            return False
    return True


def _safe_name(value) -> str | None:
    s = _text(value)
    if s is None:
        return None
    s = s.replace("'", "’")
    s = s[:1].upper() + s[1:]
    return s if _is_safe_name(s) else None


def build_area_name(response) -> dict:
    """逆ジオコーダの応答 → {name, ward, municipality, name_source}。どれも分からなければ None。

    name は通り名、ward は市町村、municipality は県（県 92 の応答のときだけ）。名前も市町村も取れなければ name_source も None。
    名前が空・長すぎる・安全でない文字を含むときは name を None にする（表にある市町村は、固定の表から引くので残る）。
    """
    feats = response.get("features") if isinstance(response, dict) else None
    props = feats[0].get("properties") if isinstance(feats, list) and feats and isinstance(feats[0], dict) else None
    if not isinstance(props, dict):
        return {"name": None, "ward": None, "municipality": None, "name_source": None}
    name = _safe_name(props.get("street") or props.get("name"))
    code = _text(props.get("citycode")) or ""
    ward = COMMUNES_JA.get(code) or _safe_name(props.get("city"))
    return {
        "name": name,
        "ward": ward,
        "municipality": DEPARTMENT if code.startswith("92") else None,
        "name_source": NAME_SOURCE if (name or ward) else None,
    }


def fallback_name(area_id: str) -> str:
    """地区 id（z18-132739-90287）から作る代わりの名前（地区 132739-90287）。"""
    return "地区 " + re.sub(r"^z\d+-", "", area_id)


def area_fields(response, area_id: str) -> dict:
    """build_area_name に、取れなかった項目の代わりの値を入れたもの。name・ward は必ず空でない文字列になる。

    name が取れない: name = 「地区 {x}-{y}」・name_source = "fallback"。ward が取れない: ward = 「区不明」。
    municipality は県 92 の応答のときだけ入る（それ以外は None）。
    """
    info = build_area_name(response)
    if info["name"] is None:
        info["name"] = fallback_name(area_id)
        info["name_source"] = FALLBACK_SOURCE
    if info["ward"] is None:
        info["ward"] = FALLBACK_WARD
    return info


def reverse_geocode_url(lon: float, lat: float) -> str:
    return ENDPOINT + "?" + urllib.parse.urlencode({"lon": f"{lon:.6f}", "lat": f"{lat:.6f}", "limit": 1, "index": "address"})


def fetch_reverse_geocode(lon: float, lat: float, *, timeout: float = 15.0, opener: Callable | None = None) -> dict:
    """1 地点の応答を取得して JSON として返す（外部通信。メインが実行する）。opener はテスト用の差し替え。"""
    req = urllib.request.Request(reverse_geocode_url(lon, lat), headers={"User-Agent": USER_AGENT})
    open_fn = opener or urllib.request.urlopen
    with open_fn(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def fetch_all(
    areas: list[dict],
    out_path: str | Path,
    *,
    fetch: Callable[[float, float], dict] = fetch_reverse_geocode,
    delay_s: float = 1.0,
    sleep: Callable[[float], None] = time.sleep,
) -> dict:
    """areas（id・centroid を持つ）の応答を集め、out_path に {area_id: 応答} で書く。

    取得済み（既存の out_path にある）地区は飛ばす。失敗した地区は書かず、戻り値の errors に残す（全体は止めない）。
    """
    out_path = Path(out_path)
    got: dict = {}
    if out_path.exists():
        try:
            got = json.loads(out_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            got = {}
    errors: dict[str, str] = {}
    first = True
    for a in areas:
        if a["id"] in got:
            continue
        if not first:
            sleep(delay_s)  # 相手のサーバーへの負荷を抑える
        first = False
        lon, lat = a["centroid"]
        try:
            got[a["id"]] = fetch(lon, lat)
        except Exception as e:  # 通信・JSON のどの失敗でも、他の地区は続ける
            errors[a["id"]] = f"{type(e).__name__}: {e}"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(got, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"fetched": len(got), "errors": errors}


def main(argv: list[str] | None = None) -> int:
    from . import colabio

    ap = argparse.ArgumentParser(description="地区の中心点の逆ジオコーダ応答を取得して geocode.json に書く（外部通信）")
    ap.add_argument("--run-dir", required=True, help="例: data/townscan/fr1（colab/ と tiles.json がある場所）")
    ap.add_argument("--delay", type=float, default=1.0, help="リクエストの間隔（秒）")
    args = ap.parse_args(argv)
    run_dir = Path(args.run_dir)
    areas = []
    for z, x, y in colabio.read_tiles(run_dir / "colab", run_dir):
        lon, lat = tilemath.tile_center_lonlat(z, x, y)
        areas.append({"id": tilemath.area_id(z, x, y), "centroid": [lon, lat]})
    result = fetch_all(areas, run_dir / "geocode.json", delay_s=args.delay)
    print(json.dumps(result, ensure_ascii=False))
    return 1 if result["errors"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
