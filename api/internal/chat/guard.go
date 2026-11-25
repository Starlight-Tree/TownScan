package chat

import (
	"bytes"
	"encoding/json"
	"math"
	"regexp"
	"strconv"
	"strings"

	"golang.org/x/text/unicode/norm"

	"townscan/api/internal/pyjson"
)

// 返答文の数字の検査（仕様 §4.5「数字は結果からだけ」。backend/app/chat/guard.py の guard_numbers と同じ）。
//
// 返答文 content に出る数字は、results に含まれる値（数値・文字列の中の数字）だけから出ていなければならない。
// 満たさない返答は返さず、数字を含まない安全なテンプレートに落とす。
//
// 見るもの: 半角・全角のアラビア数字（NFKC で揃える）。アルファベットの直後の数字（F1・m2 など）は単位・記号として見ない。
// 漢数字は、助数詞（件・棟・地区・年など）が続くものだけ見る（「一覧」「一番」のような語を巻き込まないため）。
// 実モデルをつなぐときも、返答文はここを通す。

// SafeTemplate は、数字の検査に落ちたときに返す、数字を含まない固定の文。
const SafeTemplate = "結果は下のカードのとおりです。数字はカードに表示された値を見てください。"

var kanjiCountRE = regexp.MustCompile(
	`[〇零一二三四五六七八九十百千万]+` + pySpaceClass + `*(?:件|棟|地区|枚|割|倍|%|％|か所|ヶ所|カ所|平方|パーセント|年)`)

// isASCIILetter は、Python の [A-Za-z]。
func isASCIILetter(r rune) bool { return r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' }

// normalizeNumber は、数字の表記を揃える: "1,234" → "1234"・"0.60" → "0.6"・"007" → "7"・"5.0" → "5"。
// token は、numberTokens か、数値から作った表記。Python の normalize_number（str(int(…))）と同じ。
func normalizeNumber(token string) string {
	token = strings.ReplaceAll(token, ",", "")
	if head, tail, ok := strings.Cut(token, "."); ok {
		h, _ := asciiDigits(head)
		tail = strings.TrimRight(tail, "0") // 小数部は、ASCII の 0 だけ落とす（Python の rstrip("0") と同じ）
		if tail != "" {
			return h + "." + tail
		}
		return h
	}
	out, _ := asciiDigits(token)
	return out
}

// numberTokens は、文に出る数字の連なりを、揃えた表記で返す。
// Python の (?<![A-Za-z])\d+(?:,\d{3})*(?:\.\d+)? による findall と同じ。後読み (?<![A-Za-z]) は、RE2 に無いので、手で走査する。
// 後読みは「その位置の直前が英字でない」だけなので、"F12" は、F の直後の 1 は外れるが、2 は（直前が数字なので）数字として拾われる
// （Python と同じ。結果の側の文字列も同じ関数で読むので、両側で同じように数える）。
func numberTokens(text string) []string {
	runes := []rune(norm.NFKC.String(text))
	var out []string
	for i := 0; i < len(runes); {
		if !isDecimal(runes[i]) || (i > 0 && isASCIILetter(runes[i-1])) {
			i++
			continue
		}
		j := i
		for j < len(runes) && isDecimal(runes[j]) {
			j++
		}
		// (?:,\d{3})*
		for j+3 < len(runes) && runes[j] == ',' && isDecimal(runes[j+1]) && isDecimal(runes[j+2]) && isDecimal(runes[j+3]) {
			j += 4
		}
		// (?:\.\d+)?
		if j+1 < len(runes) && runes[j] == '.' && isDecimal(runes[j+1]) {
			j += 2
			for j < len(runes) && isDecimal(runes[j]) {
				j++
			}
		}
		out = append(out, normalizeNumber(string(runes[i:j])))
		i = j
	}
	return out
}

// numberForms は、数値 1 つから、返答文に書いてよい表記を作る。整数は、そのままの桁だけ。
// 小数は、四捨五入（小数 0〜4 桁）と repr の表記。0〜1 の割合は、百分率（小数 0〜2 桁）でも書ける。
func numberForms(token json.Number) []string {
	s := token.String()
	if !strings.ContainsAny(s, ".eE") { // 整数（Python の int）
		return []string{normalizeNumber(strings.TrimPrefix(s, "-"))}
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
		return nil
	}
	v := math.Abs(f)
	var forms []string
	for d := 0; d <= 4; d++ {
		forms = append(forms, strconv.FormatFloat(v, 'f', d, 64))
	}
	if repr, err := pyjson.FormatFloat(v); err == nil {
		forms = append(forms, repr)
	}
	if v <= 1.0 { // 割合は百分率でも書ける
		for d := 0; d <= 2; d++ {
			forms = append(forms, strconv.FormatFloat(v*100, 'f', d, 64))
		}
	}
	var out []string
	for _, f := range forms {
		if strings.ContainsAny(f, "eE") { // 極端に小さい値・大きい値の指数表記は使わない
			continue
		}
		out = append(out, normalizeNumber(f))
	}
	return out
}

// genericOf は、結果（Go の値）を、JSON の値（map・[]any・string・json.Number・bool・nil）にする。数字の検査は、この形で結果を歩く。
// Python の int と float は、JSON の書き方（小数点・指数があるか）で区別できる（pyjson は float を必ず "100.0"・"1e-05" と書く）。
func genericOf(v any) any {
	b, err := pyjson.Marshal(v)
	if err != nil {
		return nil
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	var out any
	if err := dec.Decode(&out); err != nil {
		return nil
	}
	return out
}

// allowedNumbers は、結果（JSON の値）の中の、数値と、文字列の中の数字を集める。キー名は含めない。
func allowedNumbers(node any) map[string]bool {
	found := map[string]bool{}
	var walk func(any)
	walk = func(n any) {
		switch v := n.(type) {
		case json.Number:
			for _, f := range numberForms(v) {
				found[f] = true
			}
		case string:
			for _, t := range numberTokens(v) {
				found[t] = true
			}
		case map[string]any:
			for _, x := range v {
				walk(x)
			}
		case []any:
			for _, x := range v {
				walk(x)
			}
		}
	}
	walk(node)
	return found
}

// findUnsupportedNumbers は、content にあって、結果から出せない数字（と、漢数字+助数詞）。空なら合格。
func findUnsupportedNumbers(content string, results any) []string {
	allowed := allowedNumbers(results)
	var bad []string
	for _, t := range numberTokens(content) {
		if !allowed[t] {
			bad = append(bad, t)
		}
	}
	bad = append(bad, kanjiCountRE.FindAllString(norm.NFKC.String(content), -1)...)
	return bad
}

// GuardNumbers は、返答文が合格なら、そのまま返す。満たさなければ、安全なテンプレートを返す（元の文は返さない）。replaced は、差し替えたか。
// 数字・本文は、ログに出さない（差し替えた回数だけ、呼び出し側が数える）。
func GuardNumbers(content string, results []Result) (out string, replaced bool) {
	if len(findUnsupportedNumbers(content, genericOf(results))) == 0 {
		return content, false
	}
	return SafeTemplate, true
}
