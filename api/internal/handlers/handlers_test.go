package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"townscan/api/internal/pyjson"
	"townscan/api/internal/store"
)

// fakeStore は、DB の代わり（インターフェースを使った偽の実装）。問い合わせの引数を覚える。
type fakeStore struct {
	run       *store.Run
	counts    store.Counts
	areas     []store.Area
	total     int64
	summaries []store.Summary
	features  []store.Feature
	cand      *store.Candidate
	metrics   json.RawMessage

	err      error // 設定すると、すべての問い合わせがこのエラーを返す
	runErr   error // CurrentRun だけ
	countErr error

	calls    []string
	gotList  listArgs
	gotFeat  store.Filter
	gotCandI string
}

type listArgs struct {
	runID         string
	filter        store.Filter
	sort          store.Sort
	limit, offset int
}

func (f *fakeStore) note(name string) { f.calls = append(f.calls, name) }

func (f *fakeStore) CurrentRun(context.Context) (*store.Run, error) {
	f.note("CurrentRun")
	if f.runErr != nil {
		return nil, f.runErr
	}
	return f.run, f.err
}

func (f *fakeStore) RunCounts(context.Context, string) (store.Counts, error) {
	f.note("RunCounts")
	if f.countErr != nil {
		return store.Counts{}, f.countErr
	}
	return f.counts, f.err
}

func (f *fakeStore) ListAreas(context.Context, string) ([]store.Area, error) {
	f.note("ListAreas")
	return f.areas, f.err
}

func (f *fakeStore) ListCandidates(_ context.Context, runID string, flt store.Filter, sort store.Sort, limit, offset int) (int64, []store.Summary, error) {
	f.note("ListCandidates")
	f.gotList = listArgs{runID, flt, sort, limit, offset}
	return f.total, f.summaries, f.err
}

func (f *fakeStore) CandidateFeatures(_ context.Context, _ string, flt store.Filter) ([]store.Feature, error) {
	f.note("CandidateFeatures")
	f.gotFeat = flt
	return f.features, f.err
}

func (f *fakeStore) GetCandidate(_ context.Context, _, id string) (*store.Candidate, error) {
	f.note("GetCandidate")
	f.gotCandI = id
	return f.cand, f.err
}

func (f *fakeStore) GetMetrics(context.Context, string) (json.RawMessage, error) {
	f.note("GetMetrics")
	return f.metrics, f.err
}

// ---- 部品 ----

func syntheticRun() *store.Run {
	return &store.Run{RunID: "synthetic-test", Kind: "synthetic", CreatedAt: time.Date(2026, 11, 24, 3, 0, 0, 0, time.UTC), Model: "synthetic-fixture（モデルなし。合成データ）"}
}

func str(s string) *string { return &s }

func summary(id, areaID string, name *string, class string, area float64) store.Summary {
	return store.Summary{
		ID: id, AreaID: areaID, AreaName: name, Ward: str("中央区"), Class: class, AreaM2: pyjson.Float(area),
		BBox:     [4]pyjson.Float{130.7074142, 32.8064481, 130.7076824, 32.8066285},
		Centroid: [2]pyjson.Float{130.70754829999998, 32.8065383},
		Reason:   "new_absent_2018",
	}
}

type tester struct {
	t    *testing.T
	fake *fakeStore
	h    http.Handler
	logs []string
}

func newTester(t *testing.T, fake *fakeStore) *tester {
	tt := &tester{t: t, fake: fake}
	tt.h = New(Deps{Store: fake, LLMProvider: "mock", Logf: func(f string, a ...any) { tt.logs = append(tt.logs, fmt.Sprintf(f, a...)) }})
	return tt
}

func (tt *tester) get(target string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, target, nil)
	rec := httptest.NewRecorder()
	tt.h.ServeHTTP(rec, req)
	return rec
}

