package auth

import "strings"

// BearerToken は、Authorization ヘッダーの値 `Bearer <トークン>` から、トークンを取り出す（backend/app/auth.py の bearer_token と同じ）。
// 方式の名前は大文字・小文字を区別しない。無い・方式が違う・トークンが空・トークンの中に空白があるときは ok=false（呼び出し側は 401）。
// 取り出したトークンは、まだ検証していない（Verify に渡す）。
func BearerToken(header string) (token string, ok bool) {
	scheme, rest, _ := strings.Cut(header, " ")
	token = pyStrip(rest)
	if !strings.EqualFold(scheme, "bearer") || token == "" || strings.Contains(token, " ") {
		return "", false
	}
	return token, true
}
