package auth

import (
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/golang-jwt/jwt/v5"
)

// 受け取る文字列の上限（文字数。コードポイント）
const (
	maxEmail   = 254
	maxName    = 100
	maxPicture = 2048
)

// Identity は、検証に通った JWT から取り出した、ログイン中の人。Sub は Better Auth の利用者 ID。
// 応答の本文そのもの（`GET /api/me`。キーの並びは sub・email・name・picture。無い・使えない項目は null）。
type Identity struct {
	Sub     string  `json:"sub"`
	Email   *string `json:"email"`
	Name    *string `json:"name"`
	Picture *string `json:"picture"`
}

// identityFrom は、検証に通った claims から、人を取り出す（backend/app/jwt_auth.py の _identity と同じ規則。仕様 §4.4）。
// sub は、Better Auth の利用者 ID の形（英数字と _ -、8〜64 文字）でなければ受け付けない。email・name・picture は、使えなければ null。
func identityFrom(claims jwt.MapClaims) (Identity, error) {
	sub, ok := claims["sub"].(string)
	if !ok || !validUserID(sub) {
		return Identity{}, invalid(reasonSubject)
	}
	id := Identity{Sub: sub}

	if email, ok := text(claims["email"], maxEmail); ok && strings.Contains(email, "@") {
		id.Email = &email
	}
	// 画像は claim `picture`（Better Auth の既定の payload では `image`）。picture が使える文字列なら、https でなくても image には替えない
	// （Python の `or` と同じ）。画面は https の画像だけを表示するので、https 以外は持たない
	picture, ok := text(claims["picture"], maxPicture)
	if !ok {
		picture, ok = text(claims["image"], maxPicture)
	}
	if ok && strings.HasPrefix(picture, "https://") {
		id.Picture = &picture
	}
	id.Name = displayName(claims["name"])
	return id, nil
}

// validUserID は、英数字と _ - だけの 8〜64 文字（Python の `[A-Za-z0-9_-]{8,64}` の fullmatch）。
func validUserID(s string) bool {
	if len(s) < 8 || len(s) > 64 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-') {
			return false
		}
	}
	return true
}

// text は、前後の空白を除いた、1〜limit 文字の文字列。文字列でない・空・長すぎるときは ok=false。
func text(v any, limit int) (string, bool) {
	s, ok := v.(string)
	if !ok {
		return "", false
	}
	s = pyStrip(s)
	if n := utf8.RuneCountInString(s); n == 0 || n > limit {
		return "", false
	}
	return s, true
}

// displayName は、名前を、印字できない文字（制御文字のほか、全角空白・ゼロ幅の文字も）を除いて、100 文字（コードポイント）までにした値。
// 文字列でない・空になれば nil。
//
// Python の str.isprintable と、Go の unicode.IsPrint は、どちらも「文字・記号・数字・句読点・結合文字と、ASCII の空白」だけを印字できると見る。
// Unicode の版の差（Python 3.13 と Go 1.26）で、新しく割り当てられた文字の扱いが違いうるが、Better Auth の名前（Google の表示名）では実害が無い。
func displayName(v any) *string {
	s, ok := v.(string)
	if !ok {
		return nil
	}
	s = strings.Map(func(r rune) rune {
		if unicode.IsPrint(r) {
			return r
		}
		return -1
	}, s)
	s = pyStrip(s)
	if utf8.RuneCountInString(s) > maxName {
		s = string([]rune(s)[:maxName])
	}
	s = pyStrip(s)
	if s == "" {
		return nil
	}
	return &s
}

// pyStrip は、Python の str.strip()（引数なし）と同じ。Go の unicode.IsSpace に、Python が空白と見る 0x1c〜0x1f を足したもの。
// config の同名の関数と同じ（あちらは外へ出していないので、写した）。
func pyStrip(s string) string {
	return strings.TrimFunc(s, func(r rune) bool { return unicode.IsSpace(r) || (r >= 0x1c && r <= 0x1f) })
}
