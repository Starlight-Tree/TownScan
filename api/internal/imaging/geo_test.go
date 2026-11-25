package imaging

import (
	"errors"
	"image"
	"math"
	"math/rand"
	"testing"
)

func TestLonLatToTilePx(t *testing.T) {
	// タイルの北西の角が (0,0)、南東の角が (一辺, 一辺)。一辺が 512 なら、座標も 2 倍
	nwLon, nwLat := pxToLonLat(tileX0, tileY0, 0, 0)
	seLon, seLat := pxToLonLat(tileX0, tileY0, 256, 256)
	midLon, midLat := pxToLonLat(tileX0, tileY0, 128, 64)
	cases := []struct {
		name     string
		lon, lat float64
		tilePx   int
		wantX    float64
		wantY    float64
	}{
		{"北西の角", nwLon, nwLat, 256, 0, 0},
		{"南東の角", seLon, seLat, 256, 256, 256},
		{"中の点", midLon, midLat, 256, 128, 64},
		{"一辺 512 のタイル", midLon, midLat, 512, 256, 128},
	}
	for _, c := range cases {
		x, y := lonLatToTilePx(c.lon, c.lat, tileX0, tileY0, c.tilePx)
		if math.Abs(x-c.wantX) > 1e-4 || math.Abs(y-c.wantY) > 1e-4 {
			t.Errorf("%s: (%g, %g), 期待 (%g, %g)", c.name, x, y, c.wantX, c.wantY)
		}
	}
	// 東へ行くほど x が増え、北へ行くほど y が減る（北が上）
	x0, y0 := lonLatToTilePx(nwLon, nwLat, tileX0, tileY0, 256)
	x1, y1 := lonLatToTilePx(nwLon+0.0001, nwLat+0.0001, tileX0, tileY0, 256)
	if !(x1 > x0 && y1 < y0) {
		t.Errorf("向きが違う: 東へ x %g→%g、北へ y %g→%g", x0, x1, y0, y1)
	}
	// 隣のタイルは、座標が 1 タイル分ずれる
	x, _ := lonLatToTilePx(nwLon, nwLat, tileX0+1, tileY0, 256)
	if math.Abs(x+256) > 1e-4 {
		t.Errorf("隣のタイルから見た x = %g, 期待 -256", x)
	}
}

// 小さな箱は、余白（約 20 m = z18 で約 40 画素）が足されて、一辺は約 120 画素になる。中心は箱の中心
func TestCropBoxCentersTheCandidateWithAMargin(t *testing.T) {
	box, err := cropBox(boxNew.bbox(tileX0, tileY0), tileX0, tileY0, 256, MarginM)
	if err != nil {
		t.Fatal(err)
	}
	// 箱 (100,100,140,130) の中心は (120,115)。長い辺 40 + 余白 2 x 約 39.9 = 約 120
	if absDiff(box.Dx(), 120) > 2 || absDiff(box.Dy(), 120) > 2 {
		t.Errorf("切り出しの大きさ = %v, 期待は約 120 x 120", box.Size())
	}
	if cx, cy := (box.Min.X+box.Max.X)/2, (box.Min.Y+box.Max.Y)/2; absDiff(cx, 120) > 1 || absDiff(cy, 115) > 1 {
		t.Errorf("切り出しの中心 = (%d, %d), 期待 (120, 115)", cx, cy)
	}
}

func TestCropBoxSlidesInsideTheTileAtTheEdge(t *testing.T) {
	cases := []struct {
		name string
		r    rect
		want image.Rectangle // 期待の範囲（±2 画素）
	}{
		{"右下の縁", boxEdge, image.Rect(136, 136, 256, 256)},
		{"左上の縁", rect{0, 0, 24, 20}, image.Rect(0, 0, 104, 104)},
		{"右の縁", rect{230, 100, 256, 120}, image.Rect(150, 57, 256, 163)},
	}
	for _, c := range cases {
		box, err := cropBox(c.r.bbox(tileX0, tileY0), tileX0, tileY0, 256, MarginM)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if !box.In(image.Rect(0, 0, 256, 256)) {
			t.Errorf("%s: 切り出し %v がタイルの外へ出ている", c.name, box)
		}
		if absDiff(box.Dx(), box.Dy()) > 1 {
			t.Errorf("%s: 正方形でない: %v", c.name, box.Size())
		}
		if absDiff(box.Min.X, c.want.Min.X) > 4 || absDiff(box.Min.Y, c.want.Min.Y) > 4 ||
			absDiff(box.Max.X, c.want.Max.X) > 4 || absDiff(box.Max.Y, c.want.Max.Y) > 4 {
			t.Errorf("%s: %v, 期待 %v（±4）", c.name, box, c.want)
		}
	}
}

