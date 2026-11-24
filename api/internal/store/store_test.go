package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"townscan/api/internal/pyjson"
	"townscan/api/internal/testdb"
)

// DB を使うテストは、環境変数 TEST_DATABASE_URL（使い捨ての Postgres）が無いと skip する。
// 1 つのコマンドで再現するには: scripts/test-go.sh

func testStore(t *testing.T) *Store {
	t.Helper()
	ctx := context.Background()
	s, err := Open(ctx, testdb.URL(t)) // テストごとに新しい空のデータベース
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	if err := s.ApplySchema(ctx); err != nil {
		t.Fatalf("ApplySchema: %v", err)
	}
	return s
}

func exec(t *testing.T, s *Store, sql string, args ...any) {
	t.Helper()
	if _, err := s.pool.Exec(context.Background(), sql, args...); err != nil {
		t.Fatalf("%s: %v", sql, err)
	}
}

func seedRun(t *testing.T, s *Store, runID, kind string, created string, model any) {
	t.Helper()
	exec(t, s, "INSERT INTO runs (run_id, kind, created_at, model) VALUES ($1, $2, $3::timestamptz, $4)", runID, kind, created, model)
}

func seedArea(t *testing.T, s *Store, runID string, x, y int, name, ward, muni any) string {
	t.Helper()
	id := fmt.Sprintf("z18-%d-%d", x, y)
	exec(t, s, "INSERT INTO areas (run_id, id, z, x, y, west, south, east, north, centroid_lon, centroid_lat, name, ward, municipality)"+
		" VALUES ($1, $2, 18, $3, $4, 130.5, 32.5, 130.75, 32.75, 130.625, 32.625, $5, $6, $7)", runID, id, x, y, name, ward, muni)
	return id
}

func seedCandidate(t *testing.T, s *Store, runID, areaID, id, class string, area float64, geom, evidence string) {
	t.Helper()
	exec(t, s, "INSERT INTO candidates (id, run_id, area_id, class, area_m2, west, south, east, north, centroid_lon, centroid_lat, geom, evidence, reason)"+
		" VALUES ($1, $2, $3, $4, $5, 1.5, 2.5, 3.5, 4.5, 2.5, 3.5, $6::jsonb, $7::jsonb, 'new_absent_2018')", id, runID, areaID, class, area, geom, evidence)
}

