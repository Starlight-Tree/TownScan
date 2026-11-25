#!/usr/bin/env python3
"""検出画像（GET /api/candidates/{id}/image）を、Python の API（Pillow）と Go の API（x/image）で作り、画素の差を測る。Pillow が要る。

使い方（api/difftest/image.sh が、使い捨ての DB・両方の API・写真を用意して呼ぶ）:
    python3 -I image_diff.py --python http://tsgo-imgdiff-py:8000 --go http://tsgo-imgdiff-go:8000

同じ候補・同じ年・同じ size で、両方の画像を取り、次を比べる:
  構造（1 件でも違えば失敗）  状態 200・Content-Type・Cache-Control・画像の大きさ・PNG の形式（RGB 8 ビット）
  全体の差                    平均絶対差（MAD。全画素・全チャンネルの |a-b| の平均。0〜255）
  写真だけの差                輪郭・縁取りの色（白と 3 分類の色）の画素を、どちらかの画像に含む場所を除いた MAD。拡大の補間の違いだけを見る
  輪郭の食い違い              輪郭の色の画素（白・3 分類）の種類が、片方にだけある・違う画素の割合（線の太さ・位置・破線の位相の違い）
画素まで同じにする必要はない（契約が見るのは、向き・色・余白・年ごとの違い・形式）。上限（--max-photo-mad・--max-total-mad）は、
実測（既定の CatmullRom）に余裕を足した値で、補間の方式・線の描き方が大きく変わったときの検知に使う。
"""

from __future__ import annotations

import argparse
import http.client
import io
import json
import sys
import time
import urllib.parse
from collections import defaultdict

from PIL import Image, ImageChops, ImageStat

YEARS = (2018, 2023)
SIZES = (64, 128, 256, 512, 1024)
# 輪郭の色（白い縁取りと、分類ごと）。画素がこの色そのものなら「輪郭」とみなす（写真の画素が偶然この色になることは、合成の写真ではまず無い）
SPECIAL = {"casing": (255, 255, 255), "confirmed_new": (230, 70, 30), "existing_omission": (30, 110, 230), "uncertain": (245, 190, 0)}
TIMEOUT = 60


def get(base: str, path: str) -> tuple[int, dict[str, str], bytes]:
    u = urllib.parse.urlsplit(base)
    conn = http.client.HTTPConnection(u.hostname, u.port, timeout=TIMEOUT)
    try:
        conn.request("GET", path, headers={"Host": "diff.test"})
        r = conn.getresponse()
        return r.status, {k.lower(): v for k, v in r.getheaders()}, r.read()
    finally:
        conn.close()


def wait_ready(urls: list[str], seconds: float) -> bool:
    """どの API も /api/health に 200 を返すまで待つ。"""
    deadline = time.monotonic() + seconds
    pending = list(urls)
    while pending:
        try:
            if get(pending[0], "/api/health")[0] == 200:
                pending.pop(0)
                continue
        except OSError:
            pass
        if time.monotonic() > deadline:
            return False
        time.sleep(0.5)
    return True


def color_mask(img: Image.Image, rgb: tuple[int, int, int]) -> Image.Image:
    """img の画素が rgb そのものの所が 255、それ以外が 0 の 'L' 画像。"""
    mask = None
    for band, want in zip(img.split(), rgb):
        eq = band.point(lambda v, w=want: 255 if v == w else 0)
        mask = eq if mask is None else ImageChops.darker(mask, eq)
    return mask


def count_set(mask: Image.Image) -> int:
    return mask.histogram()[255]


def is_rgb8_png(data: bytes) -> bool:
    # IHDR: ビット深度（24 バイト目）= 8、色の型（25 バイト目）= 2（RGB。透明度なし）
    return data[:8] == b"\x89PNG\r\n\x1a\n" and data[24] == 8 and data[25] == 2


