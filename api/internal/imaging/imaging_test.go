package imaging

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"image/color"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

var (
	casing        = color.RGBA{255, 255, 255, 255}
	outlineByType = map[string]color.RGBA{
		"confirmed_new":     {230, 70, 30, 255},
		"existing_omission": {30, 110, 230, 255},
		"uncertain":         {245, 190, 0, 255},
	}
)

// a1 は、両年の写真が読める作業用の置き場
func a1(t testing.TB) (*Renderer, string) {
	t.Helper()
	dir := t.TempDir()
	writeTiles(t, dir, tileX0, tileY0)
	return NewRenderer(dir), dir
}

func render(t testing.TB, r *Renderer, q Request) *image.RGBA {
	t.Helper()
	data, err := r.Render(context.Background(), q)
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	return decodePNG(t, data)
}

// ---- 形式・大きさ・年 ----

func TestRenderIsAnRGBPNGOfTheRequestedSquareSize(t *testing.T) {
	r, _ := a1(t)
	for _, size := range []int{MinSize, 100, 128, DefaultSize, MaxSize} {
		data, err := r.Render(context.Background(), request(2018, boxNew, "confirmed_new", size))
		if err != nil {
			t.Fatalf("size=%d: %v", size, err)
		}
		if !bytes.HasPrefix(data, []byte("\x89PNG\r\n\x1a\n")) {
			t.Fatalf("size=%d: PNG の署名で始まらない", size)
		}
		// IHDR: 幅・高さ（4 バイトずつ）・ビット深度 8・色の型 2（RGB。透明度なし）
		w, h := int(data[16])<<24|int(data[17])<<16|int(data[18])<<8|int(data[19]), int(data[20])<<24|int(data[21])<<16|int(data[22])<<8|int(data[23])
		if w != size || h != size || data[24] != 8 || data[25] != 2 {
			t.Errorf("size=%d: IHDR 幅=%d 高さ=%d 深度=%d 型=%d", size, w, h, data[24], data[25])
		}
	}
}

func TestEachYearShowsItsOwnPhoto(t *testing.T) {
	r, _ := a1(t)
	for _, year := range Years {
		img := render(t, r, request(year, boxNew, "confirmed_new", 512))
		for _, p := range [][2]int{{2, 2}, {509, 2}, {2, 509}} { // 輪郭から遠い隅
			if got := int(pixel(img, p[0], p[1]).B); absDiff(got, int(blueOf(year))) > 3 {
				t.Errorf("%d 年 %v: B=%d, 期待 %d", year, p, got, blueOf(year))
			}
		}
	}
}

// ---- 向きと範囲 ----

func TestCropIsCenteredOnTheCandidateAndNorthUp(t *testing.T) {
	r, _ := a1(t)
	img := render(t, r, request(2018, boxNew, "confirmed_new", 512))
	// 箱 (100,100,140,130) の中心は、タイルの画素 (120, 115)。真ん中の画素が、そこ（R=列・G=行）になる
	c := pixel(img, 256, 256)
	if absDiff(int(c.R), 120) > 3 || absDiff(int(c.G), 115) > 3 {
		t.Errorf("真ん中の画素 R=%d G=%d, 期待 (120, 115)", c.R, c.G)
	}
	left, right := int(pixel(img, 16, 256).R), int(pixel(img, 496, 256).R)
	top, bottom := int(pixel(img, 256, 16).G), int(pixel(img, 256, 496).G)
	if !(right > left && bottom > top) {
		t.Fatalf("向きが逆: R %d→%d、G %d→%d（R は左→右、G は上→下に増えるはず）", left, right, top, bottom)
	}
	// 一辺は、箱の長い辺 40 + 両側の余白 約 40 画素ずつ = 約 120 画素。画像の 16〜496（480 画素分）を、一辺に換算する
	sideX, sideY := float64(right-left)*512/480, float64(bottom-top)*512/480
	if sideX < 110 || sideX > 130 || sideY < 110 || sideY > 130 {
		t.Errorf("切り出しの一辺 = (%.1f, %.1f), 期待 約 120", sideX, sideY)
	}
}

