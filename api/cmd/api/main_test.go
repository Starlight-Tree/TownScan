package main

import (
	"bytes"
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"townscan/api/internal/testdb"
)

func envOf(kv map[string]string) func(string) string {
	return func(k string) string { return kv[k] }
}

// syncBuffer は、別の goroutine から書かれるログを、安全に読めるバッファー。
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func TestRunRejectsBadConfigurationWithoutPrintingSecrets(t *testing.T) {
	const secret = "pw-secret-marker"
	cases := []struct {
		name string
		env  map[string]string
		want string
	}{
		{"DATABASE_URL が無い", map[string]string{}, "DATABASE_URL"},
		{"未対応の LLM", map[string]string{"DATABASE_URL": "postgresql://u:" + secret + "@db/x", "LLM_PROVIDER": "openai"}, "LLM_PROVIDER"},
		{"gemini にキーが無い", map[string]string{"DATABASE_URL": "postgresql://u:" + secret + "@db/x", "LLM_PROVIDER": "gemini"}, "GEMINI_API_KEY が要ります"},
		{"キーの形が不正", map[string]string{"DATABASE_URL": "postgresql://u:" + secret + "@db/x", "LLM_PROVIDER": "gemini", "GEMINI_API_KEY": "key-" + secret + " with space"}, "GEMINI_API_KEY の形"},
		{"モデル名が不正", map[string]string{"DATABASE_URL": "postgresql://u:" + secret + "@db/x", "LLM_PROVIDER": "gemini", "GEMINI_API_KEY": "k" + secret, "GEMINI_MODEL": "a/b"}, "GEMINI_MODEL の形"},
		{"DATABASE_URL の形が不正", map[string]string{"DATABASE_URL": "postgresql://u:" + secret + "@h:notaport/x"}, "DATABASE_URL の形"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var out syncBuffer
			code := run(context.Background(), nil, envOf(c.env), &out, nil)
			if code != 2 {
				t.Errorf("終了コード = %d, 期待 2（設定の誤り）", code)
			}
			if !strings.Contains(out.String(), c.want) {
				t.Errorf("出力に %q が無い: %s", c.want, out.String())
			}
			if strings.Contains(out.String(), secret) {
				t.Errorf("秘密が出力に入っている: %s", out.String())
			}
		})
	}
}

func TestRunRejectsUnknownFlags(t *testing.T) {
	var out syncBuffer
	if code := run(context.Background(), []string{"-nope"}, envOf(nil), &out, nil); code != 2 {
		t.Errorf("終了コード = %d", code)
	}
}

func TestHealthcheckFlag(t *testing.T) {
	status := http.StatusOK
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/health" {
			t.Errorf("パス = %s", r.URL.Path)
		}
		w.WriteHeader(status)
	}))
	defer srv.Close()
	addr := srv.Listener.Addr().String()
	var out syncBuffer
	if code := run(context.Background(), []string{"-healthcheck", "-listen", addr}, envOf(nil), &out, nil); code != 0 {
		t.Errorf("200 のときの終了コード = %d: %s", code, out.String())
	}
	status = http.StatusServiceUnavailable
	if code := run(context.Background(), []string{"-healthcheck", "-listen", addr}, envOf(nil), &out, nil); code != 1 {
		t.Errorf("503 のときの終了コード = %d", code)
	}
	// 待ち受けが無い
	srv.Close()
	if code := run(context.Background(), []string{"-healthcheck", "-listen", addr}, envOf(nil), &out, nil); code != 1 {
		t.Errorf("接続できないときの終了コード = %d", code)
	}
	if code := run(context.Background(), []string{"-healthcheck", "-listen", "not-an-address"}, envOf(nil), &out, nil); code != 1 {
		t.Errorf("読めないアドレスのときの終了コード = %d", code)
	}
}

func TestServeStopsGracefullyAndFinishesInFlightRequests(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-release
		_, _ = io.WriteString(w, "done")
	})
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	srv := newServer(ln.Addr().String(), h, nil)
	served := make(chan error, 1)
	go func() { served <- serve(ctx, srv, ln, 5*time.Second) }()

	type result struct {
		body string
		err  error
	}
	got := make(chan result, 1)
	go func() {
		resp, err := http.Get("http://" + ln.Addr().String() + "/")
		if err != nil {
			got <- result{err: err}
			return
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		got <- result{body: string(b)}
	}()
	<-started
	cancel() // 停止の合図。処理中の応答は、終わるまで待たれる
	select {
	case err := <-served:
		t.Fatalf("処理中の応答があるのに、serve が先に終わった: %v", err)
	case <-time.After(200 * time.Millisecond):
	}
	close(release)
	if r := <-got; r.err != nil || r.body != "done" {
		t.Errorf("処理中の応答 = %q, %v", r.body, r.err)
	}
	if err := <-served; err != nil {
		t.Errorf("serve = %v", err)
	}
	if _, err := net.DialTimeout("tcp", ln.Addr().String(), 200*time.Millisecond); err == nil {
		t.Error("停止後に接続できてしまった")
	}
}

func TestServeGivesUpAfterTheGracePeriod(t *testing.T) {
	started := make(chan struct{})
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-r.Context().Done() // 終わらない応答
	})
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	ctx, cancel := context.WithCancel(context.Background())
	srv := newServer(ln.Addr().String(), h, nil)
	served := make(chan error, 1)
	go func() { served <- serve(ctx, srv, ln, 100*time.Millisecond) }()
	go func() { _, _ = http.Get("http://" + ln.Addr().String() + "/") }()
	<-started
	cancel()
	select {
	case err := <-served:
		if err == nil {
			t.Error("待ちきれなかったときはエラーのはず")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("grace を過ぎても止まらない")
	}
}

