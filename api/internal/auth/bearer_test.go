package auth

import (
	"strings"
	"testing"
)

func TestBearerToken(t *testing.T) {
	cases := []struct {
		name   string
		header string
		token  string
		ok     bool
	}{
		{"Bearer", "Bearer abc.def.ghi", "abc.def.ghi", true},
		{"bearer（小文字）", "bearer abc", "abc", true},
		{"BEARER（大文字）", "BEARER abc", "abc", true},
		{"BeArEr", "BeArEr abc", "abc", true},
		{"方式のあとの空白が 2 つ（前後の空白は除く）", "Bearer  abc", "abc", true},
		{"トークンの前後の空白は除く", "Bearer \tabc\t", "abc", true},
		{"ヘッダーが無い", "", "", false},
		{"Basic", "Basic abc", "", false},
		{"Token", "Token abc", "", false},
		{"方式だけ", "Bearer", "", false},
		{"方式と空白だけ", "Bearer ", "", false},
		{"方式と空白が 2 つだけ", "Bearer   ", "", false},
		{"トークンが 2 つ", "Bearer a b", "", false},
		{"空白でなくタブで区切る", "Bearer\tabc", "", false},
		{"方式の名前が違う（前方一致）", "Bearerx abc", "", false},
		{"方式の名前が違う（後方）", "xBearer abc", "", false},
		{"トークンだけ", "abc", "", false},
		{"方式が空", " abc", "", false},
		{"長いトークンはそのまま（長さの検査は Verify）", "Bearer " + strings.Repeat("a", 9000), strings.Repeat("a", 9000), true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			token, ok := BearerToken(c.header)
			if token != c.token || ok != c.ok {
				t.Errorf("BearerToken(%q) = %q, %v / 期待 %q, %v", c.header, token, ok, c.token, c.ok)
			}
		})
	}
}