func TestCropSlidesInsideTheTileAtTheEdgeWithoutFillingOutside(t *testing.T) {
	r, _ := a1(t)
	img := render(t, r, request(2018, boxEdge, "uncertain", 512))
	rLeft, rRight := int(pixel(img, 16, 100).R), int(pixel(img, 496, 100).R)
	gTop, gBottom := int(pixel(img, 100, 16).G), int(pixel(img, 100, 496).G)
	if rLeft < 128 || rLeft > 148 || gTop < 128 || gTop > 148 {
		t.Errorf("左・上の端 R=%d G=%d, 期待 128〜148（約 136 から）", rLeft, gTop)
	}
	if rRight < 240 || gBottom < 240 {
		t.Errorf("右・下の端 R=%d G=%d, 期待 240 以上（タイルの縁まで）", rRight, gBottom)
	}
	// 外側を埋めた画素（黒・透明など）が無い: 輪郭・縁取り以外の画素は、すべて 2018 年の写真（B=50）
	for c, n := range countColors(img) {
		if c != casing && c != outlineByType["uncertain"] && absDiff(int(c.B), blue2018) > 3 {
			t.Errorf("写真でも輪郭でもない色 %v が %d 画素ある", c, n)
		}
		if c.A != 255 {
			t.Errorf("透明な画素 %v", c)
		}
	}
}

// ---- 輪郭: 色と線種 ----

func TestOutlineUsesTheClassColorAndNoOtherClassColor(t *testing.T) {
	r, _ := a1(t)
	for _, c := range []struct {
		box   rect
		class string
	}{{boxNew, "confirmed_new"}, {boxOmission, "existing_omission"}, {boxEdge, "uncertain"}} {
		counts := countColors(render(t, r, request(2018, c.box, c.class, 512)))
		if counts[outlineByType[c.class]] <= 100 {
			t.Errorf("%s: 輪郭の色が %d 画素しかない", c.class, counts[outlineByType[c.class]])
		}
		if counts[casing] == 0 {
			t.Errorf("%s: 白い縁取りが無い", c.class)
		}
		for other, rgb := range outlineByType {
			if other != c.class && counts[rgb] != 0 {
				t.Errorf("%s の画像に %s の色がある", c.class, other)
			}
		}
	}
}

// dutyCycle は、輪郭の水平な辺（その色の画素が最も多い行）で、辺の始まりから終わりまでのうち、その色が塗られている割合
// （contract/test_image.py の duty_cycle と同じ）。実線 ≒ 1、破線・点線は小さくなる。
func dutyCycle(t testing.TB, img *image.RGBA, c color.RGBA) float64 {
	t.Helper()
	bestRow, bestN := 0, 0
	for y := 0; y < img.Rect.Dy(); y++ {
		n := 0
		for x := 0; x < img.Rect.Dx(); x++ {
			if pixel(img, x, y) == c {
				n++
			}
		}
		if n > bestN {
			bestRow, bestN = y, n
		}
	}
	first, last, painted := -1, -1, 0
	for x := 0; x < img.Rect.Dx(); x++ {
		if pixel(img, x, bestRow) == c {
			if first < 0 {
				first = x
			}
			last = x
			painted++
		}
	}
	if first < 0 {
		t.Fatalf("輪郭の色 %v の画素が見つからない", c)
	}
	return float64(painted) / float64(last-first+1)
}

func TestLineStylesDifferSolidDashedDotted(t *testing.T) {
	r, _ := a1(t)
	solid := dutyCycle(t, render(t, r, request(2018, boxNew, "confirmed_new", 512)), outlineByType["confirmed_new"])
	dashed := dutyCycle(t, render(t, r, request(2018, boxOmission, "existing_omission", 512)), outlineByType["existing_omission"])
	dotted := dutyCycle(t, render(t, r, request(2018, boxEdge, "uncertain", 512)), outlineByType["uncertain"])
	if solid < 0.95 || dashed < 0.45 || dashed > 0.85 || dotted < 0.15 || dotted > 0.50 || !(solid > dashed && dashed > dotted) {
		t.Errorf("実線 %.2f（0.95 以上）> 破線 %.2f（0.45〜0.85）> 点線 %.2f（0.15〜0.50）にならない", solid, dashed, dotted)
	}
}

