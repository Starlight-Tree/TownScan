package auth

import (
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"townscan/api/internal/config"
)

// 試験用の偽の画面のサーバー（Better Auth の代わり）: 署名用の鍵・JWKS を配るサーバー・JWT の作り方。
// 鍵は、試験の実行ごとに作る（ファイルに書かない）。contract/support/fakes.py と同じ顔ぶれ。

const (
	testIssuer   = "https://auth.contract.test"
	testAudience = "townscan"
	testSub      = "ba_user_0000000001"
	kidA         = "test-es256-a" // JWKS に alg・use が付く鍵
	kidPlain     = "test-es256-b" // JWKS に alg・use が付かない鍵（Better Auth の実際の出力はこの形）
)

var (
	keyA        = mustECKey(elliptic.P256())
	keyPlain    = mustECKey(elliptic.P256())
	keyOther    = mustECKey(elliptic.P256()) // JWKS に載せない鍵（偽造の想定）
	keyP384     = mustECKey(elliptic.P384())
	keyRSA      = mustRSAKey()
	_, edPublic = mustEd25519()
)

// 試験の時計の既定の「いま」。秒に丸めてある（exp などの境界を、ちょうどで確かめるため）
var testNow = time.Date(2026, 11, 25, 3, 0, 0, 0, time.UTC)

func mustECKey(c elliptic.Curve) *ecdsa.PrivateKey {
	k, err := ecdsa.GenerateKey(c, rand.Reader)
	if err != nil {
		panic(err)
	}
	return k
}

func mustRSAKey() *rsa.PrivateKey {
	k, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		panic(err)
	}
	return k
}

func mustEd25519() (ed25519.PrivateKey, ed25519.PublicKey) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		panic(err)
	}
	return priv, pub
}

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// ecJWK は、EC の公開鍵の JWK（kty・crv・x・y）に extra を足したもの。座標は、曲線の大きさにそろえて 0 で埋める。
func ecJWK(pub *ecdsa.PublicKey, extra map[string]any) map[string]any {
	size := (pub.Curve.Params().BitSize + 7) / 8
	jwk := map[string]any{
		"kty": "EC",
		"crv": pub.Curve.Params().Name,
		"x":   b64(pub.X.FillBytes(make([]byte, size))),
		"y":   b64(pub.Y.FillBytes(make([]byte, size))),
	}
	for k, v := range extra {
		jwk[k] = v
	}
	return jwk
}

// jwksDocument は、配る JWKS。使える鍵（EC P-256・kid あり・署名用）が 2 つと、使えない鍵（EdDSA・RSA・P-384・kid 無し・暗号化用）が混ざる。
// 使えない鍵があっても、使える鍵で検証できること。
func jwksDocument() map[string]any {
	return map[string]any{"keys": []any{
		ecJWK(&keyA.PublicKey, map[string]any{"kid": kidA, "alg": "ES256", "use": "sig"}),
		ecJWK(&keyPlain.PublicKey, map[string]any{"kid": kidPlain}),
		map[string]any{"kty": "OKP", "crv": "Ed25519", "x": b64(edPublic), "kid": "test-ed25519", "alg": "EdDSA"},
		map[string]any{"kty": "RSA", "n": b64(keyRSA.N.Bytes()), "e": "AQAB", "kid": "test-rsa"},
		ecJWK(&keyP384.PublicKey, map[string]any{"kid": "test-p384"}),
		ecJWK(&keyOther.PublicKey, nil),                                             // kid が無い
		ecJWK(&keyOther.PublicKey, map[string]any{"kid": "test-enc", "use": "enc"}), // 暗号化用
	}}
}

// jwksServer は、JWKS を配る使い捨てのサーバー。hits は取得の回数、doc は配る中身（差し替えられる）、fail が 0 でなければ、その状態で応える。
type jwksServer struct {
	*httptest.Server
	hits    atomic.Int32
	mu      sync.Mutex
	body    []byte
	status  int
	delay   time.Duration
	headers http.Header // 最後の要求のヘッダー
}

const jwksPath = "/api/auth/jwks"

func newJWKSServer(t *testing.T) *jwksServer {
	t.Helper()
	s := &jwksServer{status: http.StatusOK}
	s.setDocument(jwksDocument())
	s.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.hits.Add(1)
		s.mu.Lock()
		body, status, delay := s.body, s.status, s.delay
		s.headers = r.Header.Clone()
		s.mu.Unlock()
		if r.URL.Path != jwksPath {
			http.NotFound(w, r)
			return
		}
		if delay > 0 {
			select {
			case <-time.After(delay):
			case <-r.Context().Done():
				return
			}
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write(body)
	}))
	t.Cleanup(s.Server.Close)
	return s
}

func (s *jwksServer) setDocument(doc any) {
	b, err := json.Marshal(doc)
	if err != nil {
		panic(err)
	}
	s.setBody(b)
}

func (s *jwksServer) setBody(b []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.body = b
}

func (s *jwksServer) setStatus(code int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.status = code
}

func (s *jwksServer) setDelay(d time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.delay = d
}

func (s *jwksServer) lastHeaders() http.Header {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.headers
}

func (s *jwksServer) url() string { return s.Server.URL + jwksPath }

// clock は、試験の時計。進めるには advance を使う。
type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *clock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

// logBuffer は、ログの行を集める（別の goroutine からも書かれる）。
type logBuffer struct {
	mu    sync.Mutex
	lines []string
}

func (l *logBuffer) logf(format string, args ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lines = append(l.lines, fmt.Sprintf(format, args...))
}

func (l *logBuffer) text() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return strings.Join(l.lines, "\n")
}

// newTestVerifier は、JWKS の URL に url を使い、時計を testNow に固定した検証。
func newTestVerifier(t *testing.T, url string) (*Verifier, *clock, *logBuffer) {
	t.Helper()
	logs := &logBuffer{}
	v, err := NewVerifier(config.Auth{Issuer: testIssuer, JWKSURL: url, Audience: testAudience}, logs.logf)
	if err != nil {
		t.Fatal(err)
	}
	clk := &clock{t: testNow}
	v.now = clk.Now
	return v, clk, logs
}

// claims は、検証に通る既定の claims（Better Auth の definePayload と同じ形）。
func claims(now time.Time) jwt.MapClaims {
	return jwt.MapClaims{
		"iss":            testIssuer,
		"aud":            testAudience,
		"sub":            testSub,
		"iat":            now.Unix(),
		"exp":            now.Add(900 * time.Second).Unix(),
		"email":          "tanaka@example.com",
		"email_verified": true,
		"name":           "田中 太郎",
		"picture":        "https://lh3.googleusercontent.com/a/test",
	}
}

// signed は、署名した JWT。kid が空なら kid ヘッダーを付けない。
func signed(t *testing.T, method jwt.SigningMethod, key any, kid string, c jwt.MapClaims) string {
	t.Helper()
	tok := jwt.NewWithClaims(method, c)
	if kid != "" {
		tok.Header["kid"] = kid
	}
	s, err := tok.SignedString(key)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// token は、JWKS の鍵 A で署名した、通る JWT。mutate で claims を変える（delete や代入）。
func token(t *testing.T, mutate func(jwt.MapClaims)) string {
	t.Helper()
	c := claims(testNow)
	if mutate != nil {
		mutate(c)
	}
	return signed(t, jwt.SigningMethodES256, keyA, kidA, c)
}
