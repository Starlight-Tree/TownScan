package chat

import (
	"reflect"
	"testing"
)

func TestNormalize(t *testing.T) {
	cases := map[string]string{
		"":            "",
		"  新築は　何件？\n": "新築は 何件?", // 前後の空白を除き、空白の連なりを半角 1 つに。全角の「？」は NFKC で半角の「?」
		"ＡＢＣ　１２３":     "abc 123", // 全角の英数 → 半角、小文字
		"ﾃﾞｰﾀ":        "データ",     // 半角カナ → 全角（濁点を合わせる）
		"c－１－２－３":     "c-1-2-3", // 全角のハイフン
		"①②":          "12",
		"ﬁ":           "fi",
		"㈱":           "(株)",
		"İ":           "i̇", // Python の lower() は 2 字にする
		"ΑΣ":          "ας", // 語の終わりの Σ は ς
		"ΣΑ":          "σα",
		"Σ":           "σ",
		"\x1c新築\x1f":  "新築", // Python は U+001C〜001F も空白と見る
		"a b":         "a b",
		"　 x 　":       "x",
	}
	for in, want := range cases {
		if got := normalize(in); got != want {
			t.Errorf("normalize(%+q) = %+q, 期待 %+q", in, got, want)
		}
	}
}

func TestRuleMatchesIsCaseInsensitiveAndWordAware(t *testing.T) {
	if !ruleSatellite.matches("Earth Engine の話") || !ruleSatellite.matches("EARTHENGINE") {
		t.Error("英字は、大文字小文字を区別しない")
	}
	if !ruleSatellite.matches("gee の話") || ruleSatellite.matches("衛星でなく、geeの話") != true {
		// 「衛星」を含むので、語の判定に関わらず一致する
		t.Error("「衛星」は一致するはず")
	}
	if ruleSatellite.matches("geeの話") {
		t.Error("geeの は、日本語の文字に続くので、語としては数えない（Python の \\b と同じ）")
	}
	if !ruleAccuracy.matches("f1 を教えて") || ruleAccuracy.matches("f1を教えて") {
		t.Error("f1 は、語の境目があるときだけ")
	}
	if !ruleList.matches("top 3") || ruleList.matches("laptop") {
		t.Error("top は、語のときだけ")
	}
	if ruleChitchat.matches("新規出現は何件？") {
		t.Error("ふつうの質問は、雑談ではない")
	}
}

func TestIDMatching(t *testing.T) {
	cases := []struct {
		text string
		want string // 最初の候補 ID（無ければ ""）
	}{
		{"c-226249-105759-2 の写真", "c-226249-105759-2"},
		{"c-226249-105759-2の写真", "c-226249-105759-2"}, // 日本語に直接つながる
		{"候補c-1-2-3の写真", "c-1-2-3"},
		{"（c-1-2-3）", "c-1-2-3"},
		{"xc-1-2-3", ""},       // 前が英数字: 別の語の一部
		{"c-1-2-3x", ""},       // 後が英数字
		{"c-1-2-3-4", ""},      // 後がハイフン
		{"-c-1-2-3", ""},       // 前がハイフン
		{"c-1-2", ""},          // 3 つ目が無い
		{"c-1-2-3c-4-5-6", ""}, // 前の ID の直後・直前が英数字
		{"c-1-2-3 c-4-5-6", "c-1-2-3"},
		{"c-1-2-3x c-4-5-6", "c-4-5-6"}, // 外れた一致のあとに、正しい一致がある
		{"abc-1-2-3 c-9-9-9", "c-9-9-9"},
		{"", ""},
	}
	for _, c := range cases {
		if got := findCandidateID(c.text); got != c.want {
			t.Errorf("findCandidateID(%q) = %q, 期待 %q", c.text, got, c.want)
		}
	}
	if got := findAreaIDs("z18-1-1と z18-2-2、az18-3-3、z18-4-4x"); !reflect.DeepEqual(got, []string{"z18-1-1", "z18-2-2"}) {
		t.Errorf("findAreaIDs = %q", got)
	}
	if got := replaceIDs(candidateIDRE, "a c-1-2-3 b xc-4-5-6 c-7-8-9", "_"); got != "a _ b xc-4-5-6 _" {
		t.Errorf("replaceIDs = %q", got)
	}
}

func TestOtherPlaces(t *testing.T) {
	cases := map[string]string{
		"福岡の新築":       "福岡",
		"熊本県の新築":      "熊本",
		"熊本市全域の新築":    "熊本", // 熊本は対象外になった（対象はフランス）
		"熊本市全体の新築":    "熊本",
		"福岡市全域":       "福岡", // いちばん左の一致
		"渋谷市全域":       "市全域",
		"市全体":         "市全体",
		"熊本市全域と渋谷市全体": "熊本", // いちばん左の一致
		"北九州":         "北九州",
		"東京と大阪":       "東京",
		"県全域":         "県全域",
		"":            "",
		"新築は何件？":      "",
	}
	for in, want := range cases {
		if got := otherPlaces(in); got != want {
			t.Errorf("otherPlaces(%q) = %q, 期待 %q", in, got, want)
		}
	}
}

func TestIsOwnPlaceWord(t *testing.T) {
	own := []string{"フランス", "パリ近郊", "市内", "中心部", "パリ南西の近郊", "全域", "対象", "対象エリア", "解析範囲", "以前", "過去", "新築", "最新", "オー・ド・セーヌ県", "全エリア", "地域", ""}
	for _, w := range own {
		if !isOwnPlaceWord(w) {
			t.Errorf("isOwnPlaceWord(%q) = false", w)
		}
	}
	other := []string{"渋谷", "渋谷全域", "渋谷エリア", "六本木ヒルズ", "熊本", "熊本市内", "熊本城", "福岡市内", "手取本町", "ニューヨーク"}
	for _, w := range other {
		if isOwnPlaceWord(w) {
			t.Errorf("isOwnPlaceWord(%q) = true", w)
		}
	}
}

// 対象をフランスに変えて足した・外した語（ADR 0015）。
func TestFranceWords(t *testing.T) {
	for _, w := range []string{"フランス", "パリ"} {
		if !ruleDomain.matches(w) {
			t.Errorf("DOMAIN が %q に当たらない", w)
		}
	}
	if ruleDomain.matches("熊本") {
		t.Error("DOMAIN が熊本に当たる")
	}
	for _, q := range []string{"市ごとに比べて", "市町村ごとの件数"} {
		if !ruleCompareStrong.matches(q) {
			t.Errorf("COMPARE_STRONG が %q に当たらない", q)
		}
	}
}
