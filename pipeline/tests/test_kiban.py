import pytest

from pipeline import kiban


def ring(*latlon):
    """(緯度, 経度) の並びを、閉じた輪の posList の文字列にする。"""
    pts = list(latlon) + [latlon[0]]
    return "\n".join(f"{lat} {lon}" for lat, lon in pts)


def block(gid, shell, holes=(), typ="普通建物", pos_attrs=""):
    interiors = "".join(
        f"<gml:interior><gml:Ring><gml:curveMember><gml:Curve><gml:segments><gml:LineStringSegment>"
        f"<gml:posList{pos_attrs}>{h}</gml:posList></gml:LineStringSegment></gml:segments></gml:Curve></gml:curveMember></gml:Ring></gml:interior>"
        for h in holes
    )
    return (
        f'<BldA gml:id="{gid}">\n<fid>fid-{gid}</fid>\n'
        f'<lfSpanFr gml:id="{gid}-1"><gml:timePosition>2018-10-01</gml:timePosition></lfSpanFr>\n'
        "<orgGILvl>2500</orgGILvl>\n<area>\n"
        f'<gml:Surface gml:id="{gid}-g" srsName="fguuid:jgd2011.bl"><gml:patches><gml:PolygonPatch>\n'
        "<gml:exterior><gml:Ring><gml:curveMember><gml:Curve><gml:segments><gml:LineStringSegment>"
        f"<gml:posList{pos_attrs}>{shell}</gml:posList>"
        f"</gml:LineStringSegment></gml:segments></gml:Curve></gml:curveMember></gml:Ring></gml:exterior>{interiors}\n"
        f"</gml:PolygonPatch></gml:patches></gml:Surface>\n</area>\n<type>{typ}</type>\n</BldA>\n"
    )


def dataset(*blocks):
    head = '<?xml version="1.0" encoding="utf-8"?>\n<Dataset xmlns:gml="http://www.opengis.net/gml/3.2" gml:id="D">\n<gml:name>基盤地図情報</gml:name>\n'
    return head + "".join(blocks) + "</Dataset>\n"


# 熊本付近の小さな矩形（緯度 32.77、経度 130.72）。東西 0.0002 度・南北 0.0001 度
A = ring((32.7700, 130.7200), (32.7700, 130.7202), (32.7701, 130.7202), (32.7701, 130.7200))
B = ring((32.7800, 130.7300), (32.7800, 130.7302), (32.7801, 130.7302), (32.7801, 130.7300))


def write(tmp_path, name, text):
    p = tmp_path / name
    p.write_text(text, encoding="utf-8")
    return p


def test_parse_block_latlon_order_and_attributes():
    b = kiban.parse_block(block("K1", A, typ="堅ろう建物"))
    assert (b.gml_id, b.fid, b.type) == ("K1", "fid-K1", "堅ろう建物")
    minx, miny, maxx, maxy = b.geometry.bounds
    # posList は「緯度 経度」。shapely は (経度, 緯度)
    assert (minx, maxx) == pytest.approx((130.7200, 130.7202))
    assert (miny, maxy) == pytest.approx((32.7700, 32.7701))


def test_interior_ring_becomes_hole():
    hole = ring((32.77003, 130.72005), (32.77003, 130.72010), (32.77006, 130.72010), (32.77006, 130.72005))
    b = kiban.parse_block(block("K1", A, holes=[hole]))
    assert len(b.geometry.interiors) == 1
    assert b.geometry.area < kiban.parse_block(block("K1", A)).geometry.area


def test_poslist_attributes_and_whitespace_variants():
    b = kiban.parse_block(block("K1", A, pos_attrs=' srsDimension="2"').replace("\n", "\r\n"))
    assert b.geometry.is_valid and b.geometry.area > 0


def test_tag_order_does_not_matter():
    text = block("K1", A)
    swapped = text.replace("<fid>fid-K1</fid>\n", "").replace("<type>普通建物</type>\n", "<type>普通建物</type>\n<fid>fid-K1</fid>\n")
    b = kiban.parse_block(swapped)
    assert b.fid == "fid-K1" and b.type == "普通建物"


