package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"testing"
)

// env は、テスト用の環境変数（os.Getenv の代わり）。
func env(kv map[string]string) func(string) string {
	return func(k string) string { return kv[k] }
}

// logs は、警告を集める。
type logs struct{ lines []string }

func (l *logs) logf(format string, args ...any) {
	l.lines = append(l.lines, fmt.Sprintf(format, args...))
}
func (l *logs) text() string { return strings.Join(l.lines, "\n") }

var db = map[string]string{"DATABASE_URL": "postgresql://u:pw@db/x"}

func with(base map[string]string, extra map[string]string) map[string]string {
	out := map[string]string{}
	for k, v := range base {
		out[k] = v
	}
	for k, v := range extra {
		out[k] = v
	}
	return out
}

func mustLoad(t *testing.T, kv map[string]string) Config {
	t.Helper()
	c, err := Load(env(kv), nil)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	return c
}

func TestLoadRequiresDatabaseURL(t *testing.T) {
	for _, kv := range []map[string]string{{}, {"DATABASE_URL": "   "}, {"DATABASE_URL": "\n"}} {
		_, err := Load(env(kv), nil)
		var ce *Error
		if !errors.As(err, &ce) || !strings.Contains(err.Error(), "DATABASE_URL") {
			t.Errorf("%v: err = %v", kv, err)
		}
	}
}

func TestLoadDefaults(t *testing.T) {
	c := mustLoad(t, db)
	if c.LLMProvider != "mock" || c.TilesDir != "/data/townscan/tiles" || c.GeminiModel != "gemini-3.5-flash-lite" {
		t.Errorf("既定が違う: %+v", c)
	}
	if c.Auth != nil || c.GeminiAPIKey.Reveal() != "" {
		t.Errorf("ログイン・Gemini のキーは未設定のはず: %+v", c)
	}
	if c.DatabaseURL.Reveal() != "postgresql://u:pw@db/x" {
		t.Error("DATABASE_URL を読めていない")
	}
}

func TestEmptyTilesDirFallsBackToTheDefault(t *testing.T) {
	// Python の API は、空の TILES_DIR を Path("") = "." にする（カレントディレクトリから写真を探す）。Go は既定に戻す
	if got := mustLoad(t, with(db, map[string]string{"TILES_DIR": ""})).TilesDir; got != "/data/townscan/tiles" {
		t.Errorf("TilesDir = %q", got)
	}
}

func TestLoadStripsAndReadsValues(t *testing.T) {
	c := mustLoad(t, with(db, map[string]string{
		"DATABASE_URL": "  postgresql://u:pw@db/x\n", "TILES_DIR": "/t", "LLM_PROVIDER": " gemini ",
		"GEMINI_API_KEY": " AIzaSyDUMMY-key_for-test0123456789abcd\n", "GEMINI_MODEL": " gemini-x.y ",
	}))
	if c.DatabaseURL.Reveal() != "postgresql://u:pw@db/x" || c.TilesDir != "/t" || c.LLMProvider != "gemini" ||
		c.GeminiAPIKey.Reveal() != "AIzaSyDUMMY-key_for-test0123456789abcd" || c.GeminiModel != "gemini-x.y" {
		t.Errorf("読み取りが違う: %#v", c)
	}
	if err := c.Validate(); err != nil {
		t.Errorf("Validate: %v", err)
	}
}

// Python の str.strip() は 0x1c〜0x1f も空白と見る
func TestLoadStripsLikePython(t *testing.T) {
	c := mustLoad(t, with(db, map[string]string{"GEMINI_MODEL": "\x1cm-1\x1f", "LLM_PROVIDER": "　mock "}))
	if c.GeminiModel != "m-1" || c.LLMProvider != "mock" {
		t.Errorf("model=%q provider=%q", c.GeminiModel, c.LLMProvider)
	}
}

// ---- 秘密は、どの書き方でも出ない ----

