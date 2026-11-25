package apierr

import "net/http"

// ログイン（GET /api/me）のエラー。backend/app/auth.py の not_logged_in・not_configured・unavailable と同じ文・ヘッダー。
// 本文は固定の文だけ（理由・例外の文字列・URL・パスは返さない）。人ごとに違う内容なので、どの応答も保存させない（Cache-Control: no-store）。

func noStore(e *Error) *Error {
	e.Headers = map[string]string{"Cache-Control": "no-store"}
	return e
}

// NotLoggedIn は、ログインしていない・JWT を受け付けないときの 401。もう一度ログインしてもらう（WWW-Authenticate: Bearer）。
func NotLoggedIn() *Error {
	e := noStore(New(http.StatusUnauthorized, "unauthorized", "ログインしてください"))
	e.Headers["WWW-Authenticate"] = "Bearer"
	return e
}

// AuthNotConfigured は、ログインの設定（AUTH_ISSUER・AUTH_JWKS_URL）が無い・不正なときの 503。
// JWT の有無・形を見る前に返す（401 と取り違えさせない。WWW-Authenticate は付けない）。
func AuthNotConfigured() *Error {
	return noStore(New(http.StatusServiceUnavailable, "unavailable", "Google でのログインは、まだ設定されていません"))
}

// AuthUnavailable は、JWKS を取りに行けず、前に取れた鍵も無いときの 503。
func AuthUnavailable() *Error {
	return noStore(New(http.StatusServiceUnavailable, "unavailable", "ログインを確認できませんでした。しばらくしてから、もう一度お試しください"))
}
