package auth

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"townscan/api/internal/config"
)

func wantInvalid(t *testing.T, err error, reason string) {
	t.Helper()
	if !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("err = %v, 期待 ErrInvalidToken(%s)", err, reason)
	}
	if errors.Is(err, ErrUnavailable) {
		t.Errorf("受け付けない理由が、鍵の取得の失敗と取り違えられている: %v", err)
	}
	if got := Reason(err); got != reason {
		t.Errorf("理由 = %q, 期待 %q", got, reason)
	}
}

func TestVerifyAValidTokenGivesTheIdentity(t *testing.T) {
	srv := newJWKSServer(t)
	v, _, _ := newTestVerifier(t, srv.url())
	got, err := v.Verify(token(t, nil))
	if err != nil {
		t.Fatal(err)
	}
	if got.Sub != testSub || got.Email == nil || *got.Email != "tanaka@example.com" || got.Name == nil || *got.Name != "田中 太郎" ||
		got.Picture == nil || *got.Picture != "https://lh3.googleusercontent.com/a/test" {
		t.Errorf("identity = %+v", got)
	}
}

// Better Auth の実際の JWKS は alg・use を持たない。使えない鍵が混ざっていても、使える鍵で検証できる。
func TestVerifyWithAKeyWhoseJWKSEntryHasNoAlgOrUse(t *testing.T) {
	srv := newJWKSServer(t)
	v, _, _ := newTestVerifier(t, srv.url())
	tok := signed(t, jwt.SigningMethodES256, keyPlain, kidPlain, claims(testNow))
	if _, err := v.Verify(tok); err != nil {
		t.Fatal(err)
	}
}

func TestVerifyAudienceMayBeAListContainingOurs(t *testing.T) {
	srv := newJWKSServer(t)
	v, _, _ := newTestVerifier(t, srv.url())
	if _, err := v.Verify(token(t, func(c jwt.MapClaims) { c["aud"] = []string{testAudience, "another-app"} })); err != nil {
		t.Errorf("配列の aud に自分の名前があるのに断られた: %v", err)
	}
}

func TestVerifyAudienceComesFromTheConfig(t *testing.T) {
	srv := newJWKSServer(t)
	v, err := NewVerifier(config.Auth{Issuer: testIssuer, JWKSURL: srv.url(), Audience: "another-app"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	v.now = func() time.Time { return testNow }
	if _, err := v.Verify(token(t, func(c jwt.MapClaims) { c["aud"] = "another-app" })); err != nil {
		t.Errorf("設定の aud の token が断られた: %v", err)
	}
	_, err = v.Verify(token(t, nil)) // aud=townscan は、another-app の API では受け付けない
	wantInvalid(t, err, reasonAudience)
}

// 時計のずれは 10 秒まで。exp は「いま - 10 秒」ちょうどで切れる（Python の exp <= now - leeway と同じ）。nbf・iat は「いま + 10 秒」ちょうどまで受け付ける。
func TestVerifyClockSkewBoundaries(t *testing.T) {
	srv := newJWKSServer(t)
	v, _, _ := newTestVerifier(t, srv.url())
	now := testNow.Unix()
	cases := []struct {
		name   string
		mutate func(jwt.MapClaims)
		reason string // 空 = 受け付ける
	}{
		{"exp が 9 秒前", func(c jwt.MapClaims) { c["exp"] = now - 9 }, ""},
		{"exp が 10 秒前（ちょうど）", func(c jwt.MapClaims) { c["exp"] = now - 10 }, reasonExpired},
		{"exp が 5 秒前", func(c jwt.MapClaims) { c["exp"] = now - 5 }, ""},
		{"nbf が 10 秒先（ちょうど）", func(c jwt.MapClaims) { c["nbf"] = now + 10 }, ""},
		{"nbf が 11 秒先", func(c jwt.MapClaims) { c["nbf"] = now + 11 }, reasonNotYetValid},
		{"iat が 10 秒先（ちょうど）", func(c jwt.MapClaims) { c["iat"] = now + 10 }, ""},
		{"iat が 11 秒先", func(c jwt.MapClaims) { c["iat"] = now + 11 }, reasonNotYetValid},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := v.Verify(token(t, c.mutate))
			if c.reason == "" {
				if err != nil {
					t.Errorf("受け付けるはずが断られた: %v", err)
				}
				return
			}
			wantInvalid(t, err, c.reason)
		})
	}
}