def test_load_folder_ignores_metadata_and_reads_all_files(tmp_path):
    write(tmp_path, "FG-GML-1-BldA-20181001-0001.xml", dataset(block("K1", A)))
    write(tmp_path, "FG-GML-1-BldA-20181001-0002.xml", dataset(block("K2", B)))
    write(tmp_path, "fmdid18-1001.xml", "<MD_Metadata><title>基盤地図情報</title></MD_Metadata>")
    stats = kiban.LoadStats()
    out = kiban.load_buildings(tmp_path, stats=stats)
    assert sorted(b.gml_id for b in out) == ["K1", "K2"]
    assert stats.blocks == 2 and stats.parsed == 2 and stats.kept == 2 and not stats.skipped


def test_bbox_filter(tmp_path):
    write(tmp_path, "FG-GML-1-BldA-20181001-0001.xml", dataset(block("K1", A), block("K2", B)))
    near_a = (130.7199, 32.7699, 130.7203, 32.7702)
    assert [b.gml_id for b in kiban.load_buildings(tmp_path, near_a)] == ["K1"]
    # 建物の外接矩形が bbox に少しでもかかれば含める
    touching = (130.7201, 32.77005, 130.7250, 32.7750)
    assert [b.gml_id for b in kiban.load_buildings(tmp_path, touching)] == ["K1"]
    assert kiban.load_buildings(tmp_path, (131.0, 33.0, 131.1, 33.1)) == []


@pytest.mark.parametrize("chunk", [1, 7, 37, 1000, 1 << 22])
def test_chunk_boundaries_do_not_change_result(tmp_path, chunk):
    """塊（と日本語の多バイト文字）がチャンクの境界で割れても、同じ結果になる。"""
    text = dataset(block("K1", A, typ="堅ろう無壁舎"), block("K2", B), block("K3", A))
    p = write(tmp_path, "FG-GML-1-BldA-20181001-0001.xml", text)
    out = kiban.load_buildings(p, chunk_size=chunk)
    assert [b.gml_id for b in out] == ["K1", "K2", "K3"]
    assert out[0].type == "堅ろう無壁舎"


def test_broken_blocks_are_counted_and_skipped(tmp_path):
    good = block("OK", A)
    bad_text = block("TXT", "32.7700 130.7200 abc 130.7300 32.7800 130.7400")  # 数値でない
    odd = block("ODD", "32.7700 130.7200 32.7700")  # 座標の数が奇数
    few = block("FEW", "32.7700 130.7200\n32.7701 130.7201")  # 点が足りない
    no_ext = block("NOEXT", A).replace("gml:exterior", "gml:xxx")
    lat_out = block("LAT", ring((130.7, 32.77), (130.7, 32.78), (130.8, 32.78)))  # 緯度が 90 を超える
    nan = block("NAN", "32.77 130.72 nan 130.73 32.78 130.74")
    degenerate = block("DEG", "32.77 130.72 32.77 130.72 32.77 130.72")
    p = write(tmp_path, "FG-GML-1-BldA-20181001-0001.xml", dataset(bad_text, good, odd, few, no_ext, lat_out, nan, degenerate))
    stats = kiban.LoadStats()
    out = kiban.load_buildings(p, stats=stats)
    assert [b.gml_id for b in out] == ["OK"]
    assert stats.blocks == 8 and stats.parsed == 1
    assert sum(stats.skipped.values()) == 7
    assert "exterior が無い" in stats.skipped


def test_broken_hole_is_ignored_but_shell_kept():
    b = kiban.parse_block(block("K1", A, holes=["abc def ghi"]))
    assert len(b.geometry.interiors) == 0 and b.geometry.area > 0


def test_self_intersecting_ring_is_repaired():
    bow = ring((32.7700, 130.7200), (32.7701, 130.7202), (32.7700, 130.7202), (32.7701, 130.7200))  # 8 の字
    b = kiban.parse_block(block("K1", bow))
    assert b.geometry.is_valid and b.geometry.area > 0


