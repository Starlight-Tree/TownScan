import io
import json
import urllib.parse

import pytest

from pipeline import geocode


def resp(code="92050", street="Rue de la Paix", **extra):
    return {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {"citycode": code, "street": street, **extra}}]}


def test_normal_response():
    assert geocode.build_area_name(resp()) == {
        "name": "Rue de la Paix",
        "ward": "ナンテール",
        "municipality": "オー・ド・セーヌ県",
        "name_source": "ign_reverse_geocoder",
    }


@pytest.mark.parametrize(
    "code, ward",
    [("92019", "シャトネ・マラブリー"), ("92023", "クラマール"), ("92048", "ムードン"), ("92060", "ル・プレシ・ロバンソン"), (92050, "ナンテール")],
)
def test_communes_in_the_table(code, ward):
    assert geocode.build_area_name(resp(code))["ward"] == ward


def test_unknown_commune_uses_the_city_name_from_the_response():
    out = geocode.build_area_name(resp("92002", "Rue A", city="Antony"))
    assert (out["ward"], out["municipality"]) == ("Antony", "オー・ド・セーヌ県")


@pytest.mark.parametrize("blank", ["", "  ", None])
def test_blank_name_becomes_none_but_ward_stays(blank):
    out = geocode.build_area_name(resp("92050", blank))
    assert out["name"] is None and out["ward"] == "ナンテール" and out["name_source"] == "ign_reverse_geocoder"


def test_name_is_stripped():
    assert geocode.build_area_name(resp(street=" Rue de la Paix \n"))["name"] == "Rue de la Paix"


@pytest.mark.parametrize(
    "bad",
    [
        None,
        [],
        "文字列",
        42,
        {},
        {"features": None},
        {"features": []},
        {"features": "x"},
        {"features": [1]},
        {"features": [{}]},
        {"features": [{"properties": []}]},
        {"features": [{"properties": {}}]},
        {"features": [{"properties": {"citycode": None, "street": None, "city": None}}]},
        {"features": [{"properties": {"citycode": 9205.5, "street": 3.14}}]},
        {"features": [{"properties": {"citycode": {"a": 1}, "street": ["b"], "city": True}}]},
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
        "Rue<b>",
        "a&amp;b",
        'a"b',
        "a\nb",
        "a\tb",
        "a\x00b",
        "a\x1bb",
        "a‮b",  # 右から左への上書き（表示の偽装）
        "a​b",  # ゼロ幅スペース
        "a b",
        "a\ud800b",  # 孤立サロゲート（JSON としては読めるが、UTF-8 では書けない）
        "ab",
        LONG_OK + "あ",  # 41 文字
    ],
)
def test_unsafe_names_are_dropped_but_ward_stays(evil):
    out = geocode.build_area_name(resp("92019", evil))
    assert out["name"] is None and out["ward"] == "シャトネ・マラブリー" and out["municipality"] == "オー・ド・セーヌ県"


def test_apostrophe_is_replaced_not_dropped():
    assert geocode.build_area_name(resp(street="Rue de l'Église"))["name"] == "Rue de l’Église"


def test_a_huge_name_is_dropped():
    out = geocode.build_area_name(resp("92019", "あ" * 2_000_000))
    assert out["name"] is None and out["ward"] == "シャトネ・マラブリー"


def test_unsafe_name_and_city_outside_the_table_give_no_source():
    out = geocode.build_area_name(resp("75056", "<script>", city="<b>Paris</b>"))
    assert out == {"name": None, "ward": None, "municipality": None, "name_source": None}


@pytest.mark.parametrize("ok", ["Allée des Bois", "Rue de la Paix 1-2", "Rue (A)", "水前寺", "ＡＢＣ", "ｱｲｳ", LONG_OK])
def test_ordinary_names_pass(ok):
    assert geocode.build_area_name(resp(street=ok))["name"] == ok


def test_fallback_name_comes_from_the_area_id():
    assert geocode.fallback_name("z18-132739-90287") == "地区 132739-90287"
    assert geocode.fallback_name("132739-90287") == "地区 132739-90287"