func TestCropBoxSideLimits(t *testing.T) {
	small := rect{120, 120, 124, 124}.bbox(tileX0, tileY0)
	cases := []struct {
		name   string
		bbox   [4]float64
		tilePx int
		margin float64
		wantDx int // ±1
	}{
		{"余白 0 の小さな箱は、下限（32 画素）まで広げる", small, 256, 0, 32},
		{"下限はタイルの大きさに比例する（512 なら 64）", rect{240, 240, 248, 248}.bbox(tileX0, tileY0), 512, 0, 64},
		{"タイルより大きければ、タイル全体", rect{-100, -100, 400, 400}.bbox(tileX0, tileY0), 256, MarginM, 256},
		{"余白が大きければ、タイル全体", small, 256, 500, 256},
	}
	for _, c := range cases {
		box, err := cropBox(c.bbox, tileX0, tileY0, c.tilePx, c.margin)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if absDiff(box.Dx(), c.wantDx) > 1 || absDiff(box.Dy(), c.wantDx) > 1 {
			t.Errorf("%s: 大きさ %v, 期待 %d", c.name, box.Size(), c.wantDx)
		}
	}
}

// 写真の一辺が 2 倍なら、切り出しの範囲も（画素で）2 倍になる
func TestCropBoxScalesWithTheTileSize(t *testing.T) {
	bbox := boxNew.bbox(tileX0, tileY0)
	a, _ := cropBox(bbox, tileX0, tileY0, 256, MarginM)
	b, _ := cropBox(bbox, tileX0, tileY0, 512, MarginM)
	if absDiff(b.Min.X, 2*a.Min.X) > 2 || absDiff(b.Min.Y, 2*a.Min.Y) > 2 || absDiff(b.Dx(), 2*a.Dx()) > 3 {
		t.Errorf("256: %v, 512: %v", a, b)
	}
}

// どんな外接矩形でも、切り出しはタイルの中に収まり、空にならず、ほぼ正方形になる
func TestCropBoxAlwaysStaysInsideTheTile(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	for _, tilePx := range []int{256, 512, 64} {
		tile := image.Rect(0, 0, tilePx, tilePx)
		for i := 0; i < 2000; i++ {
			l, tp := rng.Float64()*320-32, rng.Float64()*320-32 // タイルの外にはみ出す箱も含める
			r := rect{l, tp, l + rng.Float64()*200, tp + rng.Float64()*200}
			box, err := cropBox(r.bbox(tileX0, tileY0), tileX0, tileY0, tilePx, MarginM)
			if err != nil {
				t.Fatalf("%+v: %v", r, err)
			}
			if box.Empty() || !box.In(tile) || absDiff(box.Dx(), box.Dy()) > 1 {
				t.Fatalf("tilePx=%d %+v: 切り出し %v", tilePx, r, box)
			}
		}
	}
}

func TestCropBoxRejectsNonFiniteBBox(t *testing.T) {
	ok := boxNew.bbox(tileX0, tileY0)
	for i := 0; i < 4; i++ {
		for _, bad := range []float64{math.NaN(), math.Inf(1), math.Inf(-1)} {
			b := ok
			b[i] = bad
			if _, err := cropBox(b, tileX0, tileY0, 256, MarginM); !errors.Is(err, ErrInvalid) {
				t.Errorf("bbox[%d]=%v: err = %v, ErrInvalid を期待", i, bad, err)
			}
		}
	}
	// 緯度が極端な値でも、パニックにも、桁あふれの整数にもならない（エラーか、タイルの中の範囲）
	for _, lat := range []float64{90, -90, 1e300, -1e300} {
		box, err := cropBox([4]float64{130, lat, 131, lat}, tileX0, tileY0, 256, MarginM)
		if err == nil && !box.In(image.Rect(0, 0, 256, 256)) {
			t.Errorf("lat=%g: 切り出し %v がタイルの外", lat, box)
		}
	}
}