func TestSecretsNeverAppearInAnyFormatting(t *testing.T) {
	const dbSecret, keySecret = "pw-secret-marker", "AIzaSy-key-secret-marker"
	c := mustLoad(t, with(db, map[string]string{
		"DATABASE_URL": "postgresql://u:" + dbSecret + "@db/x", "LLM_PROVIDER": "gemini", "GEMINI_API_KEY": keySecret,
	}))
	var logbuf bytes.Buffer
	slog.New(slog.NewTextHandler(&logbuf, nil)).Info("設定", "config", c, "url", c.DatabaseURL, "key", c.GeminiAPIKey)
	js, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	outputs := []string{
		fmt.Sprintf("%v", c), fmt.Sprintf("%+v", c), fmt.Sprintf("%#v", c), fmt.Sprintf("%s", c.DatabaseURL),
		fmt.Sprint(c.GeminiAPIKey), fmt.Sprintf("%q", c.GeminiAPIKey), string(js), logbuf.String(),
	}
	for _, out := range outputs {
		if strings.Contains(out, dbSecret) || strings.Contains(out, keySecret) {
			t.Errorf("秘密が出力に入っている: %s", out)
		}
	}
}

// ---- LLM_PROVIDER・Gemini の検査（backend/tests/test_config.py と同じ表） ----

func TestValidateRejectsUnsupportedProviders(t *testing.T) {
	for _, p := range []string{"openai", "anthropic", "GEMINI", "MOCK", ""} {
		c := Config{DatabaseURL: "x", LLMProvider: p}
		err := c.Validate()
		if err == nil || !strings.Contains(err.Error(), "LLM_PROVIDER") {
			t.Errorf("%q: err = %v", p, err)
		}
	}
	err := Config{LLMProvider: "openai"}.Validate()
	want := "LLM_PROVIDER='openai' は未対応です。使えるのは mock・gemini です（既定は mock）"
	if err == nil || err.Error() != want {
		t.Errorf("message = %v\n期待 = %s", err, want)
	}
}

func TestValidateAcceptsMock(t *testing.T) {
	if err := (Config{LLMProvider: "mock"}).Validate(); err != nil {
		t.Error(err)
	}
}

func TestGeminiWithoutKeyFailsWithJapaneseMessage(t *testing.T) {
	for _, kv := range []map[string]string{
		{"LLM_PROVIDER": "gemini"}, {"LLM_PROVIDER": "gemini", "GEMINI_API_KEY": ""}, {"LLM_PROVIDER": "gemini", "GEMINI_API_KEY": "   "},
	} {
		err := mustLoad(t, with(db, kv)).Validate()
		if err == nil || !strings.Contains(err.Error(), "GEMINI_API_KEY が要ります") {
			t.Errorf("%v: err = %v", kv, err)
		}
	}
}

func TestMalformedGeminiKeyFailsWithoutEchoingIt(t *testing.T) {
	for _, bad := range []string{"has space", "tab\there", "日本語のキー", "line1\nline2"} {
		err := mustLoad(t, with(db, map[string]string{"LLM_PROVIDER": "gemini", "GEMINI_API_KEY": bad})).Validate()
		if err == nil || !strings.Contains(err.Error(), "GEMINI_API_KEY") {
			t.Errorf("%q: err = %v", bad, err)
			continue
		}
		if strings.Contains(err.Error(), strings.TrimSpace(bad)) {
			t.Errorf("%q: キーがメッセージに入っている: %v", bad, err)
		}
	}
}

func TestMalformedGeminiModelFailsAtStartup(t *testing.T) {
	for _, bad := range []string{"a/b", "../x", "m?key=1", "m:generateContent", "-lead", strings.Repeat("x", 80)} {
		c := Config{LLMProvider: "gemini", GeminiAPIKey: "k", GeminiModel: bad}
		err := c.Validate()
		if err == nil || !strings.Contains(err.Error(), "GEMINI_MODEL") {
			t.Errorf("%q: err = %v", bad, err)
		}
	}
	for _, ok := range []string{"gemini-3.5-flash-lite", "a", "A1._-x", strings.Repeat("x", 64)} {
		c := Config{LLMProvider: "gemini", GeminiAPIKey: "k", GeminiModel: ok}
		if err := c.Validate(); err != nil {
			t.Errorf("%q: %v", ok, err)
		}
	}
}