func TestVerifyBadClaims(t *testing.T) {
	srv := newJWKSServer(t)
	v, _, _ := newTestVerifier(t, srv.url())
	now := testNow.Unix()
	cases := []struct {
		name   string
		mutate func(jwt.MapClaims)
		reason string
	}{
		{"期限切れ", func(c jwt.MapClaims) { c["exp"] = now - 3600 }, reasonExpired},
		{"exp が無い", func(c jwt.MapClaims) { delete(c, "exp") }, reasonMissingClaim},
		{"exp が 0", func(c jwt.MapClaims) { c["exp"] = 0 }, reasonMissingClaim},
		{"exp が null", func(c jwt.MapClaims) { c["exp"] = nil }, reasonInvalid},
		{"exp が数でない", func(c jwt.MapClaims) { c["exp"] = "tomorrow" }, reasonInvalid},
		{"nbf が数でない", func(c jwt.MapClaims) { c["nbf"] = "soon" }, reasonInvalid},
		{"iat が数でない", func(c jwt.MapClaims) { c["iat"] = "now" }, reasonInvalid},
		{"まだ有効でない（nbf）", func(c jwt.MapClaims) { c["nbf"] = now + 3600 }, reasonNotYetValid},
		{"未来に発行された（iat）", func(c jwt.MapClaims) { c["iat"] = now + 3600 }, reasonNotYetValid},
		{"aud が違う", func(c jwt.MapClaims) { c["aud"] = "docunavi" }, reasonAudience},
		{"aud が townscan の別名", func(c jwt.MapClaims) { c["aud"] = "townscan-other" }, reasonAudience},
		{"aud が無い", func(c jwt.MapClaims) { delete(c, "aud") }, reasonMissingClaim},
		{"aud が null", func(c jwt.MapClaims) { c["aud"] = nil }, reasonMissingClaim},
		{"aud が空の文字列", func(c jwt.MapClaims) { c["aud"] = "" }, reasonMissingClaim},
		{"aud が空の配列", func(c jwt.MapClaims) { c["aud"] = []string{} }, reasonMissingClaim},
		{"aud が数", func(c jwt.MapClaims) { c["aud"] = 5 }, reasonMissingClaim},
		{"aud の配列に文字列でないものが混ざる", func(c jwt.MapClaims) { c["aud"] = []any{testAudience, 5} }, reasonInvalid},
		{"iss が違う", func(c jwt.MapClaims) { c["iss"] = "http://evil.example" }, reasonIssuer},
		{"iss の末尾に / （完全一致）", func(c jwt.MapClaims) { c["iss"] = testIssuer + "/" }, reasonIssuer},
		{"iss が無い", func(c jwt.MapClaims) { delete(c, "iss") }, reasonMissingClaim},
		{"iss が文字列でない", func(c jwt.MapClaims) { c["iss"] = 5 }, reasonInvalid},
		{"sub が無い", func(c jwt.MapClaims) { delete(c, "sub") }, reasonSubject},
		{"sub が 7 文字", func(c jwt.MapClaims) { c["sub"] = "abcdefg" }, reasonSubject},
		{"sub が 65 文字", func(c jwt.MapClaims) { c["sub"] = strings.Repeat("a", 65) }, reasonSubject},
		{"sub に使えない文字", func(c jwt.MapClaims) { c["sub"] = "has space in it!" }, reasonSubject},
		{"sub に日本語", func(c jwt.MapClaims) { c["sub"] = "ユーザーアイディー" }, reasonSubject},
		{"sub が数", func(c jwt.MapClaims) { c["sub"] = 12345678 }, reasonSubject},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := v.Verify(token(t, c.mutate))
			wantInvalid(t, err, c.reason)
		})
	}
}

