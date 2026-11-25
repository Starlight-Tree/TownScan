package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"townscan/api/internal/config"
	"townscan/api/internal/testdb"
)

// 画面のサーバー（Better Auth）の代わり: JWKS を配るサーバーと、その鍵で署名した JWT。
type fakeWeb struct {
	*httptest.Server
	key  *ecdsa.PrivateKey
	kid  string
	hits atomic.Int32
}

func newFakeWeb(t *testing.T) *fakeWeb {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	w := &fakeWeb{key: key, kid: "main-test-key"}
	enc := base64.RawURLEncoding.EncodeToString
	doc, _ := json.Marshal(map[string]any{"keys": []any{map[string]any{
		"kty": "EC", "crv": "P-256", "kid": w.kid,
		"x": enc(key.X.FillBytes(make([]byte, 32))), "y": enc(key.Y.FillBytes(make([]byte, 32))),
	}}})
	w.Server = httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		w.hits.Add(1)
		rw.Header().Set("Content-Type", "application/json")
		_, _ = rw.Write(doc)
	}))
	t.Cleanup(w.Server.Close)
	return w
}

func (w *fakeWeb) jwksURL() string { return w.Server.URL + "/api/auth/jwks" }

func (w *fakeWeb) token(t *testing.T, issuer string) string {
	t.Helper()
	now := time.Now()
	tok := jwt.NewWithClaims(jwt.SigningMethodES256, jwt.MapClaims{
		"iss": issuer, "aud": "townscan", "sub": "ba_user_0000000001", "iat": now.Unix(), "exp": now.Add(15 * time.Minute).Unix(),
		"email": "tanaka@example.com", "name": "田中 太郎", "picture": "https://lh3.googleusercontent.com/a/test",
	})
	tok.Header["kid"] = w.kid
	s, err := tok.SignedString(w.key)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func getWith(t *testing.T, h http.Handler, path, authorization string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	if authorization != "" {
		req.Header.Set("Authorization", authorization)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// 設定（config）→ 組み立て（buildHandler）→ 本物の検証 → 応答、まで。/api/me は DB を使わない（Store は nil。使えば Recover が 500 にする）。
func TestBuildHandlerServesMeWithARealVerifier(t *testing.T) {
	web := newFakeWeb(t)
	const issuer = "http://localhost:3500"
	cfg, err := config.Load(envOf(map[string]string{
		"DATABASE_URL":  "postgresql://u:pw@db/x",
		"AUTH_ISSUER":   issuer + "/", // 末尾の / は、設定の読み取りが外す（iss は完全一致）
		"AUTH_JWKS_URL": web.jwksURL(),
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	var logs syncBuffer
	h := buildHandler(cfg, nil, nil, func(f string, a ...any) { _, _ = fmt.Fprintf(&logs, "%s\n", fmt.Sprintf(f, a...)) })

	if n := web.hits.Load(); n != 0 {
		t.Fatalf("組み立てただけで、JWKS を %d 回取りに行った（最初の /api/me まで取らない）", n)
	}
	tok := web.token(t, issuer)
	rec := getWith(t, h, "/api/me", "Bearer "+tok)
	want := `{"sub":"ba_user_0000000001","email":"tanaka@example.com","name":"田中 太郎","picture":"https://lh3.googleusercontent.com/a/test"}`
	if rec.Code != 200 || rec.Body.String() != want || rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("%d %s %v", rec.Code, rec.Body.String(), rec.Header())
	}
	if rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Error("ミドルウェアが付くはずのヘッダーが無い")
	}
	getWith(t, h, "/api/me", "Bearer "+tok)
	if n := web.hits.Load(); n != 1 {
		t.Errorf("JWKS の取得 = %d 回（鍵は覚えているはず）", n)
	}

	// 別の発行元のトークンは 401
	rec = getWith(t, h, "/api/me", "Bearer "+web.token(t, "http://evil.example"))
	if rec.Code != 401 || rec.Header().Get("WWW-Authenticate") != "Bearer" {
		t.Errorf("別の iss: %d %s", rec.Code, rec.Body.String())
	}
	if rec = getWith(t, h, "/api/me", ""); rec.Code != 401 {
		t.Errorf("ヘッダーなし: %d", rec.Code)
	}
	for _, leaked := range []string{tok, "evil.example", web.Server.URL} {
		if strings.Contains(logs.String(), leaked) {
			t.Errorf("ログに %q が入っている: %s", leaked, logs.String())
		}
	}
}

// ログインの設定が無い・不正なときは、/api/me だけが 503。api は起動でき、JWKS を取りに行かない。
func TestBuildHandlerWithoutAuthConfigurationAnswers503OnlyOnMe(t *testing.T) {
	web := newFakeWeb(t)
	for name, env := range map[string]map[string]string{
		"設定なし":          {},
		"発行元だけ":         {"AUTH_ISSUER": "http://localhost:3500"},
		"JWKS の URL だけ": {"AUTH_JWKS_URL": web.jwksURL()},
		"発行元が URL でない（BETTER_AUTH_URL の書き間違い）": {"AUTH_ISSUER": "localhost:3500", "AUTH_JWKS_URL": web.jwksURL()},
	} {
		t.Run(name, func(t *testing.T) {
			env["DATABASE_URL"] = "postgresql://u:pw@db/x"
			cfg, err := config.Load(envOf(env), nil)
			if err != nil {
				t.Fatal(err)
			}
			h := buildHandler(cfg, nil, nil, func(string, ...any) {})
			for _, authorization := range []string{"", "Basic abc", "Bearer not-a-jwt", "Bearer " + web.token(t, "http://localhost:3500")} {
				rec := getWith(t, h, "/api/me", authorization)
				if rec.Code != 503 || !strings.Contains(rec.Body.String(), "まだ設定されていません") || rec.Header().Get("WWW-Authenticate") != "" {
					t.Errorf("Authorization=%q: %d %s", authorization, rec.Code, rec.Body.String())
				}
			}
			if n := web.hits.Load(); n != 0 {
				t.Errorf("JWKS を %d 回取りに行った", n)
			}
		})
	}
}

// 起動（run）から /api/me まで。DB のスキーマを適用した本物の起動で、JWKS は最初の /api/me まで取らない。
func TestRunServesMeWithoutTouchingTheDatabase(t *testing.T) {
	url := testdb.URL(t)
	web := newFakeWeb(t)
	const issuer = "http://localhost:3500"

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var out syncBuffer
	addrc := make(chan net.Addr, 1)
	done := make(chan int, 1)
	env := map[string]string{"DATABASE_URL": url, "AUTH_ISSUER": issuer, "AUTH_JWKS_URL": web.jwksURL()}
	go func() {
		done <- run(ctx, []string{"-listen", "127.0.0.1:0"}, envOf(env), &out, func(a net.Addr) { addrc <- a })
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
	if n := web.hits.Load(); n != 0 {
		t.Fatalf("起動のときに JWKS を %d 回取りに行った", n)
	}

	tok := web.token(t, issuer)
	get := func(path string) (*http.Response, []byte) {
		req, _ := http.NewRequest(http.MethodGet, base+path, nil)
		req.Header.Set("Authorization", "Bearer "+tok)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp, b
	}
	// ほかの入口は、Authorization を見ず、JWKS を取りに行かない（データが無いので 503 no_data でよい。401 にならないこと）
	for _, path := range []string{"/api/health", "/api/areas", "/api/candidates", "/api/candidates.geojson", "/api/metrics"} {
		if resp, b := get(path); resp.StatusCode == 401 || strings.Contains(string(b), "ログイン") {
			t.Errorf("%s がログインを求めた: %d %s", path, resp.StatusCode, b)
		}
	}
	if n := web.hits.Load(); n != 0 {
		t.Fatalf("/api/me 以外の入口が JWKS を %d 回取りに行った", n)
	}
	resp, body := get("/api/me")
	if resp.StatusCode != 200 || !strings.HasPrefix(string(body), `{"sub":"ba_user_0000000001","email":"tanaka@example.com"`) || resp.Header.Get("Cache-Control") != "no-store" {
		t.Errorf("/api/me: %d %s %v", resp.StatusCode, body, resp.Header)
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
	if !strings.Contains(logs, `GET "/api/me" -> 200`) {
		t.Errorf("アクセスログに /api/me が無い: %s", logs)
	}
	for _, leaked := range []string{tok, "Authorization", "Bearer", web.Server.URL, url} {
		if strings.Contains(logs, leaked) {
			t.Errorf("ログに %q が入っている", leaked)
		}
	}
}
