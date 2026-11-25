package auth

import (
	"bytes"
	"compress/gzip"
	"crypto/ecdsa"
	"crypto/elliptic"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// absent は、鍵の項目を「無い」にする目印（nil は、JSON の null になる）
type absent struct{}

func TestParseJWKSKeepsOnlyUsableKeys(t *testing.T) {
	good := ecJWK(&keyA.PublicKey, map[string]any{"kid": kidA, "alg": "ES256", "use": "sig"})
	with := func(extra map[string]any) map[string]any {
		m := map[string]any{}
		for k, v := range good {
			m[k] = v
		}
		for k, v := range extra {
			if _, gone := v.(absent); gone {
				delete(m, k)
				continue
			}
			m[k] = v // nil は JSON の null になる
		}
		return m
	}
	doc := map[string]any{"keys": []any{
		good,
		with(map[string]any{"kid": ""}),                          // kid が空
		with(map[string]any{"kid": absent{}}),                    // kid なし
		with(map[string]any{"kid": nil}),                         // kid が null
		with(map[string]any{"kid": 7}),                           // kid が文字列でない
		with(map[string]any{"kid": "enc", "use": "enc"}),         // 署名用ではない
		with(map[string]any{"kid": "use-null", "use": nil}),      // use が null（持っていて署名用でない）
		with(map[string]any{"kid": "alg-es384", "alg": "ES384"}), // alg が ES256 でない
		with(map[string]any{"kid": "alg-rs256", "alg": "RS256"}), // alg が ES256 でない
		with(map[string]any{"kid": "garbled", "x": 12345}),       // 壊れた鍵（捨てるだけで、ほかの鍵は使える）
		with(map[string]any{"kid": "garbled2", "x": "!!!"}),      // base64url でない
		with(map[string]any{"kid": "no-y", "y": absent{}}),       // y が無い
		with(map[string]any{"kid": "no-crv", "crv": absent{}}),   // crv が無い
		with(map[string]any{"kid": "crv-384", "crv": "P-384"}),   // 曲線が P-256 でない
		ecJWK(&keyP384.PublicKey, map[string]any{"kid": "p384"}), // ES384 の鍵は使わない
		map[string]any{"kty": "RSA", "kid": "rsa", "n": "AQAB", "e": "AQAB"},
		map[string]any{"kty": "oct", "kid": "sym", "k": "c2VjcmV0"}, // 共有秘密の鍵は使わない
		map[string]any{"kty": "OKP", "crv": "Ed25519", "kid": "ed", "x": b64(edPublic)},
		"not-a-dict",
		nil,
		42,
	}}
	b, _ := json.Marshal(doc)
	keys, err := parseJWKS(b)
	if err != nil {
		t.Fatal(err)
	}
	if len(keys) != 1 || keys[kidA] == nil || !keys[kidA].Equal(&keyA.PublicKey) {
		t.Errorf("使える鍵 = %d 個: %v", len(keys), keys)
	}
}

func TestParseJWKSErrors(t *testing.T) {
	cases := []struct {
		name, body, kind string
	}{
		{"空", ``, "not_json"},
		{"JSON でない", `<html>not json</html>`, "not_json"},
		{"切れた JSON", `{"keys": [`, "not_json"},
		{"配列", `[1, 2]`, "not_object"},
		{"文字列", `"keys"`, "not_object"},
		{"null", `null`, "not_object"},
		{"数", `1`, "not_object"},
		{"keys が無い", `{}`, "no_usable_keys"},
		{"keys が配列でない", `{"keys": "x"}`, "no_usable_keys"},
		{"keys が空", `{"keys": []}`, "no_usable_keys"},
		{"keys が null", `{"keys": null}`, "no_usable_keys"},
		{"keys が全部使えない", `{"keys": [{"kty":"oct","kid":"a","k":"AA"}, 1]}`, "no_usable_keys"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			keys, err := parseJWKS([]byte(c.body))
			if err == nil || keys != nil || fetchKind(err) != c.kind {
				t.Errorf("keys=%v err=%v kind=%s, 期待 kind=%s", keys, err, fetchKind(err), c.kind)
			}
		})
	}
}

func TestParseJWKSLaterEntryWithTheSameKidWins(t *testing.T) {
	doc := map[string]any{"keys": []any{
		ecJWK(&keyA.PublicKey, map[string]any{"kid": "same"}),
		ecJWK(&keyPlain.PublicKey, map[string]any{"kid": "same"}),
	}}
	b, _ := json.Marshal(doc)
	keys, err := parseJWKS(b)
	if err != nil || len(keys) != 1 || !keys["same"].Equal(&keyPlain.PublicKey) {
		t.Errorf("keys=%v err=%v", keys, err)
	}
}

