package imaging

import (
	"errors"
	"image"
	"image/color"
	"math"
	"strings"
	"testing"
	"time"
)

var (
	red   = color.RGBA{R: 255, A: 255}
	black = color.RGBA{A: 255}
)

func blank(w, h int) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for i := 3; i < len(img.Pix); i += 4 {
		img.Pix[i] = 255 // 不透明の黒
	}
	return img
}

func countOf(img *image.RGBA, c color.RGBA) int { return countColors(img)[c] }

func TestStrokeSegmentCoversExactlyWidthTimesLengthOnAxisAlignedLines(t *testing.T) {
	cases := []struct {
		name string
		a, b point
		hw   float64
		want int
	}{
		{"水平（幅 4・長さ 10）", point{10, 10}, point{20, 10}, 2, 40},
		{"水平（始まりが画素の中ほど）", point{10.3, 10.3}, point{20.3, 10.3}, 2, 40},
		{"逆向き", point{20, 10}, point{10, 10}, 2, 40},
		{"垂直", point{10, 10}, point{10, 25}, 2, 60},
		{"幅 7（縁取り）", point{10, 10}, point{30, 10}, 3.5, 140},
		{"長さ 3 の点", point{10, 10}, point{13, 10}, 2, 12},
		{"長さ 0 は何も塗らない", point{10, 10}, point{10, 10}, 2, 0},
	}
	for _, c := range cases {
		img := blank(64, 64)
		strokeSegment(img, c.a, c.b, c.hw, red)
		if got := countOf(img, red); got != c.want {
			t.Errorf("%s: %d 画素, 期待 %d", c.name, got, c.want)
		}
	}
}

// 斜めの線も、面積は幅 x 長さにほぼ等しい（向きで太さが変わらない）
func TestStrokeSegmentDiagonalAreaMatchesWidthTimesLength(t *testing.T) {
	for _, deg := range []float64{15, 30, 45, 60, 75, 120, 200, 300} {
		rad := deg * math.Pi / 180
		a := point{100, 100}
		b := point{a.x + 80*math.Cos(rad), a.y + 80*math.Sin(rad)}
		img := blank(256, 256)
		strokeSegment(img, a, b, 5, red) // 太さ 10。細いと、斜めの画素の数が対角の間隔（約 0.7 画素）で量子化されて、数が大きくずれる
		got, want := float64(countOf(img, red)), 80.0*10
		if math.Abs(got-want)/want > 0.08 { // 45 度は、対角の間隔（約 0.7 画素）の格子に重なって、約 +7% になる
			t.Errorf("%g 度: %g 画素, 期待 約 %g", deg, got, want)
		}
	}
}

func TestStrokeSegmentClipsToTheImage(t *testing.T) {
	img := blank(32, 32)
	// 画像の外へはみ出す線（パニックしない・外には塗らない）。画像の外の座標でも、整数にあふれない
	strokeSegment(img, point{-50, 16}, point{80, 16}, 2, red)
	if got := countOf(img, red); got != 32*4 {
		t.Errorf("はみ出す水平線: %d 画素, 期待 %d", got, 32*4)
	}
	strokeSegment(img, point{-1e12, -1e12}, point{1e12, 1e12}, 2, black)
	strokeSegment(img, point{1e9, 5}, point{1e9, 9}, 2, red)
	fillDisc(img, point{-1e15, 5}, 3, red)
}

func TestFillDisc(t *testing.T) {
	img := blank(40, 40)
	fillDisc(img, point{20, 20}, 3.5, red)
	// 半径 3.5 の円: 中心が (20,20) の格子の上にあるので、画素の中心 (i+0.5, j+0.5) との距離の 2 乗が 12.25 以下の画素
	want := 0
	for j := 0; j < 40; j++ {
		for i := 0; i < 40; i++ {
			dx, dy := float64(i)+0.5-20, float64(j)+0.5-20
			if dx*dx+dy*dy <= 12.25 {
				want++
			}
		}
	}
	if got := countOf(img, red); got != want || want < 30 {
		t.Errorf("円: %d 画素, 期待 %d", got, want)
	}
}

func TestStrokePolylineRoundsOnlyTheInnerJointsWhenAsked(t *testing.T) {
	pts := []point{{10, 10}, {30, 10}, {30, 30}}
	plain, round := blank(48, 48), blank(48, 48)
	strokePolyline(plain, pts, 3.5, red, false)
	strokePolyline(round, pts, 3.5, red, true)
	// 外側の角（北東）: 線分だけだと欠ける。円なら (31,8) は塗られ、角の先 (33,6) は円の外
	if pixel(plain, 31, 8) != black {
		t.Error("丸めないときは、外側の角 (31,8) が欠けるはず")
	}
	if pixel(round, 31, 8) != red {
		t.Error("丸めるときは、外側の角 (31,8) が塗られるはず")
	}
	if pixel(round, 33, 6) != black {
		t.Error("丸めても、角の先 (33,6) は塗らない（円の外）")
	}
	// 両端（折れ目でない頂点）は丸めない: 始点 (10,10) の左 (6,10) は塗られない
	if pixel(round, 6, 10) != black {
		t.Error("始点は丸めない")
	}
	if countOf(round, red) <= countOf(plain, red) {
		t.Error("丸めたほうが、塗る画素が多いはず")
	}
}

