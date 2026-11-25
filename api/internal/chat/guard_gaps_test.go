package chat

import (
	"slices"
	"strings"
	"testing"
)

// Python が見逃す書き方（助数詞の無い漢数字・英語の数詞・空白や不可視の文字で区切った数）を塞いだ検査（guard.go。README の「Python との意図した違い」）。
// 実モデル（Gemini）の返答は、数字の検査だけが頼りなので、結果に無い数を通さない。正当な返答は、誤って落とさない。
// 数字の連なりと漢数字+助数詞の、Python と同じ部分は、guard_test.go と golden_test.go が見る。

// guardRes は、結果に 3・4・7（と 2018・2023 の年）がある場合。
const guardRes = `[{"type":"count","total":3,"breakdown":[{"value":4},{"value":7}],"provenance":{"photo_years":[2018,2023]}}]`

func bad(t *testing.T, content string, known ...string) []string {
	t.Helper()
	return findUnsupportedNumbers(content, generic(t, guardRes), known...)
}

// 助数詞の表に無い漢数字（「七軒」「三千円」「七つ」）は、結果に 7 があっても、落とす（漢数字は、結果と照合しない。助数詞つきと同じ）。
func TestGuardKanjiNumbersWithoutACounterAreCaught(t *testing.T) {
	for in, want := range map[string]string{
		"七軒あります":   "七",
		"三千円です":    "三千",
		"候補は七つです":  "七",
		"二〇二三 の写真": "二〇二三",
		"百二十":      "百二十",
		"第一に":      "一",
		"最大は千です":   "千",
		"全部で十二":    "十二",
		"〇です":      "〇",
		"三\u200b軒": "三", // 不可視の文字を挟んでも、同じ
		"七\u00ad軒": "七",
		"三一覧":      "三", // 数でない語の隣でも、数は数
		"一覧のほか三":   "三",
		"二千二十四番町":  "二千二十四",
		"九州の三軒":    "三",
		"三万一":      "三", // 「万一」は語として除くが、前の三は数
		"一人暮らし":    "一",
	} {
		got := bad(t, in)
		if !slices.Contains(got, want) {
			t.Errorf("%q: bad = %q、期待に %q を含む", in, got, want)
		}
	}
	// 助数詞つきは、これまでどおり、kanji（Python と同じ）に 1 回だけ数える
	scan := scanNumbers("三十件と七軒", map[string]bool{}, nil)
	if !slices.Equal(scan.kanji, []string{"三十件"}) || !slices.Equal(scan.extra, []string{"七"}) {
		t.Errorf("scan = %+v", scan)
	}
}

// 数を表さない語は、漢数字を含んでも、数として見ない。
func TestGuardNonNumericWordsAreAllowed(t *testing.T) {
	for _, w := range nonNumericWords {
		for _, in := range []string{w, "結果は" + w + "です。", w + "のほか、" + w} {
			if got := bad(t, in); len(got) != 0 {
				t.Errorf("%q: bad = %q", in, got)
			}
		}
	}
	for _, ok := range []string{
		"結果は一覧のとおりです。", "一番大きい候補です。", "一部の地区に集中しています。", "十分な数ではありません。", "万が一の場合は、もう一度お試しください。",
		"このアプリでは、天気については、お答えできません。", "写真は 2018 年と 2023 年です。", "新規出現の候補は 3 件、描き漏れは 4 件です。",
		"件数・一覧・写真の見比べ・精度です。", "唯一の候補です。", "九州の外です。", "統一されていません。", "一時的に応答できません。",
	} {
		if got := bad(t, ok); len(got) != 0 {
			t.Errorf("%q が落ちた: %q", ok, got)
		}
	}
}

