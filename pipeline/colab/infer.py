"""事前学習の建物抽出モデルを、フランスの IGN の航空写真（2014・2024 年）に当てる（Colab の T4 で実行する）。

モデル: giswqs/whu-building-unetplusplus-efficientnet-b4（Apache-2.0。UNet++ / EfficientNet-B4。WHU 0.3 m/px で学習。2 クラス）
正規化: 0〜1 のみ（÷255。ImageNet の平均・分散は使わない。geoai の学習・推論コードで確認済み）。
入力: IGN の公開タイル配信（data.geopf.fr の WMTS。z18、県 92 の緯度で約 0.4 m/px、256 px）。
TILES（実行役が先頭に差し込む）の各タイル × 2014・2024 年。
倍率: 1.0 / 1.5 / 2.0 倍（双三次で拡大して推論。学習の 0.3 m/px に近づける）。出力は建物の確率 float16 (H, W)。

部分に分けて別々に実行する（1 回の実行は約 300 秒まで）。実行役が、先頭に PART = "..." と TILES = [...] を差し込む:
  PART=setup : パッケージとモデルの取得（版・ハッシュを記録）
  PART=infer : タイルの取得（0.5 秒間隔）と推論。/content/out/ に保存
  PART=pack  : /content/out を 1 つの tar にまとめる（取り出しは HTTP）
"""

import hashlib
import io
import json
import math
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

PART = globals().get("PART", "setup")
TILES = globals().get("TILES", [])
REPO = "giswqs/whu-building-unetplusplus-efficientnet-b4"
HF = f"https://huggingface.co/{REPO}/resolve/main/"
IGN_WMTS = "https://data.geopf.fr/wmts"
UA = "TownScan-spike/0.1 (personal learning project)"
Z = 18
YEARS = [2014, 2024]
# 年ごとのレイヤーとタイルの組の名前（配信の説明 GetCapabilities の値。2026-11-27 に確認）
LAYERS = {2014: ("ORTHOIMAGERY.ORTHOPHOTOS2014", "PM_0_18"), 2024: ("ORTHOIMAGERY.ORTHOPHOTOS2024", "PM_6_19")}
SCALES = {"s100": 256, "s150": 384, "s200": 512}
OUT = "/content/out"


def fetch(url, dest=None):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=120) as r:
        data = r.read()
    if dest:
        with open(dest, "wb") as f:
            f.write(data)
    return data


def tile_url(year, x, y):
    layer, matrix_set = LAYERS[year]
    return (
        f"{IGN_WMTS}?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER={layer}&STYLE=normal&FORMAT=image/jpeg"
        f"&TILEMATRIXSET={matrix_set}&TILEMATRIX={Z}&TILEROW={y}&TILECOL={x}"
    )


if PART == "setup":
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "segmentation-models-pytorch==0.6.0"], check=True)
    fetch(HF + "config.json", "config.json")
    fetch(HF + "model.pth", "model.pth")
    meta = {"model": REPO}
    try:
        meta["hf_sha"] = json.loads(fetch(f"https://huggingface.co/api/models/{REPO}"))["sha"]
    except Exception as e:  # 版の記録は補助。失敗しても続ける
        meta["hf_sha"] = f"unavailable: {type(e).__name__}"
    meta["model_sha256"] = hashlib.sha256(open("model.pth", "rb").read()).hexdigest()
    import torch

    import segmentation_models_pytorch as smp

    meta.update(
        torch=torch.__version__,
        smp=smp.__version__,
        cuda=torch.cuda.is_available(),
        device=torch.cuda.get_device_name(0) if torch.cuda.is_available() else "cpu",
    )
    os.makedirs(OUT, exist_ok=True)
    json.dump(meta, open(f"{OUT}/meta_setup.json", "w"), ensure_ascii=False)
    print("SETUP", json.dumps(meta, ensure_ascii=False))
    print(open("config.json").read()[:600])

elif PART == "infer":
    import numpy as np
    import segmentation_models_pytorch as smp
    import torch
    from PIL import Image

    dev = "cuda" if torch.cuda.is_available() else "cpu"
    model = smp.UnetPlusPlus(encoder_name="efficientnet-b4", encoder_weights=None, in_channels=3, classes=2)
    sd = torch.load("model.pth", map_location="cpu")
    if isinstance(sd, dict) and "state_dict" in sd:
        sd = sd["state_dict"]
    sd = {(k[6:] if k.startswith("model.") else k): v for k, v in sd.items()}
    res = model.load_state_dict(sd, strict=False)
    print("load_state_dict missing:", len(res.missing_keys), "unexpected:", len(res.unexpected_keys))
    assert not res.missing_keys and not res.unexpected_keys, "モデルの重みが一致しない"
    model.to(dev).eval()

    def predict(img):
        a = np.asarray(img.convert("RGB"), dtype=np.float32) / 255.0  # 0〜1 のみ
        t = torch.from_numpy(a.transpose(2, 0, 1)).unsqueeze(0).to(dev)
        with torch.no_grad():
            p = torch.softmax(model(t), dim=1)[0, 1].cpu().numpy()
        return p.astype(np.float16)

    os.makedirs(OUT, exist_ok=True)
    meta = {"normalization": "0-1 (/255), no mean/std", "scales": SCALES, "device": dev, "tiles": [], "fetch_log": []}
    t0 = time.time()
    for t in TILES:
        x, y = t["x"], t["y"]
        for yr in YEARS:
            rec = {"year": yr, "x": x, "y": y, "fetched": False}
            img = None
            try:
                data = fetch(tile_url(yr, x, y))
                img = Image.open(io.BytesIO(data))
                rec["bytes"] = len(data)
            except urllib.error.HTTPError as e:
                rec["http"] = e.code
                if e.code not in (400, 404):  # 写真が無い範囲だけは続ける
                    raise
            finally:
                time.sleep(0.5)  # 配信元への負荷を抑える
            if img is None:
                meta["tiles"].append(rec)
                continue
            img = img.convert("RGB")
            rec.update(fetched=True, size=list(img.size))
            img.save(f"{OUT}/tile_{yr}_{x}_{y}.png")
            stats = {}
            for key, px in SCALES.items():
                im = img if px == img.size[0] else img.resize((px, px), Image.BICUBIC)
                p = predict(im)
                np.save(f"{OUT}/prob_{yr}_{x}_{y}_{key}.npy", p)
                stats[key] = round(float((p > 0.5).mean()), 4)  # 建物と判定した画素の割合（目安）
            rec["building_fraction_at_0.5"] = stats
            meta["tiles"].append(rec)
    meta["seconds"] = round(time.time() - t0, 1)
    json.dump(meta, open(f"{OUT}/meta_infer.json", "w"), ensure_ascii=False)
    n_ok = sum(1 for r in meta["tiles"] if r["fetched"])
    print("INFER", json.dumps({"tiles_ok": n_ok, "tiles_total": len(meta["tiles"]), "seconds": meta["seconds"], "device": dev}))
    for r in meta["tiles"]:
        print(r["year"], r["x"], r["y"], r.get("http", ""), r.get("building_fraction_at_0.5", ""))

elif PART == "pack":
    subprocess.run(["tar", "-cf", "/content/townscan_colab.tar", "-C", OUT, "."], check=True)
    print("PACK", os.path.getsize("/content/townscan_colab.tar"), "bytes")