func TestModelAndKeyAreNotChecked_WhenProviderIsMock(t *testing.T) {
	c := Config{LLMProvider: "mock", GeminiAPIKey: "bad key", GeminiModel: "a/b"}
	if err := c.Validate(); err != nil {
		t.Errorf("mock のときは Gemini の設定を見ない: %v", err)
	}
}

// ---- ログイン（AUTH_ISSUER・AUTH_AUDIENCE・AUTH_JWKS_URL）。任意の機能で、足りなければ未設定として動く ----

func TestAuthIsOffByDefault(t *testing.T) {
	if mustLoad(t, db).Auth != nil {
		t.Error("既定ではログインは無効のはず")
	}
}

func TestAuthNeedsBothIssuerAndJWKSURL(t *testing.T) {
	for _, kv := range []map[string]string{
		{"AUTH_ISSUER": "http://localhost:3500"},
		{"AUTH_JWKS_URL": "http://web:3000/api/auth/jwks"},
		{"AUTH_ISSUER": "  ", "AUTH_JWKS_URL": ""},
		{"AUTH_AUDIENCE": "townscan"},
	} {
		var l logs
		c, err := Load(env(with(db, kv)), l.logf)
		if err != nil || c.Auth != nil {
			t.Errorf("%v: auth = %+v, err = %v", kv, c.Auth, err)
		}
		if len(l.lines) != 0 { // 未設定は設定ミスではない。静かに無効
			t.Errorf("%v: 警告が出た: %s", kv, l.text())
		}
	}
}

func TestAuthDefaultsAudienceAndStripsTrailingSlashes(t *testing.T) {
	c := mustLoad(t, with(db, map[string]string{"AUTH_ISSUER": "http://localhost:3500", "AUTH_JWKS_URL": "http://web:3000/api/auth/jwks"}))
	want := Auth{Issuer: "http://localhost:3500", JWKSURL: "http://web:3000/api/auth/jwks", Audience: "townscan"}
	if c.Auth == nil || *c.Auth != want {
		t.Errorf("auth = %+v", c.Auth)
	}
	c = mustLoad(t, with(db, map[string]string{
		"AUTH_ISSUER": " https://townscan.example/ ", "AUTH_JWKS_URL": "https://townscan.example/api/auth/jwks/", "AUTH_AUDIENCE": " other ",
	}))
	want = Auth{Issuer: "https://townscan.example", JWKSURL: "https://townscan.example/api/auth/jwks", Audience: "other"}
	if c.Auth == nil || *c.Auth != want {
		t.Errorf("auth = %+v", c.Auth)
	}
}

// 形が不正な URL は、起動を止めない。変数名だけを警告に出し、検証を無効にする。値は出さない（URL にユーザー名・パスワードが入りうる）
var badURLs = []string{
	"ftp://web/jwks",
	"file:///etc/passwd",
	"web:3000/jwks",
	"localhost:3500", // BETTER_AUTH_URL に、http:// を付け忘れた値
	"http://",
	"javascript:alert(1)",
	"http://[::1",
	"http://web:99999/jwks",
	"http://web:abc/jwks",
	"ftp://admin:secret-marker@web/jwks",
}

