"""写真の切り出し: 正常系・上限・パストラバーサル・年の許可リスト・タイルの外へ出ない。"""

from __future__ import annotations

import io
import os

import pytest
from PIL import Image

import synthetic
from app import imaging
from app.imaging import TileUnavailable, crop_box, tile_file
from conftest import make_client
from test_api import A1, A2, BIGGEST_NEW, assert_error

COLORS = {"confirmed_new": (230, 70, 30), "existing_omission": (30, 110, 230), "uncertain": (245, 190, 0)}


def fetch(client, cid=BIGGEST_NEW, **params):
    params.setdefault("year", 2018)
    return client.get(f"/api/candidates/{cid}/image", params=params)


def png(resp) -> Image.Image:
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"] == "image/png"
    return Image.open(io.BytesIO(resp.content)).convert("RGB")


def count_color(img: Image.Image, rgb) -> int:
    return sum(1 for p in img.get_flattened_data() if p == rgb)


# ---- API: 正常系 ----

def test_default_is_512_square_png(client):
    img = png(fetch(client))
    assert img.size == (512, 512)
    assert fetch(client).headers["cache-control"].startswith("private")


@pytest.mark.parametrize("size", [64, 128, 1024])
def test_size_within_limits(client, size):
    assert png(fetch(client, size=size)).size == (size, size)


def test_years_show_different_photos(client):
    old, new = png(fetch(client, year=2018)), png(fetch(client, year=2023))
    assert old.getpixel((2, 2))[2] == 50 and new.getpixel((2, 2))[2] == 200  # 合成タイルの B チャンネルが年を表す


def test_crop_is_centered_on_the_candidate(client):
    # 合成タイルは R=列・G=行。候補 (60..110, 60..100) の中心 (85, 80) が、切り出しの真ん中に来る
    r, g, _ = png(fetch(client)).getpixel((256, 256))
    assert abs(r - 85) <= 3 and abs(g - 80) <= 3


@pytest.mark.parametrize("cid, cls", [
    ("c-226250-105759-1", "confirmed_new"),
    ("c-226249-105760-1", "existing_omission"),
    ("c-226249-105759-1", "uncertain"),
])
def test_outline_uses_the_class_color(client, cid, cls):
    img = png(fetch(client, cid))
    assert count_color(img, COLORS[cls]) > 100
    for other, rgb in COLORS.items():
        if other != cls:
            assert count_color(img, rgb) == 0


def test_line_styles_differ_solid_dashed_dotted():
    """色だけに頼らない: 実線 > 破線 > 点線の順に、同じ長さの線の塗られる画素が減る。"""
    from PIL import ImageDraw

    def painted(dash):
        img = Image.new("RGB", (300, 20), (0, 0, 0))
        imaging._dashed(ImageDraw.Draw(img), [(5, 10), (295, 10)], (255, 0, 0), 4, dash)
        return count_color(img, (255, 0, 0))

    solid = painted(None)
    dashed = painted(imaging.CLASS_STYLE["existing_omission"]["dash"])
    dotted = painted(imaging.CLASS_STYLE["uncertain"]["dash"])
    assert solid > dashed > dotted > 0
    assert imaging.CLASS_STYLE["confirmed_new"]["dash"] is None


# ---- API: 入力の検証 ----

@pytest.mark.parametrize("params", [
    {"size": 63}, {"size": 1025}, {"size": 0}, {"size": -5}, {"size": "abc"}, {"size": "512; rm -rf /"},
])
def test_size_out_of_range_is_422(client, params):
    assert_error(fetch(client, **params), 422, "validation_error")


@pytest.mark.parametrize("year", [2017, 2019, 2020, 2024, 0, -1, "abc", "", "2018/../../etc/passwd", "../2018", "2018%00", "2018.0", " 2018", "02018", "1e3"])
def test_year_must_be_in_the_allow_list(client, year):
    assert_error(fetch(client, year=year), 422)


def test_year_is_required(client):
    assert_error(client.get(f"/api/candidates/{BIGGEST_NEW}/image"), 422)


def test_unknown_candidate_is_404(client):
    assert_error(fetch(client, "c-1-2-3"), 404, "not_found")


@pytest.mark.parametrize("cid", ["x", "c-1-2", "c-1-2-3x", "c-1-2-3'--", "..%2F..%2Fetc%2Fpasswd", "%2e%2e/%2e%2e/etc/passwd", "c-../../x-1-1"])
def test_malformed_candidate_id_is_rejected(client, cid):
    r = client.get(f"/api/candidates/{cid}/image", params={"year": 2018})
    assert r.status_code in (404, 422)
    assert set(r.json()) == {"error"}


