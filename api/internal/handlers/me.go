package handlers

import (
	"errors"
	"net/http"

	"townscan/api/internal/apierr"
	"townscan/api/internal/auth"
	"townscan/api/internal/httpx"
)

// Authenticator は、/api/me がログインの確認に使うもの。*auth.Verifier が満たす。テストは偽の実装を差し込む。
// Deps.Auth が nil なら、ログインは未設定（/api/me は 503）。
type Authenticator interface {
	// Verify は、トークンを検証する。受け付けないときは auth.ErrInvalidToken、鍵が取れないときは auth.ErrUnavailable を返す。
	Verify(token string) (auth.Identity, error)
}

var _ Authenticator = (*auth.Verifier)(nil)

// ---- GET /api/me ----

// me は、ログイン中の人（Bearer の JWT を検証した結果）。アカウントのロジックの受け口で、ほかの入口はログインを要求しない。DB は使わない。
//
//	設定が無い → 503（トークンの有無・形を見る前に。仕様 §4.4）
//	Authorization が無い・Bearer でない → 401
//	JWT を受け付けない（壊れている・署名・alg・iss・aud・exp・sub など）→ 401
//	JWKS を取れず、前に取れた鍵も無い → 503
//
// 応答はどれも Cache-Control: no-store。本文は固定の文（理由は返さない）。ログに残すのは失敗の種類だけ（トークン・ヘッダーの値は出さない）。
func (a *api) me(w http.ResponseWriter, r *http.Request, _ httpx.Params) {
	if a.d.Auth == nil {
		httpx.WriteError(w, apierr.AuthNotConfigured())
		return
	}
	token, ok := auth.BearerToken(r.Header.Get("Authorization"))
	if !ok {
		httpx.WriteError(w, apierr.NotLoggedIn())
		return
	}
	identity, err := a.d.Auth.Verify(token)
	switch {
	case errors.Is(err, auth.ErrUnavailable):
		httpx.WriteError(w, apierr.AuthUnavailable())
	case err != nil:
		a.logf("認証に失敗しました (reason=%s)", auth.Reason(err))
		httpx.WriteError(w, apierr.NotLoggedIn())
	default:
		w.Header().Set("Cache-Control", "no-store")
		a.writeJSON(w, httpx.ContentTypeJSON, identity)
	}
}