func (tt *tester) wantJSON(rec *httptest.ResponseRecorder, status int, contentType, body string) {
	tt.t.Helper()
	if rec.Code != status {
		tt.t.Errorf("状態 = %d, 期待 %d（本文 %s）", rec.Code, status, rec.Body.String())
	}
	if got := rec.Header().Get("Content-Type"); got != contentType {
		tt.t.Errorf("Content-Type = %q, 期待 %q", got, contentType)
	}
	if got := rec.Body.String(); got != body {
		tt.t.Errorf("本文 = %s\n期待 = %s", got, body)
	}
	if cl := rec.Header().Get("Content-Length"); cl != fmt.Sprint(rec.Body.Len()) {
		tt.t.Errorf("Content-Length = %q, 本文は %d バイト", cl, rec.Body.Len())
	}
}

func (tt *tester) logText() string { return strings.Join(tt.logs, "\n") }

const jsonCT = "application/json"

// ---- health ----

func TestHealth(t *testing.T) {
	tt := newTester(t, &fakeStore{run: syntheticRun(), counts: store.Counts{Areas: 3, Candidates: 9, Buildings: 24}})
	tt.wantJSON(tt.get("/api/health"), 200, jsonCT,
		`{"status":"ok","db":"ok","llm":"mock","run":{"run_id":"synthetic-test","kind":"synthetic","created_at":"2026-11-24T03:00:00+00:00"},"counts":{"areas":3,"candidates":9,"buildings":24}}`)
}

func TestHealthWithoutDataIsStillOK(t *testing.T) {
	tt := newTester(t, &fakeStore{})
	tt.wantJSON(tt.get("/api/health"), 200, jsonCT,
		`{"status":"ok","db":"ok","llm":"mock","run":null,"counts":{"areas":0,"candidates":0,"buildings":0}}`)
	if strings.Join(tt.fake.calls, ",") != "CurrentRun" {
		t.Errorf("run が無いときは件数を数えない: %v", tt.fake.calls)
	}
}

func TestHealthShowsGeminiModelButNoKey(t *testing.T) {
	fake := &fakeStore{}
	h := New(Deps{Store: fake, LLMProvider: "gemini", GeminiModel: "gemini-3.5-flash-lite"})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/api/health", nil))
	want := `{"status":"ok","db":"ok","llm":"gemini","run":null,"counts":{"areas":0,"candidates":0,"buildings":0},"llm_model":"gemini-3.5-flash-lite"}`
	if rec.Body.String() != want {
		t.Errorf("本文 = %s\n期待 = %s", rec.Body.String(), want)
	}
}

func TestHealthReportsDBDownWith503(t *testing.T) {
	for name, fake := range map[string]*fakeStore{
		"接続できない":       {runErr: store.ErrUnavailable},
		"想定外のエラーも 503": {runErr: errors.New("boom")},
	} {
		t.Run(name, func(t *testing.T) {
			tt := newTester(t, fake)
			tt.wantJSON(tt.get("/api/health"), 503, jsonCT,
				`{"status":"error","db":"error","llm":"mock","run":null,"counts":{"areas":0,"candidates":0,"buildings":0}}`)
		})
	}
}

// run を取れたあとで件数が失敗したときは、run を残したまま 503（Python の body.update の挙動）
func TestHealthKeepsRunWhenCountsFail(t *testing.T) {
	tt := newTester(t, &fakeStore{run: syntheticRun(), countErr: store.ErrUnavailable})
	tt.wantJSON(tt.get("/api/health"), 503, jsonCT,
		`{"status":"error","db":"error","llm":"mock","run":{"run_id":"synthetic-test","kind":"synthetic","created_at":"2026-11-24T03:00:00+00:00"},"counts":{"areas":0,"candidates":0,"buildings":0}}`)
}

