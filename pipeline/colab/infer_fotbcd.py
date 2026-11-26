"""FOTBCD の val に、建物抽出モデルをかける（Colab の T4 で実行する。仕様 §6.1・ADR 0015）。出力は evaluate_fotbcd の入力。

モデル・重み・正規化（÷255 のみ）は、アプリの推論（infer.py）と同じ。重みの版は固定して、ハッシュを照合する。
入力: 組の 512 px の画像（前・後）を、そのまま（512）と、PIL の双三次で縮小した 256・320 px にする。
出力: {番号}_{before|after}_{256|320|512}.npy（建物の確率。float16）と meta.json。

実行役が、先頭に PART = "..." を差し込んで、順に別々に実行する（1 回の実行は約 300 秒まで）。
先頭に行が差し込まれるので、このファイルでは from __future__ を使わない。
  PART=setup : パッケージとモデルの重みの取得（GPU が無ければ止める）
  PART=data  : val の tar の取得（版・大きさ・ハッシュを固定）
  PART=infer : 推論。時間の上限で区切って保存するので、「remaining」が 0 になるまで繰り返す
  PART=pack  : 出力を、大きさの上限で区切った tar と、ハッシュの一覧にする（取り出しは HTTP）
取り出したあとは、手元で照合して展開する:
  python -I pipeline/colab/infer_fotbcd.py unpack <取り出したフォルダ> data/fr/val/probs
test は扱わない（取得もしない。ADR 0015）。
"""

import hashlib
import io
import json
import os
import re
import subprocess
import sys
import tarfile
import time
import urllib.request
from pathlib import Path

DATASET = {
    "split": "val",
    "repo": "abdevd/FOTBCD",
    "revision": "92b677c881f0d973d76460204431c711ccbac25b",
    "file": "data/val/val-000000.tar",
    "bytes": 815_923_200,
    "sha256": "83d92ac1bd5b7a32f23dd2c997bb509c615a9383509acb1227a19238065307e0",
}
MODEL = {
    "repo": "giswqs/whu-building-unetplusplus-efficientnet-b4",
    "revision": "09df9efd323bbd3d56b98b4857129eb9b5baa2d3",  # アプリの推論で使った版
    "file": "model.pth",
    "bytes": 84_027_346,
    "sha256": "922af7c96c0dc44256ab8b4d1a071f2151e0a921c997af80b55bb766bcc30dc6",
}
SMP_VERSION = "0.6.0"
USER_AGENT = "research-client/1.0"
IMAGE_PX = 512
SIZES = (256, 320, 512)
SIDES = ("before", "after")
BATCH = 8
BUDGET_S = 240  # 1 回の実行で推論に使う時間。超えたら次の束を始めない
PART_BYTES = 400_000_000
TAR_PATH = "/content/fotbcd_val.tar"
MODEL_PATH = "/content/fotbcd_model.pth"
OUT_DIR = "/content/fotbcd_probs"
PACK_DIR = "/content/fotbcd_pack"
MANIFEST = "manifest.json"
_IMAGE_RE = re.compile(r"^(\d{9})\.(before|after)\.png$")
_OUTPUT_RE = re.compile(r"^(\d{9}_(before|after)_(256|320|512)\.npy|meta\.json)$")
_PART_RE = re.compile(r"^fotbcd_probs_\d{2}\.tar$")


def hf_url(spec, kind=""):
    return f"https://huggingface.co/{kind}{spec['repo']}/resolve/{spec['revision']}/{spec['file']}"


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while block := f.read(1 << 20):
            h.update(block)
    return h.hexdigest()


def _matches(path, nbytes, sha256):
    return Path(path).is_file() and Path(path).stat().st_size == nbytes and sha256_file(path) == sha256


def download(url, dest, *, nbytes, sha256):
    """大きさとハッシュが合うものだけを dest に置く。すでに合うものがあれば、取得しない。"""
    if _matches(dest, nbytes, sha256):
        return False
    part = f"{dest}.part"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=120) as r, open(part, "wb") as f:
        while block := r.read(1 << 20):
            f.write(block)
    if not _matches(part, nbytes, sha256):
        raise ValueError(f"取得したものの大きさかハッシュが違う: {url}（{Path(part).stat().st_size} バイト）")
    os.replace(part, dest)
    return True


def image_members(tf):
    """tar の中の画像 {(番号, 側): member}。前後がそろわない組があれば止める。"""
    found = {}
    for member in tf:
        m = _IMAGE_RE.match(member.name)
        if m and member.isfile():
            found[m.groups()] = member
    keys = {key for key, _ in found}
    incomplete = sorted(k for k in keys if any((k, side) not in found for side in SIDES))
    if incomplete or not keys:
        raise ValueError(f"前後の画像がそろわないか、画像が無い（組 {len(keys)}・そろわない {incomplete[:5]}）")
    return found