def compare(py_png: bytes, go_png: bytes) -> dict[str, float]:
    a = Image.open(io.BytesIO(py_png)).convert("RGB")
    b = Image.open(io.BytesIO(go_png)).convert("RGB")
    if a.size != b.size:
        raise ValueError(f"画像の大きさが違う: Python {a.size}, Go {b.size}")
    total = a.size[0] * a.size[1]
    diff = ImageChops.difference(a, b)
    total_mad = sum(ImageStat.Stat(diff).mean) / 3

    special_a = {k: color_mask(a, rgb) for k, rgb in SPECIAL.items()}
    special_b = {k: color_mask(b, rgb) for k, rgb in SPECIAL.items()}
    any_special = Image.new("L", a.size, 0)
    mismatch = Image.new("L", a.size, 0)
    for k in SPECIAL:
        any_special = ImageChops.lighter(any_special, ImageChops.lighter(special_a[k], special_b[k]))
        mismatch = ImageChops.lighter(mismatch, ImageChops.difference(special_a[k], special_b[k]))
    photo_mask = any_special.point(lambda v: 0 if v else 255)
    photo_px = count_set(photo_mask)
    photo_mad = sum(ImageStat.Stat(diff, mask=photo_mask).mean) / 3 if photo_px else 0.0
    return {
        "total_mad": total_mad,
        "photo_mad": photo_mad,
        "outline_mismatch": count_set(mismatch) / total,
        "outline_share": (total - photo_px) / total,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--python", required=True, help="Python の API の URL")
    ap.add_argument("--go", required=True, help="Go の API の URL")
    ap.add_argument("--wait", type=float, default=0, help="両方の API が /api/health に答えるまで待つ秒数（0 は待たない）")
    ap.add_argument("--max-photo-mad", type=float, default=2.0, help="写真だけの MAD の上限（全組の平均）")
    ap.add_argument("--max-total-mad", type=float, default=6.0, help="全体の MAD の上限（全組の平均）")
    ns = ap.parse_args()

    if ns.wait and not wait_ready([ns.python, ns.go], ns.wait):
        print(f"API が {ns.wait:g} 秒以内に起動しませんでした", file=sys.stderr)
        return 1
    status, _, body = get(ns.python, "/api/candidates?limit=500")
    if status != 200:
        print(f"候補の一覧を取れません（Python の API: {status}）", file=sys.stderr)
        return 1
    ids = [c["id"] for c in json.loads(body)["items"]]

    by_size: dict[int, list[dict[str, float]]] = defaultdict(list)
    worst: tuple[float, str] = (0.0, "")
    problems: list[str] = []
    for cid in ids:
        for year in YEARS:
            for size in SIZES:
                path = f"/api/candidates/{cid}/image?year={year}&size={size}"
                py, go = get(ns.python, path), get(ns.go, path)
                label = f"{cid} {year} {size}"
                if py[0] != 200 or go[0] != 200:
                    problems.append(f"{label}: 状態 Python {py[0]}, Go {go[0]}")
                    continue
                for h in ("content-type", "cache-control"):
                    if py[1].get(h) != go[1].get(h):
                        problems.append(f"{label}: {h} が違う（Python {py[1].get(h)!r}, Go {go[1].get(h)!r}）")
                if not is_rgb8_png(go[2]):
                    problems.append(f"{label}: Go の画像が RGB 8 ビットの PNG ではない")
                try:
                    m = compare(py[2], go[2])
                except ValueError as exc:
                    problems.append(f"{label}: {exc}")
                    continue
                by_size[size].append(m)
                if m["total_mad"] > worst[0]:
                    worst = (m["total_mad"], label)

    pairs = [m for ms in by_size.values() for m in ms]
    print(f"== 検出画像の差（候補 {len(ids)} 件 x 年 {len(YEARS)} x 大きさ {len(SIZES)} = {len(ids) * len(YEARS) * len(SIZES)} 組。Python = Pillow BICUBIC、Go = x/image）")
    print(f"{'size':>5} {'組':>4} | {'全体 MAD 平均':>12} {'最大':>6} | {'写真だけ MAD 平均':>16} {'最大':>6} | {'輪郭の食い違い 平均':>18} {'最大':>7} | 輪郭の画素の割合 平均")
    for size in SIZES:
        ms = by_size.get(size, [])
        if not ms:
            continue
        n = len(ms)
        avg = lambda k: sum(m[k] for m in ms) / n
        print(
            f"{size:>5} {n:>4} | {avg('total_mad'):>12.3f} {max(m['total_mad'] for m in ms):>6.2f} | "
            f"{avg('photo_mad'):>16.3f} {max(m['photo_mad'] for m in ms):>6.2f} | "
            f"{avg('outline_mismatch') * 100:>17.2f}% {max(m['outline_mismatch'] for m in ms) * 100:>6.2f}% | {avg('outline_share') * 100:>6.2f}%"
        )
    if pairs:
        n = len(pairs)
        total = sum(m["total_mad"] for m in pairs) / n
        photo = sum(m["photo_mad"] for m in pairs) / n
        print(f"{'全体':>5} {n:>4} | 全体 MAD 平均 {total:.3f}（最大 {worst[0]:.2f}: {worst[1]}）・写真だけ MAD 平均 {photo:.3f}")
        if photo > ns.max_photo_mad:
            problems.append(f"写真だけの MAD の平均 {photo:.3f} が上限 {ns.max_photo_mad} を超えている（補間の違い）")
        if total > ns.max_total_mad:
            problems.append(f"全体の MAD の平均 {total:.3f} が上限 {ns.max_total_mad} を超えている")
    else:
        problems.append("比べられた組が 0 件")
    for p in problems:
        print(f"[差分] {p}", file=sys.stderr)
    print("== 検出画像の差分検査: " + ("構造は一致（上の数字が差）" if not problems else f"問題 {len(problems)} 件"))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
