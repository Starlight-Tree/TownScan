package chat

import (
	"regexp"
	"strings"
)

// 文に出る「年」の読み取り。写真があるのは 2018・2023 年だけなので、それ以外の年（と、いまに近い相対語）は、答えられない質問として断る。
// 年の書き方の揺れ: 西暦（2024）・漢数字（二〇二四・二千二十四）・和暦（令和6年・令和六年・R6年）を西暦に直して判定する。

var photoYears = map[int]bool{2018: true, 2023: true}

const kanjiNum = "〇零一二三四五六七八九十百千"

var (
	kanjiYearRE = regexp.MustCompile(`([` + kanjiNum + `]{2,})年`)
	eraYearRE   = regexp.MustCompile(`(令和|平成|昭和|大正|明治) *(元|[0-9]{1,2}|[` + kanjiNum + `]+) *年`)
	// 年号の頭文字（r=令和・h=平成・s=昭和）。Python の ERA_LETTER_YEAR は (?<![a-z0-9]) で始まる（前が英数字なら、別の語の一部）。
	// RE2 には後読みが無いので、見つけたあとに、直前の 1 字を見て外す（eraLetterMatches）。
	// 一致の内側に英字は先頭の 1 字しか無いので、外れた一致の内側に別の正しい一致が隠れることは無い
	eraLetterYearRE = regexp.MustCompile(`([rhs]) *([0-9]{1,2}) *年`)
)

// eraBase は、西暦 = 基準 + 和暦の年。
var eraBase = map[string]int{"令和": 2018, "平成": 1988, "昭和": 1925, "大正": 1911, "明治": 1867}
var eraLetterBase = map[string]int{"r": 2018, "h": 1988, "s": 1925}

var (
	kanjiDigits = map[rune]int{'〇': 0, '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9}
	kanjiUnits  = map[rune]int{'十': 10, '百': 100, '千': 1000}
)

// kanjiToInt は、漢数字を整数にする。位取り（二〇二四）も、位つき（二千二十四・十二）も読む。読めなければ ok=false。
// 位取りの桁が多いときは、上限（decimalInt と同じ）で止める。
func kanjiToInt(text string) (int, bool) {
	if text == "" {
		return 0, false
	}
	allDigits := true
	for _, c := range text {
		if _, ok := kanjiDigits[c]; !ok {
			allDigits = false
			break
		}
	}
	if allDigits {
		const limit = 1 << 40
		n := 0
		for _, c := range text {
			if n < limit {
				n = n*10 + kanjiDigits[c]
			}
		}
		return n, true
	}
	total, digit, haveDigit := 0, 0, false
	for _, c := range text {
		if d, ok := kanjiDigits[c]; ok {
			if haveDigit { // 数字が続く（位が無い）のは、位つきの書き方ではない
				return 0, false
			}
			digit, haveDigit = d, true
		} else if u, ok := kanjiUnits[c]; ok {
			if haveDigit {
				total += digit * u
			} else {
				total += u
			}
			digit, haveDigit = 0, false
		} else {
			return 0, false
		}
	}
	if haveDigit {
		total += digit
	}
	return total, true
}

// eraNumber は、和暦の年の部分（元・数字・漢数字）。
func eraNumber(token string) (int, bool) {
	if token == "元" {
		return 1, true
	}
	if n, ok := decimalInt(token); ok {
		return n, true
	}
	return kanjiToInt(token)
}

// eraLetterMatches は、eraLetterYearRE の一致のうち、直前が [a-z0-9] でないもの（Python の (?<![a-z0-9])）。
func eraLetterMatches(text string) [][]int {
	var out [][]int
	for _, loc := range eraLetterYearRE.FindAllStringSubmatchIndex(text, -1) {
		if loc[0] > 0 {
			c := text[loc[0]-1]
			if c >= 'a' && c <= 'z' || c >= '0' && c <= '9' {
				continue
			}
		}
		out = append(out, loc)
	}
	return out
}

// westernYears は、文に出る西暦の 4 桁（19xx・20xx）。Python の (?<!\d)((?:19|20)\d{2})(?!\d) と同じ:
// 前後が数字でない、ちょうど 4 桁の数字の連なりで、頭の 2 桁が 19 か 20（数字は Unicode の十進数字。頭の 2 桁だけは ASCII）。
func westernYears(text string) []int {
	var years []int
	runes := []rune(text)
	for i := 0; i < len(runes); {
		if !isDecimal(runes[i]) {
			i++
			continue
		}
		j := i
		for j < len(runes) && isDecimal(runes[j]) {
			j++
		}
		if j-i == 4 {
			head := string(runes[i : i+2])
			if head == "19" || head == "20" {
				if n, ok := decimalInt(string(runes[i:j])); ok {
					years = append(years, n)
				}
			}
		}
		i = j
	}
	return years
}

// mentionedYears は、文に出る年を西暦で集める。text は normalize 済み。
func mentionedYears(text string) map[int]bool {
	years := map[int]bool{}
	for _, y := range westernYears(text) {
		years[y] = true
	}
	for _, m := range kanjiYearRE.FindAllStringSubmatch(text, -1) {
		if n, ok := kanjiToInt(m[1]); ok && n >= 1000 && n <= 2999 {
			years[n] = true
		}
	}
	for _, m := range eraYearRE.FindAllStringSubmatch(text, -1) {
		if n, ok := eraNumber(m[2]); ok {
			years[eraBase[m[1]]+n] = true
		}
	}
	for _, loc := range eraLetterMatches(text) {
		n, _ := decimalInt(text[loc[4]:loc[5]])
		years[eraLetterBase[text[loc[2]:loc[3]]]+n] = true
	}
	return years
}

// stripYears は、漢数字・和暦の年の言い回し（二〇二三年・令和五年・R5年）を取り除く。<場所>の位置の語と取り違えないため。
func stripYears(text string) string {
	text = kanjiYearRE.ReplaceAllString(text, " ")
	text = eraYearRE.ReplaceAllString(text, " ")
	var b strings.Builder
	last := 0
	for _, loc := range eraLetterMatches(text) {
		b.WriteString(text[last:loc[0]])
		b.WriteByte(' ')
		last = loc[1]
	}
	b.WriteString(text[last:])
	return b.String()
}

// hasUnphotographedYear は、写真が無い年（2018・2023 以外）が出ているか。
func hasUnphotographedYear(text string) bool {
	for y := range mentionedYears(text) {
		if !photoYears[y] {
			return true
		}
	}
	return false
}