func TestHealthCreatedAtUsesPythonIsoformat(t *testing.T) {
	cases := map[time.Time]string{
		time.Date(2026, 11, 24, 12, 0, 0, 0, time.FixedZone("JST", 9*3600)): "2026-11-24T03:00:00+00:00",
		time.Date(2026, 1, 2, 3, 4, 5, 500_000_000, time.UTC):               "2026-01-02T03:04:05.500000+00:00",
		time.Date(2026, 1, 2, 3, 4, 5, 123_456_000, time.UTC):               "2026-01-02T03:04:05.123456+00:00",
		time.Date(2026, 1, 2, 3, 4, 5, 1000, time.UTC):                      "2026-01-02T03:04:05.000001+00:00",
		time.Date(2026, 1, 2, 3, 4, 5, 999, time.UTC):                       "2026-01-02T03:04:05+00:00", // マイクロ秒未満は切り捨て（Postgres の精度はマイクロ秒）
	}
	for in, want := range cases {
		if got := (store.Run{CreatedAt: in}).CreatedAtISO(); got != want {
			t.Errorf("%v: %s, 期待 %s", in, got, want)
		}
	}
}

// ---- areas ----

func TestAreas(t *testing.T) {
	area := store.Area{
		ID: "z18-226249-105759", Name: "合成町", Ward: "中央区", Municipality: str("43101"),
		BBox:     [4]pyjson.Float{130.70571899414062, 32.80574473290687, 130.70709228515625, 32.80689899338195},
		Centroid: [2]pyjson.Float{130.70640563964844, 32.806321863144404},
		Counts:   store.AreaCounts{ConfirmedNew: 1, ExistingOmission: 1, Uncertain: 1, Total: 3},
	}
	tt := newTester(t, &fakeStore{run: syntheticRun(), areas: []store.Area{area}})
	tt.wantJSON(tt.get("/api/areas"), 200, jsonCT,
		`[{"id":"z18-226249-105759","name":"合成町","ward":"中央区","municipality":"43101","bbox":[130.70571899414062,32.80574473290687,130.70709228515625,32.80689899338195],"centroid":[130.70640563964844,32.806321863144404],"counts":{"confirmed_new":1,"existing_omission":1,"uncertain":1,"total":3}}]`)
}

func TestAreasEmptyIsAnEmptyArrayAndNullMunicipalityIsNull(t *testing.T) {
	tt := newTester(t, &fakeStore{run: syntheticRun()})
	tt.wantJSON(tt.get("/api/areas"), 200, jsonCT, `[]`)
	tt = newTester(t, &fakeStore{run: syntheticRun(), areas: []store.Area{{ID: "z18-1-1", Name: "z18-1-1"}}})
	if !strings.Contains(tt.get("/api/areas").Body.String(), `"municipality":null`) {
		t.Error("municipality は null のまま返すはず")
	}
}

// ---- candidates ----

func TestCandidatesBodyAndDefaults(t *testing.T) {
	fake := &fakeStore{run: syntheticRun(), total: 9, summaries: []store.Summary{summary("c-226250-105759-1", "z18-226250-105759", str("試験町"), "confirmed_new", 503.8)}}
	tt := newTester(t, fake)
	tt.wantJSON(tt.get("/api/candidates"), 200, jsonCT,
		`{"total":9,"items":[{"id":"c-226250-105759-1","area_id":"z18-226250-105759","area_name":"試験町","ward":"中央区","class":"confirmed_new","area_m2":503.8,"bbox":[130.7074142,32.8064481,130.7076824,32.8066285],"centroid":[130.70754829999998,32.8065383],"reason":"new_absent_2018"}]}`)
	want := listArgs{runID: "synthetic-test", sort: store.SortAreaDesc, limit: 50, offset: 0}
	if fake.gotList.runID != want.runID || fake.gotList.sort != want.sort || fake.gotList.limit != 50 || fake.gotList.offset != 0 ||
		fake.gotList.filter.AreaIDs != nil || fake.gotList.filter.Class != "" {
		t.Errorf("既定の引数 = %+v", fake.gotList)
	}
}