# ---- API: タイルが無い・壊れている・外を指す ----

def test_missing_tile_is_404(db_url, conn, loaded, tmp_path):
    (tmp_path / "2023").mkdir()  # 2018 のディレクトリが無い
    with make_client(db_url, tmp_path) as c:
        err = assert_error(fetch(c, year=2018), 404, "tile_not_found")
        assert str(tmp_path) not in err["message"]  # パスを漏らさない
        assert_error(fetch(c, year=2023), 404, "tile_not_found")


def test_corrupt_tile_is_404(db_url, conn, loaded, tmp_path):
    d = tmp_path / "2018"
    d.mkdir()
    (d / "226250_105759.png").write_bytes(b"not a png")
    with make_client(db_url, tmp_path) as c:
        assert_error(fetch(c, year=2018), 404, "tile_not_found")


def test_symlink_pointing_outside_tiles_dir_is_not_read(db_url, conn, loaded, tmp_path, tiles_dir):
    secret = tmp_path / "outside.png"
    Image.new("RGB", (256, 256), (1, 2, 3)).save(secret)
    tiles = tmp_path / "tiles"
    (tiles / "2018").mkdir(parents=True)
    os.symlink(secret, tiles / "2018" / "226250_105759.png")
    with make_client(db_url, tiles) as c:
        assert_error(fetch(c, year=2018), 404, "tile_not_found")


# ---- 部品: tile_file ----

def test_tile_file_valid(tiles_dir):
    p = tile_file(tiles_dir, 2018, 226249, 105759)
    assert p.is_file() and p.parent.name == "2018" and p.is_relative_to(tiles_dir.resolve())


@pytest.mark.parametrize("year, x, y", [
    (2020, 226249, 105759), (True, 226249, 105759), ("2018", 226249, 105759), (2018.0, 226249, 105759),
    (2018, -1, 105759), (2018, 226249, -1), (2018, 2**18, 0), (2018, 0, 2**18), (2018, "226249", 105759),
    (2018, True, 1), (2018, 1.5, 1), (2018, "../../etc/passwd", 1),
])
def test_tile_file_rejects_bad_arguments(tiles_dir, year, x, y):
    with pytest.raises(TileUnavailable):
        tile_file(tiles_dir, year, x, y)


def test_tile_file_rejects_symlink_escape(tmp_path):
    (tmp_path / "tiles" / "2018").mkdir(parents=True)
    outside = tmp_path / "outside.png"
    outside.write_bytes(b"x")
    os.symlink(outside, tmp_path / "tiles" / "2018" / "5_6.png")
    with pytest.raises(TileUnavailable, match="外"):
        tile_file(tmp_path / "tiles", 2018, 5, 6)


# ---- 部品: crop_box（タイルの外へ出ない・余白・正方形） ----

def bbox_of(box):
    poly = synthetic.rect_polygon(226249, 105759, box)["coordinates"][0]
    lons, lats = [p[0] for p in poly], [p[1] for p in poly]
    return [min(lons), min(lats), max(lons), max(lats)]


def test_crop_box_adds_about_20_m_margin_and_is_square():
    l, t, r, b = crop_box(bbox_of((100, 100, 140, 130)), 226249, 105759)
    # 候補は 40x30 画素。z18 の約 0.5 m/画素なので、余白 20 m ≒ 40 画素ずつ → 約 120 画素の正方形
    assert r - l == b - t and 110 <= r - l <= 130
    assert l < 100 and t < 100 and r > 140 and b > 130


@pytest.mark.parametrize("box", [(0, 0, 10, 10), (246, 0, 256, 10), (0, 246, 10, 256), (246, 246, 256, 256), (0, 0, 256, 256), (216, 200, 256, 236)])
def test_crop_box_never_leaves_the_tile(box):
    l, t, r, b = crop_box(bbox_of(box), 226249, 105759)
    assert 0 <= l < r <= 256 and 0 <= t < b <= 256
    assert r - l == b - t or max(r - l, b - t) - min(r - l, b - t) <= 1


def test_crop_box_has_a_minimum_size_for_tiny_candidates():
    l, t, r, b = crop_box(bbox_of((120, 120, 122, 122)), 226249, 105759)
    assert r - l >= imaging.MIN_SIDE_PX


def test_crop_box_scales_with_tile_resolution():
    small = crop_box(bbox_of((100, 100, 140, 130)), 226249, 105759, tile_px=256)
    big = crop_box(bbox_of((100, 100, 140, 130)), 226249, 105759, tile_px=512)
    assert abs((big[2] - big[0]) - 2 * (small[2] - small[0])) <= 3
