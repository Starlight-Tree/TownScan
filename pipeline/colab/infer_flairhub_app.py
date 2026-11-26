"""アプリの地区の写真（IGN のタイル。2014・2024 年）に、IGN の FLAIR-HUB をかける（Colab の T4 で実行する。仕様 §4.1）。

モデル・重み・組み立て・正規化は infer_flairhub.py と同じ。入力は IGN の公開タイル配信の z18・256 px
（県 92 の緯度で約 0.39 m/px）で、PIL の双三次で 512 px（約 0.2 m/px。学習の解像度）にする。
出力は colabio の形: prob_{year}_{x}_{y}_s200.npy（float16・512×512）・tile_{year}_{x}_{y}.png・meta.json。

PART は setup・infer・pack。TILES は {"x", "y"} の一覧（順に意味がある）。
実行役は colab_source(PART, TILES) の文字列を実行する（Colab には 1 回に 1 つの文字列しか送れない）。
先頭に行が付くので、このファイルでは from __future__ を使わない。
取り出したあとは、手元で照合して展開する（repo の直下で）:
  python3 -B -m pipeline.colab.infer_flairhub_app unpack <取り出したフォルダ> data/townscan/fr2/colab
"""

import hashlib
import io
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

try:
    import infer_flairhub as flair  # Colab: colab_source が先に読み込む
except ModuleNotFoundError:
    from pipeline.colab import infer_flairhub as flair

base = flair.base

IGN_WMTS = "https://data.geopf.fr/wmts"
ZOOM = 18
YEARS = (2014, 2024)
# 年ごとのレイヤーとタイルの組の名前（配信の説明 GetCapabilities の値。infer.py で 2026-11-27 に確認したもの）
LAYERS = {2014: ("ORTHOIMAGERY.ORTHOPHOTOS2014", "PM_0_18"), 2024: ("ORTHOIMAGERY.ORTHOPHOTOS2024", "PM_6_19")}
TILE_PX = 256
INPUT_PX = flair.IMAGE_PX
SCALE_KEY = "s200"  # 256 px に対する比が 2.0（colabio の名前の決まり）
INTERVAL_S = 0.5  # 配信元への負荷を抑える
OUT_DIR = "/content/app_probs"
PACK_DIR = "/content/app_pack"
_OUTPUT_RE = re.compile(r"^(prob_(2014|2024)_\d+_\d+_s200\.npy|tile_(2014|2024)_\d+_\d+\.png|meta\.json)$")


def colab_source(part, tiles):
    """Colab で 1 回に実行するソース。共通の 2 つのスクリプトを同じ名前のモジュールとして読み込み、PART と TILES を置いて続ける。"""
    here = Path(__file__).resolve()
    lines = ["import sys, types\n"]
    for name in ("infer_fotbcd", "infer_flairhub"):  # 後ろは前を読み込むので、この順
        source = (here.parent / f"{name}.py").read_text(encoding="utf-8")
        lines.append(
            f"_module = types.ModuleType({name!r})\n"
            f"sys.modules[{name!r}] = _module\n"
            f"exec(compile({source!r}, {name!r}, 'exec'), _module.__dict__)\n"
        )
    chosen = [{"x": int(t["x"]), "y": int(t["y"])} for t in tiles]
    lines.append(f"PART = {part!r}\nTILES = {chosen!r}\n")
    return "".join(lines) + here.read_text(encoding="utf-8")


def tile_url(year, x, y):
    layer, matrix_set = LAYERS[year]
    return (
        f"{IGN_WMTS}?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER={layer}&STYLE=normal&FORMAT=image/jpeg"
        f"&TILEMATRIXSET={matrix_set}&TILEMATRIX={ZOOM}&TILEROW={y}&TILECOL={x}"
    )


def fetch_tile(url):
    request = urllib.request.Request(url, headers={"User-Agent": base.USER_AGENT})
    with urllib.request.urlopen(request, timeout=120) as r:
        return r.read()


def model_input(img):
    """256 px の写真 → (512, 512, 3) の float32（正規化済み）。"""
    import numpy as np
    from PIL import Image

    large = img.resize((INPUT_PX, INPUT_PX), Image.BICUBIC)
    return (np.asarray(large, dtype=np.float32) - np.array(flair.MEAN, np.float32)) / np.array(flair.STD, np.float32)


