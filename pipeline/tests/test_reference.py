"""正解の建物データ（GeoJSON）の読み込み。外部通信なし。"""

import json

import pytest

from pipeline import reference


def square(w=2.28, s=48.76, d=0.0002):
    return [[w, s], [w + d, s], [w + d, s + d], [w, s + d], [w, s]]


def polygon(*rings):
    return {"type": "Feature", "properties": {}, "geometry": {"type": "Polygon", "coordinates": list(rings)}}


def write(tmp_path, features):
    path = tmp_path / "buildings.geojson"
    path.write_text(json.dumps({"type": "FeatureCollection", "features": features}), encoding="utf-8")
    return path


def test_polygon_with_a_hole_is_one_building(tmp_path):
    hole = square(2.28005, 48.76005, 0.00005)
    stats = reference.LoadStats()
    out = reference.load_buildings(write(tmp_path, [polygon(square(), hole)]), stats=stats)
    assert len(out) == 1 and len(out[0].interiors) == 1
    assert stats.as_dict() == {"features": 1, "kept": 1, "skipped": {}}


def test_multipolygon_keeps_the_largest_part(tmp_path):
    multi = {"type": "Feature", "geometry": {"type": "MultiPolygon", "coordinates": [[square(d=0.0001)], [square(2.29, 48.77, 0.0003)]]}}
    (out,) = reference.load_buildings(write(tmp_path, [multi]))
    assert out.bounds == pytest.approx((2.29, 48.77, 2.2903, 48.7703))


@pytest.mark.parametrize(
    "feature, reason",
    [
        (None, "geometry を読めない"),
        ({"type": "Feature"}, "geometry を読めない"),
        ({"type": "Feature", "geometry": None}, "geometry を読めない"),
        ({"type": "Feature", "geometry": {"type": "Point", "coordinates": [2.28, 48.76]}}, "面でない"),
        (polygon([[2.28, 48.76], [2.29, 48.76], [2.28, 48.76], [2.28, 48.76]]), "面積が 0"),
        (polygon(square(651000.0, 6862000.0, 10.0)), "経度・緯度の範囲外"),  # 投影座標（m）のままのデータ
        (polygon([[2.28, 48.76], [float("nan"), 48.76], [2.29, 48.77], [2.28, 48.76]]), "経度・緯度の範囲外"),
        (polygon([[2.28, 48.76], [float("inf"), 48.76], [2.29, 48.77], [2.28, 48.76]]), "経度・緯度の範囲外"),
    ],
)
def test_unusable_features_are_counted_and_skipped(tmp_path, feature, reason):
    stats = reference.LoadStats()
    out = reference.load_buildings(write(tmp_path, [feature, polygon(square())]), stats=stats)
    assert len(out) == 1 and dict(stats.skipped) == {reason: 1}


def test_bbox_keeps_only_overlapping_buildings(tmp_path):
    path = write(tmp_path, [polygon(square()), polygon(square(2.40, 48.90))])
    assert len(reference.load_buildings(path, (2.2801, 48.7601, 2.29, 48.77))) == 1  # 一部が重なれば入る
    assert reference.load_buildings(path, (3.0, 49.0, 3.1, 49.1)) == []


@pytest.mark.parametrize("text", ["{broken", "[]", "{}", '{"features": 3}'])
def test_a_file_that_is_not_a_feature_collection_is_an_error(tmp_path, text):
    path = tmp_path / "bad.geojson"
    path.write_text(text, encoding="utf-8")
    with pytest.raises(ValueError, match="正解の建物データ"):
        reference.load_buildings(path)


def test_a_missing_file_is_an_error(tmp_path):
    with pytest.raises(FileNotFoundError):
        reference.load_buildings(tmp_path / "none.geojson")


def test_union_bbox():
    assert reference.union_bbox([(0, 0, 1, 1), (2, -1, 3, 0.5)], pad=0.5) == (-0.5, -1.5, 3.5, 1.5)
    with pytest.raises(ValueError):
        reference.union_bbox([])