func TestCandidatesNullNamesStayNull(t *testing.T) {
	s := summary("c-1-2-3", "z18-1-1", nil, "uncertain", 100)
	s.Ward = nil
	tt := newTester(t, &fakeStore{run: syntheticRun(), total: 1, summaries: []store.Summary{s}})
	body := tt.get("/api/candidates").Body.String()
	if !strings.Contains(body, `"area_name":null,"ward":null`) || !strings.Contains(body, `"area_m2":100.0`) {
		t.Errorf("本文 = %s", body)
	}
}

func TestCandidatesEmptyItems(t *testing.T) {
	tt := newTester(t, &fakeStore{run: syntheticRun()})
	tt.wantJSON(tt.get("/api/candidates?area_id=z18-1-1"), 200, jsonCT, `{"total":0,"items":[]}`)
}

func TestCandidatesPassesFiltersSortAndPaging(t *testing.T) {
	fake := &fakeStore{run: syntheticRun()}
	tt := newTester(t, fake)
	tt.get("/api/candidates?area_id=z18-226250-105759&cls=confirmed_new&sort=area_asc&limit=+2&offset=1_0")
	g := fake.gotList
	if len(g.filter.AreaIDs) != 1 || g.filter.AreaIDs[0] != "z18-226250-105759" || g.filter.Class != "confirmed_new" ||
		g.sort != store.SortAreaAsc || g.limit != 2 || g.offset != 10 {
		t.Errorf("引数 = %+v", g)
	}
	// 同じキーが複数あれば、最後の値
	tt.get("/api/candidates?limit=1&limit=3")
	if fake.gotList.limit != 3 {
		t.Errorf("limit = %d", fake.gotList.limit)
	}
	// 上限いっぱい
	tt.get("/api/candidates?limit=500&offset=1000000")
	if fake.gotList.limit != 500 || fake.gotList.offset != 1_000_000 {
		t.Errorf("上限の値 = %+v", fake.gotList)
	}
}

// 検証エラーの本文は、Python の API（FastAPI 0.165・Pydantic 2.14）が返したもの。エラーは宣言の順（area_id, cls, sort, limit, offset）
func TestCandidatesValidationErrorsMatchPython(t *testing.T) {
	areaMsg := "String should match pattern '^z[0-9]{1,2}-[0-9]{1,7}-[0-9]{1,7}$'"
	cases := []struct{ query, where, body string }{
		{"limit=", "", `{"error":{"code":"validation_error","message":"引数が不正です（query.limit）","details":[{"loc":["query","limit"],"msg":"Input should be a valid integer, unable to parse string as an integer"}]}}`},
		{"limit=0", "", `{"error":{"code":"validation_error","message":"引数が不正です（query.limit）","details":[{"loc":["query","limit"],"msg":"Input should be greater than or equal to 1"}]}}`},
		{"limit=501", "", `{"error":{"code":"validation_error","message":"引数が不正です（query.limit）","details":[{"loc":["query","limit"],"msg":"Input should be less than or equal to 500"}]}}`},
		{"limit=99999999999999999999", "", `{"error":{"code":"validation_error","message":"引数が不正です（query.limit）","details":[{"loc":["query","limit"],"msg":"Input should be less than or equal to 500"}]}}`},
		{"offset=-1", "", `{"error":{"code":"validation_error","message":"引数が不正です（query.offset）","details":[{"loc":["query","offset"],"msg":"Input should be greater than or equal to 0"}]}}`},
		{"offset=1000001", "", `{"error":{"code":"validation_error","message":"引数が不正です（query.offset）","details":[{"loc":["query","offset"],"msg":"Input should be less than or equal to 1000000"}]}}`},
		{"cls=bogus", "", `{"error":{"code":"validation_error","message":"引数が不正です（query.cls）","details":[{"loc":["query","cls"],"msg":"Input should be 'confirmed_new', 'existing_omission' or 'uncertain'"}]}}`},
		{"sort=", "", `{"error":{"code":"validation_error","message":"引数が不正です（query.sort）","details":[{"loc":["query","sort"],"msg":"Input should be 'area_desc' or 'area_asc'"}]}}`},
		{"area_id=", "", `{"error":{"code":"validation_error","message":"引数が不正です（query.area_id）","details":[{"loc":["query","area_id"],"msg":"` + areaMsg + `"}]}}`},
		{"area_id=z18-1-1%27%20OR%20%271%27=%271", "", `{"error":{"code":"validation_error","message":"引数が不正です（query.area_id）","details":[{"loc":["query","area_id"],"msg":"` + areaMsg + `"}]}}`},
		{"limit=0&offset=-1&cls=x&sort=y&area_id=q", "",
			`{"error":{"code":"validation_error","message":"引数が不正です（query.area_id）","details":[` +
				`{"loc":["query","area_id"],"msg":"` + areaMsg + `"},` +
				`{"loc":["query","cls"],"msg":"Input should be 'confirmed_new', 'existing_omission' or 'uncertain'"},` +
				`{"loc":["query","sort"],"msg":"Input should be 'area_desc' or 'area_asc'"},` +
				`{"loc":["query","limit"],"msg":"Input should be greater than or equal to 1"},` +
				`{"loc":["query","offset"],"msg":"Input should be greater than or equal to 0"}]}}`},
	}
	for _, c := range cases {
		tt := newTester(t, &fakeStore{run: syntheticRun()})
		rec := tt.get("/api/candidates?" + c.query)
		tt.wantJSON(rec, 422, jsonCT, c.body)
		if len(tt.fake.calls) != 0 {
			t.Errorf("%s: 検証エラーのときは DB に触れない: %v", c.query, tt.fake.calls)
		}
	}
}

