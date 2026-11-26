package handlers

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"townscan/api/internal/pyjson"
	"townscan/api/internal/store"
)

// 契約の合成データの A1（合成町）のタイルと、その中の候補 1 件（画素の箱 (100,100,140,130)）
const (
	imgTileX, imgTileY = 226249, 105759
	imgCandidateID     = "c-226249-105759-2"
)

func imgPxToLonLat(px, py float64) (lon, lat float64) {
	n := float64(int(1) << 18)
	lon = (float64(imgTileX)+px/256)/n*360 - 180
	lat = math.Atan(math.Sinh(math.Pi*(1-2*(float64(imgTileY)+py/256)/n))) * 180 / math.Pi
	return lon, lat
}

func imgCandidate(class string) *store.Candidate {
	l, t, r, b := 100.0, 100.0, 140.0, 130.0
	w, n := imgPxToLonLat(l, t)
	e, s := imgPxToLonLat(r, b)
	var ring [][2]float64
	for _, c := range [][2]float64{{l, t}, {r, t}, {r, b}, {l, b}, {l, t}} {
		lon, lat := imgPxToLonLat(c[0], c[1])
		ring = append(ring, [2]float64{lon, lat})
	}
	geom, _ := json.Marshal(map[string]any{"type": "Polygon", "coordinates": [][][2]float64{ring}})
	sum := summary(imgCandidateID, "z18-226249-105759", str("合成町"), class, 1200)
	sum.BBox = [4]pyjson.Float{pyjson.Float(w), pyjson.Float(s), pyjson.Float(e), pyjson.Float(n)}
	return &store.Candidate{Summary: sum, Evidence: json.RawMessage(`{}`), Geometry: geom, TileX: imgTileX, TileY: imgTileY}
}

