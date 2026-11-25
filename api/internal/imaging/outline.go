package imaging

import (
	"encoding/json"
	"image"
	"image/color"
	"math"
)

// 輪郭の色と線種（色だけに頼らない）。backend/app/imaging.py の CLASS_STYLE と同じ。
// dash は {描く長さ, 空ける長さ}（出力の画素）。nil は実線
type style struct {
	color color.RGBA
	dash  *[2]float64
}

var (
	styleConfirmedNew     = style{color: color.RGBA{R: 230, G: 70, B: 30, A: 255}}                            // 実線
	styleExistingOmission = style{color: color.RGBA{R: 30, G: 110, B: 230, A: 255}, dash: &[2]float64{14, 7}} // 破線
	styleUncertain        = style{color: color.RGBA{R: 245, G: 190, B: 0, A: 255}, dash: &[2]float64{3, 7}}   // 点線
	colorCasing           = color.RGBA{R: 255, G: 255, B: 255, A: 255}                                        // 白い縁取り
)

// 出力の画素での座標の上限。外周の頂点がこれを超えるのは、データの誤り（正しい外周は、切り出しの中か、そのすぐ近く）
const maxOutlineCoordinate = 1e6

// styleFor は、分類の見た目。知らない分類は uncertain（Python の CLASS_STYLE.get(cls, CLASS_STYLE["uncertain"]) と同じ）。
func styleFor(class string) style {
	switch class {
	case "confirmed_new":
		return styleConfirmedNew
	case "existing_omission":
		return styleExistingOmission
	default:
		return styleUncertain
	}
}

type point struct{ x, y float64 }

// drawOutline は、候補の外周（先頭のリングだけ）を、白い縁取りの上に分類の色で描く。頂点が 2 つ未満なら何も描かない（Python と同じ）。
// box は、写真の中の切り出しの範囲（画素）。外周の座標を、そこから出力の画素へ写す。
func (r *Renderer) drawOutline(dst *image.RGBA, q Request, box image.Rectangle, tilePx int) error {
	ring, err := outerRing(q.Geometry, r.maxVertices)
	if err != nil {
		return err
	}
	if len(ring) < 2 {
		return nil
	}
	sx := float64(q.Size) / float64(box.Dx())
	sy := float64(q.Size) / float64(box.Dy())
	pts := make([]point, len(ring))
	for i, p := range ring {
		px, py := lonLatToTilePx(p[0], p[1], q.TileX, q.TileY, tilePx)
		u, v := (px-float64(box.Min.X))*sx, (py-float64(box.Min.Y))*sy
		if math.IsNaN(u) || math.IsNaN(v) || math.Abs(u) > maxOutlineCoordinate || math.Abs(v) > maxOutlineCoordinate {
			return invalid("外周の座標が範囲外です")
		}
		pts[i] = point{u, v}
	}

	st := styleFor(q.Class)
	// 白い縁取り: 実線。折れ目は丸める（Pillow の joint="curve"。幅が 4 を超えるときだけ効く）
	strokePolyline(dst, pts, casingWidth/2, colorCasing, true)
	if st.dash == nil {
		// 実線の幅は 4 なので、Pillow は折れ目を丸めない（外側の角が欠ける。白い縁取りが見える）
		strokePolyline(dst, pts, outlineWidth/2, st.color, false)
	} else {
		strokeDashed(dst, pts, outlineWidth/2, st.color, st.dash[0], st.dash[1])
	}
	return nil
}

// outerRing は、GeoJSON の Polygon の外周（先頭のリング）の [経度, 緯度] の列。
// Python は geometry["coordinates"][:1] の先頭のリングを読む（type は見ない。coordinates が無ければ何も描かない）。
// リングの形でないもの（MultiPolygon・Point など）・位置が 2 つの数に満たないもの・頂点が maxVertices を超えるものは ErrInvalid。
func outerRing(geometry []byte, maxVertices int) ([][2]float64, error) {
	if len(geometry) == 0 {
		return nil, nil
	}
	var g struct {
		Coordinates []json.RawMessage `json:"coordinates"`
	}
	if err := json.Unmarshal(geometry, &g); err != nil {
		return nil, invalid("候補の形を読めません")
	}
	if len(g.Coordinates) == 0 {
		return nil, nil
	}
	var ring [][]float64
	if err := json.Unmarshal(g.Coordinates[0], &ring); err != nil {
		return nil, invalid("候補の外周を読めません")
	}
	if len(ring) > maxVertices {
		return nil, invalid("外周の頂点が多すぎます")
	}
	out := make([][2]float64, len(ring))
	for i, p := range ring {
		if len(p) < 2 { // 3 つ目（高さ）があっても、使うのは経度・緯度だけ
			return nil, invalid("外周の位置を読めません")
		}
		out[i] = [2]float64{p[0], p[1]}
	}
	return out, nil
}

// ---- 塗り ----
//
// 縁をぼかさない（アンチエイリアスなし。Pillow の ImageDraw と同じ）。画素の中心が図形の中にある画素だけを、指定の色そのもので塗る。
// 座標は出力の画素（左上が原点。画素 i は [i, i+1) で、中心は i+0.5）。

// span は、[lo, hi) に掛かる画素の番号の範囲 [from, to)（画像の中だけ）。
func span(lo, hi float64, n int) (from, to int) {
	lo = math.Max(lo, 0)
	hi = math.Min(hi, float64(n))
	if !(lo < hi) {
		return 0, 0
	}
	return int(math.Floor(lo)), int(math.Ceil(hi))
}