func TestValidationErrorDoesNotEchoInput(t *testing.T) {
	tt := newTester(t, &fakeStore{run: syntheticRun()})
	rec := tt.get("/api/candidates?cls=SECRET-TOKEN-123")
	if rec.Code != 422 || strings.Contains(rec.Body.String(), "SECRET-TOKEN-123") {
		t.Errorf("%d %s", rec.Code, rec.Body.String())
	}
}

// 検証は run の確認より先（データが無くても、不正な引数は 422）
func TestValidationComesBeforeNoData(t *testing.T) {
	tt := newTester(t, &fakeStore{})
	for _, target := range []string{"/api/candidates?limit=0", "/api/candidates.geojson?cls=x", "/api/candidates/c-1-2"} {
		if rec := tt.get(target); rec.Code != 422 {
			t.Errorf("%s: %d", target, rec.Code)
		}
	}
	if len(tt.fake.calls) != 0 {
		t.Errorf("DB に触れてはいけない: %v", tt.fake.calls)
	}
}

// ---- geojson ----

func TestGeoJSON(t *testing.T) {
	feat := store.Feature{
		Type: "Feature", ID: "c-226250-105759-1",
		Geometry:   json.RawMessage(`{"type":"Polygon","coordinates":[[[130.7074142,32.8066285],[130.7074142,32.8064481]]]}`),
		Properties: store.FeatureProps{ID: "c-226250-105759-1", Class: "confirmed_new", AreaM2: 503.8, AreaID: "z18-226250-105759"},
	}
	fake := &fakeStore{run: syntheticRun(), features: []store.Feature{feat}}
	tt := newTester(t, fake)
	tt.wantJSON(tt.get("/api/candidates.geojson?cls=uncertain&area_id=z18-1-1"), 200, "application/geo+json",
		`{"type":"FeatureCollection","features":[{"type":"Feature","id":"c-226250-105759-1","geometry":{"type":"Polygon","coordinates":[[[130.7074142,32.8066285],[130.7074142,32.8064481]]]},"properties":{"id":"c-226250-105759-1","class":"confirmed_new","area_m2":503.8,"area_id":"z18-226250-105759"}}]}`)
	if fake.gotFeat.Class != "uncertain" || len(fake.gotFeat.AreaIDs) != 1 {
		t.Errorf("絞り込み = %+v", fake.gotFeat)
	}
	tt = newTester(t, &fakeStore{run: syntheticRun()})
	tt.wantJSON(tt.get("/api/candidates.geojson"), 200, "application/geo+json", `{"type":"FeatureCollection","features":[]}`)
}

