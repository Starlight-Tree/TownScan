"""FOTBCD の val に、IGN の FLAIR-HUB（土地被覆）をかけて、建物の確率を保存する（Colab の T4 で実行する）。

今の WHU のモデル（infer_fotbcd.py）と比べる試し。アプリの推論は変えていない。
モデル: IGNF/FLAIR-HUB_LC-A_RGB_swinbase-upernet（Etalab 2.0。2026-11-27 にモデルカードと HF の API で確認）。
組み立て: IGN のコード（github IGNF/FLAIR-HUB の e594f20b。Apache-2.0）の monotemp_model.py・flair_model.py を読み、
  同じ形を segmentation-models-pytorch で作る（IGN のパッケージは入れない。コードは写していない）。
  - エンコーダは入力 3 チャンネル、デコーダと出力の層は、入力 1 チャンネルで作った UPerNet のもの。
  - 入力が航空写真だけのとき、IGN の forward は fusion_handler を通さないので、その重みは使わない。
  - 使う重みは strict=True で読む。
入力: R・G・B の 0〜255 から、学習の設定の平均を引いて標準偏差で割る（モデルの configs_train/config_modalities.yaml）。
出力: 19 の出力の softmax のうち、建物（0 番。config_supervision.yaml）の確率。
条件（学習は 0.2 m/px）:
  native : 組の 512 px の画像（0.2 m/px）をそのまま
  lowres : PIL の双三次で 256 px に縮小してから、双三次で 512 px に戻す（アプリの約 0.4 m の写真の再現）
出力: <条件>/{番号}_{before|after}_512.npy（float16）と <条件>/meta.json。
  条件ごとのフォルダを、evaluate_fotbcd の --probs に渡せる（大きさが 512 だけなので --fixed 1.0,閾値）。

PART は setup・data・infer・pack（流れは infer_fotbcd.py と同じ）。
Colab には 1 回に 1 つの文字列しか送れないので、実行役は colab_source(PART) の文字列を実行する
（共通の処理の infer_fotbcd.py を、同じ名前のモジュールとして先に読み込む）。
先頭に行が付くので、このファイルでは from __future__ を使わない。
取り出したあとは、条件ごとに照合して展開する:
  python -I pipeline/colab/infer_fotbcd.py unpack <取り出したフォルダ>/<条件> data/fr/val/probs_flairhub/<条件>
test は扱わない（ADR 0015）。
"""

import io
import json
import subprocess
import sys
import tarfile
import time
from pathlib import Path

try:
    import infer_fotbcd as base  # Colab: colab_source が先に読み込む
except ModuleNotFoundError:
    from pipeline.colab import infer_fotbcd as base

MODEL = {
    "repo": "IGNF/FLAIR-HUB_LC-A_RGB_swinbase-upernet",
    "revision": "88190fc26a325509a78e4a7289e2ab6a8f5d58a4",
    "file": "FLAIR-HUB_LC-A_RGB_swinbase-upernet.safetensors",
    "bytes": 363_344_504,
    "sha256": "a995a226065b176c29f0a66a4937cc8bcea5741887b3f8c17812c430f75f4e3c",
}
ENCODER = "tu-swin_base_patch4_window12_384"
NUM_CLASSES = 19
BUILDING_CLASS = 0
MEAN = (105.66, 111.35, 102.18)
STD = (52.23, 45.62, 44.30)
SMP_VERSION = "0.4.0"  # IGN の setup.py の版
TIMM_VERSION = "1.0.12"  # SMP 0.4.0 の requirements/required.txt の版（IGN は版を固定していない）
CONDITIONS = {"native": None, "lowres": 256}  # 値は、一度縮小するときの一辺
IMAGE_PX = base.IMAGE_PX
BATCH = 8
MODEL_PATH = "/content/flairhub_model.safetensors"
OUT_DIR = "/content/flairhub_probs"
PACK_DIR = "/content/flairhub_pack"
STATE_PREFIXES = {
    "encoder": "model.encoders.AERIAL_RGBI.seg_model.",
    "decoder": "model.main_decoders.AERIAL_LABEL-COSIA.seg_model.decoder.",
    "segmentation_head": "model.main_decoders.AERIAL_LABEL-COSIA.seg_model.segmentation_head.",
}
UNUSED_PREFIXES = ("model.fusion_handler.", "criterion.")