// ---- DB をつないだ全体（TEST_DATABASE_URL があるときだけ） ----

func TestRunServesTheReadAPIEndToEnd(t *testing.T) {
	url := testdb.URL(t) // テストごとに新しい空のデータベース

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var out syncBuffer
	addrc := make(chan net.Addr, 1)
	done := make(chan int, 1)
	go func() {
		done <- run(ctx, []string{"-listen", "127.0.0.1:0"}, envOf(map[string]string{"DATABASE_URL": url}), &out, func(a net.Addr) { addrc <- a })
	}()
	var base string
	select {
	case a := <-addrc:
		base = "http://" + a.String()
	case code := <-done:
		t.Fatalf("起動できなかった（終了コード %d）: %s", code, out.String())
	case <-time.After(20 * time.Second):
		t.Fatal("起動が終わらない")
	}
	seed(t, url) // 起動（スキーマの適用）のあとに、行を入れる

	get := func(path string) (int, http.Header, string) {
		resp, err := http.Get(base + path)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, resp.Header, string(b)
	}

	status, hdr, body := get("/api/health")
	if status != 200 || hdr.Get("Content-Type") != "application/json" || hdr.Get("X-Content-Type-Options") != "nosniff" {
		t.Errorf("health: %d %v", status, hdr)
	}
	if want := `{"status":"ok","db":"ok","llm":"mock","run":{"run_id":"e2e","kind":"synthetic","created_at":"2026-11-24T03:00:00+00:00"},"counts":{"areas":1,"candidates":2,"buildings":0}}`; body != want {
		t.Errorf("health = %s\n期待 = %s", body, want)
	}
	if status, _, body = get("/api/candidates?limit=1&cls=confirmed_new&area_id=z18-1-1"); status != 200 ||
		!strings.HasPrefix(body, `{"total":1,"items":[{"id":"c-1-1-1","area_id":"z18-1-1","area_name":"試験町","ward":"中央区","class":"confirmed_new","area_m2":300.5,`) {
		t.Errorf("candidates: %d %s", status, body)
	}
	if status, hdr, body = get("/api/candidates.geojson"); status != 200 || hdr.Get("Content-Type") != "application/geo+json" || !strings.HasPrefix(body, `{"type":"FeatureCollection","features":[{"type":"Feature","id":"c-1-1-1",`) {
		t.Errorf("geojson: %d %v %s", status, hdr, body)
	}
	if status, _, body = get("/api/candidates/c-1-1-2"); status != 200 || !strings.Contains(body, `"evidence":{"a":2,"b":1}`) || strings.Contains(body, "tile_x") {
		t.Errorf("detail: %d %s", status, body)
	}
	if status, _, body = get("/api/candidates/c-9-9-9"); status != 404 || body != `{"error":{"code":"not_found","message":"候補が見つかりません"}}` {
		t.Errorf("detail 404: %d %s", status, body)
	}
	if status, _, body = get("/api/areas"); status != 200 || !strings.HasPrefix(body, `[{"id":"z18-1-1","name":"試験町"`) {
		t.Errorf("areas: %d %s", status, body)
	}
	if status, _, body = get("/api/metrics"); status != 200 || !strings.HasPrefix(body, `{"reference":"e2e",`) || !strings.Contains(body, `"provenance":{"source":`) {
		t.Errorf("metrics: %d %s", status, body)
	}
	if status, _, _ = get("/api/candidates?limit=0"); status != 422 {
		t.Errorf("422 のはずが %d", status)
	}

	cancel()
	select {
	case code := <-done:
		if code != 0 {
			t.Errorf("終了コード = %d: %s", code, out.String())
		}
	case <-time.After(15 * time.Second):
		t.Fatal("停止しない")
	}
	logs := out.String()
	if !strings.Contains(logs, `GET "/api/health" -> 200`) || !strings.Contains(logs, "停止しました") {
		t.Errorf("ログ = %s", logs)
	}
	if strings.Contains(logs, "limit=0") || strings.Contains(logs, url) {
		t.Errorf("ログにクエリ・接続文字列が入っている: %s", logs)
	}
}

func seed(t *testing.T, url string) {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	stmts := []string{
		`INSERT INTO runs (run_id, kind, created_at, model) VALUES ('e2e', 'synthetic', '2026-11-24T12:00:00+09:00', 'm')`,
		`INSERT INTO areas (run_id, id, z, x, y, west, south, east, north, centroid_lon, centroid_lat, name, ward, municipality) VALUES ('e2e', 'z18-1-1', 18, 1, 1, 130.5, 32.5, 130.75, 32.75, 130.625, 32.625, '試験町', '中央区', '43101')`,
		`INSERT INTO candidates (id, run_id, area_id, class, area_m2, west, south, east, north, centroid_lon, centroid_lat, geom, evidence, reason) VALUES
		 ('c-1-1-1', 'e2e', 'z18-1-1', 'confirmed_new', 300.5, 1, 2, 3, 4, 2, 3, '{"type":"Polygon","coordinates":[]}', '{}', 'new_absent_2018'),
		 ('c-1-1-2', 'e2e', 'z18-1-1', 'uncertain', 100, 1, 2, 3, 4, 2, 3, '{"type":"Polygon","coordinates":[]}', '{"b": 1, "a": 2}', 'edge')`,
		`INSERT INTO metrics (run_id, body) VALUES ('e2e', '{"reference": "e2e"}')`,
	}
	for _, s := range stmts {
		if _, err := conn.Exec(ctx, s); err != nil {
			t.Fatalf("%s: %v", s, err)
		}
	}
}