def load_image(tf, member, size):
    """画像 → (size, size, 3) の float32（0〜1）。"""
    import numpy as np
    from PIL import Image

    img = Image.open(io.BytesIO(tf.extractfile(member).read())).convert("RGB")
    if img.size != (IMAGE_PX, IMAGE_PX):
        raise ValueError(f"画像の大きさが違う: {img.size}: {member.name}")
    if size != IMAGE_PX:
        img = img.resize((size, size), Image.BICUBIC)
    return np.asarray(img, dtype=np.float32) / 255.0


def output_name(key, side, size):
    return f"{key}_{side}_{size}.npy"


def _save(path, array):
    """書きかけのファイルを、出力の名前で残さない。"""
    import numpy as np

    tmp = f"{path}.tmp"
    with open(tmp, "wb") as f:
        np.save(f, array)
    os.replace(tmp, path)


def run_infer(tar_path, out_dir, predict, *, batch=BATCH, budget_s=BUDGET_S, clock=time.monotonic):
    """まだ無い出力を推論して保存する。predict は (N, H, W, 3) の 0〜1 → (N, H, W) の建物の確率。

    時間の上限を超えたら、次の束を始めずに戻る（1 回の呼び出しで、少なくとも 1 束は進む）。
    """
    import numpy as np

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    start = clock()
    done = 0
    with tarfile.open(tar_path, "r:") as tf:
        members = image_members(tf)
        todo = {
            size: [(k, s) for k, s in sorted(members) if not (out / output_name(k, s, size)).is_file()] for size in SIZES
        }
        pending = sum(len(v) for v in todo.values())
        batches = ((size, todo[size][i : i + batch]) for size in SIZES for i in range(0, len(todo[size]), batch))
        for size, items in batches:
            if done and clock() - start >= budget_s:
                break
            x = np.stack([load_image(tf, members[item], size) for item in items])
            probs = np.asarray(predict(x))
            if probs.shape != (len(items), size, size):
                raise ValueError(f"推論の出力の形が違う: {probs.shape}")
            if not (np.isfinite(probs).all() and probs.min() >= 0 and probs.max() <= 1):
                raise ValueError("推論の出力が 0〜1 の外か、NaN がある")
            for (key, side), p in zip(items, probs):
                _save(out / output_name(key, side, size), p.astype(np.float16))
            done += len(items)
    return {
        "done": done,
        "remaining": pending - done,
        "total": len(members) * len(SIZES),
        "seconds": round(clock() - start, 1),
    }