// 地区名・区名の中の漢数字は、数として見ない（known）。名前の一部だけ・名前でない書き方は、数。
func TestGuardKnownNamesAreNotNumbers(t *testing.T) {
	names := []string{"黒髪六丁目", "二本木四丁目", "三年町", "中央区"}
	for _, in := range []string{"黒髪六丁目と二本木四丁目を比べました。", "三年町は 3 件です。"} {
		if got := bad(t, in, names...); len(got) != 0 {
			t.Errorf("%q: bad = %q", in, got)
		}
		if got := bad(t, in); len(got) == 0 {
			t.Errorf("%q: 名前を知らないのに通った", in)
		}
	}
	for _, in := range []string{"六丁目の候補です。", "黒髪六丁目の六件です。", "三年です。", "二本木四丁目四軒"} {
		if got := bad(t, in, names...); len(got) == 0 {
			t.Errorf("%q が通った", in)
		}
	}
	// 長い名前から当てる（「二本木四丁目」と「四丁目」）
	if got := bad(t, "二本木四丁目", "四丁目", "二本木四丁目"); len(got) != 0 {
		t.Errorf("長い名前: %q", got)
	}
	// 漢数字を含まない名前は、渡しても何も変わらない
	if got := bad(t, "合成町は七軒です。", "合成町"); len(got) == 0 {
		t.Error("名前の外の漢数字が通った")
	}
}

func TestGuardEnglishNumberWordsAreCaught(t *testing.T) {
	for _, in := range []string{
		"There are seven.", "SEVEN", "Seven candidates", "twenty-one", "one hundred", "候補は seven 件", "ｓｅｖｅｎ", "a dozen", "Thousand", "ten", "zero",
		"s\u200beven", "eleven.", "(three)", "ten, nine",
	} {
		if got := bad(t, in); len(got) == 0 {
			t.Errorf("%q が通った", in)
		}
	}
	for _, ok := range []string{"someone", "phone", "none", "often", "tone", "stone", "bone", "list_candidates", "count_one", "TownScan と Gemini", "F1 と IoU", "weight", "tennis", "onesie"} {
		if got := bad(t, ok); len(got) != 0 {
			t.Errorf("%q が落ちた: %q", ok, got)
		}
	}
}

// 空白・不可視の文字で区切った数は、つなげた数に見える。不可視の文字は取り除いて数え、空白で区切った整数は、つなげた数も確かめる。
func TestGuardNumbersSplitBySpacesOrInvisibleCharactersAreCaught(t *testing.T) {
	// 結果に 3 と 4 はあるが、34 は無い
	for _, in := range []string{
		"3 4", "3  4", "3\u00a04", "3\u30004", "3\u20094", "3\u202f4", "3\n4", "3\t4", "3\u200b4", "3\u00ad4", "3\u20604", "3\ufeff4", "3\u200c4", "3\u200d4", "3\u200e4",
		"3\u200b \u200b4", "3\u034f4", "3\ufe0f4", "３\u200b４", "3 4 件", "3\u200b4 件", "候補は 3 4 です", "3 4 7", "7 7",
	} {
		if got := bad(t, in); len(got) == 0 {
			t.Errorf("%q が通った", in)
		}
	}
	// 結果に 34 もあれば、通す（3 も 4 も 34 も、結果にある）
	res := generic(t, `[{"a":3,"b":4,"c":34}]`)
	for _, in := range []string{"3 4", "3\u200b4", "34", "3 件と 4 件と 34 件"} {
		if got := findUnsupportedNumbers(in, res); len(got) != 0 {
			t.Errorf("%q: bad = %q", in, got)
		}
	}
	// つなげない: 数のあいだに文字がある・コンマで区切る・年
	for _, ok := range []string{"3 件、4 件", "3 と 4", "3、4", "3-4", "4 件と 3 件", "2018 年と 2023 年", "新規出現 3 件 / 描き漏れ 4 件"} {
		if got := bad(t, ok); len(got) != 0 {
			t.Errorf("%q が落ちた: %q", ok, got)
		}
	}
	// コンマ（半角）で区切った 3,4 は、別々の数（桁区切りは 3 桁）。小数のあとは、つなげない
	if got := bad(t, "3,4 件"); len(got) != 0 {
		t.Errorf("3,4: %q", got)
	}
	res = generic(t, `[{"a":0.5,"b":3,"c":4}]`)
	if got := findUnsupportedNumbers("0.5 3 と 3 4.0", res); len(got) != 1 || got[0] != "34" {
		t.Errorf("小数のあとは、つなげない（3 4.0 は 34 になる）: %q", got)
	}
	// 結果の側も、不可視の文字を取り除いて読む（結果に「3<ZWSP>4」とあれば、34）
	res = generic(t, "[{\"s\":\"3\u200b4 件\"}]")
	if got := findUnsupportedNumbers("34 件", res); len(got) != 0 {
		t.Errorf("結果の側: %q", got)
	}
	// 慎重な側: 1 と 234 が個別には結果に無いとき、「1 234」は、1234 が結果にあっても落とす
	res = generic(t, `[{"total":1234}]`)
	if got := findUnsupportedNumbers("1 234 件", res); len(got) == 0 {
		t.Error("空白の桁区切りが通った（慎重な側に倒す）")
	}
	if got := findUnsupportedNumbers("1,234 件", res); len(got) != 0 {
		t.Errorf("コンマの桁区切り: %q", got)
	}
}