func TestVerifySubBoundariesThatAreAccepted(t *testing.T) {
	srv := newJWKSServer(t)
	v, _, _ := newTestVerifier(t, srv.url())
	for _, sub := range []string{"abcdefgh", strings.Repeat("a", 64), "ba_user-0000_0001", "ABCDEFGH12345678"} {
		got, err := v.Verify(token(t, func(c jwt.MapClaims) { c["sub"] = sub }))
		if err != nil || got.Sub != sub {
			t.Errorf("sub=%q: %+v, %v", sub, got, err)
		}
	}
}

func TestVerifyRejectsForgeriesAndOtherAlgorithmsWithoutFetchingKeys(t *testing.T) {
	srv := newJWKSServer(t)
	v, _, _ := newTestVerifier(t, srv.url())
	publicJWK, _ := json.Marshal(jwksDocument()["keys"].([]any)[0])
	hs256 := jwt.NewWithClaims(jwt.SigningMethodHS256, claims(testNow))
	hs256.Header["kid"] = kidA
	hs256Token, err := hs256.SignedString(publicJWK) // 公開鍵（JWKS で誰でも読める）を共有秘密にした偽造
	if err != nil {
		t.Fatal(err)
	}
	none := jwt.NewWithClaims(jwt.SigningMethodNone, claims(testNow))
	none.Header["kid"] = kidA
	noneToken, err := none.SignedString(jwt.UnsafeAllowNoneSignatureType)
	if err != nil {
		t.Fatal(err)
	}
	// 鍵を取りに行く前に断れるもの（alg が ES256 でない）。JWKS は、一度も取りに行かない。
	// ライブラリは、知っている別の方式（none・HS256・RS256・PS256・ES384）を「署名の方式が違う」、知らない・無い・文字列でない alg を「検証できない」と分ける。
	// どちらも 401 で、ログの理由だけが違う
	beforeKey := []struct {
		name, token, reason string
	}{
		{"alg=none", noneToken, reasonSignature},
		{"HS256（公開鍵を秘密にした偽造）", hs256Token, reasonSignature},
		{"RS256（正しく署名されていても）", signed(t, jwt.SigningMethodRS256, keyRSA, kidA, claims(testNow)), reasonSignature},
		{"PS256", signed(t, jwt.SigningMethodPS256, keyRSA, kidA, claims(testNow)), reasonSignature},
		{"ES384（正しく署名されていても）", signed(t, jwt.SigningMethodES384, keyP384, kidA, claims(testNow)), reasonSignature},
		{"alg が小文字の es256", retag(t, token(t, nil), `{"alg":"es256","kid":"`+kidA+`"}`), reasonInvalid},
		{"alg が知らない名前", retag(t, token(t, nil), `{"alg":"XX999","kid":"`+kidA+`"}`), reasonInvalid},
		{"alg が無い", retag(t, token(t, nil), `{"kid":"`+kidA+`"}`), reasonInvalid},
		{"alg が文字列でない", retag(t, token(t, nil), `{"alg":256,"kid":"`+kidA+`"}`), reasonInvalid},
	}
	for _, c := range beforeKey {
		t.Run(c.name, func(t *testing.T) {
			wantInvalid(t, verifyErr(v, c.token), c.reason)
		})
	}
	if n := srv.hits.Load(); n != 0 {
		t.Errorf("alg が ES256 でないトークンのために JWKS を %d 回取りに行った", n)
	}
	// 名前だけ ES256 にした HS256 は、鍵を取って、署名で断る（HMAC の 32 バイトは、ES256 の署名の長さ（64 バイト）ではない）
	renamed := retag(t, hs256Token, `{"alg":"ES256","kid":"`+kidA+`"}`)
	wantInvalid(t, verifyErr(v, renamed), reasonSignature)
}

func verifyErr(v *Verifier, tok string) error {
	_, err := v.Verify(tok)
	return err
}

// retag は、トークンのヘッダーだけを、与えた JSON に替える（署名はそのまま。署名が合わなくなってよい試験用）。
func retag(t *testing.T, tok, header string) string {
	t.Helper()
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		t.Fatalf("トークンの形が違う: %d 部", len(parts))
	}
	return b64([]byte(header)) + "." + parts[1] + "." + parts[2]
}