def test_area_fields_keeps_a_real_answer_untouched():
    assert geocode.area_fields(resp(), "z18-1-2") == geocode.build_area_name(resp())


@pytest.mark.parametrize("bad", [None, {}, [], "x", {"features": []}, resp("92050", "<b>"), resp("92050", "")])
def test_area_fields_never_returns_null_name_or_ward(bad):
    out = geocode.area_fields(bad, "z18-132739-90287")
    assert out["name"] == "地区 132739-90287" and out["name_source"] == geocode.FALLBACK_SOURCE
    assert isinstance(out["ward"], str) and out["ward"]


def test_area_fields_fills_only_what_is_missing():
    no_name = geocode.area_fields(resp("92023", ""), "z18-5-6")
    assert (no_name["name"], no_name["ward"], no_name["municipality"]) == ("地区 5-6", "クラマール", "オー・ド・セーヌ県")
    no_ward = geocode.area_fields(resp("75056", "Rue A"), "z18-5-6")
    assert (no_ward["name"], no_ward["ward"], no_ward["municipality"], no_ward["name_source"]) == (
        "Rue A",
        geocode.FALLBACK_WARD,
        None,
        "ign_reverse_geocoder",
    )
    nothing = geocode.area_fields(None, "z18-5-6")
    assert (nothing["ward"], nothing["municipality"]) == (geocode.FALLBACK_WARD, None)


def test_url_has_lon_lat_query():
    url = geocode.reverse_geocode_url(2.289837, 48.76391)
    parts = urllib.parse.urlsplit(url)
    assert parts.scheme == "https" and parts.netloc == "data.geopf.fr"
    assert parts.path == "/geocodage/reverse"
    q = urllib.parse.parse_qs(parts.query)
    assert q == {"lon": ["2.289837"], "lat": ["48.763910"], "limit": ["1"], "index": ["address"]}


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

    out = geocode.fetch_reverse_geocode(2.29, 48.76, timeout=3, opener=opener)
    assert out == resp()
    assert "lat=48.760000" in seen["url"] and seen["timeout"] == 3 and "townscan" in seen["ua"]


def test_fetch_all_writes_skips_existing_and_collects_errors(tmp_path):
    areas = [{"id": f"z18-1-{i}", "centroid": [2.0 + i, 48.0]} for i in range(3)]
    out = tmp_path / "geocode.json"
    out.write_text(json.dumps({"z18-1-0": resp("92019", "既存")}, ensure_ascii=False), encoding="utf-8")
    calls, sleeps = [], []

    def fetch(lon, lat):
        calls.append((lon, lat))
        if lon == 4.0:
            raise OSError("timeout")
        return resp("92023", "新規")

    result = geocode.fetch_all(areas, out, fetch=fetch, delay_s=0.25, sleep=sleeps.append)
    assert calls == [(3.0, 48.0), (4.0, 48.0)]  # 取得済みの地区は呼ばない
    assert sleeps == [0.25]  # 最初の取得の前には待たない
    assert result["fetched"] == 2 and list(result["errors"]) == ["z18-1-2"]
    saved = json.loads(out.read_text(encoding="utf-8"))
    assert geocode.build_area_name(saved["z18-1-0"])["name"] == "既存"
    assert geocode.build_area_name(saved["z18-1-1"])["name"] == "新規"
    assert "z18-1-2" not in saved


def test_fetch_all_tolerates_corrupt_existing_file(tmp_path):
    out = tmp_path / "geocode.json"
    out.write_text("{broken", encoding="utf-8")
    result = geocode.fetch_all([{"id": "a", "centroid": [1, 2]}], out, fetch=lambda lon, lat: resp(), sleep=lambda s: None)
    assert result["fetched"] == 1 and json.loads(out.read_text(encoding="utf-8")) == {"a": resp()}


def test_main_lists_areas_from_run_dir_without_network(tmp_path, monkeypatch):
    run = tmp_path / "fr1"
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
