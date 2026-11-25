// Package auth は、ログイン中の人の確認（画面のサーバー（Next.js）の中の Better Auth が発行した JWT の検証）。
// 規則は backend/app/jwt_auth.py と同じ（仕様 docs/spec-prototype.md §2.1・§4.4）。
//
// ログイン（Google との通信・セッション・JWT の発行）は Better Auth（web 側）の仕事で、この API は扱わない。web のサーバーが、ログイン中の人の
// JWT（ES256・15 分）を `Authorization: Bearer <JWT>` で送ってくるので、ここで確かめる。
//
//   - 署名の検証は、web が配る JWKS（AUTH_JWKS_URL）の公開鍵だけで行う。alg は ES256 に固定する。alg=none・HS256（公開鍵を共有秘密にする攻撃）・
//     RS256 などは、鍵を取りに行く前に断る。発行元（iss）は AUTH_ISSUER、対象（aud）は AUTH_AUDIENCE（既定 townscan。配列でもよい）に完全一致。
//     exp・iss・aud・sub は必須。時計のずれは 10 秒まで許す。
//   - 利用者の ID は、検証に通ったトークンの sub だけから取る。クライアントが送った別の値は使わない。
//   - トークンの中身・Authorization ヘッダー・JWKS の URL・取得時のエラーの文は、ログにも応答にも出さない。残すのは、失敗の種類（固定の語）だけ。
//   - 鍵を取れないときは、前に取れた鍵で続ける。前の鍵が無ければ、検証できない（ErrUnavailable。呼び出し側は 503）。共有秘密の検証には切り替えない。
//     取得に失敗したあとは、しばらく取りに行かない（web が落ちている間に、要求のたびに待たされて、API が詰まらないように）。
package auth

import (
	"errors"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"townscan/api/internal/config"
)

const (
	// 署名に使ってよいアルゴリズムは ES256（EC の P-256）だけ
	allowedAlgorithm = "ES256"
	// 端末・サーバーの時計のずれを許す長さ（exp・nbf・iat）
	leeway = 10 * time.Second
	// 受け取るトークンの長さの上限（これを超えたら、署名を見る前に断る）
	maxTokenBytes = 8192
)

// 失敗の理由（ログ用。クライアントへは返さない）。どれも固定の語で、トークン・ライブラリのエラーの文は入れない。
const (
	reasonMalformed    = "malformed"
	reasonKeyID        = "kid"
	reasonUnknownKey   = "unknown_key"
	reasonSignature    = "signature" // 署名が合わない・alg が ES256 でない（ライブラリは、この 2 つを分けない）
	reasonExpired      = "expired"
	reasonNotYetValid  = "not_yet_valid"
	reasonIssuer       = "issuer"
	reasonAudience     = "audience"
	reasonMissingClaim = "missing_claim"
	reasonSubject      = "sub"
	reasonInvalid      = "invalid"
)

var (
	// ErrInvalidToken は、トークンを受け付けないとき（無い・壊れている・署名が合わない・期限切れなど）。呼び出し側は 401。理由は Reason で読む。
	ErrInvalidToken = errors.New("auth: トークンを受け付けません")
	// ErrUnavailable は、鍵を取得できず（前に取れた鍵も無く）、検証できないとき。呼び出し側は 503。
	ErrUnavailable = errors.New("auth: 鍵を取得できず、検証できません")

	errNoKeyID    = errors.New("auth: kid がありません")
	errUnknownKey = errors.New("auth: 知らない kid です")
)

// invalidToken は、理由つきの ErrInvalidToken。
type invalidToken struct{ reason string }

func (e *invalidToken) Error() string {
	return "auth: トークンを受け付けません (" + e.reason + ")"
}

func (e *invalidToken) Is(target error) bool { return target == ErrInvalidToken }

func invalid(reason string) error { return &invalidToken{reason: reason} }

// Reason は、Verify が返したエラーの失敗の種類（ログ用の固定の語）。ErrInvalidToken でなければ "unknown"。
func Reason(err error) string {
	var e *invalidToken
	if errors.As(err, &e) {
		return e.reason
	}
	return "unknown"
}

// Verifier は、設定（発行元・JWKS の URL・対象）に対するトークンの検証。JWKS の鍵の置き場を持つ（API に 1 つ。並行に使える）。
type Verifier struct {
	keys   *keyCache
	parser *jwt.Parser
	// 時計（試験が差し替える。鍵の置き場とトークンの期限の両方が、これを使う）
	now func() time.Time
}

