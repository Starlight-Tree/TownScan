package chat

import (
	"bytes"
	"encoding/json"
	"math"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"

	"townscan/api/internal/pyjson"
	"townscan/api/internal/store"
)

// 返答文の数字の検査（仕様 §4.5「数字は結果からだけ」。backend/app/chat/guard.py の guard_numbers と同じ）。
//
// 返答文 content に出る数字は、results に含まれる値（数値・文字列の中の数字）だけから出ていなければならない。
// 満たさない返答は返さず、数字を含まない安全なテンプレートに落とす。
//
// 見るもの: 半角・全角のアラビア数字（NFKC で揃える）。アルファベットの直後の数字（F1・m2 など）は単位・記号として見ない。
// 実モデル（Gemini）の返答文も、ここを通す。
//
// 次の 2 つは Python と同じ（golden_test.go が Python の期待値と照合する）:
//   - 数字の連なりは、結果の値だけから出ていること
//   - 漢数字+助数詞（件・棟・地区・年など）は、結果と照合せず、必ず落とす
//
// 次は Go で足した（Python は見逃す。README の「Python との意図した違い」）。実モデルの返答は、この検査だけが頼りなので塞いだ。
// かけるのは、実 LLM の返答文（GuardNumbers）と、LLM が書いた refuse の文だけ。模擬モデルの返答文は、数字を結果からだけ作るので、
// Python と同じ範囲の検査（guardTemplateNumbers）のまま（強い検査にすると、利用者の語を写した断りの文が落ちて、応答が Python と変わる）:
//   - 助数詞の無い漢数字（「七軒」「三千円」「七つ」）。漢数字は、助数詞の有無に依らず、結果と照合せず落とす。
//     数を表さない語（一覧・一番・一部・十分・万が一など）と、地区名・区名の中の漢数字（九品寺など）は、数として見ない（nonNumericWords・known）
//   - 英語の数詞（seven・twenty-one・hundred など）。同じく、結果と照合せず落とす
//   - 空白・不可視の書式文字（ゼロ幅スペース U+200B・ソフトハイフン U+00AD など）で区切った数。
//     不可視の文字は読み手に見えないので、取り除いてから数える（「3<ZWSP>4」は 34）。空白で区切った整数の並び（「3 4」）は、
//     1 つずつの数に加えて、つなげた数（34）も、結果に無ければ落とす

// SafeTemplate は、数字の検査に落ちたときに返す、数字を含まない固定の文。
const SafeTemplate = "結果は下のカードのとおりです。数字はカードに表示された値を見てください。"

// numeralKanji は、漢数字として数える文字。
const numeralKanji = "〇零一二三四五六七八九十百千万"

// kanjiCounters は、漢数字に続けて書くと数になる助数詞（Python の _KANJI_COUNT_RE と同じ）。
var kanjiCounters = []string{"件", "棟", "地区", "枚", "割", "倍", "%", "％", "か所", "ヶ所", "カ所", "平方", "パーセント", "年"}

var kanjiCountRE = regexp.MustCompile(`[` + numeralKanji + `]+` + pySpaceClass + `*(?:` + counterAlternatives() + `)`)

func counterAlternatives() string {
	quoted := make([]string, len(kanjiCounters))
	for i, c := range kanjiCounters {
		quoted[i] = regexp.QuoteMeta(c)
	}
	return strings.Join(quoted, "|")
}

func isNumeralKanji(r rune) bool { return strings.ContainsRune(numeralKanji, r) }

// nonNumericWords は、漢数字を含むが、数を表さない語。漢数字を数として見る前に、この語を除く（長い語から当てる）。
// ここに無い語は、数として見て落とす側（安全なテンプレート）に倒れる。返答の見た目が変わるだけで、数は通らない。
var nonNumericWords = []string{
	"一覧", "一番", "一部", "一方", "一般", "一緒", "一定", "一致", "一帯", "一角", "一旦", "一応", "一層", "一体", "一種", "一括", "一環", "一貫",
	"一律", "一連", "一斉", "一新", "一目", "一例", "一戸建", "一切", "一変", "一歩", "一同", "一助", "一概", "一向", "一面", "一流", "一転", "一因",
	"一時", "一言", "一瞬", "一生", "もう一度",
	"唯一", "同一", "統一", "単一", "均一", "随一", "万一", "万が一", "十分", "十字", "十全", "万能", "万全", "万歳", "万人", "千差万別",
	"百科", "百貨", "九州", "四国", "四方", "三重", "千葉", "千代田", "八代", "八王子", "三角", "四角",
}

