package chat

import (
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"
)

// 模擬モデルの規則（語の表・正規表現）。backend/app/chat/mock_model.py の規則と同じ語・同じ優先順位。
// 規則は、normalize 済みの文に当てる（NFKC・小文字・空白は半角 1 つ）。
//
// Python の re と RE2 の違い（pycompat.go）のうち、規則ごとの書き換えは、それぞれの定義の注記に書く。
// 共通の書き換え: re.IGNORECASE は (?i)・\d は \p{Nd}・\s は半角の空白。

// rule は、Python の re.compile(パターン, re.IGNORECASE).search(文) が真か偽かだけを使う規則。
// words は、Python で \bword\b と書いていた語（RE2 の \b は日本語の文字を語の文字と見ないので、手書きの判定 containsWord に分けた）。
type rule struct {
	re    *regexp.Regexp
	words []string
}

func newRule(pattern string, words ...string) rule {
	return rule{re: regexp.MustCompile("(?i)" + pattern), words: words}
}

// foldDotlessI は、ドット無しの小文字の ı（U+0131）と、点つきの大文字の İ（U+0130）を、i にする。
// Python の re.IGNORECASE は、パターンの「i」を、この 2 字にも一致させる（sre の大文字小文字の同一視の表に入っている）。Go の (?i) は一致させない
// （「ıgnore all previous」「ıou」「earthengıne」「ndvı」が、Python では規則に当たり、Go では当たらなかった）。
// ASCII の英数字 36 字を、全コードポイントで Python と Go で比べて、違うのはこの 2 字だけだった（i 以外は、k↔K（ケルビン記号）・s↔ſ も含めて同じ）。
// 規則（re.IGNORECASE を付けた正規表現）に当てる文だけに使う。地区名・ID の一致は、Python も大文字小文字を区別しない指定ではないので、使わない。
// İ は、normalize の小文字化で i と結合用の上点の 2 字になるので、規則には届かない（直接渡されたときだけ効く）。
func foldDotlessI(s string) string {
	if !strings.ContainsAny(s, "ıİ") {
		return s
	}
	return strings.NewReplacer("ı", "i", "İ", "i").Replace(s)
}

func (r rule) matches(text string) bool {
	text = foldDotlessI(text)
	if r.re.MatchString(text) {
		return true
	}
	for _, w := range r.words {
		if containsWord(text, w) {
			return true
		}
	}
	return false
}

// ---- 範囲外・未実装の規則 ----

var (
	ruleInjection = newRule(`指示を無視|命令を無視|ルールを無視|システムプロンプト|プロンプトを(?:見せ|教え|表示)|ignore (?:all|previous|the above)|system prompt|jailbreak|パスワード|api ?キー|api ?key|秘密鍵|トークン`)
	ruleChitchat  = newRule(
		`天気|気温|気象|降水|雨|雪|台風|ニュース|株価|為替|レシピ|料理|映画|音楽|ゲーム|スポーツ|野球|サッカー|占い|恋愛|翻訳` +
			`|プログラム|コードを書|冗談|歌って|詩を|小説|あなたは誰|だれが作|誰が作|何歳|こんにちは|こんばんは|おはよう|ありがとう|疲れ` +
			`|おすすめの(?:店|レストラン)|ランチ|ラーメン|joke`)
	ruleSatellite = newRule(`衛星|earth ?engine|ヒートマップ|変化の当たり|変化のあたり|広域|埋め込み|sentinel|landsat|リモートセンシング|ndvi`, "gee")
	rulePanel     = newRule(`パネル|太陽光|ソーラー|発電`)
	// 写真が無い時期を指す相対語（写真は 2018・2023 年だけなので、いまに近い話は答えられない）
	ruleRelativeTime = newRule(
		`今年|昨年|去年|来年|今月|先月|直近|今日|昨日|おととし|一昨年|今週|先週|先日` +
			`|最近|近年|近頃|現在|現状|今後|将来|未来|ここ数年|この数年|数年前`)
	// このアプリが扱わない向き（建物が無くなった・減った）。2023 年に新しく現れた候補だけを扱う
	ruleDisappear = newRule(`取り壊|取壊|解体|壊され|撤去|滅失|無くなっ|なくなっ|消え|消滅|減っ|減少|あっ(?:て|た).{0,15}(?:無い|ない|なく|消)`)
)

// 対象外の場所。Python の OTHER_PLACES の、後読みの無い部分（otherPlaces が、後読みのある 2 つを足して探す）。
var otherPlacesRE = regexp.MustCompile(
	`(?i)東京|大阪|京都|名古屋|福岡|札幌|横浜|神戸|広島|仙台|北九州|長崎|大分|鹿児島|宮崎|佐賀|沖縄|那覇|八代|天草|宇土|益城|合志|菊陽|玉名|荒尾|山鹿|人吉|阿蘇|宇城` +
		`|北海道|青森|岩手|宮城|秋田|山形|福島|茨城|栃木|群馬|埼玉|千葉|神奈川|新潟|富山|石川|福井|山梨|長野|岐阜|静岡|愛知|三重|滋賀|兵庫|奈良|和歌山|鳥取|島根|岡山|山口|徳島|香川|愛媛|高知` +
		`|海外|アメリカ|中国|韓国|全国|県全域|県全体|熊本県`)