func TestMalformedAuthURLsTurnLoginOffWithoutStopping(t *testing.T) {
	for _, name := range []string{"AUTH_ISSUER", "AUTH_JWKS_URL"} {
		for _, bad := range badURLs {
			kv := with(db, map[string]string{"AUTH_ISSUER": "http://localhost:3500", "AUTH_JWKS_URL": "http://web:3000/api/auth/jwks", name: bad})
			var l logs
			c, err := Load(env(kv), l.logf)
			if err != nil {
				t.Errorf("%s=%q: 起動を止めてはいけない: %v", name, bad, err)
				continue
			}
			if c.Auth != nil {
				t.Errorf("%s=%q: 検証は無効のはず", name, bad)
			}
			if len(l.lines) != 1 || !strings.Contains(l.lines[0], name) {
				t.Errorf("%s=%q: 警告は 1 行で変数名を含むはず: %v", name, bad, l.lines)
			}
			if strings.Contains(l.text(), bad) || strings.Contains(l.text(), "secret-marker") {
				t.Errorf("%s=%q: 警告に値が入っている: %s", name, bad, l.text())
			}
			if err := c.Validate(); err != nil {
				t.Errorf("%s=%q: 起動の検査にも通るはず: %v", name, bad, err)
			}
		}
	}
}

func TestBothMalformedAuthURLsAreNamedInOneWarning(t *testing.T) {
	var l logs
	c, _ := Load(env(with(db, map[string]string{"AUTH_ISSUER": "localhost:3500", "AUTH_JWKS_URL": "web:3000/jwks"})), l.logf)
	if c.Auth != nil || len(l.lines) != 1 {
		t.Fatalf("auth = %v, 警告 = %v", c.Auth, l.lines)
	}
	if !strings.Contains(l.lines[0], "AUTH_ISSUER・AUTH_JWKS_URL") || strings.Contains(l.text(), "localhost:3500") || strings.Contains(l.text(), "web:3000") {
		t.Errorf("警告 = %s", l.text())
	}
}

func TestValidAuthURLsLogNothing(t *testing.T) {
	var l logs
	c, _ := Load(env(with(db, map[string]string{"AUTH_ISSUER": "http://localhost:3500", "AUTH_JWKS_URL": "http://web:3000/api/auth/jwks"})), l.logf)
	if c.Auth == nil || len(l.lines) != 0 {
		t.Errorf("auth = %v, 警告 = %v", c.Auth, l.lines)
	}
}

// AUTH_AUDIENCE は形の検査が無い（JWT の aud と比べるだけの文字列）。空・空白だけなら既定の townscan
func TestAudienceNeverStopsStartup(t *testing.T) {
	for _, aud := range []string{"", "   ", strings.Repeat("x", 500), "http://not a url", "日本語の対象"} {
		c := mustLoad(t, with(db, map[string]string{"AUTH_ISSUER": "http://localhost:3500", "AUTH_JWKS_URL": "http://web:3000/api/auth/jwks", "AUTH_AUDIENCE": aud}))
		want := pyStrip(aud)
		if want == "" {
			want = "townscan"
		}
		if c.Auth == nil || c.Auth.Audience != want {
			t.Errorf("%q: auth = %+v", aud, c.Auth)
		}
	}
}

func TestDatabaseURLIsStillRequiredWhenLoginIsMisconfigured(t *testing.T) {
	_, err := Load(env(map[string]string{"AUTH_ISSUER": "localhost:3500", "AUTH_JWKS_URL": "web:3000/jwks"}), nil)
	if err == nil || !strings.Contains(err.Error(), "DATABASE_URL") {
		t.Errorf("err = %v", err)
	}
}

func TestHTTPURLEdgeCases(t *testing.T) {
	ok := map[string]string{
		"http://web:3000/x/":         "http://web:3000/x",
		"HTTPS://Example.com//":      "HTTPS://Example.com",
		"http://[::1]:8080":          "http://[::1]:8080",
		"  http://localhost:3500  ":  "http://localhost:3500",
		"http://user:pw@host:1/p///": "http://user:pw@host:1/p",
	}
	for in, want := range ok {
		if got, good := httpURL(in); !good || got != want {
			t.Errorf("httpURL(%q) = %q, %v; 期待 %q", in, got, good, want)
		}
	}
	for _, in := range []string{"", "/", "http:///x", "http://:80", "mailto:a@b", "http://h:65536", "http://h:-1"} {
		if got, good := httpURL(in); good {
			t.Errorf("httpURL(%q) = %q は不正のはず", in, got)
		}
	}
}
