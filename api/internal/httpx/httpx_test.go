package httpx

import (
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"townscan/api/internal/apierr"
)

// ---- Query（Starlette の parse_qsl(keep_blank_values=True) と同じ） ----

func TestParseQueryLikeStarlette(t *testing.T) {
	cases := []struct {
		raw  string
		key  string
		want string
		ok   bool
	}{
		{"limit=2", "limit", "2", true},
		{"limit=1&limit=2", "limit", "2", true},           // 最後の値
		{"limit=2&limit=x", "limit", "x", true},           // 最後の値（不正でも）
		{"limit", "limit", "", true},                      // = の無い組は、空の値
		{"limit=", "limit", "", true},                     // 空の値
		{"a=b&&limit=2&", "limit", "2", true},             // 空の組は読み飛ばす
		{"limit=2;offset=1", "limit", "2;offset=1", true}, // ; は区切りではない
		{"limit=2;offset=1", "offset", "", false},
		{"=x&limit=1", "limit", "1", true},                // キーが空の組があっても続きを読む
		{"%61rea_id=z18-1-1", "area_id", "z18-1-1", true}, // キーのデコード
		{"area_id=%zz", "area_id", "%zz", true},           // 不正な % は残す（url.ParseQuery は組ごと捨てる）
		{"area_id=%4", "area_id", "%4", true},
		{"area_id=%", "area_id", "%", true},
		{"limit=+1", "limit", " 1", true}, // + は空白
		{"limit=%201", "limit", " 1", true},
		{"cls=%E3%81%82", "cls", "あ", true},
		{"cls=%FF", "cls", "�", true},             // UTF-8 でない並びは置換文字
		{"limit=1#frag", "limit", "1#frag", true}, // # は区切りではない
		{"", "limit", "", false},
	}
	for _, c := range cases {
		got, ok := ParseQuery(c.raw).Get(c.key)
		if got != c.want || ok != c.ok {
			t.Errorf("ParseQuery(%q).Get(%q) = %q, %v; 期待 %q, %v", c.raw, c.key, got, ok, c.want, c.ok)
		}
	}
}

// ---- Router ----

func testRouter() *Router {
	rt := &Router{}
	ok := func(name string) HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request, p Params) {
			_ = WriteJSON(w, 200, ContentTypeJSON, map[string]any{"route": name, "params": p})
		}
	}
	rt.Handle("GET", "/api/areas", ok("areas"))
	rt.Handle("GET", "/api/candidates", ok("candidates"))
	rt.Handle("GET", "/api/candidates.geojson", ok("geojson"))
	rt.Handle("GET", "/api/candidates/{candidate_id}", ok("detail"))
	rt.Handle("POST", "/api/chat", ok("chat"))
	return rt
}