// strokeSegment は、線分 a→b を、幅 2*hw の長方形（端は直角）で塗る。長さの向きは [0, 長さ)、幅の向きは [-hw, hw) の半開区間なので、
// 軸に平行な線は、いつもちょうど 2*hw 画素の太さ・長さになる（点線の 1 つ分が 3 画素なら、3 画素）。
func strokeSegment(dst *image.RGBA, a, b point, hw float64, col color.RGBA) {
	dx, dy := b.x-a.x, b.y-a.y
	length := math.Hypot(dx, dy)
	if length == 0 {
		return
	}
	ux, uy := dx/length, dy/length
	// 長方形の外接矩形（幅の向きの張り出しは、線の向きが斜めでも、これで足りる）
	ex, ey := hw*math.Abs(uy), hw*math.Abs(ux)
	x0, x1 := span(math.Min(a.x, b.x)-ex, math.Max(a.x, b.x)+ex, dst.Rect.Dx())
	y0, y1 := span(math.Min(a.y, b.y)-ey, math.Max(a.y, b.y)+ey, dst.Rect.Dy())
	for py := y0; py < y1; py++ {
		cy := float64(py) + 0.5 - a.y
		for px := x0; px < x1; px++ {
			cx := float64(px) + 0.5 - a.x
			along := cx*ux + cy*uy
			across := cx*uy - cy*ux
			if along >= 0 && along < length && across >= -hw && across < hw {
				dst.SetRGBA(px, py, col)
			}
		}
	}
}

// fillDisc は、中心 c・半径 r の円を塗る（折れ目を丸めるのに使う）。
func fillDisc(dst *image.RGBA, c point, r float64, col color.RGBA) {
	x0, x1 := span(c.x-r, c.x+r, dst.Rect.Dx())
	y0, y1 := span(c.y-r, c.y+r, dst.Rect.Dy())
	for py := y0; py < y1; py++ {
		cy := float64(py) + 0.5 - c.y
		for px := x0; px < x1; px++ {
			cx := float64(px) + 0.5 - c.x
			if cx*cx+cy*cy <= r*r {
				dst.SetRGBA(px, py, col)
			}
		}
	}
}

// strokePolyline は、折れ線を、幅 2*hw の実線で塗る。round なら、途中の頂点（両端を除く）を円で丸める。
func strokePolyline(dst *image.RGBA, pts []point, hw float64, col color.RGBA, round bool) {
	for i := 0; i+1 < len(pts); i++ {
		strokeSegment(dst, pts[i], pts[i+1], hw, col)
	}
	if round {
		for i := 1; i+1 < len(pts); i++ {
			fillDisc(dst, pts[i], hw, col)
		}
	}
}

// strokeDashed は、折れ線を、「on の長さだけ描き、off の長さだけ空ける」の繰り返し（折れ線の始まりから測る。始まりは描く側）で塗る。
// 1 つ分が折れ目をまたぐときは、線分ごとに分かれる（Pillow の実装と同じ。折れ目で端が直角に切れる）。
// 画像の外にある部分は、描かずに飛ばす（桁外れに長い線でも、時間は画像の大きさで決まる）。
func strokeDashed(dst *image.RGBA, pts []point, hw float64, col color.RGBA, on, off float64) {
	period := on + off
	w, h := float64(dst.Rect.Dx()), float64(dst.Rect.Dy())
	var start float64 // この線分の始まりまでの、折れ線の長さ
	for i := 0; i+1 < len(pts); i++ {
		a, b := pts[i], pts[i+1]
		length := math.Hypot(b.x-a.x, b.y-a.y)
		if length == 0 {
			continue
		}
		if t0, t1, ok := clipSegment(a, b, -hw-1, -hw-1, w+hw+1, h+hw+1); ok {
			lo, hi := start+t0*length, start+t1*length // 折れ線の長さの上で、画像に掛かる区間
			for k := math.Floor(lo / period); k*period < hi; k++ {
				ds, de := math.Max(k*period, lo), math.Min(k*period+on, hi)
				if de <= ds {
					continue
				}
				strokeSegment(dst, lerp(a, b, (ds-start)/length), lerp(a, b, (de-start)/length), hw, col)
			}
		}
		start += length
	}
}

func lerp(a, b point, t float64) point { return point{a.x + (b.x-a.x)*t, a.y + (b.y-a.y)*t} }

// clipSegment は、線分 a→b のうち、矩形 [xmin,xmax]x[ymin,ymax] の中にある部分のパラメーター範囲 [t0, t1]（0〜1）。掛からなければ ok=false。
// Liang-Barsky 法。
func clipSegment(a, b point, xmin, ymin, xmax, ymax float64) (t0, t1 float64, ok bool) {
	dx, dy := b.x-a.x, b.y-a.y
	p := [4]float64{-dx, dx, -dy, dy}
	q := [4]float64{a.x - xmin, xmax - a.x, a.y - ymin, ymax - a.y}
	t0, t1 = 0, 1
	for i := range p {
		if p[i] == 0 {
			if q[i] < 0 {
				return 0, 0, false
			}
			continue
		}
		r := q[i] / p[i]
		if p[i] < 0 {
			if r > t1 {
				return 0, 0, false
			}
			t0 = math.Max(t0, r)
		} else {
			if r < t0 {
				return 0, 0, false
			}
			t1 = math.Min(t1, r)
		}
	}
	return t0, t1, t0 <= t1
}