func TestGeoJSONValidation(t *testing.T) {
	tt := newTester(t, &fakeStore{run: syntheticRun()})
	tt.wantJSON(tt.get("/api/candidates.geojson?cls=x"), 422, jsonCT,
		`{"error":{"code":"validation_error","message":"引数が不正です（query.cls）","details":[{"loc":["query","cls"],"msg":"Input should be 'confirmed_new', 'existing_omission' or 'uncertain'"}]}}`)
}

// ---- detail ----

func detailCandidate() *store.Candidate {
	return &store.Candidate{
		Summary:  summary("c-226250-105759-1", "z18-226250-105759", str("試験町"), "confirmed_new", 503.8),
		Evidence: json.RawMessage(`{"ov_2018":0.02,"edge_touch":false,"prob_2023_mean":0.91}`),
		Geometry: json.RawMessage(`{"type":"Polygon","coordinates":[[[1.5,2.0]]]}`),
		TileX:    226250, TileY: 105759,
	}
}

func TestCandidateDetail(t *testing.T) {
	fake := &fakeStore{run: syntheticRun(), cand: detailCandidate()}
	tt := newTester(t, fake)
	tt.wantJSON(tt.get("/api/candidates/c-226250-105759-1"), 200, jsonCT,
		`{"id":"c-226250-105759-1","area_id":"z18-226250-105759","area_name":"試験町","ward":"中央区","class":"confirmed_new","area_m2":503.8,`+
			`"bbox":[130.7074142,32.8064481,130.7076824,32.8066285],"centroid":[130.70754829999998,32.8065383],"reason":"new_absent_2018",`+
			`"evidence":{"ov_2018":0.02,"edge_touch":false,"prob_2023_mean":0.91},"geometry":{"type":"Polygon","coordinates":[[[1.5,2.0]]]},`+
			`"explanation_key":"new_absent_2018","explanation":"2023 年の写真には建物があり、2018 年の写真にはその場所に何も見当たりません。新しく建った可能性があります。",`+
			`"images":[{"year":2018,"url":"/api/candidates/c-226250-105759-1/image?year=2018&size=512"},{"year":2023,"url":"/api/candidates/c-226250-105759-1/image?year=2023&size=512"}],`+
			`"provenance":{"source":"国土地理院 空中写真（年度別 2018・2023 年）から建物を抽出し、2 時点を比較した結果","photo_years":[2018,2023],"model":"synthetic-fixture（モデルなし。合成データ）","run_id":"synthetic-test","run_kind":"synthetic","note":"合成データ（テスト用）です。実データではありません。"}}`)
	if fake.gotCandI != "c-226250-105759-1" {
		t.Errorf("id = %q", fake.gotCandI)
	}
}

func TestCandidateDetailHasNoTileNumbersAndRealRunHasNoNote(t *testing.T) {
	run := syntheticRun()
	run.Kind, run.Model = "real", ""
	tt := newTester(t, &fakeStore{run: run, cand: detailCandidate()})
	body := tt.get("/api/candidates/c-226250-105759-1").Body.String()
	if strings.Contains(body, "tile_x") || strings.Contains(body, "tile_y") || strings.Contains(body, "226250,") {
		t.Errorf("タイル番号が応答に入っている: %s", body)
	}
	if !strings.Contains(body, `"model":"不明","run_id":"synthetic-test","run_kind":"real"}`) {
		t.Errorf("provenance = %s", body)
	}
}