def test_multiple_poslists_in_one_ring_are_joined():
    text = block("K1", A).replace(
        "</gml:posList></gml:LineStringSegment>",
        "</gml:posList></gml:LineStringSegment><gml:LineStringSegment><gml:posList>32.7701 130.7200\n32.7700 130.7200</gml:posList></gml:LineStringSegment>",
        1,
    )
    # 最初の輪は A（閉じている）。後ろの posList は連結される。壊れずに読めること
    assert kiban.parse_block(text).geometry.is_valid


def test_empty_and_noise_files(tmp_path):
    write(tmp_path, "FG-GML-1-BldA-20181001-0001.xml", "")
    write(tmp_path, "FG-GML-1-BldA-20181001-0002.xml", "<Dataset>BldA の記述なし</Dataset>")
    assert kiban.load_buildings(tmp_path) == []
    assert kiban.load_buildings(tmp_path / "none") == []  # フォルダが無ければ空（呼び出し側が検査する）


def test_find_xml_files_variants(tmp_path):
    p = write(tmp_path, "FG-GML-1-BldA-20181001-0001.xml", dataset(block("K1", A)))
    assert kiban.find_xml_files(p) == [str(p)]
    assert kiban.find_xml_files([p]) == [str(p)]
    sub = tmp_path / "sub"
    sub.mkdir()
    other = write(sub, "FG-GML-2-BldA-20181001-0001.xml", dataset(block("K2", B)))
    assert kiban.find_xml_files(sub) == [str(other)]


def test_union_bbox():
    assert kiban.union_bbox([(0, 0, 1, 1), (2, -1, 3, 0.5)], pad=0.5) == (-0.5, -1.5, 3.5, 1.5)
    with pytest.raises(ValueError):
        kiban.union_bbox([])


def test_vintage_statistics_count_attributes_of_returned_buildings(tmp_path):
    """読み込んだ建物の gml:id 接頭辞・lfSpanFr・devDate を数える（参照の時期の注記の元データ）。範囲外の建物は数えない。"""
    dev = '<devDate gml:id="{g}-2"><gml:timePosition>2018-10-02</gml:timePosition></devDate>\n'
    k1 = block("K17_1_1", A).replace("<orgGILvl>", dev.format(g="K17_1_1") + "<orgGILvl>")
    k2 = block("K17_1_2", A)  # devDate が無い
    k3 = block("N18_9_1", A).replace("2018-10-01", "2019-04-01")
    far = block("K17_9_9", B)  # bbox の外
    p = write(tmp_path, "FG-GML-1-BldA-20181001-0001.xml", dataset(k1, k2, k3, far))
    stats = kiban.LoadStats()
    out = kiban.load_buildings(p, (130.7199, 32.7699, 130.7203, 32.7702), stats=stats)
    assert [b.gml_id for b in out] == ["K17_1_1", "K17_1_2", "N18_9_1"]
    assert (out[0].lf_span_from, out[0].dev_date) == ("2018-10-01", "2018-10-02") and out[1].dev_date == ""
    v = stats.vintage_dict()
    assert v["gml_id_prefix"] == {"K17": 2, "N18": 1}
    assert v["lf_span_from"] == {"2018-10-01": 2, "2019-04-01": 1}
    assert v["dev_date"] == {kiban.NO_VALUE: 2, "2018-10-02": 1}
    assert "vintage" not in stats.as_dict()  # run.json に出る形は変えない


def test_vintage_prefix_is_empty_without_underscore(tmp_path):
    p = write(tmp_path, "FG-GML-1-BldA-20181001-0001.xml", dataset(block("K1", A), block("K2", B)))
    stats = kiban.LoadStats()
    kiban.load_buildings(p, stats=stats)
    assert stats.vintage_dict()["gml_id_prefix"] == {kiban.NO_VALUE: 2}  # 番号そのものを数えて、種類が膨らまない