func TestVerifyRejectsABadSignature(t *testing.T) {
	srv := newJWKSServer(t)
	v, _, _ := newTestVerifier(t, srv.url())
	good := token(t, nil)
	parts := strings.Split(good, ".")
	forgedClaims := claims(testNow)
	forgedClaims["sub"] = "ba_admin_00000001"
	forgedJSON, _ := json.Marshal(forgedClaims)
	cases := map[string]string{
		"別の鍵で署名（kid は同じ）":          signed(t, jwt.SigningMethodES256, keyOther, kidA, claims(testNow)),
		"kid が plain の鍵なのに、別の鍵の署名": signed(t, jwt.SigningMethodES256, mustECKey(elliptic.P256()), kidPlain, claims(testNow)),
		"本文だけ書き換えた":                b64([]byte(`{"alg":"ES256","kid":"`+kidA+`","typ":"JWT"}`)) + "." + b64(forgedJSON) + "." + parts[2],
		"署名が短い":                    parts[0] + "." + parts[1] + "." + b64([]byte("short")),
		"署名が空":                     parts[0] + "." + parts[1] + ".",
	}
	for name, tok := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := v.Verify(tok)
			wantInvalid(t, err, reasonSignature)
		})
	}
}

func TestVerifyMalformedTokens(t *testing.T) {
	srv := newJWKSServer(t)
	v, _, _ := newTestVerifier(t, srv.url())
	good := token(t, nil)
	cases := map[string]string{
		"空":                 "",
		"abc":               "abc",
		"a.b.c":             "a.b.c",
		"点だけ":               "....",
		"点が 3 つ（4 部）":       good + ".x",
		"長すぎる":              strings.Repeat("a", 9000),
		"日本語":               "é.é.é",
		"Bearer を含む":        "Bearer " + good,
		"ヘッダーが JSON でない":    b64([]byte("not json")) + ".e30.AAAA",
		"ヘッダーが JSON の配列":    b64([]byte(`["ES256"]`)) + ".e30.AAAA",
		"本文が JSON でない":      strings.Split(good, ".")[0] + "." + b64([]byte("not json")) + "." + strings.Split(good, ".")[2],
		"本文が JSON の配列":      strings.Split(good, ".")[0] + "." + b64([]byte(`[1]`)) + "." + strings.Split(good, ".")[2],
		"署名が base64url でない": strings.Split(good, ".")[0] + "." + strings.Split(good, ".")[1] + ".!!!!",
		"ちょうど上限の長さで、中身がでたらめ": strings.Repeat("a", maxTokenBytes),
	}
	for name, tok := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := v.Verify(tok)
			if !errors.Is(err, ErrInvalidToken) || errors.Is(err, ErrUnavailable) {
				t.Errorf("err = %v", err)
			}
		})
	}
	if _, err := v.Verify(strings.Repeat("a", maxTokenBytes+1)); Reason(err) != reasonMalformed {
		t.Errorf("上限を超える長さの理由 = %q", Reason(err))
	}
}

// 長さの上限（8192 バイト）は、署名・claims を見る前の断り。ほかは全部正しいトークンで、長さだけを境にして確かめる。
func TestVerifyTokenLengthLimit(t *testing.T) {
	srv := newJWKSServer(t)
	v, _, _ := newTestVerifier(t, srv.url())
	padded := func(n int) string {
		return token(t, func(c jwt.MapClaims) { c["pad"] = strings.Repeat("a", n) })
	}
	// 上限を超える最小の pad の長さ（長さは pad に対して単調に増える）を、二分探索で探す
	lo, hi := 0, maxTokenBytes
	for lo < hi {
		if mid := (lo + hi) / 2; len(padded(mid)) > maxTokenBytes {
			hi = mid
		} else {
			lo = mid + 1
		}
	}
	n := lo
	within, over := padded(n-1), padded(n)
	if len(within) > maxTokenBytes || len(within) < maxTokenBytes-2 || len(over) <= maxTokenBytes {
		t.Fatalf("境界の長さを作れなかった: %d・%d", len(within), len(over))
	}
	if _, err := v.Verify(within); err != nil {
		t.Errorf("上限（%d）以内の正しいトークン（%d バイト）が断られた: %v", maxTokenBytes, len(within), err)
	}
	_, err := v.Verify(over)
	wantInvalid(t, err, reasonMalformed)
}