func TestCandidateDetailUnknownReasonUsesFallback(t *testing.T) {
	c := detailCandidate()
	c.Reason = "something_new"
	tt := newTester(t, &fakeStore{run: syntheticRun(), cand: c})
	body := tt.get("/api/candidates/c-226250-105759-1").Body.String()
	if !strings.Contains(body, `"explanation_key":"something_new","explanation":"機械が抽出した候補です。目で確かめてください。"`) {
		t.Errorf("本文 = %s", body)
	}
}

func TestCandidateDetail404And422(t *testing.T) {
	tt := newTester(t, &fakeStore{run: syntheticRun()})
	tt.wantJSON(tt.get("/api/candidates/c-1-2-3"), 404, jsonCT, `{"error":{"code":"not_found","message":"候補が見つかりません"}}`)
	patternMsg := "String should match pattern '^c-[0-9]{1,7}-[0-9]{1,7}-[0-9]{1,7}$'"
	for _, bad := range []string{"c-1-2", "x", "c-1-2-3%27;%20DROP%20TABLE%20candidates;--", "c-a-b-c", "c-1-2-3%0A", "c-12345678-1-1", "c-1-2-3-4"} {
		tt := newTester(t, &fakeStore{run: syntheticRun()})
		tt.wantJSON(tt.get("/api/candidates/"+bad), 422, jsonCT,
			`{"error":{"code":"validation_error","message":"引数が不正です（path.candidate_id）","details":[{"loc":["path","candidate_id"],"msg":"`+patternMsg+`"}]}}`)
	}
}

// ---- metrics ----

func TestMetricsAppendsProvenanceAndKeepsKeyOrder(t *testing.T) {
	fake := &fakeStore{run: syntheticRun(), metrics: json.RawMessage(`{"reference":"合成データ","new_building_recall":null,"holdout":{"object":{"f1":0.58}},"notes":["a"]}`)}
	tt := newTester(t, fake)
	tt.wantJSON(tt.get("/api/metrics"), 200, jsonCT,
		`{"reference":"合成データ","new_building_recall":null,"holdout":{"object":{"f1":0.58}},"notes":["a"],`+
			`"provenance":{"source":"基盤地図情報（2018-10 版）を参照にした、2018 年の写真での建物抽出の評価","photo_years":[2018],"model":"synthetic-fixture（モデルなし。合成データ）","run_id":"synthetic-test","run_kind":"synthetic",`+
			`"metric":"物体単位 F1・画素 IoU","note":"合成データ（テスト用）です。実データではありません。 数字は 2018 年の写真で測った値。新築の再現率は手ラベルが無く未測定。分類の閾値は未検証の初期値。"}}`)
}

func TestMetricsReplacesAnExistingProvenanceInPlace(t *testing.T) {
	run := syntheticRun()
	run.Kind = "real"
	tt := newTester(t, &fakeStore{run: run, metrics: json.RawMessage(`{"a":1,"provenance":"old","b":2}`)})
	body := tt.get("/api/metrics").Body.String()
	if !strings.HasPrefix(body, `{"a":1,"provenance":{"source":`) || !strings.HasSuffix(body, `,"b":2}`) || strings.Contains(body, `"old"`) {
		t.Errorf("本文 = %s", body)
	}
	if !strings.Contains(body, `"note":"数字は 2018 年の写真で測った値。`) { // real の run には、合成データの注記が付かない
		t.Errorf("note = %s", body)
	}
}

func TestMetrics404AndNonObjectBody(t *testing.T) {
	tt := newTester(t, &fakeStore{run: syntheticRun()})
	tt.wantJSON(tt.get("/api/metrics"), 404, jsonCT, `{"error":{"code":"not_found","message":"評価の結果がありません"}}`)
	// 配列などの本文は、Python では {**body} が TypeError になり 500
	tt = newTester(t, &fakeStore{run: syntheticRun(), metrics: json.RawMessage(`[1,2]`)})
	tt.wantJSON(tt.get("/api/metrics"), 500, jsonCT, `{"error":{"code":"internal_error","message":"サーバー内部のエラーです"}}`)
}

