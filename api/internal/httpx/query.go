package httpx

import (
	"strings"
)

// Query は、クエリ文字列を Python（Starlette）と同じ規則で読んだもの。
//
// Starlette は parse_qsl(keep_blank_values=True) で読む。Go の url.ParseQuery と違う点が、ここで効く:
//   - 区切りは & だけ（; は区切りではない）。空の組（"a=1&&b=2"）は読み飛ばす
//   - = の無い組（"limit"）は、値が空の組（limit=）として残る
//   - 不正な %XX（"%zz"）は、エラーにせず、そのままの文字として残す（url.ParseQuery は組ごと捨てる）
//   - + は空白。UTF-8 として読めない並びは、置換文字（U+FFFD）にする
//   - 同じキーが複数あれば、最後の値が使われる（FastAPI の単一値の引数）
type Query struct {
	last map[string]string
}

// ParseQuery は、リクエストの生のクエリ文字列（r.URL.RawQuery）を読む。
func ParseQuery(raw string) Query {
	q := Query{last: map[string]string{}}
	if raw == "" {
		return q
	}
	for _, pair := range strings.Split(raw, "&") {
		if pair == "" {
			continue
		}
		name, value, _ := strings.Cut(pair, "=")
		q.last[unquote(strings.ReplaceAll(name, "+", " "))] = unquote(strings.ReplaceAll(value, "+", " "))
	}
	return q
}

// Get は、キーの最後の値。キーが無ければ ok=false（値が空のキーは ok=true で ""）。
func (q Query) Get(key string) (string, bool) {
	v, ok := q.last[key]
	return v, ok
}

// unquote は、Python の urllib.parse.unquote（errors="replace"）と同じ。%XX（16 進 2 桁）だけを 1 バイトにし、
// 形の合わない % はそのまま残す。
func unquote(s string) string {
	if !strings.Contains(s, "%") {
		return s
	}
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		if s[i] == '%' && i+2 < len(s) && isHex(s[i+1]) && isHex(s[i+2]) {
			out = append(out, unhex(s[i+1])<<4|unhex(s[i+2]))
			i += 2
			continue
		}
		out = append(out, s[i])
	}
	return strings.ToValidUTF8(string(out), "�")
}

func isHex(c byte) bool {
	return c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F'
}

func unhex(c byte) byte {
	switch {
	case c >= '0' && c <= '9':
		return c - '0'
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10
	default:
		return c - 'A' + 10
	}
}
