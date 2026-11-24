"""事前学習の建物抽出モデルを、熊本の地理院タイルに当てる 1 回目の試し（Colab の T4 で実行する）。

目的: 「動くか・おおよそ当たるか」を見る。精度の評価ではない（正解データが無い）。
モデル: giswqs/whu-building-unetplusplus-efficientnet-b4（Apache-2.0。WHU 0.3 m/px で学習）
入力: 地理院タイル nendophoto2018 / nendophoto2023（z18, 約 0.5 m/px, 256 px）。3 地点 × 2 年 = 6 枚。
比べるもの: 尺度（そのまま 256 px / 2 倍に拡大して 512 px。学習の 0.3 m/px に近づける）×
            正規化（ImageNet の平均・分散 / 0〜1 のみ）。

2 つの部分に分けて、別々に実行する（1 回の実行は約 300 秒まで）:
  PART=setup  : パッケージとモデルの取得
  PART=infer  : タイルの取得と推論。数字を出力し、画像は /content/out/ に保存する（取り出しは HTTP）
"""

import io
import json
import math
import os
import sys
import time
import urllib.error
import urllib.request

PART = globals().get("PART", "setup")
HF = "https://huggingface.co/giswqs/whu-building-unetplusplus-efficientnet-b4/resolve/main/"
GSI = "https://cyberjapandata.gsi.go.jp/xyz/"
UA = "TownScan-spike/0.1 (personal learning project)"
Z = 18
POINTS = [("center", 32.8032, 130.7079), ("suizenji", 32.7872, 130.7358), ("kengun", 32.7895, 130.7625)]  # 中心 / 水前寺 / 健軍
YEARS = [2018, 2023]


def tile_xy(lat, lon, z=Z):
    n = 2**z
    x = int((lon + 180) / 360 * n)
    y = int((1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n)
    return x, y


def fetch(url, dest=None):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=120) as r:
        data = r.read()
    if dest:
        with open(dest, "wb") as f:
            f.write(data)
    return data


if PART == "setup":
    import subprocess

    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "segmentation-models-pytorch"], check=True)
    fetch(HF + "config.json", "config.json")
    fetch(HF + "model.pth", "model.pth")
    import torch

    print("torch", torch.__version__, "cuda", torch.cuda.is_available(), torch.cuda.get_device_name(0) if torch.cuda.is_available() else "")
    import segmentation_models_pytorch as smp

    print("smp", smp.__version__)
    print(open("config.json").read())

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
    print("load_state_dict:", model.load_state_dict(sd, strict=False))
    model.to(dev).eval()

    MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
    STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)

    def predict(img, norm):
        a = np.asarray(img.convert("RGB"), dtype=np.float32) / 255.0
        if norm == "imagenet":
            a = (a - MEAN) / STD
        t = torch.from_numpy(a.transpose(2, 0, 1)).unsqueeze(0).to(dev)
        with torch.no_grad():
            p = torch.softmax(model(t), dim=1)[0, 1].cpu().numpy()
        return p  # 建物の確率 (H, W)

    def overlay(img, prob, size=256):
        im = img.convert("RGB").resize((size, size))
        m = np.asarray(Image.fromarray((prob * 255).astype(np.uint8)).resize((size, size)), dtype=np.float32) / 255.0 > 0.5
        a = np.asarray(im, dtype=np.float32).copy()
        a[m] = a[m] * 0.45 + np.array([255, 0, 0], dtype=np.float32) * 0.55
        return Image.fromarray(a.astype(np.uint8))

    rows = []
    sheets = {}
    for name, lat, lon in POINTS:
        x, y = tile_xy(lat, lon)
        panels = []
        for yr in YEARS:
            img = None
            for ext in ("png", "jpg"):
                try:
                    img = Image.open(io.BytesIO(fetch(f"{GSI}nendophoto{yr}/{Z}/{x}/{y}.{ext}")))
                    break
                except urllib.error.HTTPError as e:
                    if e.code != 404:
                        raise
                time.sleep(0.5)
            time.sleep(0.5)
            if img is None:
                rows.append({"point": name, "year": yr, "tile": f"{Z}/{x}/{y}", "fetched": False})
                continue
            img = img.convert("RGB")
            up = img.resize((512, 512), Image.BICUBIC)
            res = {"point": name, "year": yr, "tile": f"{Z}/{x}/{y}", "size": img.size}
            keep = {}
            for norm in ("imagenet", "raw"):
                for scale, im in (("native", img), ("x2", up)):
                    p = predict(im, norm)
                    res[f"{norm}/{scale}"] = round(float((p > 0.5).mean()), 4)  # 建物と判定した画素の割合
                    keep[(norm, scale)] = p
            rows.append(res)
            panels.append([img.resize((256, 256)), overlay(img, keep[("imagenet", "native")]), overlay(up, keep[("imagenet", "x2")])])
        if panels:
            sheet = Image.new("RGB", (768, 256 * len(panels)))
            for r, row in enumerate(panels):
                for c, im in enumerate(row):
                    sheet.paste(im, (256 * c, 256 * r))
            os.makedirs("/content/out", exist_ok=True)
            path = f"/content/out/sheet_{name}.jpg"
            sheet.save(path, "JPEG", quality=85)
            sheets[name] = path

    print("RESULT_JSON", json.dumps(rows, ensure_ascii=False))
    print("SHEETS", json.dumps(sheets, ensure_ascii=False))  # 画像は HTTP で取り出す（出力に base64 を載せない）