// NewVerifier は、検証を作る。logf は警告の出力先（nil なら出さない。URL・本文・エラーの文は渡さない）。
// 発行元・JWKS の URL・対象のどれかが空なら、エラー（空の iss・aud は、ライブラリが検査を省くため。config は、空にならないようにしてある）。
func NewVerifier(cfg config.Auth, logf func(format string, args ...any)) (*Verifier, error) {
	if cfg.Issuer == "" || cfg.JWKSURL == "" || cfg.Audience == "" {
		return nil, errors.New("auth: 発行元・JWKS の URL・対象のどれかが空です")
	}
	v := &Verifier{now: time.Now}
	clock := func() time.Time { return v.now() }
	v.keys = newKeyCache(cfg.JWKSURL, clock, logf)
	v.parser = jwt.NewParser(
		jwt.WithValidMethods([]string{allowedAlgorithm}), // 鍵を取りに行く前に、alg を ES256 に固定する
		jwt.WithTimeFunc(clock),
		jwt.WithLeeway(leeway),
		jwt.WithExpirationRequired(),
		jwt.WithIssuedAt(), // 未来の iat は受け付けない（iat が無いのは構わない）
		jwt.WithIssuer(cfg.Issuer),
		jwt.WithAudience(cfg.Audience),
	)
	return v, nil
}

// Verify は、トークンを検証して、ログイン中の人を返す。受け付けないときは ErrInvalidToken、鍵が取れないときは ErrUnavailable。
//
// 順序は Python と同じ: 長さ → 形（3 つの部分・JSON）→ alg（ES256 だけ。ここまでは鍵を取りに行かない）→ kid → 鍵（取得）→ 署名 → claims。
// Python は、鍵を取るときまで本文（claims）を読まないが、Go のライブラリは先に読むので、ヘッダーが正しく本文が壊れたトークンは、
// JWKS が取れないときも 401 になる（Python は 503）。鍵なしで断れるものは 401、という分け方に沿うので、そのままにしてある。
func (v *Verifier) Verify(token string) (Identity, error) {
	if token == "" || len(token) > maxTokenBytes {
		return Identity{}, invalid(reasonMalformed)
	}
	claims := jwt.MapClaims{}
	if _, err := v.parser.ParseWithClaims(token, claims, v.keyFor); err != nil {
		return Identity{}, classify(err)
	}
	return identityFrom(claims)
}

// keyFor は、ライブラリが署名を確かめる前に呼ぶ（alg の検査のあと）。kid の鍵を、置き場から渡す。
func (v *Verifier) keyFor(t *jwt.Token) (any, error) {
	kid, _ := t.Header["kid"].(string)
	if kid == "" {
		return nil, errNoKeyID
	}
	key, err := v.keys.get(kid)
	if err != nil {
		return nil, err // ErrUnavailable
	}
	if key == nil {
		return nil, errUnknownKey
	}
	return key, nil
}

// classify は、ライブラリのエラーを、ErrUnavailable か、理由つきの ErrInvalidToken にする。ライブラリのエラーの文は、外へ出さない。
func classify(err error) error {
	switch {
	case errors.Is(err, ErrUnavailable):
		return ErrUnavailable
	case errors.Is(err, errNoKeyID):
		return invalid(reasonKeyID)
	case errors.Is(err, errUnknownKey):
		return invalid(reasonUnknownKey)
	case errors.Is(err, jwt.ErrTokenMalformed):
		return invalid(reasonMalformed)
	case errors.Is(err, jwt.ErrTokenSignatureInvalid):
		return invalid(reasonSignature)
	case errors.Is(err, jwt.ErrTokenExpired):
		return invalid(reasonExpired)
	case errors.Is(err, jwt.ErrTokenNotValidYet), errors.Is(err, jwt.ErrTokenUsedBeforeIssued):
		return invalid(reasonNotYetValid)
	case errors.Is(err, jwt.ErrTokenInvalidIssuer):
		return invalid(reasonIssuer)
	case errors.Is(err, jwt.ErrTokenInvalidAudience):
		return invalid(reasonAudience)
	case errors.Is(err, jwt.ErrTokenRequiredClaimMissing):
		return invalid(reasonMissingClaim)
	default:
		return invalid(reasonInvalid)
	}
}