func TestStrokeDashedPatternAlongAHorizontalLine(t *testing.T) {
	img := blank(128, 16)
	strokeDashed(img, []point{{0, 8}, {100, 8}}, 2, red, 14, 7)
	// 周期 21 の始まりの 14 画素が塗られる。0〜99 の列: 描く列 = (x mod 21) < 14 かつ x < 100
	for x := 0; x < 128; x++ {
		want := x < 100 && x%21 < 14
		got := pixel(img, x, 7) == red // 太さ 4 は 6〜9 行
		if got != want {
			t.Fatalf("列 %d: 塗られている=%v, 期待 %v", x, got, want)
		}
	}
	// 太さは 4 行
	rows := 0
	for y := 0; y < 16; y++ {
		if pixel(img, 0, y) == red {
			rows++
		}
	}
	if rows != 4 {
		t.Errorf("太さ = %d 行, 期待 4", rows)
	}
	// 点線（3 描く・7 空ける）
	dot := blank(128, 16)
	strokeDashed(dot, []point{{0, 8}, {100, 8}}, 2, red, 3, 7)
	if got, want := countOf(dot, red), 10*3*4; got != want {
		t.Errorf("点線: %d 画素, 期待 %d", got, want)
	}
}

// 折れ線の長さの上で、つながって途切れない: 1 つ分が折れ目をまたぐと、線分ごとに分かれる。周期は折れ線の始まりから測る
func TestStrokeDashedKeepsThePhaseAcrossSegments(t *testing.T) {
	img := blank(64, 64)
	// 水平 30 → 下へ 30。周期 21: 描く [0,14)、[21,35)。2 つ目は折れ目（長さ 30）をまたぎ、水平の 9 + 垂直の 5
	strokeDashed(img, []point{{10, 10}, {40, 10}, {40, 40}}, 2, red, 14, 7)
	if pixel(img, 10+25, 10) != red { // 長さ 25（21〜35 の中）
		t.Error("2 つ目の描く区間（水平の部分）が塗られていない")
	}
	if pixel(img, 10+18, 10) == red { // 長さ 18（14〜21 の空き）
		t.Error("空きの区間が塗られている")
	}
	if pixel(img, 40, 10+3) != red { // 長さ 33（21〜35 の中。垂直の部分）
		t.Error("折れ目のあとの描く区間（垂直の部分）が塗られていない")
	}
	if pixel(img, 40, 10+10) == red { // 長さ 40（35〜42 の空き）
		t.Error("折れ目のあとの空きが塗られている")
	}
}

// 桁外れに長い線でも、時間は画像の大きさで決まり、周期の位相も保たれる
func TestStrokeDashedHugeCoordinatesFinishQuicklyAndKeepTheRhythm(t *testing.T) {
	img := blank(64, 16)
	start := time.Now()
	strokeDashed(img, []point{{-1e6, 8}, {1e6, 8}}, 2, red, 14, 7)
	if d := time.Since(start); d > time.Second {
		t.Fatalf("%v かかった", d)
	}
	for x := 0; x < 64; x++ {
		pos := float64(x) + 1e6 // 折れ線の長さの上の位置（画素の左端）
		want := math.Mod(pos, 21) < 14
		if got := pixel(img, x, 7) == red; got != want {
			t.Fatalf("列 %d: %v, 期待 %v", x, got, want)
		}
	}
}

func TestClipSegment(t *testing.T) {
	cases := []struct {
		name           string
		a, b           point
		ok             bool
		wantT0, wantT1 float64
	}{
		{"中にある", point{2, 2}, point{8, 8}, true, 0, 1},
		{"左から入って中で終わる", point{-10, 5}, point{5, 5}, true, 10.0 / 15, 1},
		{"両側へ抜ける", point{-10, 5}, point{20, 5}, true, 10.0 / 30, 20.0 / 30},
		{"外（上）", point{0, -5}, point{10, -5}, false, 0, 0},
		{"外（斜めに、角を避ける）", point{-5, 8}, point{2, 15}, false, 0, 0},
		{"外で平行", point{-3, 0}, point{-3, 10}, false, 0, 0},
		{"縁を這う", point{0, 0}, point{10, 0}, true, 0, 1},
	}
	for _, c := range cases {
		t0, t1, ok := clipSegment(c.a, c.b, 0, 0, 10, 10)
		if ok != c.ok {
			t.Errorf("%s: ok=%v, 期待 %v", c.name, ok, c.ok)
			continue
		}
		if ok && (math.Abs(t0-c.wantT0) > 1e-9 || math.Abs(t1-c.wantT1) > 1e-9) {
			t.Errorf("%s: [%g, %g], 期待 [%g, %g]", c.name, t0, t1, c.wantT0, c.wantT1)
		}
	}
}