func TestVerifyTokenWithoutKidIsRejectedWithoutFetching(t *testing.T) {
	srv := newJWKSServer(t)
	v, _, _ := newTestVerifier(t, srv.url())
	_, err := v.Verify(signed(t, jwt.SigningMethodES256, keyA, "", claims(testNow)))
	wantInvalid(t, err, reasonKeyID)
	_, err = v.Verify(retag(t, token(t, nil), `{"alg":"ES256","kid":""}`))
	wantInvalid(t, err, reasonKeyID)
	_, err = v.Verify(retag(t, token(t, nil), `{"alg":"ES256","kid":7}`))
	wantInvalid(t, err, reasonKeyID)
	if n := srv.hits.Load(); n != 0 {
		t.Errorf("kid の無いトークンのために JWKS を %d 回取りに行った", n)
	}
}

func TestVerifyUnknownKidIsRejectedAndTheJWKSIsNotHammered(t *testing.T) {
	srv := newJWKSServer(t)
	v, clk, _ := newTestVerifier(t, srv.url())
	_, err := v.Verify(signed(t, jwt.SigningMethodES256, keyA, "nope-1", claims(testNow)))
	wantInvalid(t, err, reasonUnknownKey)
	if n := srv.hits.Load(); n != 1 {
		t.Fatalf("取得 = %d 回", n)
	}
	// でたらめな kid を続けても、最小間隔（60 秒）のあいだは、JWKS を取り直さない
	for i := 0; i < 5; i++ {
		clk.advance(5 * time.Second)
		_, err := v.Verify(signed(t, jwt.SigningMethodES256, keyA, "nope-"+string(rune('a'+i)), claims(clk.Now())))
		wantInvalid(t, err, reasonUnknownKey)
	}
	if n := srv.hits.Load(); n != 1 {
		t.Errorf("最小間隔の内に取り直した: %d 回", n)
	}
	// 間隔が過ぎれば、新しい鍵（ローテーション）を取りに行ける
	clk.advance(120 * time.Second)
	_, err = v.Verify(signed(t, jwt.SigningMethodES256, keyA, "nope-after", claims(clk.Now())))
	wantInvalid(t, err, reasonUnknownKey)
	if n := srv.hits.Load(); n != 2 {
		t.Errorf("間隔が過ぎたのに取り直さなかった: %d 回", n)
	}
}

func TestVerifyPicksUpAKeyRotationForAnUnknownKid(t *testing.T) {
	srv := newJWKSServer(t)
	v, clk, _ := newTestVerifier(t, srv.url())
	if _, err := v.Verify(token(t, nil)); err != nil {
		t.Fatal(err)
	}
	newKey := mustECKey(elliptic.P256())
	rotated := jwksDocument()
	rotated["keys"] = append(rotated["keys"].([]any), ecJWK(&newKey.PublicKey, map[string]any{"kid": "rotated-2"}))
	srv.setDocument(rotated) // web が鍵を回した
	rotatedToken := func() string { return signed(t, jwt.SigningMethodES256, newKey, "rotated-2", claims(clk.Now())) }
	_, err := v.Verify(rotatedToken())
	wantInvalid(t, err, reasonUnknownKey) // 最小間隔の内は、取り直さない
	clk.advance(minRefreshInterval + time.Second)
	if got, err := v.Verify(rotatedToken()); err != nil || got.Sub != testSub {
		t.Errorf("回した鍵が使えない: %+v, %v", got, err)
	}
	if _, err := v.Verify(signed(t, jwt.SigningMethodES256, keyA, kidA, claims(clk.Now()))); err != nil {
		t.Errorf("古い鍵も、JWKS に残っている間は使える: %v", err)
	}
}