func marshal(t *testing.T, v any) string {
	t.Helper()
	b, err := pyjson.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// ---- スキーマ ----

func TestSchemaMatchesBackend(t *testing.T) {
	dir := os.Getenv("BACKEND_DB_DIR")
	if dir == "" {
		t.Skip("BACKEND_DB_DIR が未設定のため、backend/db/ との一致の検査を飛ばします（scripts/test-go.sh は読み取り専用でマウントして設定する）")
	}
	for name, embedded := range map[string]string{"schema.sql": schemaSQL, "auth.sql": authSQL} {
		want, err := os.ReadFile(dir + "/" + name)
		if err != nil {
			t.Fatal(err)
		}
		if string(want) != embedded {
			t.Errorf("internal/store/sql/%s が backend/db/%s と違います（写しを更新してください）", name, name)
		}
	}
}

func TestApplySchemaIsIdempotentAndCreatesAuthTables(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	seedRun(t, s, "r1", "real", "2026-01-01T00:00:00Z", nil)
	for i := 0; i < 2; i++ { // 2 回流しても、行は消えない・失敗しない
		if err := s.ApplySchema(ctx); err != nil {
			t.Fatalf("ApplySchema（%d 回目）: %v", i+2, err)
		}
	}
	run, err := s.CurrentRun(ctx)
	if err != nil || run == nil || run.RunID != "r1" {
		t.Errorf("既存の行が残っていない: %v, %v", run, err)
	}
	for _, table := range []string{"runs", "areas", "buildings", "candidates", "metrics", "auth_user", "auth_session", "auth_account", "auth_verification", "auth_jwks"} {
		var n int
		if err := s.pool.QueryRow(ctx, "SELECT count(*) FROM information_schema.tables WHERE table_name = $1", table).Scan(&n); err != nil || n != 1 {
			t.Errorf("表 %s が無い: %d, %v", table, n, err)
		}
	}
}

func TestWaitAndApplySchemaFailsFastOnSQLErrorsAndRetriesOnConnectionErrors(t *testing.T) {
	// 接続できない（127.0.0.1:1 は誰も待ち受けない）: 回数分やり直して、日本語の文で失敗。接続文字列は文に入らない
	s, err := Open(context.Background(), "postgresql://townscan:pw-secret-marker@127.0.0.1:1/x?connect_timeout=1")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var logs []string
	start := time.Now()
	err = s.WaitAndApplySchema(context.Background(), 2, 10*time.Millisecond, func(f string, a ...any) { logs = append(logs, fmt.Sprintf(f, a...)) })
	if err == nil || !strings.HasPrefix(err.Error(), "DB に接続してスキーマを適用できませんでした: ") {
		t.Fatalf("err = %v", err)
	}
	if len(logs) != 2 || !strings.Contains(logs[0], "（1/2）") || !strings.Contains(logs[1], "（2/2）") {
		t.Errorf("警告 = %v", logs)
	}
	if strings.Contains(err.Error(), "pw-secret-marker") || strings.Contains(strings.Join(logs, "\n"), "pw-secret-marker") || strings.Contains(strings.Join(logs, "\n"), "127.0.0.1") {
		t.Errorf("接続の値が出ている: %v %v", err, logs)
	}
	if time.Since(start) > 8*time.Second {
		t.Errorf("遅すぎる: %v", time.Since(start))
	}
	// 停止の合図（ctx の取り消し）で、待たずに止まる
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := s.WaitAndApplySchema(ctx, 20, time.Hour, nil); err == nil {
		t.Error("取り消されたら失敗のはず")
	}
}

// ---- run ----

func TestCurrentRunPicksLatestCreatedAtThenLargerRunID(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	if run, err := s.CurrentRun(ctx); err != nil || run != nil {
		t.Fatalf("run が無いときは nil: %v, %v", run, err)
	}
	seedRun(t, s, "a-old", "real", "2026-11-23T00:00:00Z", "model-a")
	seedRun(t, s, "b-new", "synthetic", "2026-11-24T03:00:00Z", nil)
	run, err := s.CurrentRun(ctx)
	if err != nil || run == nil || run.RunID != "b-new" || run.Kind != "synthetic" || run.Model != "" {
		t.Fatalf("run = %+v, %v", run, err)
	}
	if got := run.CreatedAtISO(); got != "2026-11-24T03:00:00+00:00" {
		t.Errorf("created_at = %s", got)
	}
	seedRun(t, s, "c-same", "real", "2026-11-24T03:00:00Z", "model-c") // 同時刻なら run_id の大きい方
	run, _ = s.CurrentRun(ctx)
	if run.RunID != "c-same" || run.Model != "model-c" {
		t.Errorf("同時刻のとき: %+v", run)
	}
	seedRun(t, s, "0-same", "real", "2026-11-24T03:00:00Z", nil)
	if run, _ = s.CurrentRun(ctx); run.RunID != "c-same" {
		t.Errorf("run_id の大きい方のまま: %+v", run)
	}
	// タイムゾーン付きの入力でも、UTC で返す
	seedRun(t, s, "z-jst", "real", "2026-11-24T12:00:00.250+09:00", nil)
	if run, _ = s.CurrentRun(ctx); run.RunID != "z-jst" || run.CreatedAtISO() != "2026-11-24T03:00:00.250000+00:00" {
		t.Errorf("JST: %+v %s", run, run.CreatedAtISO())
	}
}

func TestRunCountsOnlyCountsThatRun(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	seedRun(t, s, "r1", "real", "2026-01-01T00:00:00Z", nil)
	seedRun(t, s, "r2", "real", "2026-01-02T00:00:00Z", nil)
	a1 := seedArea(t, s, "r1", 1, 1, "a", "w", "m")
	seedArea(t, s, "r1", 2, 1, "b", "w", "m")
	a2 := seedArea(t, s, "r2", 1, 1, "a", "w", "m")
	seedCandidate(t, s, "r1", a1, "c-1-1-1", "confirmed_new", 10, `{}`, `{}`)
	seedCandidate(t, s, "r2", a2, "c-1-1-1", "uncertain", 10, `{}`, `{}`)
	exec(t, s, "INSERT INTO buildings (run_id, area_id, year, area_m2, geom) VALUES ('r1', $1, 2018, 1, '{}'), ('r1', $1, 2023, 1, '{}')", a1)
	n, err := s.RunCounts(ctx, "r1")
	if err != nil || n != (Counts{Areas: 2, Candidates: 1, Buildings: 2}) {
		t.Errorf("r1 = %+v, %v", n, err)
	}
	n, _ = s.RunCounts(ctx, "r2")
	if n != (Counts{Areas: 1, Candidates: 1, Buildings: 0}) {
		t.Errorf("r2 = %+v", n)
	}
	n, _ = s.RunCounts(ctx, "none")
	if n != (Counts{}) {
		t.Errorf("none = %+v", n)
	}
}

// ---- areas ----

func TestListAreasOrderCountsAndFallbacks(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	seedRun(t, s, "r1", "real", "2026-01-01T00:00:00Z", nil)
	seedRun(t, s, "r2", "real", "2026-01-02T00:00:00Z", nil)
	// y→x の順（挿入の順とは逆）
	aLate := seedArea(t, s, "r1", 1, 9, "あと", "中央区", "43101")
	aNull := seedArea(t, s, "r1", 5, 2, nil, nil, nil)
	aEmpty := seedArea(t, s, "r1", 3, 2, "", "", "")
	aNamed := seedArea(t, s, "r1", 4, 1, "試験町", "東区", "43102")
	seedArea(t, s, "r2", 1, 1, "別の run", "x", "y")
	seedCandidate(t, s, "r1", aNamed, "c-4-1-1", "confirmed_new", 10, `{}`, `{}`)
	seedCandidate(t, s, "r1", aNamed, "c-4-1-2", "confirmed_new", 9, `{}`, `{}`)
	seedCandidate(t, s, "r1", aNamed, "c-4-1-3", "uncertain", 8, `{}`, `{}`)
	seedCandidate(t, s, "r1", aNull, "c-5-2-1", "existing_omission", 7, `{}`, `{}`)

	areas, err := s.ListAreas(ctx, "r1")
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, a := range areas {
		ids = append(ids, a.ID)
	}
	if want := []string{aNamed, aEmpty, aNull, aLate}; strings.Join(ids, ",") != strings.Join(want, ",") {
		t.Fatalf("並び = %v, 期待 %v", ids, want)
	}
	if got := marshal(t, areas[0]); got != `{"id":"z18-4-1","name":"試験町","ward":"東区","municipality":"43102","bbox":[130.5,32.5,130.75,32.75],"centroid":[130.625,32.625],"counts":{"confirmed_new":2,"existing_omission":0,"uncertain":1,"total":3}}` {
		t.Errorf("地区 = %s", got)
	}
	// 名前が空 → id、区が空 → 空、municipality の空は空のまま
	if got := marshal(t, areas[1]); !strings.Contains(got, `"name":"z18-3-2","ward":"","municipality":""`) {
		t.Errorf("空の名前 = %s", got)
	}
	// NULL: 名前 → id、区 → ""、municipality → null
	if got := marshal(t, areas[2]); !strings.Contains(got, `"name":"z18-5-2","ward":"","municipality":null`) || !strings.Contains(got, `"counts":{"confirmed_new":0,"existing_omission":1,"uncertain":0,"total":1}`) {
		t.Errorf("NULL の名前 = %s", got)
	}
	if got, _ := s.ListAreas(ctx, "none"); got == nil || len(got) != 0 {
		t.Errorf("地区が無いときは空の配列（nil ではない）: %#v", got)
	}
}

// ---- candidates ----

func seedCandidatesFixture(t *testing.T, s *Store) {
	t.Helper()
	seedRun(t, s, "r1", "real", "2026-01-01T00:00:00Z", nil)
	seedRun(t, s, "r2", "real", "2026-01-02T00:00:00Z", nil)
	a1 := seedArea(t, s, "r1", 1, 1, "甲", "中央区", nil)
	a2 := seedArea(t, s, "r1", 2, 1, nil, nil, nil)
	b1 := seedArea(t, s, "r2", 1, 1, "別", "別区", nil)
	seedCandidate(t, s, "r1", a1, "c-1-1-3", "uncertain", 100, `{"type":"Polygon","coordinates":[[[1,2],[3,4]]]}`, `{"b": 1, "a": 2}`)
	seedCandidate(t, s, "r1", a1, "c-1-1-1", "confirmed_new", 300.5, `{"type":"Polygon","coordinates":[[[1.5,2.25]]]}`, `{}`)
	seedCandidate(t, s, "r1", a1, "c-1-1-2", "existing_omission", 100, `{}`, `{}`) // 面積が同じ → id の順
	seedCandidate(t, s, "r1", a2, "c-2-1-1", "confirmed_new", 50, `{}`, `{}`)
	seedCandidate(t, s, "r1", a2, "c-2-1-2", "confirmed_new", 400, `{}`, `{}`)
	seedCandidate(t, s, "r2", b1, "c-1-1-1", "uncertain", 999, `{}`, `{}`)
}

func ids(items []Summary) string {
	var out []string
	for _, i := range items {
		out = append(out, i.ID)
	}
	return strings.Join(out, ",")
}

func TestListCandidatesOrderFiltersAndPaging(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	seedCandidatesFixture(t, s)

	cases := []struct {
		name          string
		filter        Filter
		sort          Sort
		limit, offset int
		total         int64
		ids           string
	}{
		{"面積の降順（同じ面積は id の昇順）", Filter{}, SortAreaDesc, 50, 0, 5, "c-2-1-2,c-1-1-1,c-1-1-2,c-1-1-3,c-2-1-1"},
		{"面積の昇順", Filter{}, SortAreaAsc, 50, 0, 5, "c-2-1-1,c-1-1-2,c-1-1-3,c-1-1-1,c-2-1-2"},
		{"地区", Filter{AreaIDs: []string{"z18-2-1"}}, SortAreaDesc, 50, 0, 2, "c-2-1-2,c-2-1-1"},
		{"分類", Filter{Class: "confirmed_new"}, SortAreaDesc, 50, 0, 3, "c-2-1-2,c-1-1-1,c-2-1-1"},
		{"地区と分類", Filter{AreaIDs: []string{"z18-1-1"}, Class: "uncertain"}, SortAreaDesc, 50, 0, 1, "c-1-1-3"},
		{"地区の複数指定", Filter{AreaIDs: []string{"z18-1-1", "z18-2-1"}}, SortAreaAsc, 3, 0, 5, "c-2-1-1,c-1-1-2,c-1-1-3"},
		{"ページ分け（total はページ分けの前）", Filter{}, SortAreaDesc, 2, 1, 5, "c-1-1-1,c-1-1-2"},
		{"範囲外の offset", Filter{}, SortAreaDesc, 50, 100, 5, ""},
		{"存在しない地区", Filter{AreaIDs: []string{"z18-1-2"}}, SortAreaDesc, 50, 0, 0, ""},
		{"空の地区リスト（何にも合わない）", Filter{AreaIDs: []string{}}, SortAreaDesc, 50, 0, 0, ""},
	}
	for _, c := range cases {
		total, items, err := s.ListCandidates(ctx, "r1", c.filter, c.sort, c.limit, c.offset)
		if err != nil {
			t.Errorf("%s: %v", c.name, err)
			continue
		}
		if total != c.total || ids(items) != c.ids {
			t.Errorf("%s: total=%d ids=%s; 期待 total=%d ids=%s", c.name, total, ids(items), c.total, c.ids)
		}
		if items == nil {
			t.Errorf("%s: 空でも nil ではなく空の配列のはず", c.name)
		}
	}
	if _, _, err := s.ListCandidates(ctx, "r1", Filter{}, Sort("bogus"), 1, 0); err == nil {
		t.Error("許可リストに無い並び順はエラーのはず")
	}
}

func TestListCandidatesRowShapeKeepsDBValues(t *testing.T) {
	s := testStore(t)
	seedCandidatesFixture(t, s)
	_, items, err := s.ListCandidates(context.Background(), "r1", Filter{AreaIDs: []string{"z18-1-1"}, Class: "confirmed_new"}, SortAreaDesc, 50, 0)
	if err != nil || len(items) != 1 {
		t.Fatal(items, err)
	}
	want := `{"id":"c-1-1-1","area_id":"z18-1-1","area_name":"甲","ward":"中央区","class":"confirmed_new","area_m2":300.5,"bbox":[1.5,2.5,3.5,4.5],"centroid":[2.5,3.5],"reason":"new_absent_2018"}`
	if got := marshal(t, items[0]); got != want {
		t.Errorf("行 = %s\n期待 = %s", got, want)
	}
	// 整数の値の浮動小数点は ".0" を付けて書く（Python の float と同じ）
	_, items, _ = s.ListCandidates(context.Background(), "r1", Filter{AreaIDs: []string{"z18-2-1"}}, SortAreaDesc, 1, 0)
	if got := marshal(t, items[0]); !strings.Contains(got, `"area_m2":400.0`) || !strings.Contains(got, `"area_name":null,"ward":null`) {
		t.Errorf("行 = %s", got)
	}
}

func TestCandidateFeaturesAndDetail(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	seedCandidatesFixture(t, s)

	feats, err := s.CandidateFeatures(ctx, "r1", Filter{AreaIDs: []string{"z18-1-1"}})
	if err != nil {
		t.Fatal(err)
	}
	if got := marshal(t, feats); got != `[`+
		`{"type":"Feature","id":"c-1-1-1","geometry":{"type":"Polygon","coordinates":[[[1.5,2.25]]]},"properties":{"id":"c-1-1-1","class":"confirmed_new","area_m2":300.5,"area_id":"z18-1-1"}},`+
		`{"type":"Feature","id":"c-1-1-2","geometry":{},"properties":{"id":"c-1-1-2","class":"existing_omission","area_m2":100.0,"area_id":"z18-1-1"}},`+
		`{"type":"Feature","id":"c-1-1-3","geometry":{"type":"Polygon","coordinates":[[[1,2],[3,4]]]},"properties":{"id":"c-1-1-3","class":"uncertain","area_m2":100.0,"area_id":"z18-1-1"}}]` {
		t.Errorf("features = %s", got)
	}
	if feats, _ := s.CandidateFeatures(ctx, "r1", Filter{Class: "nothing"}); feats == nil || len(feats) != 0 {
		t.Errorf("0 件は空の配列: %#v", feats)
	}

	c, err := s.GetCandidate(ctx, "r1", "c-1-1-3")
	if err != nil || c == nil {
		t.Fatal(c, err)
	}
	// jsonb は、空白だけ詰める。キーの並びは Postgres の jsonb のもの（短いキーが先）で、Python の API と同じ
	if string(c.Evidence) != `{"a":2,"b":1}` || string(c.Geometry) != `{"type":"Polygon","coordinates":[[[1,2],[3,4]]]}` {
		t.Errorf("evidence=%s geometry=%s", c.Evidence, c.Geometry)
	}
	if c.TileX != 1 || c.TileY != 1 || c.Class != "uncertain" || c.AreaID != "z18-1-1" || *c.AreaName != "甲" {
		t.Errorf("candidate = %+v", c)
	}
	if c2, err := s.GetCandidate(ctx, "r1", "c-9-9-9"); err != nil || c2 != nil {
		t.Errorf("無い id は nil: %v, %v", c2, err)
	}
	// 別の run の同じ id は見えない
	other, _ := s.GetCandidate(ctx, "r2", "c-1-1-1")
	if other == nil || float64(other.AreaM2) != 999 {
		t.Errorf("r2 の候補 = %+v", other)
	}
	if c3, _ := s.GetCandidate(ctx, "r2", "c-2-1-1"); c3 != nil {
		t.Error("r1 の候補が r2 から見えている")
	}
}

// jsonb の出力は、Python の API（json.loads → json.dumps）と同じバイト列になる。Postgres の numeric は "0.00001"・"1.50" と書くが、
// Python の float は "1e-05"・"1.5"。文字列の逃がし方は、どちらも同じ（制御文字だけ \u00xx。DEL・U+2028 は、そのまま）
func TestJSONBIsRewrittenLikePythonDoes(t *testing.T) {
	s := testStore(t)
	seedRun(t, s, "r1", "real", "2026-01-01T00:00:00Z", nil)
	a := seedArea(t, s, "r1", 1, 1, "甲", "中央区", nil)
	// 入力の文字列: あ・A（\u0041 の逃がし）・改行・タブ・" ・\ ・/・DEL（\u007f の逃がし）・U+2028（\u2028 の逃がし）・絵文字・制御文字（\u001f の逃がし）
	seedCandidate(t, s, "r1", a, "c-1-1-1", "confirmed_new", 1, `{"n": [0.00001, 1.50, 100.0, 5, 1e5, -0, 0.1000]}`,
		`{"s": "あ\u0041\n\t\"\\/ \u007f \u2028 😀 \u001f", "bb": 1, "a": 2}`)
	c, err := s.GetCandidate(context.Background(), "r1", "c-1-1-1")
	if err != nil || c == nil {
		t.Fatal(c, err)
	}
	if want := `{"n":[1e-05,1.5,100.0,5,100000,0,0.1]}`; string(c.Geometry) != want {
		t.Errorf("geometry = %s\n期待 = %s", c.Geometry, want)
	}
	// キーは短い順・同じ長さなら辞書順（jsonb の並び）。DEL と U+2028 は、逃がさずそのまま（Python の json.dumps と同じ）
	want := `{"a":2,"s":"あA\n\t\"\\/ ` + "\x7f \xe2\x80\xa8" + ` 😀 \u001f","bb":1}`
	if string(c.Evidence) != want {
		t.Errorf("evidence = %q\n期待 = %q", c.Evidence, want)
	}
}

func TestGetMetrics(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	seedRun(t, s, "r1", "real", "2026-01-01T00:00:00Z", nil)
	if m, err := s.GetMetrics(ctx, "r1"); err != nil || m != nil {
		t.Errorf("評価が無いときは nil: %v, %v", m, err)
	}
	exec(t, s, `INSERT INTO metrics (run_id, body) VALUES ('r1', '{"holdout": {"object": {"f1": 0.58}}, "new_building_recall": null, "notes": ["合成"]}')`)
	m, err := s.GetMetrics(ctx, "r1")
	if err != nil {
		t.Fatal(err)
	}
	// 短いキーが先（jsonb の並び）。値は変えない
	if string(m) != `{"notes":["合成"],"holdout":{"object":{"f1":0.58}},"new_building_recall":null}` {
		t.Errorf("metrics = %s", m)
	}
	var v any
	if err := json.Unmarshal(m, &v); err != nil {
		t.Error(err)
	}
}

// ---- 接続できないとき ----

func TestUnreachableDBIsErrUnavailableWithoutLeakingTheURL(t *testing.T) {
	s, err := Open(context.Background(), "postgresql://townscan:pw-secret-marker@127.0.0.1:1/x?connect_timeout=1")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()
	calls := map[string]func() error{
		"CurrentRun":        func() error { _, err := s.CurrentRun(ctx); return err },
		"RunCounts":         func() error { _, err := s.RunCounts(ctx, "r"); return err },
		"ListAreas":         func() error { _, err := s.ListAreas(ctx, "r"); return err },
		"ListCandidates":    func() error { _, _, err := s.ListCandidates(ctx, "r", Filter{}, SortAreaDesc, 1, 0); return err },
		"CandidateFeatures": func() error { _, err := s.CandidateFeatures(ctx, "r", Filter{}); return err },
		"GetCandidate":      func() error { _, err := s.GetCandidate(ctx, "r", "c-1-1-1"); return err },
		"GetMetrics":        func() error { _, err := s.GetMetrics(ctx, "r"); return err },
	}
	for name, call := range calls {
		err := call()
		if !errors.Is(err, ErrUnavailable) {
			t.Errorf("%s: err = %v（ErrUnavailable のはず）", name, err)
			continue
		}
		if strings.Contains(err.Error(), "pw-secret-marker") || strings.Contains(err.Error(), "127.0.0.1") {
			t.Errorf("%s: エラーの文に接続の値が入っている: %v", name, err)
		}
	}
}

func TestClosedPoolIsErrUnavailable(t *testing.T) {
	s, err := Open(context.Background(), "postgresql://u:p@127.0.0.1:1/x")
	if err != nil {
		t.Fatal(err)
	}
	s.Close()
	if _, err := s.CurrentRun(context.Background()); !errors.Is(err, ErrUnavailable) {
		t.Errorf("err = %v", err)
	}
}

func TestCanceledContextIsNotReportedAsUnavailable(t *testing.T) {
	s, err := Open(context.Background(), "postgresql://u:p@127.0.0.1:1/x")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := s.CurrentRun(ctx); !errors.Is(err, context.Canceled) || errors.Is(err, ErrUnavailable) {
		t.Errorf("err = %v", err)
	}
}

func TestOpenRejectsAMalformedURLWithoutEchoingIt(t *testing.T) {
	for _, bad := range []string{"postgresql://u:pw-secret-marker@h:notaport/x", "://pw-secret-marker", "host=h port=x password=pw-secret-marker"} {
		_, err := Open(context.Background(), bad)
		if err == nil {
			t.Errorf("%q: エラーのはず", bad)
			continue
		}
		if strings.Contains(err.Error(), "pw-secret-marker") {
			t.Errorf("%q: エラーの文に秘密が入っている: %v", bad, err)
		}
	}
}

func TestClassify(t *testing.T) {
	unavailable := []error{
		&pgconn.PgError{Code: "08006"}, &pgconn.PgError{Code: "53300"}, &pgconn.PgError{Code: "57P01"}, &pgconn.PgError{Code: "58000"},
		&pgconn.PgError{Code: "40001"}, &pgconn.PgError{Code: "54000"}, &pgconn.PgError{Code: "F0000"},
		io.EOF, io.ErrUnexpectedEOF, context.DeadlineExceeded, &net.OpError{Op: "dial", Err: errors.New("refused")},
		fmt.Errorf("wrap: %w", io.EOF), errors.New("closed pool"), pgconn.ErrConnClosed,
	}
	for _, err := range unavailable {
		if got := classify(err); !errors.Is(got, ErrUnavailable) {
			t.Errorf("%T %v は ErrUnavailable のはず", err, err)
		}
	}
	other := []error{
		&pgconn.PgError{Code: "42P01"}, &pgconn.PgError{Code: "22003"}, &pgconn.PgError{Code: "23505"}, &pgconn.PgError{Code: "42601"},
		errors.New("scan: wrong type"), context.Canceled,
	}
	for _, err := range other {
		if got := classify(err); errors.Is(got, ErrUnavailable) {
			t.Errorf("%T %v は ErrUnavailable ではないはず", err, err)
		}
	}
	if classify(nil) != nil {
		t.Error("nil は nil")
	}
	// 包んでも、もとのエラーを取り出せる
	pg := &pgconn.PgError{Code: "57P01", Message: "terminating connection"}
	var got *pgconn.PgError
	if !errors.As(classify(pg), &got) || got != pg {
		t.Error("もとの PgError を取り出せない")
	}
}