def run_infer(tiles, out_dir, predict, *, fetch=fetch_tile, sleep=time.sleep):
    """地区の順・年の順に、取得して推論して保存する。取得の記録を返す。取れないタイルがあれば、そこで止める。"""
    import numpy as np
    from PIL import Image

    if not tiles:
        raise ValueError("TILES が空")
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    records = []
    for tile in tiles:
        x, y = tile["x"], tile["y"]
        for year in YEARS:
            try:
                data = fetch(tile_url(year, x, y))
            finally:
                sleep(INTERVAL_S)
            img = Image.open(io.BytesIO(data)).convert("RGB")
            if img.size != (TILE_PX, TILE_PX):
                raise ValueError(f"タイルの大きさが違う: {img.size}（{year} 年 x={x} y={y}）")
            probs = np.asarray(predict(model_input(img)[None]))
            if probs.shape != (1, INPUT_PX, INPUT_PX):
                raise ValueError(f"推論の出力の形が違う: {probs.shape}")
            if not (np.isfinite(probs).all() and probs.min() >= 0 and probs.max() <= 1):
                raise ValueError("推論の出力が 0〜1 の外か、NaN がある")
            img.save(out / f"tile_{year}_{x}_{y}.png")
            base._save(out / f"prob_{year}_{x}_{y}_{SCALE_KEY}.npy", probs[0].astype(np.float16))
            records.append(
                {
                    "year": year,
                    "x": x,
                    "y": y,
                    "fetched": True,
                    "bytes": len(data),
                    "source_sha256": hashlib.sha256(data).hexdigest(),
                }
            )
    return records


def write_meta(out_dir, environment, records):
    meta = {
        "model": flair.MODEL["repo"],
        "model_revision": flair.MODEL["revision"],
        "model_sha256": flair.MODEL["sha256"],
        "encoder": flair.ENCODER,
        "building_class": flair.BUILDING_CLASS,
        "probability": f"softmax over {flair.NUM_CLASSES} outputs",
        "normalization": {"input": "RGB 0-255", "mean": list(flair.MEAN), "std": list(flair.STD)},
        "resize": f"PIL BICUBIC {TILE_PX} -> {INPUT_PX} px",
        "source": f"{IGN_WMTS} (WMTS z{ZOOM}, image/jpeg)",
        "layers": {str(year): LAYERS[year][0] for year in YEARS},
        "scales": {SCALE_KEY: INPUT_PX},
        "tiles": records,
        **environment,
    }
    Path(out_dir, "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def pack(out_dir, pack_dir):
    """出力を tar にする。meta.json の取得の記録 1 件につき、写真と確率の 2 つがそろっていなければ止める。"""
    meta_path = Path(out_dir, "meta.json")
    if not meta_path.is_file():
        raise ValueError("meta.json が無い。推論（PART=infer）が終わっていない")
    records = json.loads(meta_path.read_text(encoding="utf-8"))["tiles"]
    return base.pack(out_dir, pack_dir, output_re=_OUTPUT_RE, expected=len(records) * 2 + 1)


def unpack(pack_dir, dest_dir):
    return base.unpack(pack_dir, dest_dir, output_re=_OUTPUT_RE)


def run_part(part, tiles):
    if part == "setup":
        flair.run_part("setup")
    elif part == "infer":
        predict, environment = flair._load_predict()
        Path(OUT_DIR, "meta.json").unlink(missing_ok=True)  # 途中で止まったときに、前の meta.json で詰めない
        records = run_infer(tiles, OUT_DIR, predict)
        write_meta(OUT_DIR, environment, records)
        print("INFER", json.dumps({"tiles": len(records), "bytes": sum(r["bytes"] for r in records)}))
    elif part == "pack":
        print("PACK", json.dumps(pack(OUT_DIR, PACK_DIR)))
    else:
        raise ValueError(f"PART は setup・infer・pack のどれか: {part!r}")


def cli(argv):
    if len(argv) == 3 and argv[0] == "unpack":
        print(f"展開した: {unpack(argv[1], argv[2])} ファイル → {argv[2]}")
        return 0
    print("使い方: python3 -B -m pipeline.colab.infer_flairhub_app unpack <取り出したフォルダ> <展開先>", file=sys.stderr)
    return 2


if "PART" in globals():  # Colab: colab_source が置く
    run_part(globals()["PART"], globals()["TILES"])
elif __name__ == "__main__":
    raise SystemExit(cli(sys.argv[1:]))