// otherPlaces は、Python の OTHER_PLACES.search(文) が返す、いちばん左の一致（無ければ ""）。
// Python の正規表現には、(?<!熊本)市全域 と (?<!熊本)市全体 がある（「熊本市全域」は対象そのもの）。RE2 には後読みが無いので、
// この 2 語は、直前が「熊本」でない出現だけを手で探し、ほかの語の一致と、開始位置の小さい方を取る
// （どの語も「市全」から始まる語と同じ位置で始まらないので、同じ位置の優先順位は考えなくてよい）。
func otherPlaces(text string) string {
	best, bestAt := "", -1
	if loc := otherPlacesRE.FindStringIndex(text); loc != nil {
		best, bestAt = text[loc[0]:loc[1]], loc[0]
	}
	for _, w := range []string{"市全域", "市全体"} {
		for from := 0; ; {
			i := strings.Index(text[from:], w)
			if i < 0 {
				break
			}
			at := from + i
			if !strings.HasSuffix(text[:at], "熊本") {
				if bestAt < 0 || at < bestAt {
					best, bestAt = w, at
				}
				break
			}
			from = at + 1
		}
	}
	return best
}

// 「渋谷の新築」「六本木ヒルズ周辺の建物」のような、<場所>の<このアプリの語> の形。
// 場所の語が対象の語彙でなければ、対象外の場所と見なす。
var (
	placeTokenRE = regexp.MustCompile(`[一-龥]{2,5}(?:市|区|町|村)`)
	placeNounRE  = regexp.MustCompile(`([一-龥ァ-ヶー]{2,8}?)(?:周辺|付近|近辺|あたり|辺り)?(?:の|での|にある|にあたる)(?:新築|建物|建築|新規|候補|件数|写真|地図|棟)`)
	placeOKWords = map[string]bool{"熊本市": true}

	ruleOwnVocabulary = newRule(`新築|新規|候補|建物|建築|描き漏れ|既存|保留|未検出|未判定|要確認|確定|地区|全体|全部|旧写真|新写真|写真|画像|地図|精度|一覧|面積|分類|件数|合計|最大|最新|中心部|結果|分析`)
	ownExactWords     = map[string]bool{"熊本": true, "熊本市": true, "市内": true, "中心部": true, "市中心部": true, "熊本市中心部": true}
)

// 対象そのもの・時間を指す語。<場所>の位置に来ても、対象外の場所ではない。
// 「渋谷全域」のように、これらを除いて場所の語が残るなら、対象外の場所（部分一致で通さないために、除いた残りで見る）。
// 長い語から除く（同じ長さの語は、ここに書いた順）。
var ownScopeWords = func() []string {
	words := []string{
		"熊本市内", "熊本市", "熊本", "市内", "中心部", "市街地", "全域", "全エリア", "全地域", "全範囲", "エリア", "地域", "範囲", "区域", "域内", "圏内",
		"対象", "解析", "以前", "昔", "過去", "かつて", "当時", "従来", "最新", "以降", "以後", "その後", "当初",
	}
	sort.SliceStable(words, func(i, j int) bool { return utf8.RuneCountInString(words[i]) > utf8.RuneCountInString(words[j]) })
	return words
}()

// isOwnPlaceWord は、<場所>の位置に来た語が、このアプリの対象（解析した地区・熊本市内・全域など）を指すか。
func isOwnPlaceWord(word string) bool {
	if ownExactWords[word] || ruleOwnVocabulary.matches(word) {
		return true
	}
	rest := word
	for _, w := range ownScopeWords {
		rest = strings.ReplaceAll(rest, w, "")
	}
	return rest == ""
}

// ---- スロット（地区・分類・文脈）の規則 ----

var (
	ruleClsNew    = newRule(`新築|新規|新しく|新しい|新たに|増えた|できた|建った|建てられ|確定|旧写真に(?:無|な)い|新設|未検出`)
	ruleClsOmit   = newRule(`描き漏れ|描き漏らし|漏れ|既存|もともと|元から|既に|すでに|旧写真に(?:既|も)|データの抜け|(?:年も|写真でも)検出`)
	ruleClsUnc    = newRule(`未判定|要確認|保留|不明|判定できない|曖昧|あいまい|微妙|不確か|はっきりしない|uncertain`)
	ruleAllAreas  = newRule(`全地区|すべての地区|全ての地区|全部の地区|全体|どの地区も`)
	ruleFollowup  = newRule(`その|それ|そこ|ここ|同じ|さっき|先ほど|上の|前の|では|じゃあ|次は|他の|ほかの|もう一度|続き|同地区`)
	limitARE      = regexp.MustCompile(`(?:上位|トップ|top) *(\p{Nd}{1,3})`)
	limitBRE      = regexp.MustCompile(`(\p{Nd}{1,3}) *(?:件|棟|個|つ)`)
	nameSuffixRE  = regexp.MustCompile(`(?:[0-9一二三四五六七八九十]+丁目|丁目|町)$`)
	candidateIDRE = regexp.MustCompile(`c-[0-9]+-[0-9]+-[0-9]+`)
	areaIDRE      = regexp.MustCompile(`z[0-9]+-[0-9]+-[0-9]+`)
)