func TestUnknownClassLooksLikeUncertain(t *testing.T) {
	r, _ := a1(t)
	counts := countColors(render(t, r, request(2018, boxNew, "something_else", 256)))
	if counts[outlineByType["uncertain"]] == 0 {
		t.Error("知らない分類は uncertain の色になるはず")
	}
}

func TestNoOutlineWhenTheRingHasLessThanTwoPoints(t *testing.T) {
	r, _ := a1(t)
	for name, geom := range map[string]string{
		"頂点が 1 つ":        `{"type":"Polygon","coordinates":[[[130.7,32.8]]]}`,
		"coordinates なし": `{"type":"Polygon"}`,
		"外周が空":           `{"type":"Polygon","coordinates":[[]]}`,
		"形が未設定":          ``,
	} {
		q := request(2018, boxNew, "confirmed_new", 128)
		q.Geometry = []byte(geom)
		counts := countColors(render(t, r, q))
		if counts[casing] != 0 || counts[outlineByType["confirmed_new"]] != 0 {
			t.Errorf("%s: 輪郭が描かれている", name)
		}
	}
}

// 写真の拡大が、一様な写真を一様のまま保ち（暗い縁・はみ出しが無い）、傾きのある写真の位置を正しく保つ
func TestScalingKeepsAFlatPhotoFlatAndAGradientAccurate(t *testing.T) {
	r, _ := a1(t)
	q := request(2023, boxNew, "confirmed_new", 1024)
	q.Geometry = nil // 輪郭なしの写真だけ
	img := render(t, r, q)
	box, _ := cropBox(q.BBox, tileX0, tileY0, 256, MarginM)
	for y := 0; y < 1024; y += 7 {
		for x := 0; x < 1024; x += 7 {
			p := pixel(img, x, y)
			if p.B != blue2023 {
				t.Fatalf("(%d,%d): B=%d, 期待 %d（一様な写真が一様でない）", x, y, p.B, blue2023)
			}
			// 画素 (x,y) の中心が、タイルの (box.Min.X + (x+0.5)*dx/1024, …) に当たる。R=列（画素の左端の値）なので、中心は +0.5
			wantR := float64(box.Min.X) + (float64(x)+0.5)*float64(box.Dx())/1024 - 0.5
			wantG := float64(box.Min.Y) + (float64(y)+0.5)*float64(box.Dy())/1024 - 0.5
			if d := float64(p.R) - wantR; d > 1.5 || d < -1.5 {
				t.Fatalf("(%d,%d): R=%d, 期待 %.1f", x, y, p.R, wantR)
			}
			if d := float64(p.G) - wantG; d > 1.5 || d < -1.5 {
				t.Fatalf("(%d,%d): G=%d, 期待 %.1f", x, y, p.G, wantG)
			}
		}
	}
}

// 同じ入力なら、同じ PNG（キャッシュ・差分の検査に使える）。同時に使っても同じ
func TestRenderIsDeterministicAndSafeToUseConcurrently(t *testing.T) {
	r, _ := a1(t)
	q := request(2018, boxNew, "confirmed_new", 300)
	want, err := r.Render(context.Background(), q)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	errs := make(chan string, 32)
	for i := 0; i < 32; i++ { // 上限（8）より多く、同時に
		wg.Add(1)
		go func() {
			defer wg.Done()
			got, err := r.Render(context.Background(), q)
			if err != nil || !bytes.Equal(got, want) {
				errs <- fmt.Sprintf("err=%v, 同じ PNG か=%v", err, bytes.Equal(got, want))
			}
		}()
	}
	wg.Wait()
	close(errs)
	for e := range errs {
		t.Error(e)
	}
}

// 同時に作る数が上限に達していると、待つ。待っているあいだに取り消されたら、すぐ返る（作業を始めない）
func TestRenderWaitsForASlotAndHonorsCancellation(t *testing.T) {
	r, _ := a1(t)
	for i := 0; i < cap(r.sem); i++ {
		r.sem <- struct{}{}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := r.Render(ctx, request(2018, boxNew, "confirmed_new", 128)); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, context.Canceled を期待", err)
	}
	<-r.sem // 1 つ空ける
	if _, err := r.Render(context.Background(), request(2018, boxNew, "confirmed_new", 128)); err != nil {
		t.Fatalf("空きができたら作れるはず: %v", err)
	}
	if len(r.sem) != cap(r.sem)-1 {
		t.Errorf("使い終わったら枠を返す: 使用中 %d, 期待 %d", len(r.sem), cap(r.sem)-1)
	}
}