// findKey は、条件に合う P-256 の鍵が出るまで作る（先頭が 0 の座標は、約 1/256）。
func findKey(t *testing.T, ok func(*ecdsa.PrivateKey) bool) *ecdsa.PrivateKey {
	t.Helper()
	for i := 0; i < 20000; i++ {
		if k := mustECKey(elliptic.P256()); ok(k) {
			return k
		}
	}
	t.Fatal("条件に合う鍵を作れなかった")
	return nil
}

func TestParseKeyCoordinates(t *testing.T) {
	// 先頭が 0 の座標は、省いて書く送り手がいる。短いものは 0 で埋めて、同じ鍵になる（Python の鍵の読み取りは、整数として読む）
	shortX := findKey(t, func(k *ecdsa.PrivateKey) bool { return k.X.BitLen() <= 248 })
	shortY := findKey(t, func(k *ecdsa.PrivateKey) bool { return k.Y.BitLen() <= 248 })
	for name, k := range map[string]*ecdsa.PrivateKey{"x": shortX, "y": shortY} {
		jwk := map[string]any{"kty": "EC", "crv": "P-256", "kid": "short", "x": b64(k.X.Bytes()), "y": b64(k.Y.Bytes())} // Bytes() は先頭の 0 を省く
		_, key, ok := parseKey(jwk)
		if !ok || !key.Equal(&k.PublicKey) {
			t.Errorf("先頭の 0 を省いた %s を読めない: ok=%v", name, ok)
		}
	}

	full := ecJWK(&keyA.PublicKey, map[string]any{"kid": "k"})
	mut := func(over map[string]any) map[string]any {
		m := map[string]any{}
		for k, v := range full {
			m[k] = v
		}
		for k, v := range over {
			m[k] = v
		}
		return m
	}
	cases := []struct {
		name string
		jwk  map[string]any
		ok   bool
	}{
		{"そのまま", full, true},
		{"= の埋めが付いた座標", mut(map[string]any{"x": full["x"].(string) + "=", "y": full["y"].(string) + "=="}), true},
		{"x が 33 バイト", mut(map[string]any{"x": b64(append([]byte{0}, keyA.X.FillBytes(make([]byte, 32))...))}), false},
		{"x が空", mut(map[string]any{"x": ""}), false},
		{"y が空", mut(map[string]any{"y": ""}), false},
		{"標準の base64（+ /）は読まない", mut(map[string]any{"x": "+/+/+/+/+/+/+/+/+/+/+/+/+/+/+/+/+/+/+/+/+/8"}), false},
		{"曲線の上に無い点", mut(map[string]any{"y": b64(make([]byte, 32))}), false},
		{"x と y が入れ替わった点", mut(map[string]any{"x": full["y"], "y": full["x"]}), false},
		{"無限遠点（0, 0）", mut(map[string]any{"x": b64(make([]byte, 32)), "y": b64(make([]byte, 32))}), false},
		{"use が sig", mut(map[string]any{"use": "sig"}), true},
		{"use が大文字", mut(map[string]any{"use": "SIG"}), false},
		{"alg が ES256", mut(map[string]any{"alg": "ES256"}), true},
		{"alg が es256（小文字）", mut(map[string]any{"alg": "es256"}), false},
		{"d（秘密鍵）が付いていても、公開鍵の部分だけを使う", mut(map[string]any{"d": "AAAA"}), true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			kid, key, ok := parseKey(c.jwk)
			if ok != c.ok || (ok && (kid != "k" || key == nil)) {
				t.Errorf("ok = %v, 期待 %v", ok, c.ok)
			}
		})
	}
}

// ---- 本物の HTTP での取得 ----

func TestFetchSendsAcceptAndUserAgent(t *testing.T) {
	srv := newJWKSServer(t)
	v, _, _ := newTestVerifier(t, srv.url())
	if _, err := v.Verify(token(t, nil)); err != nil {
		t.Fatal(err)
	}
	h := srv.lastHeaders()
	if h.Get("Accept") != "application/json" || h.Get("User-Agent") != "townscan-api/1.0" {
		t.Errorf("ヘッダー = %v", h)
	}
	if h.Get("Authorization") != "" || h.Get("Cookie") != "" {
		t.Errorf("認証情報を JWKS の取得に付けている: %v", h)
	}
}