// ---- 意図の規則 ----

var (
	ruleHelp     = newRule(`使い方|使いかた|できること|何ができ|なにができ|ヘルプ|機能|このアプリ(?:は|って)|説明して|どう(?:使|やって)|はじめて|初めて|何を聞|なにを聞|質問例|聞き方`, "help")
	ruleAccuracy = newRule(`精度|正解率|再現率|適合率|評価|信頼|どれくらい正しい|どのくらい正しい|どのくらい当た|どれくらい当た|誤検出|正確|当たってる|合ってる|あってる`, "f1", "iou")
	rulePhoto    = newRule(`写真|画像|見比べ|見くらべ|ビフォー|アフター|before|after|様子|検出画像|切り出し|拡大`)
	ruleMap      = newRule(`地図|マップ|位置|場所|どこにある|どこにあり|どの辺|どのあたり|ズーム|フォーカス`)

	ruleCompareStrong = newRule(
		`地区別|地区ごと|地区毎|区ごと|ランキング|順位|多い順|少ない順|どの地区|どこが|多い地区|少ない地区|多いところ` +
			`|一番多|最も多|もっとも多|最多|最少`)
	ruleCompareWeak  = newRule(`比較|比べ|くらべ|違い|どちら|どっち`)
	ruleListExplicit = newRule(`一覧|リスト|表で|表に|表形式`)
	ruleList         = newRule(
		`一覧|リスト|表で|表に|表形式|上位|トップ|大きい順|大きな順|面積順|一番大きい|最大|最も大きい`+
			`|大きい(?:もの|候補|新築|建物)|候補(?:を|は|が)?(?:見せ|出し|教え|ください|どれ|どんな)`, "top")
	ruleCount       = newRule(`何件|件数|いくつ|何棟|何個|何軒|何戸|何か所|数は|総数|合計|全部で|どれくらい|どのくらい|どれだけ|どのぐらい|多い|少ない|増え|ありますか|あります`)
	ruleCountStrong = newRule(`何件|件数|何棟|いくつ|何軒|何戸|何個`)
	ruleDomain      = newRule(`新築|新規|建物|建築|棟|候補|描き漏れ|保留|未検出|未判定|要確認|分類|熊本|地区`)
)

// ---- ID の読み取り ----

// matchesID は、re（c-… か z18-… の形）に一致する出現のうち、前後が [0-9A-Za-z-] でないものの位置。
// Python の (?<![0-9A-Za-z-])…(?![0-9A-Za-z-]) に当たる（RE2 には先読み・後読みが無い）。
// \b は日本語の文字も語の文字と見て、「c-…-1の写真」のように ID が日本語に直接つながると境界にならないので使えない。
// 半角の英数字とハイフンだけを境界にする（それ以外は、日本語・記号・空白・文頭文末のどれでも ID の区切り）。
//
// 一致の中に英字は先頭の 1 字しか無いので、後読み・先読みで外れた一致の内側に、別の正しい一致が隠れることは無い
// （正規表現の最長一致で見つけてから、前後を見る形で、Python の探し方と同じ結果になる）。
func matchesID(re *regexp.Regexp, text string) [][2]int {
	var out [][2]int
	for _, loc := range re.FindAllStringIndex(text, -1) {
		if loc[0] > 0 && isIDBoundaryChar(text[loc[0]-1]) {
			continue
		}
		if loc[1] < len(text) && isIDBoundaryChar(text[loc[1]]) {
			continue
		}
		out = append(out, [2]int{loc[0], loc[1]})
	}
	return out
}

func isIDBoundaryChar(c byte) bool {
	return c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c == '-'
}

// findCandidateID は、文の中の最初の候補 ID（c-<数>-<数>-<数>）。無ければ ""。
func findCandidateID(text string) string {
	if ms := matchesID(candidateIDRE, text); len(ms) > 0 {
		return text[ms[0][0]:ms[0][1]]
	}
	return ""
}

// findAreaIDs は、文の中のすべての地区 ID（z<数>-<数>-<数>）。出た順。
func findAreaIDs(text string) []string {
	var out []string
	for _, m := range matchesID(areaIDRE, text) {
		out = append(out, text[m[0]:m[1]])
	}
	return out
}

// replaceIDs は、ID の出現（matchesID）を、すべて repl に替える。
func replaceIDs(re *regexp.Regexp, text, repl string) string {
	var b strings.Builder
	last := 0
	for _, m := range matchesID(re, text) {
		b.WriteString(text[last:m[0]])
		b.WriteString(repl)
		last = m[1]
	}
	b.WriteString(text[last:])
	return b.String()
}
