"""GET /api/candidates/{id}/image?year=&size=（検出画像: 写真の切り出し＋輪郭）。構成 main。

画素の完全な一致は求めない（縮小の方法は実装ごとに違ってよい）。契約にするのは、PNG であること・大きさ・年ごとの写真・向きと範囲
（候補が真ん中・余白は約 20 m・タイルの外へ出ない）・輪郭の色と線種・入力の検証・写真が使えないときの 404。

写真タイルは合成（scripts/test-contract.sh が置く）: R=列・G=行（タイル内の画素の位置）、B=年（2014→50、2024→200）。
これで、切り出した画像の画素から、元のタイルのどこを切ったか（位置・範囲・向き）と、どの年の写真かが分かる。
"""

from __future__ import annotations

import io
from collections import Counter
from urllib.parse import quote

import pytest
from PIL import Image

from support import expected
from support.checks import assert_error, assert_validation_error

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
# 輪郭の色（分類ごと）。線種は 新規出現=実線・既存の描き漏れ=破線・判定保留=点線（色だけに頼らない）
OUTLINE = {"confirmed_new": (230, 70, 30), "existing_omission": (30, 110, 230), "uncertain": (245, 190, 0)}
WHITE = (255, 255, 255)  # 輪郭の白い縁取り（暗い写真でも見える）

# A1（合成町）の候補は、両年とも写真が読める。画像の検査は主に A1 の候補を使う
A1_NEW = "c-226249-105759-2"  # 新規出現。画素の箱 (100,100,140,130) → 中心 (120, 115)
A1_OMISSION = "c-226249-105759-3"  # 既存の描き漏れ。(30,40,50,55)
A1_UNCERTAIN_EDGE = "c-226249-105759-1"  # 判定保留。(216,200,256,236) = タイルの右下の縁に接している


def fetch(api, cid: str = A1_NEW, **params):
    params.setdefault("year", 2014)
    return api.get(f"/api/candidates/{cid}/image", params=params)


def decode(resp) -> Image.Image:
    assert resp.status == 200, resp
    assert resp.header("content-type") == "image/png", resp.headers
    assert resp.body.startswith(PNG_SIGNATURE)
    img = Image.open(io.BytesIO(resp.body))
    img.load()  # 壊れていれば、ここで例外
    assert img.format == "PNG"
    return img.convert("RGB")


def color_counts(img: Image.Image) -> Counter:
    return Counter(zip(*[iter(img.tobytes())] * 3))


# ---- 正常: 形式・大きさ・年 ----

def test_default_is_a_512_square_png_cached_only_privately(api):
    resp = fetch(api)
    assert decode(resp).size == (512, 512)
    assert (resp.header("cache-control") or "").startswith("private")  # 共有のキャッシュに載せない


@pytest.mark.parametrize("size", [64, 100, 128, 1024])
def test_size_within_64_and_1024_is_the_square_side(api, size):
    assert decode(fetch(api, size=size)).size == (size, size)


@pytest.mark.parametrize("year, blue", [(2014, 50), (2024, 200)])
def test_each_year_shows_its_own_photo(api, year, blue):
    img = decode(fetch(api, year=year))
    for xy in ((2, 2), (509, 2), (2, 509)):  # 輪郭から遠い隅（余白の約 20 m の外側）
        assert abs(img.getpixel(xy)[2] - blue) <= 3, (year, xy, img.getpixel(xy))


# ---- 向きと範囲（候補が真ん中・余白は約 20 m） ----

def test_crop_is_centered_on_the_candidate(api):
    # 候補 (100,100,140,130) の中心は、タイルの画素 (120, 115)。切り出しの真ん中の画素が、そこ（R=列・G=行）になる
    r, g, _ = decode(fetch(api)).getpixel((256, 256))
    assert abs(r - 120) <= 3 and abs(g - 115) <= 3, (r, g)