// 本文の上限は 1,000,000 バイト。ちょうどは読み、1 バイト超えたら失敗。
func TestFetchBodyLimit(t *testing.T) {
	doc := func(size int) []byte {
		base := map[string]any{"keys": []any{ecJWK(&keyA.PublicKey, map[string]any{"kid": kidA})}, "pad": ""}
		b, _ := json.Marshal(base)
		padding := size - len(b)
		base["pad"] = strings.Repeat("a", padding)
		b, _ = json.Marshal(base)
		if len(b) != size {
			t.Fatalf("本文の大きさ = %d, 期待 %d", len(b), size)
		}
		return b
	}
	srv := newJWKSServer(t)
	v, _, _ := newTestVerifier(t, srv.url())

	srv.setBody(doc(maxJWKSBytes))
	if _, err := v.Verify(token(t, nil)); err != nil {
		t.Errorf("上限ちょうどの JWKS を読めない: %v", err)
	}

	srv2 := newJWKSServer(t)
	srv2.setBody(doc(maxJWKSBytes + 1))
	v2, _, logs := newTestVerifier(t, srv2.url())
	if _, err := v2.Verify(token(t, nil)); !errors.Is(err, ErrUnavailable) {
		t.Errorf("上限を 1 バイト超えた JWKS を読んでしまった: %v", err)
	}
	if !strings.Contains(logs.text(), "(too_large)") {
		t.Errorf("ログ = %q", logs.text())
	}
}

// 終わらない本文は、上限（1,000,000 バイト）の少し先で読むのをやめる（メモリーを使い切らせない）。
func TestFetchStopsReadingAnEndlessBody(t *testing.T) {
	var written atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		chunk := bytes.Repeat([]byte("a"), 64<<10)
		_, _ = w.Write([]byte(`{"keys":[],"pad":"`))
		for written.Load() < 200<<20 { // 読むのをやめない相手への安全弁（200 MB）
			n, err := w.Write(chunk)
			written.Add(int64(n))
			if err != nil {
				return // 取り手が切った
			}
		}
	}))
	v, _, logs := newTestVerifier(t, srv.URL)
	if _, err := v.Verify(token(t, nil)); !errors.Is(err, ErrUnavailable) {
		t.Errorf("err = %v", err)
	}
	srv.Close() // 取り手が切ったあと、送り手の処理が終わるのを待つ
	// 取り手が読んだのは上限まで。送り手が書けたのは、それに、つなぎのバッファー（送信・受信）を足した分まで
	if n := written.Load(); n > 32<<20 {
		t.Errorf("上限を超えて %d バイトも送らせた", n)
	}
	if !strings.Contains(logs.text(), "(too_large)") {
		t.Errorf("ログ = %q", logs.text())
	}
}

// 圧縮された応答も、展開したあとの大きさで上限を判断する（小さく圧縮された巨大な本文で、メモリーを使い切らせない）。
func TestFetchLimitAppliesToTheDecompressedBody(t *testing.T) {
	var gz bytes.Buffer
	w := gzip.NewWriter(&gz)
	_, _ = w.Write([]byte(`{"keys":[],"pad":"`))
	_, _ = w.Write(bytes.Repeat([]byte("a"), 5*maxJWKSBytes))
	_, _ = w.Write([]byte(`"}`))
	_ = w.Close()
	if gz.Len() > maxJWKSBytes {
		t.Fatalf("圧縮後が大きすぎる: %d", gz.Len())
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Encoding", "gzip")
		_, _ = w.Write(gz.Bytes())
	}))
	defer srv.Close()
	v, _, logs := newTestVerifier(t, srv.URL)
	if _, err := v.Verify(token(t, nil)); !errors.Is(err, ErrUnavailable) {
		t.Errorf("err = %v", err)
	}
	if !strings.Contains(logs.text(), "(too_large)") {
		t.Errorf("ログ = %q", logs.text())
	}
}

// 転送先へは行かない（JWKS の URL は、設定した 1 つだけ）。転送の応答は失敗として扱う。
func TestFetchDoesNotFollowRedirects(t *testing.T) {
	var targetHits atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		targetHits.Add(1)
		_ = json.NewEncoder(w).Encode(jwksDocument())
	}))
	defer target.Close()
	for _, code := range []int{http.StatusMovedPermanently, http.StatusFound, http.StatusTemporaryRedirect, http.StatusPermanentRedirect} {
		redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, target.URL, code)
		}))
		v, _, logs := newTestVerifier(t, redirector.URL)
		if _, err := v.Verify(token(t, nil)); !errors.Is(err, ErrUnavailable) {
			t.Errorf("%d: err = %v", code, err)
		}
		if !strings.Contains(logs.text(), "(redirect)") {
			t.Errorf("%d: ログ = %q", code, logs.text())
		}
		redirector.Close()
	}
	if n := targetHits.Load(); n != 0 {
		t.Errorf("転送先へ %d 回つないだ", n)
	}
}