// englishNumberRE は、英語の数詞（一語ずつ。twenty-one は twenty と one）。\b は ASCII の語境界（日本語の文字は語の外）。
var englishNumberRE = regexp.MustCompile(`(?i)\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|` +
	`seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|trillion|dozen)\b`)

// isInvisible は、読み手に見えない文字（表示に幅を持たない書式文字・異体字選択子・フィラー）。数の途中に挟んで、数を区切って見せかけられる。
func isInvisible(r rune) bool {
	switch {
	case r < 0x20 && !isPySpace(r), r == 0x7F, r >= 0x80 && r < 0xA0 && !isPySpace(r), r == 0x2800: // 空白でない制御文字（NUL・BS・ESC・DEL など。幅ゼロで描かれうる）と、点字の空白
		return true
	case unicode.Is(unicode.Cf, r): // ゼロ幅スペース U+200B・ソフトハイフン U+00AD・ZWNJ/ZWJ・語結合子 U+2060・BOM U+FEFF・方向記号など
		return true
	case r == 0x034F, r == 0x115F, r == 0x1160, r == 0x17B4, r == 0x17B5, r == 0x3164, r == 0xFFA0: // 結合用の字素連結子・ハングルのフィラー・クメールの母音
		return true
	case r >= 0x180B && r <= 0x180D, r >= 0xFE00 && r <= 0xFE0F, r >= 0xE0100 && r <= 0xE01EF: // 異体字選択子
		return true
	}
	return false
}

// visibleText は、読み手に見える形の文: NFKC で揃えてから、不可視の文字を除く。数字の検査は、すべてこの形で読む
// （結果の文字列も同じ関数で読むので、両側で同じように数える）。
func visibleText(s string) string {
	s = norm.NFKC.String(s)
	if !strings.ContainsFunc(s, isInvisible) {
		return s
	}
	return strings.Map(func(r rune) rune {
		if isInvisible(r) {
			return -1
		}
		return r
	}, s)
}

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

// numberSpan は、文（rune の列）の中の、数字の連なり 1 つ。
type numberSpan struct {
	start, end int    // runes[start:end]
	raw        string // 文に書かれたまま（コンマ・小数点を含む）
	norm       string // 揃えた表記
}

// numberSpans は、文に出る数字の連なりを、位置つきで返す。
// Python の (?<![A-Za-z])\d+(?:,\d{3})*(?:\.\d+)? による finditer と同じ。後読み (?<![A-Za-z]) は、RE2 に無いので、手で走査する。
// 後読みは「その位置の直前が英字でない」だけなので、"F12" は、F の直後の 1 は外れるが、2 は（直前が数字なので）数字として拾われる
// （Python と同じ。結果の側の文字列も同じ関数で読むので、両側で同じように数える）。
func numberSpans(runes []rune) []numberSpan {
	var out []numberSpan
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
		raw := string(runes[i:j])
		out = append(out, numberSpan{start: i, end: j, raw: raw, norm: normalizeNumber(raw)})
		i = j
	}
	return out
}