func TestVerifyKeysAreCachedAndRefreshedAfterTheTTL(t *testing.T) {
	srv := newJWKSServer(t)
	v, clk, _ := newTestVerifier(t, srv.url())
	for i := 0; i < 3; i++ {
		if _, err := v.Verify(token(t, nil)); err != nil {
			t.Fatal(err)
		}
	}
	if n := srv.hits.Load(); n != 1 {
		t.Fatalf("取得 = %d 回（鍵は覚えているはず）", n)
	}
	clk.advance(keysTTL - time.Second)
	if _, err := v.Verify(signed(t, jwt.SigningMethodES256, keyA, kidA, claims(clk.Now()))); err != nil {
		t.Fatal(err)
	}
	if n := srv.hits.Load(); n != 1 {
		t.Errorf("期限（600 秒）の前に取り直した: %d 回", n)
	}
	clk.advance(2 * time.Second)
	if _, err := v.Verify(signed(t, jwt.SigningMethodES256, keyA, kidA, claims(clk.Now()))); err != nil {
		t.Fatal(err)
	}
	if n := srv.hits.Load(); n != 2 {
		t.Errorf("期限が過ぎたのに取り直さなかった: %d 回", n)
	}
}

// ---- JWKS が取れないとき ----

func TestVerifyKeepsUsingPreviousKeysWhenTheJWKSFails(t *testing.T) {
	srv := newJWKSServer(t)
	v, clk, logs := newTestVerifier(t, srv.url())
	if _, err := v.Verify(token(t, nil)); err != nil {
		t.Fatal(err)
	}
	srv.setStatus(500)
	clk.advance(keysTTL + time.Second)
	mk := func() string { return signed(t, jwt.SigningMethodES256, keyA, kidA, claims(clk.Now())) }
	if _, err := v.Verify(mk()); err != nil { // 取り直しに失敗しても、前の鍵で続ける
		t.Fatalf("前の鍵で続けられない: %v", err)
	}
	hits := srv.hits.Load()
	if _, err := v.Verify(mk()); err != nil { // 前の鍵があるあいだは、最小間隔（60 秒）に 1 回だけ取りに行く。間は、前の鍵で続く
		t.Fatal(err)
	}
	if n := srv.hits.Load(); n != hits {
		t.Errorf("最小間隔の内に、また取りに行った: %d → %d", hits, n)
	}
	if !strings.Contains(logs.text(), "JWKS を取得できませんでした (status)") {
		t.Errorf("ログ = %q", logs.text())
	}
	// 間隔が過ぎて、web が戻っていれば、取り直せる
	srv.setStatus(200)
	clk.advance(minRefreshInterval + time.Second)
	if _, err := v.Verify(mk()); err != nil {
		t.Fatal(err)
	}
	if n := srv.hits.Load(); n != hits+1 {
		t.Errorf("取得 = %d, 期待 %d", n, hits+1)
	}
}

func TestVerifyWithoutKeysAndTheJWKSDownIsUnavailable(t *testing.T) {
	for name, setup := range map[string]func(*jwksServer){
		"500":         func(s *jwksServer) { s.setStatus(500) },
		"404":         func(s *jwksServer) { s.setStatus(404) },
		"200 だが本文が空":  func(s *jwksServer) { s.setBody(nil) },
		"JSON でない":    func(s *jwksServer) { s.setBody([]byte("<html>not json</html>")) },
		"JSON の配列":    func(s *jwksServer) { s.setBody([]byte("[1, 2]")) },
		"JSON の null": func(s *jwksServer) { s.setBody([]byte("null")) },
		"keys が空":     func(s *jwksServer) { s.setBody([]byte(`{"keys":[]}`)) },
		"keys が配列でない": func(s *jwksServer) { s.setBody([]byte(`{"keys":"x"}`)) },
		"keys が無い":    func(s *jwksServer) { s.setBody([]byte(`{}`)) },
		"使える鍵が 1 つも無い": func(s *jwksServer) {
			s.setDocument(map[string]any{"keys": []any{ecJWK(&keyP384.PublicKey, map[string]any{"kid": "p384"})}})
		},
	} {
		t.Run(name, func(t *testing.T) {
			srv := newJWKSServer(t)
			setup(srv)
			v, _, _ := newTestVerifier(t, srv.url())
			_, err := v.Verify(token(t, nil))
			if !errors.Is(err, ErrUnavailable) || errors.Is(err, ErrInvalidToken) {
				t.Errorf("err = %v, 期待 ErrUnavailable", err)
			}
		})
	}
}