// ---- 入力の誤り ----

func TestRenderRejectsBadInput(t *testing.T) {
	r, _ := a1(t)
	r.maxVertices = 3
	cases := map[string]func(q *Request){
		"size が小さすぎる": func(q *Request) { q.Size = MinSize - 1 },
		"size が大きすぎる": func(q *Request) { q.Size = MaxSize + 1 },
		"外接矩形が NaN":   func(q *Request) { q.BBox[0] = nan() },
		"MultiPolygon": func(q *Request) {
			q.Geometry = []byte(`{"type":"MultiPolygon","coordinates":[[[[130.7,32.8],[130.8,32.8],[130.8,32.9]]]]}`)
		},
		"外周が JSON でない": func(q *Request) { q.Geometry = []byte(`{`) },
		"頂点が上限を超える":    func(q *Request) {}, // 下で maxVertices=3 に対して、箱の外周（5 点）が多すぎる
		"座標が桁外れ":       func(q *Request) { q.Geometry = []byte(`{"coordinates":[[[1e300,32.8],[130.8,32.8]]]}`) },
		"経度が桁外れ（有限だが画素にして範囲外）": func(q *Request) { q.Geometry = []byte(`{"coordinates":[[[1e12,32.8],[130.8,32.8]]]}`) },
	}
	for name, mutate := range cases {
		q := request(2018, boxNew, "confirmed_new", 128)
		mutate(&q)
		_, err := r.Render(context.Background(), q)
		if !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: err = %v, ErrInvalid を期待", name, err)
		}
		var te *TileError
		if errors.As(err, &te) {
			t.Errorf("%s: 写真のエラーになっている", name)
		}
	}
}

// 写真が使えないときは、入力の誤りより先に TileError（Python は、写真 → 切り出し → 輪郭の順に調べる）
func TestTileProblemsComeBeforeGeometryProblems(t *testing.T) {
	r, _ := a1(t)
	q := request(2017, boxNew, "confirmed_new", 128)
	q.Geometry = []byte(`{`)
	var te *TileError
	if _, err := r.Render(context.Background(), q); !errors.As(err, &te) {
		t.Errorf("err = %v, TileError を期待", err)
	}
}

func nan() float64 { var z float64; return z / z }

// ---- 写真が使えないとき ----

func tileErrReason(err error) (string, bool) {
	var te *TileError
	if errors.As(err, &te) {
		return te.Reason, true
	}
	return "", false
}

