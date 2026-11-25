package chat

import (
	"math"
	"strconv"
	"strings"
	"unicode"
)

// この部分は、Python（re・str）の文字の扱いを、Go で同じにするための小さな道具。
// 模擬モデルの規則は、Python の API と同じ入力で同じ出力になる必要がある。Go の regexp（RE2）は、次の点で Python の re と違う:
//   - \s は ASCII の空白だけ（Python は Unicode の空白）。\d は ASCII の数字だけ（Python は Unicode の十進数字 = \p{Nd}）
//   - \b は ASCII の語境界（Python は、日本語の文字も語の文字と見る）
//   - 先読み・後読みが無い
//
// 規則は、先に正規化した文（normalize。空白は半角 1 つ）に使うので、\s は半角の空白で足りる。\d は \p{Nd}、\b と後読みは、
// この部分とそれぞれの規則の注記にある手書きの判定で置き換える。

// isPySpace は、Python の str.isspace()（正規表現の \s と、strip() の対象）が真の文字。
// Go の unicode.IsSpace に、Python が空白と見る U+001C〜U+001F を足したもの。
func isPySpace(r rune) bool {
	switch {
	case r >= 0x09 && r <= 0x0d, r >= 0x1c && r <= 0x20:
		return true
	case r == 0x85, r == 0xa0, r == 0x1680, r >= 0x2000 && r <= 0x200a, r == 0x2028, r == 0x2029, r == 0x202f, r == 0x205f, r == 0x3000:
		return true
	}
	return false
}

// pyFixed は、Python の f"{v:.{prec}f}"。Go の strconv は NaN と無限大を "NaN"・"+Inf"・"-Inf" と書くが、Python は "nan"・"inf"・"-inf"。
// 値は DB の double precision で、NaN や無限大が入ることがある（応答の文にも、Python と同じ綴りで出る）。
func pyFixed(v float64, prec int) string {
	switch {
	case math.IsNaN(v):
		return "nan"
	case math.IsInf(v, 1):
		return "inf"
	case math.IsInf(v, -1):
		return "-inf"
	}
	return strconv.FormatFloat(v, 'f', prec, 64)
}

// IsBlank は、Python の `not s.strip()`（空か、空白だけ）。
func IsBlank(s string) bool { return strings.TrimFunc(s, isPySpace) == "" }

// pySpaceClass は、正規表現の文字クラスとしての isPySpace（正規化していない文に \s を使うところで使う）。
const pySpaceClass = `[\x{9}-\x{d}\x{1c}-\x{20}\x{85}\x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}]`

// isWordRune は、Python の正規表現の \w（str.isalnum() が真の文字と _）。\b の判定に使う。
func isWordRune(r rune) bool {
	return r == '_' || unicode.IsLetter(r) || unicode.IsNumber(r)
}

// containsWord は、Python の `\bword\b` に当たる検索。word の前後が語の文字でないところに、word があるか。
// word は小文字の ASCII（文は、normalize で小文字にしてある）。日本語の文字は語の文字なので、「衛星geeの」の gee は語として数えない。
func containsWord(text, word string) bool {
	for from := 0; ; {
		i := strings.Index(text[from:], word)
		if i < 0 {
			return false
		}
		start := from + i
		end := start + len(word)
		before, after := true, true
		if start > 0 {
			r := lastRune(text[:start])
			before = !isWordRune(r)
		}
		if end < len(text) {
			r := firstRune(text[end:])
			after = !isWordRune(r)
		}
		if before && after {
			return true
		}
		from = start + 1
	}
}

func firstRune(s string) rune {
	for _, r := range s {
		return r
	}
	return 0
}

func lastRune(s string) rune {
	r := rune(0)
	for _, c := range s {
		r = c
	}
	return r
}

// digitValue は、Unicode の十進数字（Nd。Python の \d）の値。Nd は 0〜9 の 10 字ずつの連なりで、表の範囲の先頭が 0 に当たる。
func digitValue(r rune) (int, bool) {
	if r >= '0' && r <= '9' {
		return int(r - '0'), true
	}
	if r < 0x80 || !unicode.IsDigit(r) {
		return 0, false
	}
	for _, rg := range unicode.Nd.R16 {
		if r >= rune(rg.Lo) && r <= rune(rg.Hi) {
			return int(r-rune(rg.Lo)) % 10, true
		}
	}
	for _, rg := range unicode.Nd.R32 {
		if r >= rune(rg.Lo) && r <= rune(rg.Hi) {
			return int(r-rune(rg.Lo)) % 10, true
		}
	}
	return 0, false
}

// isDecimal は、Python の \d（Unicode の十進数字）。
func isDecimal(r rune) bool {
	_, ok := digitValue(r)
	return ok
}

// decimalInt は、Unicode の十進数字だけの文字列を整数にする（Python の int(s)）。大きすぎる値は、上限で止める
// （年・件数の判定にしか使わず、どの値も「大きい」ことだけが分かればよい）。数字でない文字があれば ok=false。
func decimalInt(s string) (int, bool) {
	const limit = 1 << 40
	n := 0
	for _, r := range s {
		d, ok := digitValue(r)
		if !ok {
			return 0, false
		}
		if n < limit {
			n = n*10 + d
		}
	}
	return n, s != ""
}

// asciiDigits は、Unicode の十進数字を ASCII の数字にして、先頭の 0 を落とす（Python の str(int(s))。0 は "0"）。
// 数字でない文字が混ざっていれば ok=false。
func asciiDigits(s string) (string, bool) {
	var b strings.Builder
	for _, r := range s {
		d, ok := digitValue(r)
		if !ok {
			return "", false
		}
		b.WriteByte(byte('0' + d))
	}
	out := strings.TrimLeft(b.String(), "0")
	if out == "" && s != "" {
		out = "0"
	}
	return out, s != ""
}