func do(h http.Handler, method, target string, mods ...func(*http.Request)) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, nil)
	req.Host = "probe.test"
	for _, m := range mods {
		m(req)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// 下の表は、Python の API（FastAPI 0.165・Starlette 1.10）に同じ要求を送って得た結果
func TestRouterMatchesStarlette(t *testing.T) {
	rt := testRouter()
	notFound := `{"error":{"code":"not_found","message":"見つかりません"}}`
	notAllowed := `{"error":{"code":"method_not_allowed","message":"このメソッドは使えません"}}`
	cases := []struct {
		method, target string
		status         int
		location       string
		body           string
	}{
		{"GET", "/api/areas", 200, "", `{"params":null,"route":"areas"}`},
		{"GET", "/api/candidates/c-1-2-3", 200, "", `{"params":{"candidate_id":"c-1-2-3"},"route":"detail"}`},
		{"GET", "/api/candidates/%63-1-2-3", 200, "", `{"params":{"candidate_id":"c-1-2-3"},"route":"detail"}`}, // パスはデコードしてから合わせる
		{"GET", "/api/candidates.geojson", 200, "", `{"params":null,"route":"geojson"}`},
		{"POST", "/api/chat", 200, "", `{"params":null,"route":"chat"}`},
		// メソッド違い（HEAD・OPTIONS も 405）
		{"POST", "/api/areas", 405, "", notAllowed},
		{"HEAD", "/api/areas", 405, "", ""},
		{"OPTIONS", "/api/areas", 405, "", notAllowed},
		{"GET", "/api/chat", 405, "", notAllowed},
		// 無いパス
		{"GET", "/nothing", 404, "", notFound},
		{"GET", "/", 404, "", notFound},
		{"GET", "/api//areas", 404, "", notFound},
		{"GET", "//api/areas", 404, "", notFound},
		{"GET", "/API/areas", 404, "", notFound},
		{"GET", "/api/areas/x", 404, "", notFound},
		{"GET", "/api/candidates/c-1-2-3/foo", 404, "", notFound},
		{"GET", "/api/candidates/c-1-2%2F3", 404, "", notFound}, // %2F は / として扱う
		// 末尾の / は 307（クエリはそのまま。メソッドが違っても移す）
		{"GET", "/api/areas/", 307, "http://probe.test/api/areas", ""},
		{"GET", "/api/areas//", 307, "http://probe.test/api/areas", ""},
		{"GET", "/api/areas/?limit=2&x=%20y", 307, "http://probe.test/api/areas?limit=2&x=%20y", ""},
		{"GET", "/api/candidates//", 307, "http://probe.test/api/candidates", ""},
		{"GET", "/api/candidates/c-1-2-3/", 307, "http://probe.test/api/candidates/c-1-2-3", ""},
		{"GET", "/api/candidates.geojson/?cls=x", 307, "http://probe.test/api/candidates.geojson?cls=x", ""},
		{"GET", "/api/candidates/c-226250-105759-1%2F", 307, "http://probe.test/api/candidates/c-226250-105759-1", ""},
		{"GET", "/api/candidates/%E3%81%82/", 307, "http://probe.test/api/candidates/%E3%81%82", ""}, // Location は、非 ASCII をパーセントエンコード
		{"POST", "/api/areas/", 307, "http://probe.test/api/areas", ""},
		{"GET", "/api/nothing/", 404, "", notFound},
	}
	for _, c := range cases {
		rec := do(rt, c.method, c.target)
		if rec.Code != c.status {
			t.Errorf("%s %s: 状態 = %d, 期待 %d", c.method, c.target, rec.Code, c.status)
		}
		if got := rec.Header().Get("Location"); got != c.location {
			t.Errorf("%s %s: Location = %q, 期待 %q", c.method, c.target, got, c.location)
		}
		if c.method != "HEAD" && strings.TrimSpace(rec.Body.String()) != c.body {
			t.Errorf("%s %s: 本文 = %s\n期待 = %s", c.method, c.target, rec.Body.String(), c.body)
		}
		// Python の API は 405 に Allow を付けない（RFC 9110 §15.5.6 に反する）。Go は、そのパスで使えるメソッドを付ける（写さない）
		if wantAllow := allowFor(c.target); c.status == 405 && rec.Header().Get("Allow") != wantAllow {
			t.Errorf("%s %s: Allow = %q, 期待 %q", c.method, c.target, rec.Header().Get("Allow"), wantAllow)
		}
		if c.status != 405 && rec.Header().Get("Allow") != "" {
			t.Errorf("%s %s: 405 以外に Allow は付けない", c.method, c.target)
		}
		if c.status == 307 && rec.Header().Get("Content-Length") != "0" {
			t.Errorf("%s %s: 307 の Content-Length = %q", c.method, c.target, rec.Header().Get("Content-Length"))
		}
	}
}

func allowFor(target string) string {
	if target == "/api/chat" {
		return "POST"
	}
	return "GET"
}

func TestRouterAllowListsEveryMethodOfThePath(t *testing.T) {
	rt := &Router{}
	noop := func(http.ResponseWriter, *http.Request, Params) {}
	rt.Handle("POST", "/x", noop)
	rt.Handle("GET", "/x", noop)
	rt.Handle("PUT", "/x", noop)
	rt.Handle("GET", "/x", noop) // 重複は 1 つにする
	rec := do(rt, "DELETE", "/x")
	if rec.Code != 405 || rec.Header().Get("Allow") != "GET, POST, PUT" {
		t.Errorf("%d Allow=%q", rec.Code, rec.Header().Get("Allow"))
	}
}

func TestRouterRedirectHostFallbacks(t *testing.T) {
	rt := testRouter()
	rec := do(rt, "GET", "/api/areas/", func(r *http.Request) { r.Host = "127.0.0.1:8500" })
	if got := rec.Header().Get("Location"); got != "http://127.0.0.1:8500/api/areas" {
		t.Errorf("Location = %q", got)
	}
	rec = do(rt, "GET", "/api/areas/", func(r *http.Request) { r.TLS = &tls.ConnectionState{} })
	if got := rec.Header().Get("Location"); got != "https://probe.test/api/areas" {
		t.Errorf("Location = %q", got)
	}
}

func TestPyQuoteMatchesPython(t *testing.T) {
	// Python: quote(s, safe=":/%#?=@[]!$&'()*+,;")
	cases := map[string]string{
		"http://h/a b":      "http://h/a%20b",
		"http://h/あ":        "http://h/%E3%81%82",
		"http://h/~a_b.c-d": "http://h/~a_b.c-d",
		"x?a=1&b=%20#f":     "x?a=1&b=%20#f",
		"\"<>\\^`{|}":       "%22%3C%3E%5C%5E%60%7B%7C%7D",
		"\x7f\x00":          "%7F%00",
		"'()*+,;!$@[]":      "'()*+,;!$@[]",
	}
	for in, want := range cases {
		if got := pyQuote(in); got != want {
			t.Errorf("pyQuote(%q) = %q, 期待 %q", in, got, want)
		}
	}
}

// ---- ミドルウェア ----

type logSink struct{ lines []string }

func (l *logSink) logf(format string, args ...any) {
	l.lines = append(l.lines, fmt.Sprintf(format, args...))
}
func (l *logSink) text() string { return strings.Join(l.lines, "\n") }

func TestRecoverTurnsPanicIntoPythonStyle500AndHidesTheValue(t *testing.T) {
	var l logSink
	h := Chain(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic("secret-internal-detail")
	}), AccessLog(l.logf), Recover(l.logf))
	rec := do(h, "GET", "/x?token=SECRET-TOKEN")
	if rec.Code != 500 || strings.TrimSpace(rec.Body.String()) != `{"error":{"code":"internal_error","message":"サーバー内部のエラーです"}}` {
		t.Errorf("応答 = %d %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q", ct)
	}
	if strings.Contains(rec.Body.String(), "secret") || strings.Contains(l.text(), "secret-internal-detail") {
		t.Errorf("panic の値が漏れている:\n応答 %s\nログ %s", rec.Body.String(), l.text())
	}
	if strings.Contains(l.text(), "SECRET-TOKEN") {
		t.Errorf("クエリ文字列がログに入っている: %s", l.text())
	}
	if !strings.Contains(l.text(), "-> 500") {
		t.Errorf("アクセスログに 500 が出ていない: %s", l.text())
	}
}