def colab_source(part):
    """Colab で 1 回に実行するソース。infer_fotbcd.py をモジュールとして読み込み、PART を置いて、このファイルを続ける。"""
    here = Path(__file__).resolve()
    shared = (here.parent / "infer_fotbcd.py").read_text(encoding="utf-8")
    return (
        "import sys, types\n"
        "_shared = types.ModuleType('infer_fotbcd')\n"
        f"exec(compile({shared!r}, 'infer_fotbcd', 'exec'), _shared.__dict__)\n"
        "sys.modules['infer_fotbcd'] = _shared\n"
        f"PART = {part!r}\n" + here.read_text(encoding="utf-8")
    )


def split_state_dict(state):
    """重みの一式を、エンコーダ・デコーダ・出力の層に分ける。想定しない名前や、空の部分があれば止める。"""
    parts = {name: {} for name in STATE_PREFIXES}
    unknown = []
    for key, value in state.items():
        for name, prefix in STATE_PREFIXES.items():
            if key.startswith(prefix):
                parts[name][key[len(prefix) :]] = value
                break
        else:
            if not key.startswith(UNUSED_PREFIXES):
                unknown.append(key)
    empty = [name for name, part in parts.items() if not part]
    if unknown or empty:
        raise ValueError(f"重みの名前が想定と違う: 知らない名前 {sorted(unknown)[:5]}・空の部分 {empty}")
    return parts


def load_image(tf, member, low_px):
    """画像 → (512, 512, 3) の float32（正規化済み）。low_px があれば、その一辺に縮小してから 512 に戻す。"""
    import numpy as np
    from PIL import Image

    img = Image.open(io.BytesIO(tf.extractfile(member).read())).convert("RGB")
    if img.size != (IMAGE_PX, IMAGE_PX):
        raise ValueError(f"画像の大きさが違う: {img.size}: {member.name}")
    if low_px:
        img = img.resize((low_px, low_px), Image.BICUBIC).resize((IMAGE_PX, IMAGE_PX), Image.BICUBIC)
    return (np.asarray(img, dtype=np.float32) - np.array(MEAN, np.float32)) / np.array(STD, np.float32)


def run_infer(tar_path, out_dir, predict, *, batch=BATCH, budget_s=base.BUDGET_S, clock=time.monotonic):
    """まだ無い出力を推論して保存する。predict は (N, 512, 512, 3) の正規化済み → (N, 512, 512) の建物の確率。

    時間の上限を超えたら、次の束を始めずに戻る（1 回の呼び出しで、少なくとも 1 束は進む）。
    """
    import numpy as np

    out = Path(out_dir)
    start = clock()
    done = 0
    with tarfile.open(tar_path, "r:") as tf:
        members = base.image_members(tf)
        todo = {}
        for condition in CONDITIONS:
            (out / condition).mkdir(parents=True, exist_ok=True)
            todo[condition] = [
                (k, s) for k, s in sorted(members) if not (out / condition / base.output_name(k, s, IMAGE_PX)).is_file()
            ]
        pending = sum(len(v) for v in todo.values())
        batches = ((c, todo[c][i : i + batch]) for c in CONDITIONS for i in range(0, len(todo[c]), batch))
        for condition, items in batches:
            if done and clock() - start >= budget_s:
                break
            x = np.stack([load_image(tf, members[item], CONDITIONS[condition]) for item in items])
            probs = np.asarray(predict(x))
            if probs.shape != (len(items), IMAGE_PX, IMAGE_PX):
                raise ValueError(f"推論の出力の形が違う: {probs.shape}")
            if not (np.isfinite(probs).all() and probs.min() >= 0 and probs.max() <= 1):
                raise ValueError("推論の出力が 0〜1 の外か、NaN がある")
            for (key, side), p in zip(items, probs):
                base._save(out / condition / base.output_name(key, side, IMAGE_PX), p.astype(np.float16))
            done += len(items)
    return {
        "done": done,
        "remaining": pending - done,
        "total": len(members) * len(CONDITIONS),
        "seconds": round(clock() - start, 1),
    }


