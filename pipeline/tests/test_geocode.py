import io
import json
import urllib.parse

import pytest

from pipeline import geocode


def resp(muni="43101", name="水前寺"):
    return {"results": {"muniCd": muni, "lv01Nm": name}}


def test_normal_response():
    assert geocode.build_area_name(resp()) == {
        "name": "水前寺",
        "ward": "中央区",
        "municipality": "熊本市",
        "name_source": "gsi_reverse_geocoder",
    }


@pytest.mark.parametrize(
    "code, ward",
    [("43101", "中央区"), ("43102", "東区"), ("43103", "西区"), ("43104", "南区"), ("43105", "北区"), (43104, "南区")],
)
def test_wards(code, ward):
    assert geocode.build_area_name(resp(code))["ward"] == ward


def test_unknown_municipality_keeps_name_without_ward():
    out = geocode.build_area_name(resp("43212", "植木町"))
    assert out["name"] == "植木町" and out["ward"] is None and out["municipality"] is None
    assert out["name_source"] == "gsi_reverse_geocoder"


@pytest.mark.parametrize("blank", ["", "  ", "－", "-", None])
def test_blank_name_becomes_none_but_ward_stays(blank):
    out = geocode.build_area_name(resp("43101", blank))
    assert out["name"] is None and out["ward"] == "中央区" and out["name_source"] == "gsi_reverse_geocoder"


def test_name_is_stripped():
    assert geocode.build_area_name(resp("43101", " 水前寺 \n"))["name"] == "水前寺"


@pytest.mark.parametrize(
    "bad",
    [
        None,
        [],
        "文字列",
        42,
        {},
        {"results": None},
        {"results": []},
        {"results": "x"},
        {"results": {}},
        {"results": {"muniCd": None, "lv01Nm": None}},
        {"results": {"muniCd": 4310.5, "lv01Nm": 3.14}},
        {"results": {"muniCd": {"a": 1}, "lv01Nm": ["b"]}},
        {"results": {"muniCd": True, "lv01Nm": False}},
        {"error": "out of range"},
    ],
)
def test_unexpected_shapes_never_raise_and_give_null_name(bad):
    out = geocode.build_area_name(bad)
    assert out == {"name": None, "ward": None, "municipality": None, "name_source": None}


LONG_OK = "あ" * geocode.MAX_NAME_LEN


@pytest.mark.parametrize(
    "evil",
    [
        "<img src=x onerror=alert(document.domain)>",
        "水前寺<b>",
        "a&amp;b",
        'a"b',
        "a'b",
        "a\nb",
        "a\tb",
        "a\x00b",
        "a\x1bb",
        "a\u202eb",  # 右から左への上書き（表示の偽装）
        "a\u200bb",  # ゼロ幅スペース
        "a\u2028b",
        "a\ud800b",  # 孤立サロゲート（JSON としては読めるが、UTF-8 では書けない）
        "a\ue000b",
        LONG_OK + "あ",  # 41 文字
    ],
)
def test_unsafe_names_are_dropped_but_ward_stays(evil):
    out = geocode.build_area_name(resp("43102", evil))
    assert out["name"] is None and out["ward"] == "東区" and out["municipality"] == "熊本市"


def test_a_huge_name_is_dropped():
    out = geocode.build_area_name(resp("43102", "あ" * 2_000_000))
    assert out["name"] is None and out["ward"] == "東区"


def test_unsafe_name_with_unknown_municipality_gives_no_source():
    out = geocode.build_area_name(resp("43212", "<script>"))
    assert out == {"name": None, "ward": None, "municipality": None, "name_source": None}


@pytest.mark.parametrize("ok", ["水前寺", "水前寺６丁目", "上通町 1-2", "新市街（アーケード）", "ＡＢＣ", "ｱｲｳ", LONG_OK])
def test_ordinary_names_pass(ok):
    assert geocode.build_area_name(resp("43101", ok))["name"] == ok


def test_fallback_name_comes_from_the_area_id():
    assert geocode.fallback_name("z18-226274-105752") == "地区 226274-105752"
    assert geocode.fallback_name("226274-105752") == "地区 226274-105752"


def test_area_fields_keeps_a_real_answer_untouched():
    assert geocode.area_fields(resp(), "z18-1-2") == geocode.build_area_name(resp())


@pytest.mark.parametrize("bad", [None, {}, [], "x", {"results": {}}, {"results": {"muniCd": "43101", "lv01Nm": "<b>"}}, resp("43101", "")])
def test_area_fields_never_returns_null_name_or_ward(bad):
    out = geocode.area_fields(bad, "z18-226274-105752")
    assert out["name"] == "地区 226274-105752" and out["name_source"] == geocode.FALLBACK_SOURCE
    assert isinstance(out["ward"], str) and out["ward"]