func TestRecoverKeepsRuntimeErrorText(t *testing.T) {
	var l logSink
	h := Chain(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var m map[string]int
		m["x"] = 1
	}), Recover(l.logf))
	if rec := do(h, "GET", "/"); rec.Code != 500 {
		t.Errorf("状態 = %d", rec.Code)
	}
	if !strings.Contains(l.text(), "nil map") {
		t.Errorf("実行時エラーの文がログに無い: %s", l.text())
	}
}

func TestRecoverAbortsWhenResponseAlreadyStarted(t *testing.T) {
	var l logSink
	h := Chain(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		_, _ = w.Write([]byte("partial"))
		panic("boom")
	}), Recover(l.logf))
	defer func() {
		if v := recover(); v != http.ErrAbortHandler {
			t.Errorf("recover = %v, http.ErrAbortHandler のはず", v)
		}
	}()
	do(h, "GET", "/")
	t.Error("接続を切る panic が出なかった")
}

func TestAccessLogRecordsOneSafeLine(t *testing.T) {
	var l logSink
	h := Chain(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(404)
		_, _ = w.Write([]byte("12345"))
	}), AccessLog(l.logf))
	do(h, "GET", "/api/a%0Ab?area_id=SECRET", func(r *http.Request) { r.Header.Set("Authorization", "Bearer SECRET-JWT") })
	if len(l.lines) != 1 {
		t.Fatalf("行数 = %d: %v", len(l.lines), l.lines)
	}
	line := l.lines[0]
	if !strings.Contains(line, `GET "/api/a\nb" -> 404 (5B,`) {
		t.Errorf("行 = %s", line)
	}
	if strings.Contains(line, "SECRET") || strings.Contains(line, "\n") {
		t.Errorf("秘密・改行が入っている: %q", line)
	}
}

