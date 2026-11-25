package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"townscan/api/internal/auth"
	"townscan/api/internal/config"
	"townscan/api/internal/store"
)

// fakeAuth は、ログインの確認の代わり（インターフェースを使った偽の実装）。渡されたトークンを覚える。
type fakeAuth struct {
	identity auth.Identity
	err      error
	tokens   []string
}

func (f *fakeAuth) Verify(token string) (auth.Identity, error) {
	f.tokens = append(f.tokens, token)
	return f.identity, f.err
}

type meTester struct {
	t    *testing.T
	h    http.Handler
	logs []string
}

func newMeTester(t *testing.T, a Authenticator, fake *fakeStore) *meTester {
	mt := &meTester{t: t}
	d := Deps{Store: fake, LLMProvider: "mock", Logf: func(f string, args ...any) { mt.logs = append(mt.logs, fmt.Sprintf(f, args...)) }}
	if a != nil { // 型つきの nil を、nil のインターフェースにしない
		d.Auth = a
	}
	mt.h = New(d)
	return mt
}

func (mt *meTester) do(method string, header map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, "/api/me", nil)
	for k, v := range header {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	mt.h.ServeHTTP(rec, req)
	return rec
}

func (mt *meTester) logText() string { return strings.Join(mt.logs, "\n") }

func bearer(token string) map[string]string {
	return map[string]string{"Authorization": "Bearer " + token}
}

const (
	notLoggedInBody = `{"error":{"code":"unauthorized","message":"ログインしてください"}}`
	notConfigBody   = `{"error":{"code":"unavailable","message":"Google でのログインは、まだ設定されていません"}}`
	cannotVerify    = `{"error":{"code":"unavailable","message":"ログインを確認できませんでした。しばらくしてから、もう一度お試しください"}}`
)

func (mt *meTester) want(rec *httptest.ResponseRecorder, status int, body string) {
	mt.t.Helper()
	if rec.Code != status {
		mt.t.Errorf("状態 = %d, 期待 %d（本文 %s）", rec.Code, status, rec.Body.String())
	}
	if got := rec.Body.String(); got != body {
		mt.t.Errorf("本文 = %s\n期待 = %s", got, body)
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		mt.t.Errorf("Content-Type = %q", got)
	}
	// どの応答（成功・失敗）も、ブラウザーや中継に保存させない（人ごとに違う内容）
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		mt.t.Errorf("Cache-Control = %q", got)
	}
	if cl := rec.Header().Get("Content-Length"); cl != fmt.Sprint(rec.Body.Len()) {
		mt.t.Errorf("Content-Length = %q, 本文は %d バイト", cl, rec.Body.Len())
	}
}

func TestMeReturnsTheIdentity(t *testing.T) {
	fa := &fakeAuth{identity: auth.Identity{Sub: "ba_user_0000000001", Email: str("tanaka@example.com"), Name: str("田中 太郎"), Picture: str("https://lh3.googleusercontent.com/a/test")}}
	fake := &fakeStore{}
	mt := newMeTester(t, fa, fake)
	rec := mt.do(http.MethodGet, bearer("the-token"))
	mt.want(rec, 200, `{"sub":"ba_user_0000000001","email":"tanaka@example.com","name":"田中 太郎","picture":"https://lh3.googleusercontent.com/a/test"}`)
	if rec.Header().Get("WWW-Authenticate") != "" {
		t.Error("成功に WWW-Authenticate が付いている")
	}
	if len(fa.tokens) != 1 || fa.tokens[0] != "the-token" {
		t.Errorf("検証に渡したトークン = %v", fa.tokens)
	}
	if len(fake.calls) != 0 {
		t.Errorf("/api/me が DB を使った: %v", fake.calls)
	}
}

func TestMeMissingClaimsAreNull(t *testing.T) {
	mt := newMeTester(t, &fakeAuth{identity: auth.Identity{Sub: "ba_user_0000000001"}}, &fakeStore{})
	mt.want(mt.do(http.MethodGet, bearer("t")), 200, `{"sub":"ba_user_0000000001","email":null,"name":null,"picture":null}`)
}

