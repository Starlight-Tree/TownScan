package auth

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	// JWKS の取得: 1 回の待ち時間の上限（接続・応答・本文の読み込みの全部で）と、読む本文の上限
	fetchTimeout = 3 * time.Second
	maxJWKSBytes = 1_000_000
	// 取得した鍵を使い続ける時間。過ぎたら取り直す（取り直しに失敗したときは、前の鍵を使い続ける）
	keysTTL = 600 * time.Second
	// 鍵があるときの取り直しの最小間隔（未知の kid を理由にした取り直しも、この間隔まで）。でたらめな kid のトークンで、JWKS への問い合わせを増幅させないため
	minRefreshInterval = 60 * time.Second
	// 鍵が 1 つも無いまま取得に失敗したあと、次に取りに行くまでの間隔（その間の要求は、待たせずに 503）
	failureBackoff = 5 * time.Second

	jwksUserAgent = "townscan-api/1.0"
	// P-256 の座標（x・y）の長さ（バイト）
	p256CoordinateBytes = 32
)

// fetchError は、JWKS を取れなかった理由。kind は固定の語（timeout・network・redirect・status・too_large・not_json・not_object・no_usable_keys）で、
// ログに出すのはこれだけ。URL・本文・ネットワークのエラーの文（接続先のアドレスが入る）は持たない。
type fetchError struct{ kind string }

func (e *fetchError) Error() string { return "auth: JWKS を取得できません (" + e.kind + ")" }

// fetchKind は、取得の失敗のエラーから、ログ用の語を取り出す。
func fetchKind(err error) string {
	var fe *fetchError
	if errors.As(err, &fe) {
		return fe.kind
	}
	return "unknown"
}

// keyCache は、JWKS の公開鍵の置き場。期限が来たら取り直し、未知の kid は間隔を空けて取り直す（backend/app/jwt_auth.py の JwksCache と同じ状態の動き）。
//
// 取得のあいだも、mu を持ったままにする（Python と同じ）。同時に来た要求は、取得が終わるのを待って、取れた鍵（取れなければ、失敗の間隔の判断）を使うので、
// JWKS への問い合わせは 1 回に束ねられる。待たせる長さは、取得の上限（3 秒）まで。
type keyCache struct {
	url    string
	client *http.Client
	now    func() time.Time
	logf   func(format string, args ...any)

	// 試験が縮められるように、定数を持つ
	ttl, minRefresh, backoff time.Duration

	mu          sync.Mutex
	keys        map[string]*ecdsa.PublicKey
	fetchedAt   time.Time // 最後に取得に成功した時刻（ゼロ = まだ）
	attemptedAt time.Time // 最後に取得を試みた時刻（成功・失敗とも。ゼロ = まだ）
}

func newKeyCache(url string, now func() time.Time, logf func(format string, args ...any)) *keyCache {
	if logf == nil {
		logf = func(string, ...any) {}
	}
	return &keyCache{
		url: url,
		client: &http.Client{
			Timeout: fetchTimeout,
			// 転送先へは行かない。JWKS の URL は設定した 1 つだけ（転送で別の場所へ連れて行かれない）。転送の応答は、状態が 200 でないので失敗になる
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
			Transport: &http.Transport{
				Proxy:             nil,  // 環境の HTTP_PROXY を使わない。web は、同じネットワークの中へ直接つなぐ
				DisableKeepAlives: true, // 10 分に 1 回ほどの取得のために、つなぎっぱなしにしない
			},
		},
		now:        now,
		logf:       logf,
		ttl:        keysTTL,
		minRefresh: minRefreshInterval,
		backoff:    failureBackoff,
	}
}

// get は、kid の鍵。無ければ nil（受け付けない）。鍵が 1 つも無く、取得もできないときは ErrUnavailable。
func (c *keyCache) get(kid string) (*ecdsa.PublicKey, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	now := c.now()
	fresh := !c.fetchedAt.IsZero() && now.Sub(c.fetchedAt) < c.ttl
	if fresh {
		if key, ok := c.keys[kid]; ok {
			return key, nil
		}
	}
	interval := c.backoff
	if len(c.keys) > 0 {
		interval = c.minRefresh
	}
	if !c.attemptedAt.IsZero() && now.Sub(c.attemptedAt) < interval {
		if len(c.keys) == 0 {
			return nil, ErrUnavailable
		}
		return c.keys[kid], nil
	}

	c.attemptedAt = c.now()
	keys, err := c.fetch()
	if err != nil {
		c.logf("JWKS を取得できませんでした (%s)", fetchKind(err)) // URL・本文・エラーの文は出さない
		if len(c.keys) == 0 {
			return nil, ErrUnavailable
		}
		return c.keys[kid], nil // 前の鍵で続ける
	}
	c.keys, c.fetchedAt = keys, c.now()
	return c.keys[kid], nil
}