def test_area_fields_fills_only_what_is_missing():
    no_name = geocode.area_fields(resp("43103", ""), "z18-5-6")
    assert (no_name["name"], no_name["ward"], no_name["municipality"]) == ("地区 5-6", "西区", "熊本市")
    no_ward = geocode.area_fields(resp("43212", "植木町"), "z18-5-6")
    assert (no_ward["name"], no_ward["ward"], no_ward["municipality"], no_ward["name_source"]) == (
        "植木町",
        geocode.FALLBACK_WARD,
        None,
        "gsi_reverse_geocoder",
    )
    nothing = geocode.area_fields(None, "z18-5-6")
    assert (nothing["ward"], nothing["municipality"]) == (geocode.FALLBACK_WARD, None)


def test_url_has_lat_lon_query():
    url = geocode.reverse_geocode_url(130.706406, 32.794779)
    parts = urllib.parse.urlsplit(url)
    assert parts.scheme == "https" and parts.netloc == "mreversegeocoder.gsi.go.jp"
    assert parts.path == "/reverse-geocoder/LonLatToAddress"
    q = urllib.parse.parse_qs(parts.query)
    assert q == {"lat": ["32.794779"], "lon": ["130.706406"]}


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_fetch_reverse_geocode_uses_injected_opener_only():
    seen = {}

    def opener(req, timeout):
        seen["url"], seen["ua"], seen["timeout"] = req.full_url, req.get_header("User-agent"), timeout
        return FakeResponse(json.dumps(resp(), ensure_ascii=False).encode("utf-8"))

    out = geocode.fetch_reverse_geocode(130.7, 32.8, timeout=3, opener=opener)
    assert out == resp()
    assert "lat=32.800000" in seen["url"] and seen["timeout"] == 3 and "townscan" in seen["ua"]


def test_fetch_all_writes_skips_existing_and_collects_errors(tmp_path):
    areas = [{"id": f"z18-1-{i}", "centroid": [130.0 + i, 32.0]} for i in range(3)]
    out = tmp_path / "geocode.json"
    out.write_text(json.dumps({"z18-1-0": resp("43102", "既存")}, ensure_ascii=False), encoding="utf-8")
    calls, sleeps = [], []

    def fetch(lon, lat):
        calls.append((lon, lat))
        if lon == 132.0:
            raise OSError("timeout")
        return resp("43103", "新規")

    result = geocode.fetch_all(areas, out, fetch=fetch, delay_s=0.25, sleep=sleeps.append)
    assert calls == [(131.0, 32.0), (132.0, 32.0)]  # 取得済みの地区は呼ばない
    assert sleeps == [0.25]  # 最初の取得の前には待たない
    assert result["fetched"] == 2 and list(result["errors"]) == ["z18-1-2"]
    saved = json.loads(out.read_text(encoding="utf-8"))
    assert saved["z18-1-0"]["results"]["lv01Nm"] == "既存" and saved["z18-1-1"]["results"]["lv01Nm"] == "新規"
    assert "z18-1-2" not in saved


def test_fetch_all_tolerates_corrupt_existing_file(tmp_path):
    out = tmp_path / "geocode.json"
    out.write_text("{broken", encoding="utf-8")
    result = geocode.fetch_all([{"id": "a", "centroid": [1, 2]}], out, fetch=lambda lon, lat: resp(), sleep=lambda s: None)
    assert result["fetched"] == 1 and json.loads(out.read_text(encoding="utf-8")) == {"a": resp()}


def test_main_lists_areas_from_run_dir_without_network(tmp_path, monkeypatch):
    run = tmp_path / "run1"
    (run / "colab").mkdir(parents=True)
    (run / "tiles.json").write_text(json.dumps([{"z": 18, "x": 226249, "y": 105769}, {"z": 18, "x": 226250, "y": 105769}]), encoding="utf-8")
    captured = {}

    def fake_fetch_all(areas, out_path, *, delay_s):
        captured.update(areas=areas, out=out_path, delay=delay_s)
        return {"fetched": 2, "errors": {}}

    monkeypatch.setattr(geocode, "fetch_all", fake_fetch_all)
    assert geocode.main(["--run-dir", str(run), "--delay", "0.5"]) == 0
    assert [a["id"] for a in captured["areas"]] == ["z18-226249-105769", "z18-226250-105769"]
    assert captured["areas"][0]["centroid"] == pytest.approx([130.706406, 32.794779], abs=2e-6)
    assert captured["out"] == run / "geocode.json" and captured["delay"] == 0.5


def test_tests_cannot_reach_the_network():
    import socket

    with pytest.raises(RuntimeError, match="禁止"):
        socket.create_connection(("127.0.0.1", 9), timeout=0.1)