def test_crop_is_north_up_and_covers_the_candidate_plus_a_margin_of_about_20_m(api):
    img = decode(fetch(api))
    left, right = img.getpixel((16, 256))[0], img.getpixel((496, 256))[0]
    top, bottom = img.getpixel((256, 16))[1], img.getpixel((256, 496))[1]
    assert right > left and bottom > top, "向きが逆（R は左→右、G は上→下に増える）"
    # 切り出しの一辺は、候補の長い辺 40 画素 + 両側の余白 20 m ずつ（z18 の約 0.5 m/画素 → 約 40 画素ずつ）= 約 120 画素
    side_x = (right - left) * 512 / 480  # 画像の 16〜496（480 画素分）が、タイルの何画素に当たるか → 一辺に換算
    side_y = (bottom - top) * 512 / 480
    assert 110 <= side_x <= 130 and 110 <= side_y <= 130, (side_x, side_y)


def test_crop_never_leaves_the_tile_and_slides_inside_when_the_candidate_is_at_the_edge(api):
    # 候補 (216,200,256,236) はタイルの右下の縁に接する。中心に置くと外へ出るので、正方形のまま内側へずらす（約 120 画素 → 左・上は約 136 から）
    img = decode(fetch(api, A1_UNCERTAIN_EDGE))
    r_left, r_right = img.getpixel((16, 100))[0], img.getpixel((496, 100))[0]
    g_top, g_bottom = img.getpixel((100, 16))[1], img.getpixel((100, 496))[1]
    assert 128 <= r_left <= 148 and 128 <= g_top <= 148, (r_left, g_top)
    assert r_right >= 240 and g_bottom >= 240, (r_right, g_bottom)
    # 外側を埋めた画素（黒・透明など）が無い: 輪郭・縁取り以外の画素は、すべて 2014 年の写真（B=50）
    for color, n in color_counts(img).items():
        if color != WHITE and color not in OUTLINE.values():
            assert abs(color[2] - 50) <= 3, (color, n)


# ---- 輪郭: 色と線種 ----

@pytest.mark.parametrize("cid, cls", [(A1_NEW, "confirmed_new"), (A1_OMISSION, "existing_omission"), (A1_UNCERTAIN_EDGE, "uncertain")])
def test_outline_uses_the_class_color_and_no_other_class_color(api, cid, cls):
    counts = color_counts(decode(fetch(api, cid)))
    assert counts[OUTLINE[cls]] > 100, counts.most_common(4)
    for other, rgb in OUTLINE.items():
        if other != cls:
            assert counts[rgb] == 0, (cls, other)


def duty_cycle(img: Image.Image, rgb: tuple[int, int, int]) -> float:
    """輪郭の水平な辺（その色の画素が最も多い行）で、辺の始まりから終わりまでのうち、その色が塗られている割合。実線≒1、破線・点線は小さくなる。"""
    best_row, best_n = 0, 0
    for y in range(img.height):
        n = sum(1 for p in zip(*[iter(img.crop((0, y, img.width, y + 1)).tobytes())] * 3) if p == rgb)
        if n > best_n:
            best_row, best_n = y, n
    row = [p == rgb for p in zip(*[iter(img.crop((0, best_row, img.width, best_row + 1)).tobytes())] * 3)]
    assert any(row), f"輪郭の色 {rgb} の画素が見つからない"
    first, last = row.index(True), len(row) - 1 - row[::-1].index(True)
    return sum(row[first : last + 1]) / (last - first + 1)


def test_line_styles_differ_solid_dashed_dotted(api):
    """色だけに頼らない: 新規出現=実線 > 既存の描き漏れ=破線 > 判定保留=点線の順に、辺が塗られている割合が低くなる（3 つの帯が重ならない）。"""
    solid = duty_cycle(decode(fetch(api, A1_NEW)), OUTLINE["confirmed_new"])
    dashed = duty_cycle(decode(fetch(api, A1_OMISSION)), OUTLINE["existing_omission"])
    dotted = duty_cycle(decode(fetch(api, A1_UNCERTAIN_EDGE)), OUTLINE["uncertain"])
    assert solid >= 0.95, solid
    assert 0.45 <= dashed <= 0.85, dashed
    assert 0.15 <= dotted <= 0.50, dotted
    assert solid > dashed > dotted


