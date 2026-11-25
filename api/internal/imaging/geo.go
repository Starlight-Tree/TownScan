package imaging

import (
	"image"
	"math"
)

// 緯度 1 度あたりの長さ（m）。余白（m）を度にするのに使う
const metersPerDegLat = 111_320.0

// lonLatToTilePx は、経度・緯度を、タイル (z18, x, y) の中の画素の座標（左上が原点・下が +y。タイルの外の値にもなる）にする。
// tilePx は、写真の一辺（256 なら 1 タイル = 256 画素）。Web メルカトル。
func lonLatToTilePx(lon, lat float64, x, y, tilePx int) (px, py float64) {
	n := float64(int(1) << TileZ)
	fx := (lon + 180.0) / 360.0 * n
	fy := (1.0 - math.Asinh(math.Tan(lat*math.Pi/180.0))/math.Pi) / 2.0 * n
	return (fx - float64(x)) * float64(tilePx), (fy - float64(y)) * float64(tilePx)
}

// cropBox は、外接矩形（[西, 南, 東, 北]）＋余白を覆う、タイル内の正方形（画素。右・下は含まない）。
//
// 余白は、緯度方向 marginM（m。通常は MarginM）、経度方向は中心の緯度で割った度（cos で補正）。一辺は、余白つきの外接矩形の長い辺か、MinSidePx
// （タイルの大きさに比例）の大きいほう。タイルより大きければタイル全体。タイルの外へ出るときは、正方形のまま内側へずらす。
// 整数にするとき、左・上は切り捨て、右・下は切り上げるので、幅と高さは 1 画素ほど違うことがある（Python と同じ）。
// 外接矩形が数でない（NaN・無限大）ときは ErrInvalid。
func cropBox(bbox [4]float64, x, y, tilePx int, marginM float64) (image.Rectangle, error) {
	for _, v := range bbox {
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return image.Rectangle{}, invalid("外接矩形が有限の数ではありません")
		}
	}
	w, s, e, n := bbox[0], bbox[1], bbox[2], bbox[3]
	latC := (s + n) / 2.0
	dLat := marginM / metersPerDegLat
	dLon := marginM / (metersPerDegLat * math.Max(math.Cos(latC*math.Pi/180.0), 1e-6))
	x0, y0 := lonLatToTilePx(w-dLon, n+dLat, x, y, tilePx)
	x1, y1 := lonLatToTilePx(e+dLon, s-dLat, x, y, tilePx)
	cx, cy := (x0+x1)/2.0, (y0+y1)/2.0
	tile := float64(tilePx)
	scale := tile / 256.0
	side := math.Min(math.Max(math.Max(math.Abs(x1-x0), math.Abs(y1-y0)), MinSidePx*scale), tile)
	left := math.Min(math.Max(cx-side/2.0, 0.0), tile-side)
	top := math.Min(math.Max(cy-side/2.0, 0.0), tile-side)
	for _, v := range []float64{left, top, side} { // 桁あふれ（緯度が極端な値のとき）で、整数にできない
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return image.Rectangle{}, invalid("切り出しの範囲を決められません")
		}
	}
	box := image.Rect(
		int(math.Floor(left)), int(math.Floor(top)),
		min(tilePx, int(math.Ceil(left+side))), min(tilePx, int(math.Ceil(top+side))),
	)
	if box.Empty() {
		return image.Rectangle{}, invalid("切り出しの範囲が空です")
	}
	return box, nil
}