func TestVerifyConnectionRefusedIsUnavailableAndLogsNoAddress(t *testing.T) {
	srv := newJWKSServer(t)
	url := srv.url()
	srv.Close() // 接続を拒否される
	v, _, logs := newTestVerifier(t, url)
	_, err := v.Verify(token(t, nil))
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("err = %v", err)
	}
	for _, leaked := range []string{url, strings.TrimPrefix(srv.Server.URL, "http://"), "127.0.0.1", "refused", "dial", "jwks"} {
		if strings.Contains(logs.text(), leaked) || strings.Contains(err.Error(), leaked) {
			t.Errorf("ログ・エラーに %q が入っている: %q / %v", leaked, logs.text(), err)
		}
	}
	if !strings.Contains(logs.text(), "(network)") {
		t.Errorf("失敗の種類が無い: %q", logs.text())
	}
}

// web が落ちている間、要求のたびに取得を待たせない（API の処理を詰まらせない）。
func TestVerifyFailureIsNotRetriedOnEveryRequest(t *testing.T) {
	srv := newJWKSServer(t)
	srv.setStatus(503)
	v, clk, _ := newTestVerifier(t, srv.url())
	for i := 0; i < 4; i++ {
		if _, err := v.Verify(token(t, nil)); !errors.Is(err, ErrUnavailable) {
			t.Fatalf("err = %v", err)
		}
		clk.advance(time.Second)
	}
	if n := srv.hits.Load(); n != 1 {
		t.Fatalf("取得 = %d 回（失敗のあとの 5 秒は、取りに行かないはず）", n)
	}
	// 間隔（5 秒）が過ぎれば、もう一度試す。web が戻っていれば、そのまま使える
	clk.advance(failureBackoff)
	srv.setStatus(200)
	if _, err := v.Verify(signed(t, jwt.SigningMethodES256, keyA, kidA, claims(clk.Now()))); err != nil {
		t.Fatal(err)
	}
	if n := srv.hits.Load(); n != 2 {
		t.Errorf("取得 = %d 回", n)
	}
}

// 使える鍵が 1 つも無い JWKS は、取得の失敗として扱う（前の鍵は捨てない）。
func TestVerifyJWKSWithoutUsableKeysKeepsTheOldKeys(t *testing.T) {
	srv := newJWKSServer(t)
	srv.setBody([]byte(`{"keys":[]}`))
	v, clk, _ := newTestVerifier(t, srv.url())
	if _, err := v.Verify(token(t, nil)); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("err = %v", err)
	}
	srv.setDocument(jwksDocument())
	clk.advance(failureBackoff)
	mk := func() string { return signed(t, jwt.SigningMethodES256, keyA, kidA, claims(clk.Now())) }
	if _, err := v.Verify(mk()); err != nil {
		t.Fatal(err)
	}
	srv.setBody([]byte(`{"keys":[]}`))
	clk.advance(keysTTL + time.Second)
	if _, err := v.Verify(mk()); err != nil {
		t.Errorf("使える鍵が無い JWKS で、前の鍵を捨てた: %v", err)
	}
}