def write_meta(out_dir, environment, total):
    """条件ごとの meta.json。total は run_infer の total（条件の全部の合計）。"""
    for condition, low_px in CONDITIONS.items():
        meta = {
            "model": MODEL["repo"],
            "model_revision": MODEL["revision"],
            "model_sha256": MODEL["sha256"],
            "encoder": ENCODER,
            "building_class": BUILDING_CLASS,
            "probability": f"softmax over {NUM_CLASSES} outputs",
            "normalization": {"input": "RGB 0-255", "mean": list(MEAN), "std": list(STD)},
            "condition": condition,
            "resize": f"PIL BICUBIC 512 -> {low_px} -> 512 px" if low_px else "none",
            "sizes": [IMAGE_PX],
            "batch": BATCH,
            "dataset": base.DATASET,
            "arrays": total // len(CONDITIONS),
            **environment,
        }
        Path(out_dir, condition, "meta.json").write_text(
            json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )


def pack(out_dir, pack_dir, *, max_bytes=base.PART_BYTES):
    """条件ごとに tar に分ける（pack_dir/<条件>/ に、tar と manifest.json）。"""
    return {c: base.pack(Path(out_dir, c), Path(pack_dir, c), max_bytes=max_bytes) for c in CONDITIONS}


def _load_predict():
    """T4 にモデルを読み込んで、predict と、記録する実行環境を返す。"""
    import numpy as np
    import segmentation_models_pytorch as smp
    import timm
    import torch
    from safetensors.torch import load_file

    if not torch.cuda.is_available():
        raise RuntimeError("GPU が無い。T4 のランタイムで実行する")
    if (smp.__version__, timm.__version__) != (SMP_VERSION, TIMM_VERSION):
        raise RuntimeError(f"版が違う: smp {smp.__version__}・timm {timm.__version__}。新しいランタイムで PART=setup から実行する")
    if not base._matches(MODEL_PATH, MODEL["bytes"], MODEL["sha256"]):
        raise RuntimeError("モデルの重みが無いか、違う。先に PART=setup を実行する")

    def build(in_channels):
        return smp.create_model(
            arch="upernet",
            encoder_name=ENCODER,
            encoder_weights=None,
            in_channels=in_channels,
            classes=NUM_CLASSES,
            img_size=IMAGE_PX,
        )

    decoding = build(1)
    modules = {
        "encoder": build(3).encoder,
        "decoder": decoding.decoder,
        "segmentation_head": decoding.segmentation_head,
    }
    parts = split_state_dict(load_file(MODEL_PATH))
    for name, module in modules.items():
        module.load_state_dict(parts[name], strict=True)
        module.to("cuda").eval()

    def predict(batch):
        t = torch.from_numpy(np.ascontiguousarray(batch.transpose(0, 3, 1, 2))).to("cuda")
        with torch.no_grad():
            logits = modules["segmentation_head"](modules["decoder"](*modules["encoder"](t)))
            return torch.softmax(logits, dim=1)[:, BUILDING_CLASS].cpu().numpy()

    environment = {
        "torch": torch.__version__,
        "smp": smp.__version__,
        "timm": timm.__version__,
        "device": torch.cuda.get_device_name(0),
    }
    return predict, environment


def run_part(part):
    if part == "setup":
        packages = [f"segmentation-models-pytorch=={SMP_VERSION}", f"timm=={TIMM_VERSION}"]
        subprocess.run([sys.executable, "-m", "pip", "install", "-q", *packages], check=True)
        base.download(base.hf_url(MODEL), MODEL_PATH, nbytes=MODEL["bytes"], sha256=MODEL["sha256"])
        _, environment = _load_predict()
        print("SETUP", json.dumps(environment, ensure_ascii=False))
    elif part == "data":
        base.run_part("data")
    elif part == "infer":
        predict, environment = _load_predict()
        result = run_infer(base.TAR_PATH, OUT_DIR, predict)
        if result["remaining"] == 0:
            write_meta(OUT_DIR, environment, result["total"])
        print("INFER", json.dumps(result))
    elif part == "pack":
        print("PACK", json.dumps(pack(OUT_DIR, PACK_DIR)))
    else:
        raise ValueError(f"PART は setup・data・infer・pack のどれか: {part!r}")


if "PART" in globals():  # Colab: colab_source が置く
    run_part(globals()["PART"])
