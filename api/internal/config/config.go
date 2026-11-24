// Package config は、環境変数からの設定。名前・既定・検証は backend/app/config.py と同じ。
//
// 秘密（DB のパスワードは DATABASE_URL に、Gemini のキーは GEMINI_API_KEY に入る）は、表示・ログ・エラーに出さない。
// 秘密の型（Secret）は、fmt・ログ・JSON のどれで書いても伏せ字になる（値を取り出すのは Reveal だけ）。
package config

import (
	"fmt"
	"log/slog"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

// 実 LLM（Gemini）の既定のモデル。変えるときは GEMINI_MODEL で上書きする（docs/decisions/0003-llm-provider.md）
const DefaultGeminiModel = "gemini-3.5-flash-lite"

// JWT の aud の既定（画面側の JWT_AUDIENCE と同じ値）
const DefaultAuthAudience = "townscan"

// 既定の写真タイルの置き場
const DefaultTilesDir = "/data/townscan/tiles"

// SupportedLLMProviders は、LLM_PROVIDER に使える値。
var SupportedLLMProviders = []string{"mock", "gemini"}

// キーは HTTP ヘッダーに載せる。空白・改行・日本語が混ざると、値そのもの（=キー）を含む例外が出るので、先に形で止める
var geminiKeyPattern = regexp.MustCompile(`^[\x21-\x7e]+$`)

// モデル名は URL の path に入る。`/`・`:`・`?` などを通さない
var geminiModelPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

// Error は、設定が足りない・不正なとき（backend の ConfigError）。起動時に出して止める。メッセージに秘密の値は入れない。
type Error struct{ Message string }

func (e *Error) Error() string { return e.Message }

func errorf(format string, args ...any) *Error { return &Error{Message: fmt.Sprintf(format, args...)} }

// Secret は、秘密の文字列。どの書き方（%v・%+v・%#v・%s・JSON・slog）でも、値を出さない。
type Secret string

const redacted = "[秘密]"

// Reveal は、値を取り出す（接続・ヘッダーに渡すときだけ使う）。
func (s Secret) Reveal() string { return string(s) }

// String は fmt の %v・%s。
func (s Secret) String() string { return redacted }

// GoString は fmt の %#v。
func (s Secret) GoString() string { return `"` + redacted + `"` }

// MarshalJSON は JSON（ログの構造化出力など）。
func (s Secret) MarshalJSON() ([]byte, error) { return []byte(`"` + redacted + `"`), nil }

// MarshalText は、テキストとして書き出される場面（map のキーなど）。
func (s Secret) MarshalText() ([]byte, error) { return []byte(redacted), nil }

// LogValue は log/slog。
func (s Secret) LogValue() slog.Value { return slog.StringValue(redacted) }

// Auth は、JWT（画面のサーバーの中の Better Auth が発行）を検証するための設定。値はどれも秘密ではない（公開の URL と名前）。
//
// Issuer は Better Auth の BETTER_AUTH_URL（JWT の iss）、JWKSURL は API から届く JWKS の URL（compose の中では http://web:3000/api/auth/jwks）、
// Audience は JWT の aud（既定 townscan。画面側の JWT_AUDIENCE と同じ値）。
type Auth struct {
	Issuer   string
	JWKSURL  string
	Audience string
}

// Config は、API の設定。
type Config struct {
	DatabaseURL Secret
	TilesDir    string
	LLMProvider string
	// nil = ログインは未設定（/api/me は 503。ほかの機能は影響を受けない）
	Auth *Auth
	// 実 LLM（Gemini。任意）。LLM_PROVIDER=gemini のときだけ使う
	GeminiAPIKey Secret
	GeminiModel  string
}

// Logf は、警告の出力先（log.Printf など）。nil なら出さない。
type Logf func(format string, args ...any)

// Load は、環境変数（get は os.Getenv の代わり。テストで差し替える）から設定を読む。DATABASE_URL が無いときだけエラー。
// ログインの設定（AUTH_*）の形が不正でも、起動は止めない（警告を出して、検証を無効にする。下の authFromEnv）。
func Load(get func(string) string, logf Logf) (Config, error) {
	dsn := pyStrip(get("DATABASE_URL"))
	if dsn == "" {
		return Config{}, errorf("環境変数 DATABASE_URL が未設定です（例: postgresql://ユーザー:パスワード@db:5432/townscan）")
	}
	// 空（設定したが空）のときは、既定に戻す。Python の API は Path("") = "."（カレントディレクトリ）になり、そこから写真を探してしまう
	tiles := get("TILES_DIR")
	if tiles == "" {
		tiles = DefaultTilesDir
	}
	provider := pyStrip(get("LLM_PROVIDER"))
	if provider == "" {
		provider = "mock"
	}
	model := pyStrip(get("GEMINI_MODEL"))
	if model == "" {
		model = DefaultGeminiModel
	}
	return Config{
		DatabaseURL:  Secret(dsn),
		TilesDir:     tiles,
		LLMProvider:  provider,
		Auth:         authFromEnv(get, logf),
		GeminiAPIKey: Secret(pyStrip(get("GEMINI_API_KEY"))),
		GeminiModel:  model,
	}, nil
}

// Validate は、起動時の検査（未対応の LLM_PROVIDER・gemini なのにキーが無い・形が不正）。キーの値は、どの文にも入れない。
func (c Config) Validate() error {
	supported := false
	for _, p := range SupportedLLMProviders {
		if c.LLMProvider == p {
			supported = true
		}
	}
	if !supported {
		return errorf("LLM_PROVIDER=%s は未対応です。使えるのは %s です（既定は mock）", pyRepr(c.LLMProvider), strings.Join(SupportedLLMProviders, "・"))
	}
	if c.LLMProvider == "gemini" {
		key := c.GeminiAPIKey.Reveal()
		if key == "" {
			return errorf("LLM_PROVIDER=gemini には GEMINI_API_KEY が要ります（Infisical に登録したなら infisical run 経由で api を作り直す。使わないなら .env に書く）")
		}
		if !geminiKeyPattern.MatchString(key) {
			return errorf("GEMINI_API_KEY の形が正しくありません（空白・改行・全角文字を含まない 1 行の文字列にしてください）")
		}
		if !geminiModelPattern.MatchString(c.GeminiModel) {
			return errorf("GEMINI_MODEL の形が正しくありません（英数字・ドット・ハイフン・アンダースコアだけ。例: gemini-3.5-flash-lite）")
		}
	}
	return nil
}

// authFromEnv は、AUTH_ISSUER と AUTH_JWKS_URL がそろっているときだけ有効（ログインは任意の機能。足りなければ nil で、/api/me が 503 になるだけ）。
//
// 形が不正な URL も、起動を止めずに「無い」として扱う。ここでエラーにすると、BETTER_AUTH_URL の書き間違い
// （compose が同じ値を AUTH_ISSUER へ渡す。例: localhost:3500）で api が起動のたびに落ち続け、web も api の healthy を
// 待つので、チャット・地図まで使えなくなる（仕様 §2.1「どの場合も、いまの機能は壊れない」）。
// ログに出すのは変数名だけ（値は出さない。URL にユーザー名・パスワードが入っていることがあるため）。
// AUTH_AUDIENCE は形の検査が無い（任意の文字列。空なら既定）ので、起動を止める理由にならない。
func authFromEnv(get func(string) string, logf Logf) *Auth {
	urls := map[string]string{}
	var malformed []string
	for _, name := range []string{"AUTH_ISSUER", "AUTH_JWKS_URL"} {
		raw := pyStrip(get(name))
		if raw == "" {
			continue
		}
		u, ok := httpURL(raw)
		if !ok {
			malformed = append(malformed, name)
			continue
		}
		urls[name] = u
	}
	if len(malformed) > 0 {
		if logf != nil {
			logf("環境変数 %s は http(s) の URL ではないため、ログインの検証を無効にしました（/api/me は 503。ほかの機能は動きます）", strings.Join(malformed, "・"))
		}
		return nil
	}
	issuer, jwks := urls["AUTH_ISSUER"], urls["AUTH_JWKS_URL"]
	if issuer == "" || jwks == "" {
		return nil
	}
	aud := pyStrip(get("AUTH_AUDIENCE"))
	if aud == "" {
		aud = DefaultAuthAudience
	}
	return &Auth{Issuer: issuer, JWKSURL: jwks, Audience: aud}
}

// httpURL は、末尾の / を外した URL。http(s) 以外・ホストなし・読めない形（`http://[::1`・ポートが数字でない・範囲外 など）は false。
func httpURL(raw string) (string, bool) {
	raw = strings.TrimRight(pyStrip(raw), "/")
	u, err := url.Parse(raw)
	if err != nil {
		return "", false
	}
	if s := strings.ToLower(u.Scheme); s != "http" && s != "https" {
		return "", false
	}
	if u.Hostname() == "" {
		return "", false
	}
	if p := u.Port(); p != "" {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 || n > 65535 {
			return "", false
		}
	}
	return raw, true
}

// pyStrip は、Python の str.strip()（引数なし）と同じ。Go の unicode.IsSpace に、Python が空白と見る 0x1c〜0x1f を足したもの。
func pyStrip(s string) string {
	return strings.TrimFunc(s, func(r rune) bool { return unicode.IsSpace(r) || (r >= 0x1c && r <= 0x1f) })
}

// pyRepr は、Python の repr(str) に近い書き方（'…'）。LLM_PROVIDER の値は秘密ではないので、メッセージに入れてよい。
func pyRepr(s string) string {
	if !strings.Contains(s, "'") {
		return "'" + s + "'"
	}
	if !strings.Contains(s, `"`) {
		return `"` + s + `"`
	}
	return "'" + strings.ReplaceAll(s, "'", `\'`) + "'"
}
