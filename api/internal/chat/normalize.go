package chat

import (
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

// normalize は、規則に当てる前の文の整え方（mock_model.normalize と同じ）:
// Unicode の NFKC（全角の英数・記号・半角カナなどを標準の形にする）→ 空白の連なりを半角 1 つ → 前後の空白を除く → 小文字。
// NFKC は golang.org/x/text/unicode/norm（pgx の依存として、もうビルドに入っている）。
func normalize(text string) string {
	s := norm.NFKC.String(text)
	var b strings.Builder
	pending := false
	for _, r := range s {
		if isPySpace(r) {
			pending = b.Len() > 0
			continue
		}
		if pending {
			b.WriteByte(' ')
			pending = false
		}
		b.WriteRune(r)
	}
	return pyLower(b.String())
}

// pyLower は、Python の str.lower()。Go の strings.ToLower との違いは 2 つ:
//   - İ（U+0130）は、i と結合用の上点（U+0307）の 2 字になる（Go は i の 1 字）
//   - 大文字のシグマ Σ は、語の終わりなら ς、そうでなければ σ（Go は常に σ）
//
// 規則の語（日本語と ASCII の語）には関係しないが、Python と同じ文字列になるように合わせる。
func pyLower(s string) string {
	runes := []rune(s)
	var b strings.Builder
	for i, r := range runes {
		switch r {
		case 0x130:
			b.WriteString("i̇")
		case 0x3a3:
			if isFinalSigma(runes, i) {
				b.WriteRune(0x3c2)
			} else {
				b.WriteRune(0x3c3)
			}
		default:
			b.WriteRune(unicode.ToLower(r))
		}
	}
	return b.String()
}

// isFinalSigma は、CPython の handle_capital_sigma と同じ条件:
// 直前に、(大小のある文字)(大小を無視する文字)* があり、直後に、(大小を無視する文字)*(大小のある文字) が続かない。
func isFinalSigma(runes []rune, i int) bool {
	j := i - 1
	for j >= 0 && isCaseIgnorable(runes[j]) {
		j--
	}
	if j < 0 || !isCased(runes[j]) {
		return false
	}
	for j = i + 1; j < len(runes) && isCaseIgnorable(runes[j]); j++ {
	}
	return j == len(runes) || !isCased(runes[j])
}

// isCased は、大文字・小文字・タイトル文字（Unicode の Cased に近い近似）。
func isCased(r rune) bool { return unicode.IsUpper(r) || unicode.IsLower(r) || unicode.IsTitle(r) }

// isCaseIgnorable は、Unicode の Case_Ignorable に近い近似（結合文字・書式文字・修飾文字・語の途中に入る記号）。
func isCaseIgnorable(r rune) bool {
	if unicode.In(r, unicode.Mn, unicode.Me, unicode.Cf, unicode.Lm, unicode.Sk) {
		return true
	}
	return strings.ContainsRune("'.:·‘’․‧︓﹒﹕＇．：", r)
}

// MaxMessageChars は、会話の 1 件の本文の上限（文字数）。handlers が、正規化の前と後の両方で数える。
const MaxMessageChars = 2000

// NormalizedLen は、NFKC で揃えたあとの文字数。NFKC は、1 文字を最大 18 文字に伸ばす（「ﷺ」）ので、正規化の前の数え方だけでは、上限を守れない。
func NormalizedLen(s string) int { return utf8.RuneCountInString(norm.NFKC.String(s)) }