func TestOuterRing(t *testing.T) {
	const ring = `[[130.0,32.0],[130.1,32.0],[130.1,32.1],[130.0,32.0]]`
	cases := []struct {
		name    string
		in      string
		want    int // 頂点数
		wantErr bool
	}{
		{"Polygon の外周", `{"type":"Polygon","coordinates":[` + ring + `]}`, 4, false},
		{"穴は無視して、外周だけ", `{"type":"Polygon","coordinates":[` + ring + `,[[130.02,32.02],[130.03,32.02],[130.02,32.03]]]}`, 4, false},
		{"type が無くても読む（Python は type を見ない）", `{"coordinates":[` + ring + `]}`, 4, false},
		{"高さつきの位置", `{"type":"Polygon","coordinates":[[[130.0,32.0,10.0],[130.1,32.0,11.0]]]}`, 2, false},
		{"coordinates が無い", `{"type":"Polygon"}`, 0, false},
		{"coordinates が空", `{"type":"Polygon","coordinates":[]}`, 0, false},
		{"外周が空", `{"type":"Polygon","coordinates":[[]]}`, 0, false},
		{"形が空（未設定）", ``, 0, false},
		{"MultiPolygon は読めない", `{"type":"MultiPolygon","coordinates":[[` + ring + `]]}`, 0, true},
		{"Point は読めない", `{"type":"Point","coordinates":[130.0,32.0]}`, 0, true},
		{"LineString は読めない", `{"type":"LineString","coordinates":` + ring + `}`, 0, true},
		{"位置が 1 つの数だけ", `{"type":"Polygon","coordinates":[[[130.0]]]}`, 0, true},
		{"数でない座標", `{"type":"Polygon","coordinates":[[["a","b"]]]}`, 0, true},
		{"JSON でない", `{"type":`, 0, true},
		{"オブジェクトでない", `[1,2]`, 0, true},
		{"null", `null`, 0, false},
	}
	for _, c := range cases {
		got, err := outerRing([]byte(c.in), 100)
		if (err != nil) != c.wantErr || (err != nil && !errors.Is(err, ErrInvalid)) {
			t.Errorf("%s: err = %v, エラーの有無の期待 %v（ErrInvalid）", c.name, err, c.wantErr)
			continue
		}
		if len(got) != c.want {
			t.Errorf("%s: 頂点 %d 個, 期待 %d", c.name, len(got), c.want)
		}
	}
	// 高さは使わない。経度・緯度の順
	got, _ := outerRing([]byte(`{"coordinates":[[[130.5,32.5,99.0],[131.5,33.5]]]}`), 100)
	if got[0] != [2]float64{130.5, 32.5} || got[1] != [2]float64{131.5, 33.5} {
		t.Errorf("頂点 = %v", got)
	}
	// 頂点の数の上限
	big := `{"coordinates":[[` + strings.Repeat(`[130.0,32.0],`, 100) + `[130.0,32.0]]]}`
	if _, err := outerRing([]byte(big), 100); !errors.Is(err, ErrInvalid) {
		t.Errorf("101 頂点: err = %v, 上限 100 の ErrInvalid を期待", err)
	}
	if got, err := outerRing([]byte(big), 101); err != nil || len(got) != 101 {
		t.Errorf("101 頂点・上限 101: %d 個, err = %v", len(got), err)
	}
}

func TestStyleFor(t *testing.T) {
	cases := []struct {
		class string
		color color.RGBA
		dash  *[2]float64
	}{
		{"confirmed_new", color.RGBA{230, 70, 30, 255}, nil},
		{"existing_omission", color.RGBA{30, 110, 230, 255}, &[2]float64{14, 7}},
		{"uncertain", color.RGBA{245, 190, 0, 255}, &[2]float64{3, 7}},
		{"unknown", color.RGBA{245, 190, 0, 255}, &[2]float64{3, 7}}, // 知らない分類は uncertain
		{"", color.RGBA{245, 190, 0, 255}, &[2]float64{3, 7}},
	}
	for _, c := range cases {
		got := styleFor(c.class)
		if got.color != c.color || (got.dash == nil) != (c.dash == nil) || (c.dash != nil && *got.dash != *c.dash) {
			t.Errorf("%q: %+v", c.class, got)
		}
	}
}