// ---- データ無し・DB の不調 ----

func TestNoDataIs503WithErrorShape(t *testing.T) {
	want := `{"error":{"code":"no_data","message":"データが読み込まれていません。python -m pipeline.load で pipeline の出力を読み込んでください"}}`
	for _, target := range []string{"/api/areas", "/api/candidates", "/api/candidates.geojson", "/api/metrics", "/api/candidates/c-1-2-3"} {
		tt := newTester(t, &fakeStore{})
		tt.wantJSON(tt.get(target), 503, jsonCT, want)
	}
}

func TestDBUnavailableIs503AndUnexpectedIs500WithoutLeaking(t *testing.T) {
	targets := []string{"/api/areas", "/api/candidates", "/api/candidates.geojson", "/api/metrics", "/api/candidates/c-1-2-3"}
	for _, target := range targets {
		// run を取れない
		tt := newTester(t, &fakeStore{runErr: fmt.Errorf("wrap: %w", store.ErrUnavailable)})
		tt.wantJSON(tt.get(target), 503, jsonCT, `{"error":{"code":"db_unavailable","message":"データベースに接続できません。しばらくしてから再試行してください"}}`)

		// run のあとの問い合わせが落ちる
		tt = newTester(t, &fakeStore{run: syntheticRun(), err: store.ErrUnavailable})
		tt.wantJSON(tt.get(target), 503, jsonCT, `{"error":{"code":"db_unavailable","message":"データベースに接続できません。しばらくしてから再試行してください"}}`)

		tt = newTester(t, &fakeStore{run: syntheticRun(), err: errors.New("secret-internal-detail postgres://u:pw@db/x")})
		rec := tt.get(target)
		tt.wantJSON(rec, 500, jsonCT, `{"error":{"code":"internal_error","message":"サーバー内部のエラーです"}}`)
		if strings.Contains(rec.Body.String(), "secret") || strings.Contains(tt.logText(), "secret") || strings.Contains(tt.logText(), "pw@db") {
			t.Errorf("%s: 原因の文が漏れている: %s", target, tt.logText())
		}
	}
}

func TestClientCancelWritesNothing(t *testing.T) {
	tt := newTester(t, &fakeStore{run: syntheticRun(), err: context.Canceled})
	rec := tt.get("/api/areas")
	if rec.Body.Len() != 0 || len(tt.logs) != 0 {
		t.Errorf("切断のときは何も書かない・記録しない: %q %v", rec.Body.String(), tt.logs)
	}
}

// ---- ルーティング（Python と同じ。表は httpx のテストにもある） ----

func TestOnlyGetIsAllowed(t *testing.T) {
	tt := newTester(t, &fakeStore{run: syntheticRun()})
	for _, path := range []string{"/api/health", "/api/areas", "/api/candidates", "/api/candidates.geojson", "/api/candidates/c-1-2-3", "/api/metrics", "/api/me"} {
		for _, m := range []string{http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodHead, http.MethodOptions, http.MethodPatch} {
			rec := httptest.NewRecorder()
			tt.h.ServeHTTP(rec, httptest.NewRequest(m, path, nil))
			if rec.Code != 405 {
				t.Errorf("%s %s: %d", m, path, rec.Code)
			}
		}
	}
	rec := tt.get("/api/nothing")
	if rec.Code != 404 || rec.Body.String() != `{"error":{"code":"not_found","message":"見つかりません"}}` {
		t.Errorf("%d %s", rec.Code, rec.Body.String())
	}
	// チャットは、Deps.Chat が無ければ作らない（ある場合は chat_test.go）。docs・openapi は作らない
	for _, path := range []string{"/api/chat", "/api/docs", "/api/openapi.json"} {
		if rec := tt.get(path); rec.Code != 404 {
			t.Errorf("%s: %d", path, rec.Code)
		}
	}
}
