package apierr

import (
	"net/http/httptest"
	"testing"
)

// ログイン（GET /api/me）のエラー: 文・code・ヘッダーは backend/app/auth.py と同じ。どれも保存させない。
func TestAuthErrorsMatchPython(t *testing.T) {
	cases := []struct {
		name   string
		err    *Error
		status int
		body   string
		www    string // WWW-Authenticate（401 だけ）
	}{
		{"未ログイン", NotLoggedIn(), 401, `{"error":{"code":"unauthorized","message":"ログインしてください"}}`, "Bearer"},
		{"ログイン未設定", AuthNotConfigured(), 503, `{"error":{"code":"unavailable","message":"Google でのログインは、まだ設定されていません"}}`, ""},
		{"鍵を取れない", AuthUnavailable(), 503, `{"error":{"code":"unavailable","message":"ログインを確認できませんでした。しばらくしてから、もう一度お試しください"}}`, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			Write(rec, c.err)
			if rec.Code != c.status || rec.Body.String() != c.body {
				t.Errorf("%d %s\n期待 %d %s", rec.Code, rec.Body.String(), c.status, c.body)
			}
			if got := rec.Header().Get("Cache-Control"); got != "no-store" {
				t.Errorf("Cache-Control = %q", got)
			}
			if got := rec.Header().Get("WWW-Authenticate"); got != c.www {
				t.Errorf("WWW-Authenticate = %q, 期待 %q", got, c.www)
			}
			if got := rec.Header().Get("Content-Type"); got != "application/json" {
				t.Errorf("Content-Type = %q", got)
			}
		})
	}
}

// 作るたびに別のヘッダーの表を持つ（1 つを書き換えても、次のエラーに移らない）。
func TestAuthErrorsDoNotShareHeaders(t *testing.T) {
	a := NotLoggedIn()
	a.Headers["Cache-Control"] = "public"
	if got := NotLoggedIn().Headers["Cache-Control"]; got != "no-store" {
		t.Errorf("Cache-Control = %q", got)
	}
	if _, ok := AuthNotConfigured().Headers["WWW-Authenticate"]; ok {
		t.Error("503 に WWW-Authenticate がある")
	}
}