def write_meta(out_dir, environment, total):
    meta = {
        "model": MODEL["repo"],
        "model_revision": MODEL["revision"],
        "model_sha256": MODEL["sha256"],
        "normalization": "0-1 (/255), no mean/std",
        "resize": "PIL BICUBIC from 512 px",
        "sizes": list(SIZES),
        "batch": BATCH,
        "dataset": DATASET,
        "arrays": total,
        **environment,
    }
    Path(out_dir, "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def pack(out_dir, pack_dir, *, max_bytes=PART_BYTES):
    """推論の出力を、max_bytes ごとの tar に分ける（1 つのファイルは分けない）。推論が終わっていなければ止める。"""
    out, dest = Path(out_dir), Path(pack_dir)
    if not (out / "meta.json").is_file():
        raise ValueError("meta.json が無い。推論（PART=infer）が remaining 0 になっていない")
    names = sorted(p.name for p in out.iterdir() if _OUTPUT_RE.match(p.name))
    expected = json.loads((out / "meta.json").read_text(encoding="utf-8"))["arrays"] + 1
    if len(names) != expected:
        raise ValueError(f"出力の数が違う: {len(names)}（期待 {expected}）")
    groups, size = [[]], 0
    for name in names:
        n = (out / name).stat().st_size
        if groups[-1] and size + n > max_bytes:
            groups.append([])
            size = 0
        groups[-1].append(name)
        size += n
    dest.mkdir(parents=True, exist_ok=True)
    parts = []
    for i, group in enumerate(groups):
        path = dest / f"fotbcd_probs_{i:02d}.tar"
        with tarfile.open(path, "w") as tf:
            for name in group:
                tf.add(out / name, arcname=name)
        parts.append({"name": path.name, "bytes": path.stat().st_size, "sha256": sha256_file(path), "files": len(group)})
    manifest = {"files_total": len(names), "parts": parts}
    (dest / MANIFEST).write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def unpack(pack_dir, dest_dir):
    """取り出した tar を、一覧の大きさ・ハッシュと照合してから展開する。展開した数を返す。

    照合は、全部の tar が済んでから展開を始める。想定した名前の通常のファイルだけを書き、前の出力があれば止める。
    """
    src, dest = Path(pack_dir), Path(dest_dir)
    manifest = json.loads((src / MANIFEST).read_text(encoding="utf-8"))
    names = set()
    for part in manifest["parts"]:
        if not _PART_RE.match(part["name"]) or not _matches(src / part["name"], part["bytes"], part["sha256"]):
            raise ValueError(f"tar の名前・大きさ・ハッシュが、一覧と違う: {part['name']!r}")
        with tarfile.open(src / part["name"], "r:") as tf:
            for member in tf:
                if not member.isfile() or not _OUTPUT_RE.match(member.name) or member.name in names:
                    raise ValueError(f"tar に、想定しないものがある: {member.name!r}")
                names.add(member.name)
    if len(names) != manifest["files_total"]:
        raise ValueError(f"ファイルの数が違う: {len(names)}（一覧は {manifest['files_total']}）")
    if dest.is_dir() and any(_OUTPUT_RE.match(p.name) for p in dest.iterdir()):
        raise FileExistsError(f"展開先に、前の出力がある（上書きしない）: {dest}")
    dest.mkdir(parents=True, exist_ok=True)
    for part in manifest["parts"]:
        with tarfile.open(src / part["name"], "r:") as tf:
            for member in tf:
                (dest / member.name).write_bytes(tf.extractfile(member).read())
    return len(names)


def _load_predict():
    """T4 にモデルを読み込んで、predict と、記録する実行環境を返す。"""
    import numpy as np
    import segmentation_models_pytorch as smp
    import torch

    if not torch.cuda.is_available():
        raise RuntimeError("GPU が無い。T4 のランタイムで実行する")
    if not _matches(MODEL_PATH, MODEL["bytes"], MODEL["sha256"]):
        raise RuntimeError("モデルの重みが無いか、違う。先に PART=setup を実行する")
    model = smp.UnetPlusPlus(encoder_name="efficientnet-b4", encoder_weights=None, in_channels=3, classes=2)
    sd = torch.load(MODEL_PATH, map_location="cpu")
    if isinstance(sd, dict) and "state_dict" in sd:
        sd = sd["state_dict"]
    sd = {(k[6:] if k.startswith("model.") else k): v for k, v in sd.items()}
    res = model.load_state_dict(sd, strict=False)
    if res.missing_keys or res.unexpected_keys:
        raise RuntimeError(f"モデルの重みが一致しない: missing {len(res.missing_keys)}・unexpected {len(res.unexpected_keys)}")
    model.to("cuda").eval()

    def predict(batch):
        t = torch.from_numpy(np.ascontiguousarray(batch.transpose(0, 3, 1, 2))).to("cuda")
        with torch.no_grad():
            return torch.softmax(model(t), dim=1)[:, 1].cpu().numpy()

    environment = {"torch": torch.__version__, "smp": smp.__version__, "device": torch.cuda.get_device_name(0)}
    return predict, environment


def run_part(part):
    if part == "setup":
        subprocess.run([sys.executable, "-m", "pip", "install", "-q", f"segmentation-models-pytorch=={SMP_VERSION}"], check=True)
        download(hf_url(MODEL), MODEL_PATH, nbytes=MODEL["bytes"], sha256=MODEL["sha256"])
        _, environment = _load_predict()
        print("SETUP", json.dumps(environment, ensure_ascii=False))
    elif part == "data":
        fetched = download(hf_url(DATASET, "datasets/"), TAR_PATH, nbytes=DATASET["bytes"], sha256=DATASET["sha256"])
        print("DATA", json.dumps({"fetched": fetched, "bytes": DATASET["bytes"], "sha256": "ok"}))
    elif part == "infer":
        predict, environment = _load_predict()
        result = run_infer(TAR_PATH, OUT_DIR, predict)
        if result["remaining"] == 0:
            write_meta(OUT_DIR, environment, result["total"])
        print("INFER", json.dumps(result))
    elif part == "pack":
        print("PACK", json.dumps(pack(OUT_DIR, PACK_DIR)))
    else:
        raise ValueError(f"PART は setup・data・infer・pack のどれか: {part!r}")


def cli(argv):
    if len(argv) == 3 and argv[0] == "unpack":
        print(f"展開した: {unpack(argv[1], argv[2])} ファイル → {argv[2]}")
        return 0
    print("使い方: python -I pipeline/colab/infer_fotbcd.py unpack <取り出したフォルダ> <展開先>", file=sys.stderr)
    return 2


if "PART" in globals():  # Colab: 実行役が差し込む
    run_part(globals()["PART"])
elif __name__ == "__main__":
    raise SystemExit(cli(sys.argv[1:]))