// numberTokens は、文に出る数字の連なりを、揃えた表記で返す。文は、読み手に見える形（visibleText）で読む。
func numberTokens(text string) []string {
	var out []string
	for _, sp := range numberSpans([]rune(visibleText(text))) {
		out = append(out, sp.norm)
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

// numberScan は、返答文の検査の結果。
type numberScan struct {
	digits []string // 結果に無い数字の連なり（Python と同じ範囲）
	kanji  []string // 漢数字+助数詞（Python と同じ範囲。結果と照合せず落とす）
	extra  []string // Python が見逃す書き方: 助数詞の無い漢数字・英語の数詞・空白や不可視の文字で区切った数（上の README の違い）
}

// all は、見つかった全部。順は、Python の find_unsupported_numbers（数字・漢数字+助数詞）に、足した分を続ける。
func (s numberScan) all() []string {
	out := append([]string{}, s.digits...)
	out = append(out, s.kanji...)
	return append(out, s.extra...)
}

// placeNames は、地区名と区名（空でないもの）。返答文は、これを書いてよい。漢数字を含む名前（黒髪六丁目など）を、数として見ないために、
// 数字の検査へ渡す（GuardNumbers・findUnsupportedNumbers の known）。
func placeNames(areas []store.Area) []string {
	var out []string
	for _, a := range areas {
		if a.Name != "" {
			out = append(out, a.Name)
		}
		if a.Ward != "" {
			out = append(out, a.Ward)
		}
	}
	return out
}

// knownKanjiNames は、known（地区名・区名）のうち、漢数字を含むもの（含まない名前は、除かなくても検査に影響しない）。
func knownKanjiNames(known []string) []string {
	var out []string
	for _, k := range known {
		if k = visibleText(k); strings.ContainsFunc(k, isNumeralKanji) {
			out = append(out, k)
		}
	}
	return out
}

// maskWords は、words を、1 文字の仮の文字に替える（長い語から当てる）。
// 仮の文字は、数字でも漢数字でも空白でもないので、前後の漢数字をつなげも、助数詞につなげもしない（「三<一覧>件」は、三と件が離れる）。
func maskWords(text string, words []string) string {
	if len(words) == 0 {
		return text
	}
	sorted := append([]string{}, words...)
	sort.SliceStable(sorted, func(i, j int) bool { return utf8.RuneCountInString(sorted[i]) > utf8.RuneCountInString(sorted[j]) })
	pairs := make([]string, 0, 2*len(sorted))
	for _, w := range sorted {
		pairs = append(pairs, w, "\uFFFD")
	}
	return strings.NewReplacer(pairs...).Replace(text)
}

// hasCounterPrefix は、runes が、空白を挟んでもよい助数詞で始まるか（kanjiCountRE の後半と同じ）。
func hasCounterPrefix(runes []rune) bool {
	i := 0
	for i < len(runes) && isPySpace(runes[i]) {
		i++
	}
	rest := runes[i:]
	for _, c := range counterRunes {
		if len(rest) >= len(c) && slices.Equal(rest[:len(c)], c) {
			return true
		}
	}
	return false
}

var counterRunes = func() [][]rune {
	out := make([][]rune, len(kanjiCounters))
	for i, c := range kanjiCounters {
		out[i] = []rune(c)
	}
	return out
}()

// bareKanjiNumbers は、助数詞の付かない漢数字の連なり（助数詞つきは、kanjiCountRE が数える）。text は、数として見ない語を maskWords で除いたもの。
func bareKanjiNumbers(text string) []string {
	runes := []rune(text)
	var out []string
	for i := 0; i < len(runes); {
		if !isNumeralKanji(runes[i]) {
			i++
			continue
		}
		j := i
		for j < len(runes) && isNumeralKanji(runes[j]) {
			j++
		}
		if !hasCounterPrefix(runes[j:]) {
			out = append(out, string(runes[i:j]))
		}
		i = j
	}
	return out
}

// joinedNumbers は、空白だけで区切って並べた整数（「3 4」「1 234」）を、つなげた数（34・1234）にする。
// 読み手には、つなげた数に見えうる。小数（0.5 3）や、数のあいだに文字がある並び（「3 件 4 件」）は、つなげない。
// 不可視の文字で区切った数は、visibleText が取り除くので、1 つの数として numberSpans が読む。
func joinedNumbers(runes []rune, spans []numberSpan) []string {
	var out []string
	for i := 0; i < len(spans); {
		j := i
		raw := spans[i].raw
		for j+1 < len(spans) && !strings.Contains(spans[j].raw, ".") && spacesOnly(runes[spans[j].end:spans[j+1].start]) {
			j++
			raw += spans[j].raw
		}
		if j > i {
			out = append(out, normalizeNumber(raw))
		}
		i = j + 1
	}
	return out
}

// spacesOnly は、空でなく、すべて空白（Python の \s）であること。
func spacesOnly(runes []rune) bool {
	if len(runes) == 0 {
		return false
	}
	for _, r := range runes {
		if !isPySpace(r) {
			return false
		}
	}
	return true
}

// scanNumbers は、content にあって、結果（allowed）から出せない数（と、漢数字・英語の数詞）を集める。
// known は、数として見ない地区名・区名（漢数字を含む名前を、返答文は書いてよい）。
func scanNumbers(content string, allowed map[string]bool, known []string) numberScan {
	var s numberScan
	text := visibleText(content)
	runes := []rune(text)
	spans := numberSpans(runes)
	for _, sp := range spans {
		if !allowed[sp.norm] {
			s.digits = append(s.digits, sp.norm)
		}
	}
	names := knownKanjiNames(known)
	s.kanji = kanjiCountRE.FindAllString(maskWords(text, names), -1)
	for _, j := range joinedNumbers(runes, spans) {
		if !allowed[j] {
			s.extra = append(s.extra, j)
		}
	}
	s.extra = append(s.extra, bareKanjiNumbers(maskWords(text, append(append([]string{}, nonNumericWords...), names...)))...)
	for _, w := range englishNumberRE.FindAllString(text, -1) {
		s.extra = append(s.extra, strings.ToLower(w))
	}
	return s
}

// findUnsupportedNumbers は、content にあって、結果から出せない数字（と、漢数字・英語の数詞など）。空なら合格。実 LLM が書いた文に使う（強い検査）。
// known は、数として見ない地区名・区名（任意）。
func findUnsupportedNumbers(content string, results any, known ...string) []string {
	return scanNumbers(content, allowedNumbers(results), known).all()
}

// findUnsupportedNumbersLikePython は、Python の find_unsupported_numbers と同じ範囲（数字の連なりと、漢数字+助数詞だけ）。
// 模擬モデルの返答文（テンプレートに、結果の値を入れた文）に使う。模擬モデルは、返答の数字を結果からだけ作るので、強い検査は要らない。
// 強い検査にすると、利用者の語（「六本木」など、助数詞の無い漢数字）を写した断りの文が落ちて、Python と応答が変わる。
func findUnsupportedNumbersLikePython(content string, results any) []string {
	s := scanNumbers(content, allowedNumbers(results), nil)
	return slices.Concat(s.digits, s.kanji)
}

// GuardNumbers は、実 LLM が書いた返答文が合格なら、そのまま返す。満たさなければ、安全なテンプレートを返す（元の文は返さない）。replaced は、差し替えたか。
// 強い検査（助数詞の無い漢数字・英語の数詞・区切った数も落とす）。known は、数として見ない地区名・区名（漢数字を含む名前を、返答文は書いてよい。省略可）。
// 数字・本文は、ログに出さない（差し替えた回数だけ、呼び出し側が数える）。
func GuardNumbers(content string, results []Result, known ...string) (out string, replaced bool) {
	if len(findUnsupportedNumbers(content, genericOf(results), known...)) != 0 {
		return SafeTemplate, true
	}
	return stripPositionWords(content)
}

// 回答の並び（本文 → カード → 図）は、画面の幅やタブで変わりうるので、返答文に、カードや図の位置（上・下・右・左・上記・下記）を書かせない。
// 指示（gemini_model.go）でも言うが、モデルは確率的にしか守らないので、ここでも止める。
//   - 「上の/下のカード」のように、方向の語が、カード・図などの名前の直前にあるとき: 方向の語だけを取り除く（「カードのとおり」）。replaced は false（文は残る）。
//   - 「上記」「下記」: 取り除くと文が崩れるので、安全なテンプレートに替える（replaced は true）。
//
// 検査が止めるのは、数字と、この位置の語だけ。数字以外の主張（「最も多い」「過半」「確信度が分かれる」など）は、検査の外にある。
var (
	positionBeforeNounRE = regexp.MustCompile(`[上下右左](?:の|記の)(カード|図|表|グラフ|地図|一覧)`)
	positionAnywhereRE   = regexp.MustCompile(`[上下]記`)
)

func stripPositionWords(content string) (out string, replaced bool) {
	// 「以上の表」「以下の図」のような、位置ではない言い方（直前が「以」）は残す。RE2 に後読みは無いので、直前の文字を手で見る
	var b strings.Builder
	last := 0
	for _, m := range positionBeforeNounRE.FindAllStringSubmatchIndex(content, -1) {
		if r, _ := utf8.DecodeLastRuneInString(content[:m[0]]); r == '以' {
			continue
		}
		b.WriteString(content[last:m[0]])
		b.WriteString(content[m[2]:m[3]]) // 方向の語を除き、名前（カードなど）だけ残す
		last = m[1]
	}
	b.WriteString(content[last:])
	out = b.String()
	if positionAnywhereRE.MatchString(out) {
		return SafeTemplate, true
	}
	return out, false
}

// guardTemplateNumbers は、模擬モデルの返答文の検査。Python の guard_numbers と同じ範囲（findUnsupportedNumbersLikePython）。
func guardTemplateNumbers(content string, results []Result) (out string, replaced bool) {
	if len(findUnsupportedNumbersLikePython(content, genericOf(results))) == 0 {
		return content, false
	}
	return SafeTemplate, true
}