// 鍵を使う検証だけが 503。鍵が要らずに断れるもの（形・alg）は、JWKS が落ちていても 401（鍵の取得に失敗しない）。
func TestVerifyWhatCanBeRefusedWithoutAKeyIsStillInvalidWhenTheJWKSIsDown(t *testing.T) {
	srv := newJWKSServer(t)
	srv.setStatus(500)
	v, _, _ := newTestVerifier(t, srv.url())
	none := jwt.NewWithClaims(jwt.SigningMethodNone, claims(testNow))
	none.Header["kid"] = kidA
	noneToken, _ := none.SignedString(jwt.UnsafeAllowNoneSignatureType)
	for name, tok := range map[string]string{
		"空": "", "形が違う": "not-a-jwt", "alg=none": noneToken,
		"kid が無い": signed(t, jwt.SigningMethodES256, keyA, "", claims(testNow)),
	} {
		if _, err := v.Verify(tok); !errors.Is(err, ErrInvalidToken) {
			t.Errorf("%s: err = %v, 期待 ErrInvalidToken", name, err)
		}
	}
	if n := srv.hits.Load(); n != 0 {
		t.Errorf("鍵の要らない断りのために、JWKS を %d 回取りに行った", n)
	}
	if _, err := v.Verify(token(t, nil)); !errors.Is(err, ErrUnavailable) {
		t.Errorf("鍵が要るものは 503 のはず: %v", err)
	}
}

// 同時に来た要求は、JWKS への問い合わせを 1 回に束ねる（-race で、鍵の置き場の排他も確かめる）。
func TestVerifyConcurrentRequestsFetchTheJWKSOnce(t *testing.T) {
	srv := newJWKSServer(t)
	srv.setDelay(100 * time.Millisecond) // 取得の最中に、ほかの要求が来るように
	v, _, _ := newTestVerifier(t, srv.url())
	tok := token(t, nil)
	var wg sync.WaitGroup
	errs := make(chan error, 32)
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := v.Verify(tok)
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Errorf("err = %v", err)
		}
	}
	if n := srv.hits.Load(); n != 1 {
		t.Errorf("取得 = %d 回", n)
	}
}

func TestNewVerifierRefusesAnEmptyIssuerJWKSURLOrAudience(t *testing.T) {
	full := config.Auth{Issuer: testIssuer, JWKSURL: "http://web:3000/api/auth/jwks", Audience: testAudience}
	if _, err := NewVerifier(full, nil); err != nil {
		t.Fatalf("正しい設定が断られた: %v", err)
	}
	for name, mutate := range map[string]func(*config.Auth){
		"Issuer":   func(a *config.Auth) { a.Issuer = "" },
		"JWKSURL":  func(a *config.Auth) { a.JWKSURL = "" },
		"Audience": func(a *config.Auth) { a.Audience = "" },
	} {
		cfg := full
		mutate(&cfg)
		if v, err := NewVerifier(cfg, nil); err == nil || v != nil {
			t.Errorf("%s が空なのに作れた", name)
		}
	}
}

func TestReasonOfOtherErrorsIsUnknown(t *testing.T) {
	if got := Reason(errors.New("x")); got != "unknown" {
		t.Errorf("Reason = %q", got)
	}
	if got := Reason(nil); got != "unknown" {
		t.Errorf("Reason(nil) = %q", got)
	}
}

// 秘密を共有する形の偽造（HS256）が、鍵を使わずに断られることの別の確かめ: 検証に使う鍵の型は *ecdsa.PublicKey だけ。
func TestKeyForReturnsOnlyECDSAPublicKeys(t *testing.T) {
	srv := newJWKSServer(t)
	v, _, _ := newTestVerifier(t, srv.url())
	tok := &jwt.Token{Header: map[string]any{"kid": kidA}}
	k, err := v.keyFor(tok)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := k.(*ecdsa.PublicKey); !ok {
		t.Errorf("鍵の型 = %T", k)
	}
}

// 署名は、64 バイトの R||S 形式（JOSE）だけ。DER 形式の署名（ASN.1）は受け付けない。
func TestVerifyRejectsADERSignature(t *testing.T) {
	srv := newJWKSServer(t)
	v, _, _ := newTestVerifier(t, srv.url())
	good := token(t, nil)
	parts := strings.Split(good, ".")
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	der, err := ecdsa.SignASN1(rand.Reader, keyA, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	_, err = v.Verify(parts[0] + "." + parts[1] + "." + b64(der))
	wantInvalid(t, err, reasonSignature)
}