// fetch は、JWKS を取得して、使ってよい鍵を kid で引ける形にする。使える鍵が 1 つも無い JWKS は、取得の失敗として扱う。
func (c *keyCache) fetch() (map[string]*ecdsa.PublicKey, error) {
	req, err := http.NewRequest(http.MethodGet, c.url, nil)
	if err != nil {
		return nil, &fetchError{"network"}
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", jwksUserAgent)
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, &fetchError{networkKind(err)} // err の文は、接続先の URL・アドレスを含むので捨てる
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode >= 300 && resp.StatusCode < 400:
		return nil, &fetchError{"redirect"}
	case resp.StatusCode != http.StatusOK:
		return nil, &fetchError{"status"}
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxJWKSBytes+1))
	if err != nil {
		return nil, &fetchError{networkKind(err)}
	}
	if len(body) > maxJWKSBytes {
		return nil, &fetchError{"too_large"}
	}
	return parseJWKS(body)
}

// networkKind は、通信のエラーを timeout か network にする。
func networkKind(err error) string {
	var ne net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &ne) && ne.Timeout()) {
		return "timeout"
	}
	return "network"
}

// parseJWKS は、JWKS（JSON のオブジェクトで、keys が配列）から、使ってよい鍵だけを kid で引ける形にする。
// JSON のオブジェクトでなければ、使える鍵が 1 つも無ければ、エラー。
func parseJWKS(body []byte) (map[string]*ecdsa.PublicKey, error) {
	var doc any
	if err := json.Unmarshal(body, &doc); err != nil {
		return nil, &fetchError{"not_json"}
	}
	obj, ok := doc.(map[string]any)
	if !ok {
		return nil, &fetchError{"not_object"}
	}
	items, _ := obj["keys"].([]any)
	keys := map[string]*ecdsa.PublicKey{}
	for _, raw := range items {
		item, ok := raw.(map[string]any)
		if !ok {
			continue // 壊れた 1 件で、ほかの鍵まで使えなくしない（その 1 件だけ捨てる）
		}
		if kid, key, ok := parseKey(item); ok {
			keys[kid] = key
		}
	}
	if len(keys) == 0 {
		return nil, &fetchError{"no_usable_keys"}
	}
	return keys, nil
}

// parseKey は、JWK 1 件から、使ってよい鍵（EC の P-256 で、kid があり、署名用で、alg があれば ES256 のもの）を取り出す。
// Better Auth の実際の JWKS は、alg・use を持たない（kty・crv・x・y・kid だけ）。持つ場合は、ES256・sig だけを受け付ける。
// 点が曲線の上に無い（壊れた x・y）鍵も捨てる。
func parseKey(item map[string]any) (kid string, key *ecdsa.PublicKey, ok bool) {
	if kty, _ := item["kty"].(string); kty != "EC" {
		return "", nil, false
	}
	if crv, _ := item["crv"].(string); crv != "P-256" {
		return "", nil, false
	}
	kid, _ = item["kid"].(string)
	if kid == "" {
		return "", nil, false
	}
	if use, has := item["use"]; has && use != "sig" {
		return "", nil, false
	}
	if alg, has := item["alg"]; has && alg != allowedAlgorithm {
		return "", nil, false
	}
	x, okX := coordinate(item["x"])
	y, okY := coordinate(item["y"])
	if !okX || !okY {
		return "", nil, false
	}
	point := make([]byte, 0, 1+2*p256CoordinateBytes)
	point = append(point, 0x04) // 圧縮しない点（SEC 1）
	point = append(point, x...)
	point = append(point, y...)
	key, err := ecdsa.ParseUncompressedPublicKey(elliptic.P256(), point) // 曲線の上の点かも確かめる
	if err != nil {
		return "", nil, false
	}
	return kid, key, true
}

// coordinate は、JWK の x・y（base64url。末尾の = は付いていても外す）を、32 バイトにそろえる。
// 先頭の 0 を省いた短いものは、0 で埋める（Python の鍵の読み取りが、整数として読むのと同じ）。32 バイトより長い・空・文字列でないものは false。
func coordinate(v any) ([]byte, bool) {
	s, ok := v.(string)
	if !ok {
		return nil, false
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(s, "="))
	if err != nil || len(raw) == 0 || len(raw) > p256CoordinateBytes {
		return nil, false
	}
	out := make([]byte, p256CoordinateBytes)
	copy(out[p256CoordinateBytes-len(raw):], raw)
	return out, true
}
