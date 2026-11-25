package imaging

import (
	"bytes"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"testing"
)

// 契約の検査（contract/test_image.py）と同じ、合成の写真タイル: R=列・G=行（タイルの中の画素の位置）、B=年（2018→50、2023→200）。
// これで、切り出した画像の画素から、元のタイルのどこを切ったか（位置・範囲・向き）と、どの年の写真かが分かる。
const (
	blue2018 = 50
	blue2023 = 200
	// 契約の合成データの A1（合成町）のタイル番号
	tileX0, tileY0 = 226249, 105759
)

func blueOf(year int) uint8 {
	if year == 2018 {
		return blue2018
	}
	return blue2023
}

func gradientTile(px int, blue uint8) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, px, px))
	for y := 0; y < px; y++ {
		for x := 0; x < px; x++ {
			img.SetRGBA(x, y, color.RGBA{R: uint8(x * 256 / px), G: uint8(y * 256 / px), B: blue, A: 255})
		}
	}
	return img
}

func encodePNG(t testing.TB, img image.Image) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// writeTiles は、dir に、両年の合成の写真（256x256）を置く。
func writeTiles(t testing.TB, dir string, x, y int) {
	t.Helper()
	for _, year := range Years {
		writeFile(t, tilePath(dir, year, x, y), encodePNG(t, gradientTile(256, blueOf(year))))
	}
}

func tilePath(dir string, year, x, y int) string {
	return filepath.Join(dir, fmt.Sprint(year), fmt.Sprintf("%d_%d.png", x, y))
}

func writeFile(t testing.TB, path string, data []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func jpegBytes(t testing.TB, img image.Image) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 95}); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// pxToLonLat は、タイル (z18, x, y) の中の画素（256 画素の一辺）の位置の経度・緯度（Python の px_to_lonlat と同じ）。
func pxToLonLat(x, y int, px, py float64) (lon, lat float64) {
	n := float64(int(1) << TileZ)
	lon = (float64(x)+px/256)/n*360 - 180
	lat = math.Atan(math.Sinh(math.Pi*(1-2*(float64(y)+py/256)/n))) * 180 / math.Pi
	return lon, lat
}

// rect は、タイルの中の画素の箱（左・上・右・下）の候補: 外接矩形（西・南・東・北）と、外周が箱の Polygon（JSON）。
type rect struct{ l, t, r, b float64 }

func (r rect) bbox(x, y int) [4]float64 {
	w, n := pxToLonLat(x, y, r.l, r.t)
	e, s := pxToLonLat(x, y, r.r, r.b)
	return [4]float64{w, s, e, n}
}

func (r rect) geometry(x, y int) []byte {
	var ring [][2]float64
	for _, c := range [][2]float64{{r.l, r.t}, {r.r, r.t}, {r.r, r.b}, {r.l, r.b}, {r.l, r.t}} {
		lon, lat := pxToLonLat(x, y, c[0], c[1])
		ring = append(ring, [2]float64{lon, lat})
	}
	b, err := json.Marshal(map[string]any{"type": "Polygon", "coordinates": [][][2]float64{ring}})
	if err != nil {
		panic(err)
	}
	return b
}

// 契約の合成データの A1 の 3 候補（画素の箱）
var (
	boxNew      = rect{100, 100, 140, 130} // 新規出現。中心 (120, 115)
	boxOmission = rect{30, 40, 50, 55}     // 既存の描き漏れ
	boxEdge     = rect{216, 200, 256, 236} // 判定保留。タイルの右下の縁に接している
)

func request(year int, box rect, class string, size int) Request {
	return Request{
		Year: year, TileX: tileX0, TileY: tileY0,
		BBox: box.bbox(tileX0, tileY0), Geometry: box.geometry(tileX0, tileY0), Class: class, Size: size,
	}
}

func decodePNG(t testing.TB, data []byte) *image.RGBA {
	t.Helper()
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("PNG として読めません: %v", err)
	}
	out := image.NewRGBA(img.Bounds())
	for y := out.Rect.Min.Y; y < out.Rect.Max.Y; y++ {
		for x := out.Rect.Min.X; x < out.Rect.Max.X; x++ {
			out.Set(x, y, img.At(x, y))
		}
	}
	return out
}

func pixel(img *image.RGBA, x, y int) color.RGBA { return img.RGBAAt(x, y) }

func countColors(img *image.RGBA) map[color.RGBA]int {
	m := map[color.RGBA]int{}
	for y := img.Rect.Min.Y; y < img.Rect.Max.Y; y++ {
		for x := img.Rect.Min.X; x < img.Rect.Max.X; x++ {
			m[img.RGBAAt(x, y)]++
		}
	}
	return m
}

func absDiff(a, b int) int {
	if a < b {
		return b - a
	}
	return a - b
}
