package auth

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/golang-jwt/jwt/v5"
)

func sp(s string) *string { return &s }

func derefOr(p *string, none string) string {
	if p == nil {
		return none
	}
	return *p
}

// identityOf は、sub だけが正しい claims に over を足して、取り出した人を返す。
func identityOf(t *testing.T, over jwt.MapClaims) Identity {
	t.Helper()
	c := jwt.MapClaims{"sub": testSub}
	for k, v := range over {
		c[k] = v
	}
	id, err := identityFrom(c)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func TestIdentityMissingClaimsBecomeNull(t *testing.T) {
	id := identityOf(t, nil)
	b, err := json.Marshal(id)
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"sub":"ba_user_0000000001","email":null,"name":null,"picture":null}`; string(b) != want {
		t.Errorf("JSON = %s\n期待 = %s", b, want)
	}
}

func TestIdentityEmailIsKeptAsIsAndTheNameIsTrimmed(t *testing.T) {
	id := identityOf(t, jwt.MapClaims{"email": " Tanaka@Example.com ", "name": " 田中 太郎 "})
	if derefOr(id.Email, "<nil>") != "Tanaka@Example.com" || derefOr(id.Name, "<nil>") != "田中 太郎" {
		t.Errorf("email=%v name=%v", derefOr(id.Email, "<nil>"), derefOr(id.Name, "<nil>"))
	}
}

func TestIdentityPicture(t *testing.T) {
	https2048 := "https://example.com/" + strings.Repeat("a", 2048-len("https://example.com/"))
	cases := []struct {
		name string
		over jwt.MapClaims
		want string // "<nil>" = null
	}{
		{"https", jwt.MapClaims{"picture": "https://lh3.googleusercontent.com/a/test"}, "https://lh3.googleusercontent.com/a/test"},
		{"前後の空白は除く", jwt.MapClaims{"picture": "  https://example.com/a.png \n"}, "https://example.com/a.png"},
		{"http は持たない", jwt.MapClaims{"picture": "http://example.com/a.png"}, "<nil>"},
		{"javascript: は持たない", jwt.MapClaims{"picture": "javascript:alert(1)"}, "<nil>"},
		{"大文字の HTTPS:// は持たない（前方一致は大文字小文字を区別する）", jwt.MapClaims{"picture": "HTTPS://example.com/a.png"}, "<nil>"},
		{"2100 文字は持たない", jwt.MapClaims{"picture": "https://example.com/" + strings.Repeat("a", 2100)}, "<nil>"},
		{"2049 文字は持たない", jwt.MapClaims{"picture": "https://example.com/" + strings.Repeat("a", 2049-len("https://example.com/"))}, "<nil>"},
		{"ちょうど 2048 文字は持つ", jwt.MapClaims{"picture": https2048}, https2048},
		{"空白だけ", jwt.MapClaims{"picture": "   "}, "<nil>"},
		{"数", jwt.MapClaims{"picture": 123}, "<nil>"},
		{"picture が無ければ image を使う", jwt.MapClaims{"image": "https://lh3.googleusercontent.com/a/img"}, "https://lh3.googleusercontent.com/a/img"},
		{"picture が空白だけなら image を使う", jwt.MapClaims{"picture": "  ", "image": "https://example.com/i.png"}, "https://example.com/i.png"},
		{"picture が長すぎれば image を使う", jwt.MapClaims{"picture": "https://example.com/" + strings.Repeat("a", 2100), "image": "https://example.com/i.png"}, "https://example.com/i.png"},
		{"picture が使える文字列なら、https でなくても image には替えない", jwt.MapClaims{"picture": "http://example.com/a.png", "image": "https://example.com/i.png"}, "<nil>"},
		{"picture があれば image は見ない", jwt.MapClaims{"picture": "https://example.com/p.png", "image": "https://example.com/i.png"}, "https://example.com/p.png"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := derefOr(identityOf(t, c.over).Picture, "<nil>"); got != c.want {
				t.Errorf("picture = %q, 期待 %q", got, c.want)
			}
		})
	}
}

func TestIdentityEmail(t *testing.T) {
	at254 := strings.Repeat("a", 254-len("@example.com")) + "@example.com"
	cases := []struct {
		name  string
		email any
		want  string
	}{
		{"ふつう", "tanaka@example.com", "tanaka@example.com"},
		{"@ が無い", "not-an-email", "<nil>"},
		{"254 文字を超える", strings.Repeat("a", 250) + "@example.com", "<nil>"},
		{"255 文字", strings.Repeat("a", 243) + "@example.com", "<nil>"},
		{"ちょうど 254 文字", at254, at254},
		{"空白だけ", "   ", "<nil>"},
		{"数", 123, "<nil>"},
		{"配列", []string{"a@example.com"}, "<nil>"},
		{"null", nil, "<nil>"},
		{"文字数はコードポイント（日本語 254 文字は持つ）", strings.Repeat("あ", 252) + "@a", strings.Repeat("あ", 252) + "@a"},
		{"日本語 255 文字は持たない", strings.Repeat("あ", 253) + "@a", "<nil>"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := derefOr(identityOf(t, jwt.MapClaims{"email": c.email}).Email, "<nil>"); got != c.want {
				t.Errorf("email = %q, 期待 %q", got, c.want)
			}
		})
	}
}

// 名前は、印字できない文字（制御文字のほか、全角空白・ゼロ幅の文字も）を除いて、100 文字（コードポイント）までにする。空になれば null。
func TestIdentityName(t *testing.T) {
	cases := []struct {
		name string
		raw  any
		want string
	}{
		{"100 文字で切る", strings.Repeat("あ", 150), strings.Repeat("あ", 100)},
		{"文字数はコードポイント", strings.Repeat("😀", 101), strings.Repeat("😀", 100)},
		{"ちょうど 100 文字はそのまま", strings.Repeat("a", 100), strings.Repeat("a", 100)},
		{"制御文字は持たない", "a\nb\tc", "abc"},
		{"全角空白も除く", "田中　太郎", "田中太郎"},
		{"ゼロ幅の文字", "a​b", "ab"},
		{"ゼロ幅のつなぎ（ZWJ）", "a‍b", "ab"},
		{"改行を含む長い名前", "a\r\nb", "ab"},
		{"NBSP", "a b", "ab"},
		{"ASCII の空白は残す", "田中 太郎", "田中 太郎"},
		{"切ったあとの末尾の空白も除く", strings.Repeat("a", 99) + " b", strings.Repeat("a", 99)},
		{"空白だけ", "   ", "<nil>"},
		{"改行・タブだけ", "\n\t", "<nil>"},
		{"数", 123, "<nil>"},
		{"null", nil, "<nil>"},
		{"空", "", "<nil>"},
		{"絵文字（異体字選択子つき）は残す", "❤️", "❤️"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := derefOr(identityOf(t, jwt.MapClaims{"name": c.raw}).Name, "<nil>"); got != c.want {
				t.Errorf("name = %q, 期待 %q", got, c.want)
			}
		})
	}
}

func TestIdentityEmailVerifiedIsNotExposed(t *testing.T) {
	b, _ := json.Marshal(identityOf(t, jwt.MapClaims{"email_verified": true}))
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	if len(m) != 4 {
		t.Errorf("キー = %v", m)
	}
	for _, k := range []string{"sub", "email", "name", "picture"} {
		if _, ok := m[k]; !ok {
			t.Errorf("%s が無い", k)
		}
	}
}

func TestValidUserID(t *testing.T) {
	for s, want := range map[string]bool{
		"abcdefgh":              true,
		strings.Repeat("a", 64): true,
		"ba_user-0000_0001":     true,
		"ABCDEFGH12345678":      true,
		"abcdefg":               false, // 7 文字
		strings.Repeat("a", 65): false,
		"":                      false,
		"has space in it!":      false,
		"abcdefgh\n":            false, // 末尾の改行（Python の fullmatch でも通らない）
		"abcdefǵ":              false,
		"ａｂｃｄｅｆｇｈ":              false, // 全角の英字
		"abcdefg.h":             false,
		"abcdefg/h":             false,
	} {
		if got := validUserID(s); got != want {
			t.Errorf("validUserID(%q) = %v, 期待 %v", s, got, want)
		}
	}
}

func TestIdentityRejectsASubThatIsNotAString(t *testing.T) {
	for _, sub := range []any{nil, 12345678, []string{"abcdefgh"}, true} {
		if _, err := identityFrom(jwt.MapClaims{"sub": sub}); !isInvalid(err, reasonSubject) {
			t.Errorf("sub=%v: err = %v", sub, err)
		}
	}
	if _, err := identityFrom(jwt.MapClaims{}); !isInvalid(err, reasonSubject) {
		t.Errorf("sub なし: err = %v", err)
	}
}

func isInvalid(err error, reason string) bool { return err != nil && Reason(err) == reason }