// 写真: R=列・G=行・B=年（契約の合成の写真と同じ）
func imgWriteTile(t *testing.T, dir string, year int, blue uint8) {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 256, 256))
	for y := 0; y < 256; y++ {
		for x := 0; x < 256; x++ {
			img.SetRGBA(x, y, color.RGBA{R: uint8(x), G: uint8(y), B: blue, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	imgWriteFile(t, filepath.Join(dir, fmt.Sprint(year), fmt.Sprintf("%d_%d.png", imgTileX, imgTileY)), buf.Bytes())
}

func imgWriteFile(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func imgTester(t *testing.T, fake *fakeStore, tilesDir string) *tester {
	tt := newTester(t, fake)
	tt.h = New(Deps{Store: fake, LLMProvider: "mock", TilesDir: tilesDir, Logf: func(f string, a ...any) { tt.logs = append(tt.logs, fmt.Sprintf(f, a...)) }})
	return tt
}

func imgTilesDir(t *testing.T) string {
	dir := t.TempDir()
	imgWriteTile(t, dir, 2014, 50)
	imgWriteTile(t, dir, 2024, 200)
	return dir
}

func imgURL(query string) string { return "/api/candidates/" + imgCandidateID + "/image" + query }

func imgDecode(t *testing.T, rec *httptest.ResponseRecorder) image.Image {
	t.Helper()
	img, err := png.Decode(bytes.NewReader(rec.Body.Bytes()))
	if err != nil {
		t.Fatalf("PNG として読めません: %v（状態 %d, 本文の先頭 %q）", err, rec.Code, rec.Body.String()[:min(80, rec.Body.Len())])
	}
	return img
}

func imgBlueAt(img image.Image, x, y int) uint32 {
	_, _, b, _ := img.At(x, y).RGBA()
	return b >> 8
}

func TestImageReturnsAPrivatelyCachedPNG(t *testing.T) {
	fake := &fakeStore{run: syntheticRun(), cand: imgCandidate("confirmed_new")}
	tt := imgTester(t, fake, imgTilesDir(t))
	rec := tt.get(imgURL("?year=2014"))
	if rec.Code != 200 {
		t.Fatalf("状態 = %d（本文 %s）", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Content-Type"); got != "image/png" {
		t.Errorf("Content-Type = %q", got)
	}
	if got := rec.Header().Get("Cache-Control"); !strings.HasPrefix(got, "private") {
		t.Errorf("Cache-Control = %q, private で始まるはず（共有のキャッシュに載せない）", got)
	}
	if got := rec.Header().Get("Cache-Control"); got != "private, max-age=60" {
		t.Errorf("Cache-Control = %q, Python の API と同じ値を期待", got)
	}
	if cl := rec.Header().Get("Content-Length"); cl != fmt.Sprint(rec.Body.Len()) {
		t.Errorf("Content-Length = %q, 本文は %d バイト", cl, rec.Body.Len())
	}
	img := imgDecode(t, rec)
	if b := img.Bounds(); b.Dx() != 512 || b.Dy() != 512 {
		t.Errorf("既定の大きさ = %v, 期待 512 x 512", b.Size())
	}
	if got := imgBlueAt(img, 2, 2); got < 47 || got > 53 {
		t.Errorf("2014 年の写真のはず: B = %d", got)
	}
	if strings.Join(fake.calls, ",") != "CurrentRun,GetCandidate" || fake.gotCandI != imgCandidateID {
		t.Errorf("DB の呼び出し = %v（候補 %q）", fake.calls, fake.gotCandI)
	}
}

func TestImageYearAndSizeFollowTheQuery(t *testing.T) {
	tt := imgTester(t, &fakeStore{run: syntheticRun(), cand: imgCandidate("existing_omission")}, imgTilesDir(t))
	cases := []struct {
		query    string
		size     int
		wantBlue uint32
	}{
		{"?year=2024", 512, 200},
		{"?year=2014&size=64", 64, 50},
		{"?year=2014&size=1024", 1024, 50},
		{"?size=100&year=2024", 100, 200},
		{"?year=2014&year=2024", 512, 200}, // 同じキーが複数あれば、最後（FastAPI の単一値と同じ）
		{"?year=2014&size=256.0", 256, 50}, // Pydantic の lax モード: 小数点以下が 0 の整数
		{"?year=2014&size=%20256", 256, 50},
		{"?year=2014&size=2_56", 256, 50},
	}
	for _, c := range cases {
		rec := tt.get(imgURL(c.query))
		if rec.Code != 200 {
			t.Errorf("%s: 状態 %d（本文 %s）", c.query, rec.Code, rec.Body.String())
			continue
		}
		img := imgDecode(t, rec)
		if img.Bounds().Dx() != c.size || img.Bounds().Dy() != c.size {
			t.Errorf("%s: 大きさ %v, 期待 %d", c.query, img.Bounds().Size(), c.size)
		}
		if got := imgBlueAt(img, 1, 1); got < c.wantBlue-3 || got > c.wantBlue+3 {
			t.Errorf("%s: B = %d, 期待 %d", c.query, got, c.wantBlue)
		}
	}
}

const imgValidationHead = `{"error":{"code":"validation_error","message":`

func TestImageValidationComesFirstAndNamesTheParameter(t *testing.T) {
	cases := []struct {
		name  string
		url   string
		wantD string // details の中身（JSON）
		where string
	}{
		{"year が無い", imgURL(""), `[{"loc":["query","year"],"msg":"Field required"}]`, "query.year"},
		{"year が空", imgURL("?year="), `[{"loc":["query","year"],"msg":"Input should be '2014' or '2024'"}]`, "query.year"},
		{"year が 2017", imgURL("?year=2017"), `[{"loc":["query","year"],"msg":"Input should be '2014' or '2024'"}]`, "query.year"},
		{"year が 2025", imgURL("?year=2025"), `[{"loc":["query","year"],"msg":"Input should be '2014' or '2024'"}]`, "query.year"},
		{"year の末尾に空白", imgURL("?year=2014%20"), `[{"loc":["query","year"],"msg":"Input should be '2014' or '2024'"}]`, "query.year"},
		{"year の先頭に 0", imgURL("?year=02018"), `[{"loc":["query","year"],"msg":"Input should be '2014' or '2024'"}]`, "query.year"},
		{"year にパス", imgURL("?year=2014/../../etc/passwd"), `[{"loc":["query","year"],"msg":"Input should be '2014' or '2024'"}]`, "query.year"},
		{"year に NUL", imgURL("?year=2014%00"), `[{"loc":["query","year"],"msg":"Input should be '2014' or '2024'"}]`, "query.year"},
		{"size が 63", imgURL("?year=2014&size=63"), `[{"loc":["query","size"],"msg":"Input should be greater than or equal to 64"}]`, "query.size"},
		{"size が 1025", imgURL("?year=2014&size=1025"), `[{"loc":["query","size"],"msg":"Input should be less than or equal to 1024"}]`, "query.size"},
		{"size が整数でない", imgURL("?year=2014&size=abc"), `[{"loc":["query","size"],"msg":"Input should be a valid integer, unable to parse string as an integer"}]`, "query.size"},
		{"size が小数", imgURL("?year=2014&size=512.5"), `[{"loc":["query","size"],"msg":"Input should be a valid integer, unable to parse string as an integer"}]`, "query.size"},
		{"size が空", imgURL("?year=2014&size="), `[{"loc":["query","size"],"msg":"Input should be a valid integer, unable to parse string as an integer"}]`, "query.size"},
		{"候補の ID の形", "/api/candidates/c-1-2/image?year=2014", `[{"loc":["path","candidate_id"],"msg":"String should match pattern '^c-[0-9]{1,7}-[0-9]{1,7}-[0-9]{1,7}$'"}]`, "path.candidate_id"},
		// 複数の誤りは、宣言の順（候補の ID → year → size）に全部並ぶ。message は先頭のもの
		{"全部不正", "/api/candidates/x/image?year=1&size=1",
			`[{"loc":["path","candidate_id"],"msg":"String should match pattern '^c-[0-9]{1,7}-[0-9]{1,7}-[0-9]{1,7}$'"},{"loc":["query","year"],"msg":"Input should be '2014' or '2024'"},{"loc":["query","size"],"msg":"Input should be greater than or equal to 64"}]`,
			"path.candidate_id"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			// 候補も写真も用意しない: 検証が先なので、DB には問い合わせない
			fake := &fakeStore{run: syntheticRun(), cand: imgCandidate("confirmed_new")}
			tt := imgTester(t, fake, t.TempDir())
			want := imgValidationHead + fmt.Sprintf(`"引数が不正です（%s）","details":%s}}`, c.where, c.wantD)
			tt.wantJSON(tt.get(c.url), 422, jsonCT, want)
			if len(fake.calls) != 0 {
				t.Errorf("検証が先: DB を呼んでいる %v", fake.calls)
			}
		})
	}
}

func TestImageValidationDoesNotEchoTheInput(t *testing.T) {
	tt := imgTester(t, &fakeStore{run: syntheticRun(), cand: imgCandidate("confirmed_new")}, t.TempDir())
	rec := tt.get(imgURL("?year=SECRET-VALUE&size=SECRET-SIZE"))
	if rec.Code != 422 || strings.Contains(rec.Body.String(), "SECRET") {
		t.Errorf("状態 %d、入力値が応答に出ている: %s", rec.Code, rec.Body.String())
	}
}

func TestImageNoDataIs503BeforeLookingUpTheCandidate(t *testing.T) {
	fake := &fakeStore{cand: imgCandidate("confirmed_new")}
	tt := imgTester(t, fake, imgTilesDir(t))
	tt.wantJSON(tt.get(imgURL("?year=2014")), 503, jsonCT,
		`{"error":{"code":"no_data","message":"データが読み込まれていません。python -m pipeline.load で pipeline の出力を読み込んでください"}}`)
	if strings.Join(fake.calls, ",") != "CurrentRun" {
		t.Errorf("DB の呼び出し = %v", fake.calls)
	}
}

func TestImageUnknownCandidateIs404(t *testing.T) {
	tt := imgTester(t, &fakeStore{run: syntheticRun()}, imgTilesDir(t))
	tt.wantJSON(tt.get("/api/candidates/c-1-2-3/image?year=2014"), 404, jsonCT,
		`{"error":{"code":"not_found","message":"候補が見つかりません"}}`)
}

func TestImageDBErrors(t *testing.T) {
	tt := imgTester(t, &fakeStore{run: syntheticRun(), err: store.ErrUnavailable}, imgTilesDir(t))
	tt.wantJSON(tt.get(imgURL("?year=2014")), 503, jsonCT,
		`{"error":{"code":"db_unavailable","message":"データベースに接続できません。しばらくしてから再試行してください"}}`)
	tt = imgTester(t, &fakeStore{run: syntheticRun(), err: errors.New("boom password=hunter2")}, imgTilesDir(t))
	tt.wantJSON(tt.get(imgURL("?year=2014")), 500, jsonCT,
		`{"error":{"code":"internal_error","message":"サーバー内部のエラーです"}}`)
	if strings.Contains(tt.logText(), "hunter2") {
		t.Errorf("ログに DB のエラーの文が出ている: %s", tt.logText())
	}
}

func TestImageUnusablePhotoIs404WithoutLeakingPaths(t *testing.T) {
	cases := []struct {
		name   string
		setup  func(t *testing.T, dir, outside string)
		year   int
		reason string
	}{
		{"ファイルが無い", func(t *testing.T, dir, _ string) {
			os.Remove(filepath.Join(dir, "2014", fmt.Sprintf("%d_%d.png", imgTileX, imgTileY)))
		}, 2014, "この年の写真がありません"},
		{"PNG ではない", func(t *testing.T, dir, _ string) {
			imgWriteFile(t, filepath.Join(dir, "2014", fmt.Sprintf("%d_%d.png", imgTileX, imgTileY)), []byte("not a png"))
		}, 2014, "写真を読めません"},
		{"TILES_DIR の外を指すリンク", func(t *testing.T, dir, outside string) {
			p := filepath.Join(dir, "2024", fmt.Sprintf("%d_%d.png", imgTileX, imgTileY))
			os.Remove(p)
			if err := os.Symlink(outside, p); err != nil {
				t.Fatal(err)
			}
		}, 2024, "許可された場所の外です"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dir := imgTilesDir(t)
			outsideDir := t.TempDir()
			outside := filepath.Join(outsideDir, "outside.png")
			imgWriteFile(t, outside, imgPNGBytes(t))
			c.setup(t, dir, outside)
			tt := imgTester(t, &fakeStore{run: syntheticRun(), cand: imgCandidate("confirmed_new")}, dir)
			rec := tt.get(imgURL(fmt.Sprintf("?year=%d", c.year)))
			want := fmt.Sprintf(`{"error":{"code":"tile_not_found","message":"%d 年の写真を用意できません（%s）"}}`, c.year, c.reason)
			tt.wantJSON(rec, 404, jsonCT, want)
			for _, leak := range []string{dir, outsideDir, "outside.png", "Traceback"} {
				if strings.Contains(rec.Body.String(), leak) || strings.Contains(tt.logText(), leak) {
					t.Errorf("パス・内部の文 %q が応答かログに出ている", leak)
				}
			}
		})
	}
}

func imgPNGBytes(t *testing.T) []byte {
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 256, 256))); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestImageWithoutATilesDirIsTileNotFound(t *testing.T) {
	tt := imgTester(t, &fakeStore{run: syntheticRun(), cand: imgCandidate("confirmed_new")}, "")
	tt.wantJSON(tt.get(imgURL("?year=2014")), 404, jsonCT,
		`{"error":{"code":"tile_not_found","message":"2014 年の写真を用意できません（この年の写真がありません）"}}`)
}

// 候補の形が壊れている（DB の値の誤り）は 500。座標・形の中身はログにも応答にも出さない
func TestImageBrokenGeometryIs500WithoutEchoingIt(t *testing.T) {
	cand := imgCandidate("confirmed_new")
	cand.Geometry = json.RawMessage(`{"type":"Point","coordinates":[130.12345,32.67891]}`)
	tt := imgTester(t, &fakeStore{run: syntheticRun(), cand: cand}, imgTilesDir(t))
	rec := tt.get(imgURL("?year=2014"))
	tt.wantJSON(rec, 500, jsonCT, `{"error":{"code":"internal_error","message":"サーバー内部のエラーです"}}`)
	for _, secret := range []string{"130.12345", "32.67891"} {
		if strings.Contains(tt.logText(), secret) || strings.Contains(rec.Body.String(), secret) {
			t.Errorf("座標 %s がログか応答に出ている", secret)
		}
	}
	if tt.logText() == "" {
		t.Error("原因の種類を記録するはず")
	}
}

func TestImageOnlyAllowsGET(t *testing.T) {
	tt := imgTester(t, &fakeStore{run: syntheticRun(), cand: imgCandidate("confirmed_new")}, imgTilesDir(t))
	for _, m := range []string{http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodPatch, http.MethodHead} {
		rec := httptest.NewRecorder()
		tt.h.ServeHTTP(rec, httptest.NewRequest(m, imgURL("?year=2014"), nil))
		if rec.Code != 405 || rec.Header().Get("Allow") != "GET" {
			t.Errorf("%s: 状態 %d, Allow %q, 期待 405 / GET", m, rec.Code, rec.Header().Get("Allow"))
		}
		if m != http.MethodHead && !strings.Contains(rec.Body.String(), `"code":"method_not_allowed"`) {
			t.Errorf("%s: 本文 %s", m, rec.Body.String())
		}
	}
	if len(tt.fake.calls) != 0 {
		t.Errorf("405 では DB を呼ばない: %v", tt.fake.calls)
	}
}

// 末尾の / は、Starlette と同じく 307 で外した URL へ移す（クエリは保つ）
func TestImageTrailingSlashRedirects(t *testing.T) {
	tt := imgTester(t, &fakeStore{run: syntheticRun(), cand: imgCandidate("confirmed_new")}, imgTilesDir(t))
	rec := tt.get("/api/candidates/" + imgCandidateID + "/image/?year=2014")
	if rec.Code != 307 || !strings.HasSuffix(rec.Header().Get("Location"), "/api/candidates/"+imgCandidateID+"/image?year=2014") {
		t.Errorf("状態 %d, Location %q", rec.Code, rec.Header().Get("Location"))
	}
}

// 候補の詳細の images の URL（/api/candidates/{id}）が指す先は、この API で読める
func TestDetailImageURLsAreServedByTheImageRoute(t *testing.T) {
	fake := &fakeStore{run: syntheticRun(), cand: imgCandidate("confirmed_new")}
	tt := imgTester(t, fake, imgTilesDir(t))
	var detail struct {
		Images []struct {
			Year int    `json:"year"`
			URL  string `json:"url"`
		} `json:"images"`
	}
	if err := json.Unmarshal(tt.get("/api/candidates/"+imgCandidateID).Body.Bytes(), &detail); err != nil || len(detail.Images) != 2 {
		t.Fatalf("詳細: %v %+v", err, detail)
	}
	for _, im := range detail.Images {
		rec := tt.get(im.URL)
		if rec.Code != 200 || imgDecode(t, rec).Bounds().Dx() != 512 {
			t.Errorf("%d 年 %s: 状態 %d", im.Year, im.URL, rec.Code)
		}
	}
}