func TestVisibleText(t *testing.T) {
	for in, want := range map[string]string{
		"":                       "",
		"abc":                    "abc",
		"３\u200b４":               "34",
		"a\u00adb\u2060c\ufeffd": "abcd",
		"ｓｅｖｅｎ":                  "seven",
		"７\ufe0f⃣":               "7⃣",  // キーキャップの絵文字: 異体字選択子を除く
		"́":                      "́",   // 結合文字は、見える（除かない）
		"a b":                    "a b", // 空白は残す
		"\u200b":                 "",
		"㌀":                      "アパート",
	} {
		if got := visibleText(in); got != want {
			t.Errorf("visibleText(%+q) = %+q、期待 %+q", in, got, want)
		}
	}
	if got := numberTokens("3\u200b4 と 5\u00ad6"); !slices.Equal(got, []string{"34", "56"}) {
		t.Errorf("numberTokens = %q", got)
	}
}

const guardResWide = `[{"type":"count","total":4,"title":"件数","breakdown":[{"value":3},{"value":1234}],"area_m2":302.3,"f1":0.7634,"candidate_id":"c-226249-105759-2","provenance":{"photo_years":[2018,2023]}}]`

// 正当な返答（結果にある数・年・「3 件」など）を、誤って落とさない。
func TestGuardLegitimateRepliesStillPass(t *testing.T) {
	res := generic(t, guardResWide)
	for _, ok := range []string{
		"全地区の新規出現の候補は 4 件です。機械が写真から見つけた候補で、確定ではありません。",
		"2018 年と 2023 年の写真を比べました。",
		"面積は約 302 m² です。",
		"F1 は 0.76（76 %）です。",
		"候補 c-226249-105759-2 の写真です。",
		"地区ごとの件数を比べました。合成町が 3 件、試験町が 3 件、仮想町が 3 件です。",
		"1,234 件のうち、3 件を表示しています。",
		"結果は下のカードのとおりです。数字はカードに表示された値を見てください。",
		"",
	} {
		if got := findUnsupportedNumbers(ok, res); len(got) != 0 {
			t.Errorf("%q が落ちた: %q", ok, got)
		}
	}
}

// 地区名を渡せば、漢数字を含む名前の返答も、本文が残る。
func TestGuardNumbersWithKnownNames(t *testing.T) {
	ok := []Result{CountResult{Type: "count", Title: "件数", Total: 4}}
	if out, replaced := GuardNumbers("黒髪六丁目は 4 件です。", ok, "黒髪六丁目"); out != "黒髪六丁目は 4 件です。" || replaced {
		t.Errorf("名前つき: %q %v", out, replaced)
	}
	if out, replaced := GuardNumbers("黒髪六丁目は 4 件です。", ok); out != SafeTemplate || !replaced {
		t.Errorf("名前なし: %q %v", out, replaced)
	}
	if out, replaced := GuardNumbers("黒髪六丁目は七軒です。", ok, "黒髪六丁目"); out != SafeTemplate || !replaced {
		t.Errorf("名前の外の数: %q %v", out, replaced)
	}
	// 安全なテンプレート自身は、どの検査にも通る
	if bad := findUnsupportedNumbers(SafeTemplate, nil); len(bad) != 0 || strings.Contains(SafeTemplate, "一") {
		t.Errorf("安全なテンプレート: %q", bad)
	}
}

// 空白でない制御文字（NUL・ESC・DEL）と点字の空白は、数字の間に挟んでも、つなげた数として読む（幅ゼロで描かれて「34」に見えうる）。
func TestGuardControlCharactersAndBrailleBlankBetweenDigitsAreCaught(t *testing.T) {
	for _, in := range []string{"3\x004 件", "3\x1b4 件", "3\x7f4 件", "3\u28004 件"} {
		if got := bad(t, in); len(got) != 1 || got[0] != "34" {
			t.Errorf("%q: %v", in, got)
		}
	}
}