# ---- 入力の検証 ----

@pytest.mark.parametrize("size", [63, 1025, 0, -5, "abc", "512; rm -rf /", "", "1e3", 512.5])
def test_size_out_of_range_or_not_an_integer_is_422(api, size):
    assert_validation_error(fetch(api, size=size), "query", "size")


@pytest.mark.parametrize("year", [2017, 2019, 2020, 2025, 0, -1, "abc", "", "2014/../../etc/passwd", "../2014", "2014.0", " 2014", "02018", "1e3", "2014 "])
def test_year_must_be_exactly_2014_or_2024(api, year):
    assert_validation_error(fetch(api, year=year), "query", "year")


def test_year_with_a_nul_byte_is_422(api):
    assert_validation_error(api.get(f"/api/candidates/{A1_NEW}/image?year=2014%00"), "query", "year")


def test_year_is_required(api):
    assert_validation_error(api.get(f"/api/candidates/{A1_NEW}/image"), "query", "year")


def test_validation_comes_before_the_lookup(api):
    # 候補が無くても、引数が不正なら 422（404 より先）
    assert_validation_error(api.get("/api/candidates/c-1-2-3/image", params={"year": 2025}), "query", "year")


def test_unknown_candidate_is_404(api):
    assert_error(fetch(api, "c-1-2-3"), 404, "not_found", "候補が見つかりません")


@pytest.mark.parametrize("cid", ["x", "c-1-2", "c-1-2-3x", "c-1-2-3'--", "c-12345678-1-1"])
def test_malformed_candidate_id_is_422(api, cid):
    assert_validation_error(api.get(f"/api/candidates/{quote(cid, safe='')}/image", params={"year": 2014}), "path", "candidate_id")


@pytest.mark.parametrize("cid", ["..%2F..%2Fetc%2Fpasswd", "%2e%2e/%2e%2e/etc/passwd", "c-..%2F..%2Fx-1-1"])
def test_path_traversal_in_the_id_is_never_served(api, cid):
    resp = api.get(f"/api/candidates/{cid}/image?year=2014")
    assert resp.status in (404, 422), resp
    assert_error(resp, resp.status)


def test_image_only_allows_get(api):
    assert_error(api.post(f"/api/candidates/{A1_NEW}/image?year=2014"), 405, "method_not_allowed")


# ---- 写真が使えないとき（404 tile_not_found）。故障は、写真タイルを置くときに仕込んである（support/expected.py の TILE_FAULTS） ----

def test_other_year_of_the_same_area_still_works(api):
    # 試験町は 2014 年のファイルだけが無い。2024 年は読める
    assert decode(fetch(api, expected.BIGGEST_NEW, year=2024)).size == (512, 512)


@pytest.mark.parametrize("area_id, year, fault", [(a, y, f) for (a, y), f in expected.TILE_FAULTS.items()], ids=lambda v: str(v))
def test_unusable_photo_is_404_without_leaking_paths(api, area_id, year, fault):
    for cand in (c for c in expected.CANDIDATES if c.area_id == area_id):
        resp = fetch(api, cand.id, year=year)
        err = assert_error(resp, 404, "tile_not_found")
        # missing=ファイルが無い / corrupt=PNG ではないファイル / symlink_outside=TILES_DIR の外を指すリンク（読んではいけない）
        assert err["message"].startswith(f"{year} 年の写真を用意できません"), err
        for leaked in ("/work", "tiles", "outside.png", "Traceback"):
            assert leaked not in resp.text, (fault, leaked)