func TestRecorderPassesFlushThrough(t *testing.T) {
	var flushed bool
	h := Chain(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := http.NewResponseController(w).Flush(); err != nil {
			t.Errorf("Flush: %v", err)
		}
		flushed = true
	}), AccessLog(func(string, ...any) {}), Recover(func(string, ...any) {}))
	do(h, "GET", "/")
	if !flushed {
		t.Error("ハンドラーが動いていない")
	}
}

func TestSecurityHeaders(t *testing.T) {
	h := Chain(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}), SecurityHeaders())
	if got := do(h, "GET", "/").Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Errorf("X-Content-Type-Options = %q", got)
	}
}

func TestLimitBody(t *testing.T) {
	read := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, err := io.ReadAll(r.Body)
		if err != nil {
			var mbe *http.MaxBytesError
			if errors.As(err, &mbe) {
				WriteError(w, apierr.PayloadTooLarge())
				return
			}
			t.Errorf("想定外のエラー: %v", err)
		}
		_, _ = w.Write(b)
	})
	h := Chain(read, LimitBody(10))

	rec := do(h, "POST", "/", func(r *http.Request) { r.Body = io.NopCloser(strings.NewReader("12345")); r.ContentLength = 5 })
	if rec.Code != 200 || rec.Body.String() != "12345" {
		t.Errorf("上限内: %d %q", rec.Code, rec.Body.String())
	}
	// Content-Length が上限を超えていれば、読まずに 413
	rec = do(h, "POST", "/", func(r *http.Request) { r.Body = io.NopCloser(strings.NewReader("12345678901")); r.ContentLength = 11 })
	if rec.Code != 413 || !strings.Contains(rec.Body.String(), `"code":"payload_too_large"`) {
		t.Errorf("申告が超過: %d %s", rec.Code, rec.Body.String())
	}
	// 申告が無い（chunked）のに、読み進めて超えたら、読む側がエラーを受け取る
	rec = do(h, "POST", "/", func(r *http.Request) { r.Body = io.NopCloser(strings.NewReader("12345678901")); r.ContentLength = -1 })
	if rec.Code != 413 {
		t.Errorf("読み進めて超過: %d %s", rec.Code, rec.Body.String())
	}
}

func TestWriteJSONSetsHeadersAndRefusesNaN(t *testing.T) {
	rec := httptest.NewRecorder()
	if err := WriteJSON(rec, 200, ContentTypeGeoJSON, map[string]any{"a": []int{1}}); err != nil {
		t.Fatal(err)
	}
	if rec.Header().Get("Content-Type") != "application/geo+json" || rec.Header().Get("Content-Length") != "9" || rec.Body.String() != `{"a":[1]}` {
		t.Errorf("応答 = %v %q", rec.Header(), rec.Body.String())
	}
	rec = httptest.NewRecorder()
	if err := WriteJSON(rec, 200, ContentTypeJSON, json.Number("x")); err == nil {
		t.Error("書けない値はエラーのはず")
	}
	if rec.Body.Len() != 0 {
		t.Error("エラーのとき何も書いてはいけない")
	}
}