func TestTileErrors(t *testing.T) {
	type setup func(t *testing.T, dir, outside string, r *Renderer)
	// 2018 年の写真に仕込む故障
	fault := func(f func(t *testing.T, path, outside string)) setup {
		return func(t *testing.T, dir, outside string, r *Renderer) {
			path := tilePath(dir, 2018, tileX0, tileY0)
			if err := os.Remove(path); err != nil {
				t.Fatal(err)
			}
			f(t, path, outside)
		}
	}
	cases := []struct {
		name   string
		req    func(q *Request)
		setup  setup
		reason string
	}{
		{"年が許可リストに無い（2017）", func(q *Request) { q.Year = 2017 }, nil, reasonYear},
		{"年が許可リストに無い（0）", func(q *Request) { q.Year = 0 }, nil, reasonYear},
		{"年が許可リストに無い（負）", func(q *Request) { q.Year = -2018 }, nil, reasonYear},
		{"タイル番号が負", func(q *Request) { q.TileX = -1 }, nil, reasonTileNumber},
		{"タイル番号が 2^18 以上", func(q *Request) { q.TileY = 1 << 18 }, nil, reasonTileNumber},
		{"ファイルが無い（別のタイル）", func(q *Request) { q.TileX++ }, nil, reasonMissing},
		{"ファイルが無い", nil, fault(func(*testing.T, string, string) {}), reasonMissing},
		{"PNG ではないファイル", nil, fault(func(t *testing.T, path, _ string) { writeFile(t, path, []byte("not a png")) }), reasonUnreadable},
		{"空のファイル", nil, fault(func(t *testing.T, path, _ string) { writeFile(t, path, nil) }), reasonUnreadable},
		{"途中で切れた PNG", nil, fault(func(t *testing.T, path, _ string) {
			full := encodePNG(t, gradientTile(256, 50))
			writeFile(t, path, full[:len(full)/2])
		}), reasonUnreadable},
		{"ディレクトリ", nil, fault(func(t *testing.T, path, _ string) {
			if err := os.MkdirAll(path, 0o755); err != nil {
				t.Fatal(err)
			}
		}), reasonMissing},
		{"TILES_DIR の外を指す相対リンク", nil, fault(func(t *testing.T, path, outside string) {
			rel, _ := filepath.Rel(filepath.Dir(path), outside)
			if err := os.Symlink(rel, path); err != nil {
				t.Fatal(err)
			}
		}), reasonOutside},
		{"TILES_DIR の外を指す絶対リンク", nil, fault(func(t *testing.T, path, outside string) {
			if err := os.Symlink(outside, path); err != nil {
				t.Fatal(err)
			}
		}), reasonOutside},
		{"外のディレクトリ全体へのリンク（年のディレクトリ）", nil, func(t *testing.T, dir, outside string, r *Renderer) {
			if err := os.RemoveAll(filepath.Join(dir, "2018")); err != nil {
				t.Fatal(err)
			}
			evil := filepath.Dir(outside)
			writeFile(t, filepath.Join(evil, fmt.Sprintf("%d_%d.png", tileX0, tileY0)), encodePNG(t, gradientTile(256, 99)))
			if err := os.Symlink(evil, filepath.Join(dir, "2018")); err != nil {
				t.Fatal(err)
			}
		}, reasonOutside},
		{"存在しない場所へのリンク", nil, fault(func(t *testing.T, path, _ string) {
			if err := os.Symlink("/nonexistent/where/ever.png", path); err != nil {
				t.Fatal(err)
			}
		}), reasonMissing},
		{"リンクの輪", nil, fault(func(t *testing.T, path, _ string) {
			if err := os.Symlink(filepath.Base(path), path); err != nil {
				t.Fatal(err)
			}
		}), reasonUnreadable},
		{"寸法が上限を超える（1025 画素）", nil, fault(func(t *testing.T, path, _ string) {
			writeFile(t, path, encodePNG(t, image.NewRGBA(image.Rect(0, 0, 1025, 1025))))
		}), reasonUnreadable},
		{"正方形でない", nil, fault(func(t *testing.T, path, _ string) {
			writeFile(t, path, encodePNG(t, image.NewRGBA(image.Rect(0, 0, 256, 128))))
		}), reasonUnreadable},
		{"ファイルが大きすぎる", nil, func(t *testing.T, dir, outside string, r *Renderer) { r.maxTileBytes = 100 }, reasonUnreadable},
		{"TILES_DIR が無い", nil, func(t *testing.T, dir, outside string, r *Renderer) { r.dir = filepath.Join(dir, "no-such-dir") }, reasonMissing},
		{"TILES_DIR が空の設定（カレントディレクトリを読まない）", nil, func(t *testing.T, dir, outside string, r *Renderer) { r.dir = "" }, reasonMissing},
		{"TILES_DIR がファイル", nil, func(t *testing.T, dir, outside string, r *Renderer) { r.dir = outside }, reasonMissing},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r, dir := a1(t)
			outsideDir := t.TempDir() // TILES_DIR の外。正しい PNG（B=99）がある
			outside := filepath.Join(outsideDir, "outside.png")
			writeFile(t, outside, encodePNG(t, gradientTile(256, 99)))
			if c.setup != nil {
				c.setup(t, dir, outside, r)
			}
			q := request(2018, boxNew, "confirmed_new", 128)
			if c.req != nil {
				c.req(&q)
			}
			data, err := r.Render(context.Background(), q)
			reason, ok := tileErrReason(err)
			if !ok {
				t.Fatalf("err = %v（画像 %d バイト）, TileError を期待", err, len(data))
			}
			if reason != c.reason {
				t.Errorf("理由 = %q, 期待 %q", reason, c.reason)
			}
			// パス・環境の詳細を漏らさない
			for _, leak := range []string{dir, outsideDir, "outside.png", "/tmp", "no such file", "permission", "Traceback"} {
				if strings.Contains(err.Error(), leak) || strings.Contains(reason, leak) {
					t.Errorf("エラーの文に %q が入っている: %v", leak, err)
				}
			}
		})
	}
}