// 本文は ensure_ascii=False・HTML の逃がしなし（Python の API と同じ書式）。
func TestMeBodyIsWrittenLikePython(t *testing.T) {
	mt := newMeTester(t, &fakeAuth{identity: auth.Identity{Sub: "ba_user_0000000001", Name: str(`a<b>&"c"\`), Picture: str("https://example.com/?a=1&b=2")}}, &fakeStore{})
	mt.want(mt.do(http.MethodGet, bearer("t")), 200, `{"sub":"ba_user_0000000001","email":null,"name":"a<b>&\"c\"\\","picture":"https://example.com/?a=1&b=2"}`)
}

func TestMeSchemeIsCaseInsensitive(t *testing.T) {
	for _, scheme := range []string{"Bearer", "bearer", "BEARER"} {
		fa := &fakeAuth{identity: auth.Identity{Sub: "ba_user_0000000001"}}
		mt := newMeTester(t, fa, &fakeStore{})
		if rec := mt.do(http.MethodGet, map[string]string{"Authorization": scheme + " tok"}); rec.Code != 200 {
			t.Errorf("%s: 状態 = %d", scheme, rec.Code)
		}
		if len(fa.tokens) != 1 || fa.tokens[0] != "tok" {
			t.Errorf("%s: トークン = %v", scheme, fa.tokens)
		}
	}
}

// 設定が無いときは、トークンの有無・形を見る前に 503。ログインできない環境で、401（もう一度ログインを）と誤解させない。
func TestMeNotConfiguredIs503BeforeLookingAtTheToken(t *testing.T) {
	for name, header := range map[string]map[string]string{
		"ヘッダーなし":        nil,
		"Basic":         {"Authorization": "Basic abc"},
		"Bearer の中身は不正": bearer("not-a-jwt"),
		"それらしいトークン":     bearer("a.b.c"),
	} {
		t.Run(name, func(t *testing.T) {
			mt := newMeTester(t, nil, &fakeStore{})
			rec := mt.do(http.MethodGet, header)
			mt.want(rec, 503, notConfigBody)
			if rec.Header().Get("WWW-Authenticate") != "" {
				t.Error("503 に WWW-Authenticate が付いている（もう一度ログインを、と誤解させる）")
			}
		})
	}
}

func TestMeMissingOrMalformedAuthorizationIs401WithoutVerifying(t *testing.T) {
	for name, header := range map[string]map[string]string{
		"ヘッダーなし":     nil,
		"空":          {"Authorization": ""},
		"Basic":      {"Authorization": "Basic abc"},
		"Token":      {"Authorization": "Token abc"},
		"Bearer だけ":  {"Authorization": "Bearer"},
		"Bearer と空白": {"Authorization": "Bearer "},
		"トークンが 2 つ":  {"Authorization": "Bearer a b"},
		"別の方式のトークン":  {"Authorization": "Basic eyJhbGciOiJFUzI1NiJ9.e30.AAAA"},
		"小文字の basic": {"Authorization": "basic abc"},
	} {
		t.Run(name, func(t *testing.T) {
			fa := &fakeAuth{}
			mt := newMeTester(t, fa, &fakeStore{})
			rec := mt.do(http.MethodGet, header)
			mt.want(rec, 401, notLoggedInBody)
			if got := rec.Header().Get("WWW-Authenticate"); got != "Bearer" {
				t.Errorf("WWW-Authenticate = %q", got)
			}
			if len(fa.tokens) != 0 {
				t.Errorf("形が違うのに検証へ渡した: %v", fa.tokens)
			}
		})
	}
}

func TestMeInvalidTokenIs401WithAFixedMessageAndLogsOnlyTheReason(t *testing.T) {
	const token = "eyJhbGciOiJFUzI1NiIsImtpZCI6ImsifQ.eyJzdWIiOiJzZWNyZXQtc3ViamVjdCJ9.c2lnbmF0dXJl"
	for name, err := range map[string]error{
		"期限切れ": fmt.Errorf("%w: token is expired (secret-detail)", auth.ErrInvalidToken),
		"想定外のエラー（Unwrap できない）": errors.New("boom secret-detail"),
	} {
		t.Run(name, func(t *testing.T) {
			mt := newMeTester(t, &fakeAuth{err: err}, &fakeStore{})
			rec := mt.do(http.MethodGet, bearer(token))
			mt.want(rec, 401, notLoggedInBody) // 理由・例外の文字列は無い
			if got := rec.Header().Get("WWW-Authenticate"); got != "Bearer" {
				t.Errorf("WWW-Authenticate = %q", got)
			}
			for _, leaked := range []string{token, "secret", "expired", "Authorization"} {
				if strings.Contains(mt.logText(), leaked) || strings.Contains(rec.Body.String(), leaked) {
					t.Errorf("ログまたは応答に %q が入っている: %q", leaked, mt.logText())
				}
			}
			if !strings.Contains(mt.logText(), "認証に失敗しました (reason=unknown)") {
				t.Errorf("ログ = %q", mt.logText())
			}
		})
	}
}

// 本物の検証（auth.Verifier）が返す理由の語が、ログに出る。形が壊れたトークンは、鍵を取りに行く前に断る（ここでは、ネットワークを使わない）。
func TestMeLogsTheReasonFromTheRealVerifier(t *testing.T) {
	v, err := auth.NewVerifier(config.Auth{Issuer: "https://auth.test", JWKSURL: "http://127.0.0.1:1/jwks", Audience: "townscan"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	mt := newMeTester(t, v, &fakeStore{})
	mt.want(mt.do(http.MethodGet, bearer("not-a-jwt")), 401, notLoggedInBody)
	if got := mt.logText(); got != "認証に失敗しました (reason=malformed)" {
		t.Errorf("ログ = %q", got)
	}
}

func TestMeUnavailableIs503WithoutLeakingDetails(t *testing.T) {
	// 鍵を取れないことを表すエラーが、接続先の情報を包んでいても、応答・ログに出ない
	err := fmt.Errorf("%w: dial tcp 10.0.0.5:3000: connect: connection refused http://web:3000/api/auth/jwks", auth.ErrUnavailable)
	mt := newMeTester(t, &fakeAuth{err: err}, &fakeStore{})
	rec := mt.do(http.MethodGet, bearer("tok"))
	mt.want(rec, 503, cannotVerify)
	if rec.Header().Get("WWW-Authenticate") != "" {
		t.Error("503 に WWW-Authenticate が付いている")
	}
	for _, leaked := range []string{"ECONNREFUSED", "10.0.0.5", "refused", "web:3000", "jwks", "OSError", "Traceback"} {
		if strings.Contains(rec.Body.String(), leaked) || strings.Contains(mt.logText(), leaked) {
			t.Errorf("応答・ログに %q が入っている", leaked)
		}
	}
}

// ログイン中の人の確認は、DB を使わない。DB が止まっていても動く。
func TestMeDoesNotNeedTheDatabase(t *testing.T) {
	fake := &fakeStore{err: store.ErrUnavailable, runErr: store.ErrUnavailable}
	mt := newMeTester(t, &fakeAuth{identity: auth.Identity{Sub: "ba_user_0000000001"}}, fake)
	if rec := mt.do(http.MethodGet, bearer("t")); rec.Code != 200 {
		t.Errorf("状態 = %d", rec.Code)
	}
	if len(fake.calls) != 0 {
		t.Errorf("DB を使った: %v", fake.calls)
	}
	// 設定が無くても、401 でも、DB は使わない
	mt = newMeTester(t, nil, fake)
	mt.do(http.MethodGet, nil)
	mt = newMeTester(t, &fakeAuth{}, fake)
	mt.do(http.MethodGet, nil)
	if len(fake.calls) != 0 {
		t.Errorf("DB を使った: %v", fake.calls)
	}
}

// ほかの入口は、Authorization を見ない・ログインの設定に影響されない（付けても付けなくても、応答は同じ）。
func TestOtherEndpointsNeverLookAtAuthorization(t *testing.T) {
	fa := &fakeAuth{err: auth.ErrUnavailable}
	fake := &fakeStore{run: syntheticRun(), metrics: json.RawMessage(`{"a":1}`)}
	mt := newMeTester(t, fa, fake)
	get := func(path string, header map[string]string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		for k, v := range header {
			req.Header.Set(k, v)
		}
		rec := httptest.NewRecorder()
		mt.h.ServeHTTP(rec, req)
		return rec
	}
	for _, path := range []string{"/api/health", "/api/areas", "/api/candidates", "/api/candidates.geojson", "/api/metrics"} {
		plain, with := get(path, nil), get(path, bearer("garbage"))
		if plain.Code != 200 || with.Code != 200 || plain.Body.String() != with.Body.String() {
			t.Errorf("%s: %d / %d（本文が同じ: %v）", path, plain.Code, with.Code, plain.Body.String() == with.Body.String())
		}
	}
	if len(fa.tokens) != 0 {
		t.Errorf("/api/me 以外が検証を呼んだ: %v", fa.tokens)
	}
}

func TestMeRejectsOtherMethods(t *testing.T) {
	fa := &fakeAuth{identity: auth.Identity{Sub: "ba_user_0000000001"}}
	mt := newMeTester(t, fa, &fakeStore{})
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodPatch, http.MethodHead} {
		rec := mt.do(method, bearer("t"))
		if rec.Code != 405 || rec.Body.String() != `{"error":{"code":"method_not_allowed","message":"このメソッドは使えません"}}` {
			t.Errorf("%s: %d %s", method, rec.Code, rec.Body.String())
		}
		if got := rec.Header().Get("Allow"); got != "GET" {
			t.Errorf("%s: Allow = %q", method, got)
		}
	}
	if len(fa.tokens) != 0 {
		t.Errorf("GET 以外が検証を呼んだ: %v", fa.tokens)
	}
}