func TestFetchTimesOutWithoutWaitingForASlowServer(t *testing.T) {
	srv := newJWKSServer(t)
	srv.setDelay(2 * time.Second)
	v, _, logs := newTestVerifier(t, srv.url())
	v.keys.client.Timeout = 300 * time.Millisecond
	started := time.Now()
	_, err := v.Verify(token(t, nil))
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("err = %v", err)
	}
	if elapsed := time.Since(started); elapsed > 1500*time.Millisecond {
		t.Errorf("遅いサーバーを待ちすぎた: %v", elapsed)
	}
	if !strings.Contains(logs.text(), "(timeout)") {
		t.Errorf("ログ = %q", logs.text())
	}
}

// 本文を読んでいる途中で止まるサーバー（ヘッダーは来る）も、期限で打ち切る。
func TestFetchTimesOutWhileReadingTheBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "100000")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"keys":`))
		w.(http.Flusher).Flush()
		select {
		case <-time.After(3 * time.Second):
		case <-r.Context().Done():
		}
	}))
	defer srv.Close()
	v, _, logs := newTestVerifier(t, srv.URL)
	v.keys.client.Timeout = 300 * time.Millisecond
	started := time.Now()
	if _, err := v.Verify(token(t, nil)); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("err = %v", err)
	}
	if elapsed := time.Since(started); elapsed > 1500*time.Millisecond {
		t.Errorf("止まった本文を待ちすぎた: %v", elapsed)
	}
	if !strings.Contains(logs.text(), "(timeout)") {
		t.Errorf("ログ = %q", logs.text())
	}
}

// 失敗のログに、URL・本文・エラーの文（接続先のアドレス）を出さない。
func TestFetchFailureLogsOnlyTheKind(t *testing.T) {
	srv := newJWKSServer(t)
	srv.setStatus(500)
	srv.setBody([]byte("secret-body-marker"))
	v, _, logs := newTestVerifier(t, srv.url())
	tok := token(t, nil)
	if _, err := v.Verify(tok); !errors.Is(err, ErrUnavailable) {
		t.Fatal(err)
	}
	text := logs.text()
	for _, leaked := range []string{srv.Server.URL, "127.0.0.1", "secret-body-marker", tok, "jwks", jwksPath} {
		if strings.Contains(text, leaked) {
			t.Errorf("ログに %q が入っている: %q", leaked, text)
		}
	}
	if text != "JWKS を取得できませんでした (status)" {
		t.Errorf("ログ = %q", text)
	}
}

// 環境の HTTP_PROXY を使わない（JWKS は、同じネットワークの中の web へ直接つなぐ）。
func TestFetchTransportDoesNotUseTheProxyEnvironment(t *testing.T) {
	c := newKeyCache("http://web:3000"+jwksPath, time.Now, nil)
	tr, ok := c.client.Transport.(*http.Transport)
	if !ok || tr.Proxy != nil {
		t.Errorf("Transport = %#v", c.client.Transport)
	}
	if c.client.Timeout != fetchTimeout || c.client.CheckRedirect == nil {
		t.Error("取得の期限・転送の扱いが設定されていない")
	}
}

func TestKeyCacheWithoutLoggerDoesNotPanic(t *testing.T) {
	srv := newJWKSServer(t)
	srv.setStatus(500)
	c := newKeyCache(srv.url(), time.Now, nil)
	if _, err := c.get("x"); !errors.Is(err, ErrUnavailable) {
		t.Errorf("err = %v", err)
	}
}

// 鍵を覚えたあと、未知の kid には nil（受け付けない）を返し、取得の失敗にはしない。
func TestKeyCacheUnknownKidIsNilNotAnError(t *testing.T) {
	srv := newJWKSServer(t)
	c := newKeyCache(srv.url(), time.Now, nil)
	if k, err := c.get(kidA); err != nil || k == nil {
		t.Fatalf("known: %v %v", k, err)
	}
	if k, err := c.get("unknown"); err != nil || k != nil {
		t.Errorf("unknown: %v %v", k, err)
	}
}

func TestFetchErrorKindOfOtherErrorsIsUnknown(t *testing.T) {
	if got := fetchKind(errors.New("x")); got != "unknown" {
		t.Errorf("fetchKind = %q", got)
	}
	if got := networkKind(errors.New("dial tcp 10.0.0.5:3000: connection refused")); got != "network" {
		t.Errorf("networkKind = %q", got)
	}
}