func TestSymlinksInsideTilesDirAreAllowed(t *testing.T) {
	r, dir := a1(t)
	// 写真を別の名前で置き、リンクで指す（TILES_DIR の中）。内側のリンクは読める
	real := filepath.Join(dir, "stash", "real.png")
	writeFile(t, real, encodePNG(t, gradientTile(256, 77)))
	path := tilePath(dir, 2018, tileX0, tileY0)
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join("..", "stash", "real.png"), path); err != nil {
		t.Fatal(err)
	}
	img := render(t, r, request(2018, boxNew, "confirmed_new", 128))
	if got := pixel(img, 2, 2).B; got != 77 {
		t.Errorf("B = %d, 内側のリンク先の写真（77）を期待", got)
	}
}

func TestTilesDirItselfMayBeASymlink(t *testing.T) {
	_, dir := a1(t)
	link := filepath.Join(t.TempDir(), "tiles-link")
	if err := os.Symlink(dir, link); err != nil {
		t.Fatal(err)
	}
	img := render(t, NewRenderer(link), request(2023, boxNew, "confirmed_new", 128))
	if got := pixel(img, 2, 2).B; absDiff(int(got), blue2023) > 3 {
		t.Errorf("B = %d", got)
	}
	// 相対パスの TILES_DIR も読める
	cwd, _ := os.Getwd()
	rel, err := filepath.Rel(cwd, dir)
	if err != nil {
		t.Skip("相対パスにできない")
	}
	render(t, NewRenderer(rel), request(2023, boxNew, "confirmed_new", 128))
}

// JPEG の写真も、中身で判別して読む（拡張子は .png のまま）。一辺 512 の写真なら、切り出しも 2 倍の画素で行う
func TestRenderReadsJPEGAndLargerTiles(t *testing.T) {
	r, dir := a1(t)
	path := tilePath(dir, 2018, tileX0, tileY0)
	writeFile(t, path, jpegBytes(t, gradientTile(256, 50)))
	img := render(t, r, request(2018, boxNew, "confirmed_new", 256))
	if c := pixel(img, 128, 128); absDiff(int(c.R), 120) > 4 || absDiff(int(c.G), 115) > 4 {
		t.Errorf("JPEG: 真ん中の画素 R=%d G=%d, 期待 (120, 115)", c.R, c.G)
	}
	writeFile(t, path, encodePNG(t, gradientTile(512, 50)))
	img = render(t, r, request(2018, boxNew, "confirmed_new", 256))
	if c := pixel(img, 128, 128); absDiff(int(c.R), 120) > 3 || absDiff(int(c.G), 115) > 3 {
		t.Errorf("512 画素の写真: 真ん中の画素 R=%d G=%d, 期待 (120, 115)", c.R, c.G)
	}
}

// 透明度つきの写真は、透明度を無視して RGB をそのまま使う（Pillow の convert("RGB") と同じ）
func TestRenderIgnoresTheAlphaChannelOfThePhoto(t *testing.T) {
	r, dir := a1(t)
	tile := image.NewNRGBA(image.Rect(0, 0, 256, 256))
	for i := 0; i < len(tile.Pix); i += 4 {
		tile.Pix[i], tile.Pix[i+1], tile.Pix[i+2], tile.Pix[i+3] = 200, 100, 50, 64 // 透明度 25%
	}
	writeFile(t, tilePath(dir, 2018, tileX0, tileY0), encodePNG(t, tile))
	q := request(2018, boxNew, "confirmed_new", 128)
	q.Geometry = nil
	if c := pixel(render(t, r, q), 3, 3); c != (color.RGBA{200, 100, 50, 255}) {
		t.Errorf("画素 = %v, 期待 (200,100,50,255)", c)
	}
}
