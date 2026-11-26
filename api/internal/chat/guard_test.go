package chat

import (
	"bytes"
	"encoding/json"
	"slices"
	"strings"
	"testing"
	"unicode"

	"townscan/api/internal/pyjson"
)

// 数字の検査（guard.go）の単体テスト（backend/tests/test_guard.py と同じ観点）。
// Python と同じ出力になることは、golden_test.go（Python が出した期待値）も確かめる。

// generic は、JSON の文字列を、数字の検査が歩く形（map・[]any・string・json.Number・bool・nil）にする。
func generic(t *testing.T, s string) any {
	t.Helper()
	dec := json.NewDecoder(bytes.NewReader([]byte(s)))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		t.Fatal(err)
	}
	return v
}

const guardResults = `[{"type":"count","title":"新規出現候補の件数（全地区）","total":1234,` +
	`"breakdown":[{"key":"confirmed_new","label":"新規出現","value":3},{"key":"x","label":"y","value":0}],` +
	`"filter":{"area_id":"z18-226249-105759"},"provenance":{"photo_years":[2014,2024],"run_id":"synthetic-test","model":"m"}}]`

func TestGuardNumbersFromResultsPass(t *testing.T) {
	res := generic(t, guardResults)
	text := "全地区の候補は 1,234 件です。内訳は新規出現 3 件、2014 年と 2024 年の写真から。"
	if bad := findUnsupportedNumbers(text, res); len(bad) != 0 {
		t.Errorf("bad = %v", bad)
	}
}

func TestGuardFabricatedNumbersAreCaught(t *testing.T) {
	res := generic(t, guardResults)
	cases := []struct {
		text string
		want []string
	}{
		{"全地区の候補は 9999 件です。", []string{"9999"}},
		{"候補は１２３４件です", nil}, // NFKC で 1234 に揃う
		{"候補は 5 件です", []string{"5"}},
		{"候補は９９９件です", []string{"999"}},
		{"候補は三十件です", []string{"三十件"}},
		{"二〇二三年の写真です", []string{"二〇二三年"}},
		{"一覧を表示します。一番大きい候補です。", nil},              // 「一覧」「一番」は、助数詞が続かない
		{"三 件と 十\u3000棟", []string{"三 件", "十 棟"}}, // 空白は NFKC で半角になる
		{"F1 と m2 と z18 は記号", nil},
		{"0.91 です", []string{"0.91"}},
		{"1,234,567 件", []string{"1234567"}},
		{"", nil},
	}
	for _, c := range cases {
		got := findUnsupportedNumbers(c.text, res)
		if !slices.Equal(got, c.want) && !(len(got) == 0 && len(c.want) == 0) {
			t.Errorf("findUnsupportedNumbers(%q) = %q, 期待 %q", c.text, got, c.want)
		}
	}
}

func TestGuardNumbersReplacesWithTheSafeTemplate(t *testing.T) {
	ok := []Result{CountResult{Type: "count", Title: "件数", Total: 4}}
	if out, replaced := GuardNumbers("候補は 4 件です。", ok); out != "候補は 4 件です。" || replaced {
		t.Errorf("合格: %q %v", out, replaced)
	}
	out, replaced := GuardNumbers("候補は 424242 件です。", ok)
	if out != SafeTemplate || !replaced || strings.Contains(out, "424242") {
		t.Errorf("不合格: %q %v", out, replaced)
	}
	// 結果が無いのに数字がある → 落ちる。数字が無ければ通る
	if out, _ := GuardNumbers("候補は 3 件です", nil); out != SafeTemplate {
		t.Errorf("結果なし・数字あり: %q", out)
	}
	if out, replaced := GuardNumbers("結果はありません", nil); out != "結果はありません" || replaced {
		t.Errorf("結果なし・数字なし: %q", out)
	}
}

func TestIDsInResultStringsAreAllowed(t *testing.T) {
	res := generic(t, `[{"type":"detection_image","candidate_id":"c-226249-105759-1","images":[{"year":2014},{"year":2024}]}]`)
	if bad := findUnsupportedNumbers("候補 c-226249-105759-1 の 2014 年と 2024 年", res); len(bad) != 0 {
		t.Errorf("bad = %v", bad)
	}
	if bad := findUnsupportedNumbers("候補 c-226249-105759-2 です", res); !slices.Equal(bad, []string{"2"}) { // 末尾の番号を取り違えている
		t.Errorf("bad = %v", bad)
	}
}

func TestNumberFormsOfFloatsAreRoundingsAndPercent(t *testing.T) {
	forms := numberForms(json.Number("0.7634"))
	for _, want := range []string{"0.76", "0.763", "0.7634", "76", "76.34", "1"} {
		if !slices.Contains(forms, want) {
			t.Errorf("0.7634 の表記に %s が無い: %v", want, forms)
		}
	}
	res := generic(t, `[{"value":0.7634}]`)
	for text, want := range map[string]int{"F1 は 0.76 です": 0, "F1 は 76 % です": 0, "F1 は 0.91 です": 1, "F1 は 0.7634 です": 0, "F1 は 0.7635 です": 1} {
		if got := len(findUnsupportedNumbers(text, res)); got != want {
			t.Errorf("%s: 不合格 %d 件, 期待 %d", text, got, want)
		}
	}
	// 1 を超える値は、百分率にしない
	if forms := numberForms(json.Number("12.5")); slices.Contains(forms, "1250") || !slices.Contains(forms, "12.5") || !slices.Contains(forms, "12") {
		t.Errorf("12.5 の表記 = %v", forms)
	}
	// 指数表記・非数は使わない
	if forms := numberForms(json.Number("1e-05")); slices.ContainsFunc(forms, func(s string) bool { return strings.ContainsAny(s, "eE") }) {
		t.Errorf("1e-05 の表記に指数がある: %v", forms)
	}
	if forms := numberForms(json.Number("1e999")); forms != nil {
		t.Errorf("無限大 = %v", forms)
	}
	// 整数は、そのままの桁だけ（符号は落とす）
	if got := numberForms(json.Number("-1234")); !slices.Equal(got, []string{"1234"}) {
		t.Errorf("-1234 = %v", got)
	}
	if got := numberForms(json.Number("0")); !slices.Equal(got, []string{"0"}) {
		t.Errorf("0 = %v", got)
	}
}

func TestTrailingZeroAndCommaNormalisation(t *testing.T) {
	res := generic(t, `[{"v":12.5,"n":1200}]`)
	if bad := findUnsupportedNumbers("12.50 と 1,200 と 1200", res); len(bad) != 0 {
		t.Errorf("bad = %v", bad)
	}
}

func TestBoolAndNullAreIgnoredAndKeysAreNotASource(t *testing.T) {
	if got := allowedNumbers(generic(t, `{"a":true,"b":null}`)); len(got) != 0 {
		t.Errorf("allowed = %v", got)
	}
	if got := allowedNumbers(generic(t, `{"2014":"x"}`)); len(got) != 0 {
		t.Errorf("キー名から出た: %v", got)
	}
	if bad := findUnsupportedNumbers("2014 年", generic(t, `[{"2014":"x"}]`)); !slices.Equal(bad, []string{"2014"}) {
		t.Errorf("bad = %v", bad)
	}
}

func TestNumberTokens(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"", nil},
		{"数字なし", nil},
		{"3 件", []string{"3"}},
		{"1,234 件", []string{"1234"}},
		{"1,23 件", []string{"1", "23"}}, // コンマの後が 3 桁でなければ、別の数
		{"1234,567", []string{"1234567"}},
		{"1,234,567.89", []string{"1234567.89"}},
		{"0.60", []string{"0.6"}},
		{"5.0", []string{"5"}},
		{"007", []string{"7"}},
		{"0,000", []string{"0"}},
		{"3.", []string{"3"}},
		{"12.5.3", []string{"12.5", "3"}},
		{"１２３", []string{"123"}},    // 全角（NFKC）
		{"１，２３４", []string{"1234"}}, // 全角のコンマも NFKC で半角
		{"٣", []string{"3"}},        // 十進数字（Python の \d）
		{"F12", []string{"2"}},      // 直前が英字の数字は外れるが、そのあとの数字は、直前が数字なので拾う（Python と同じ）
		{"m2 と z18", []string{"8"}},
		{"a1b2", nil},
		{"A 1", []string{"1"}},
		{"2014年と2024年", []string{"2014", "2024"}},
		{"c-226249-105759-1", []string{"226249", "105759", "1"}},
	}
	for _, c := range cases {
		got := numberTokens(c.in)
		if !slices.Equal(got, c.want) && !(len(got) == 0 && len(c.want) == 0) {
			t.Errorf("numberTokens(%q) = %q, 期待 %q", c.in, got, c.want)
		}
	}
}

func TestNormalizeNumber(t *testing.T) {
	for in, want := range map[string]string{
		"1,234": "1234", "0.60": "0.6", "007": "7", "5.0": "5", "0": "0", "000": "0", "0.0": "0", "10": "10", "100.100": "100.1", "٠٠٧": "7",
	} {
		if got := normalizeNumber(in); got != want {
			t.Errorf("normalizeNumber(%q) = %q, 期待 %q", in, got, want)
		}
	}
}

func TestSafeTemplateHasNoDigits(t *testing.T) {
	for _, r := range SafeTemplate {
		if unicode.IsDigit(r) || strings.ContainsRune("〇零一二三四五六七八九十百千万", r) {
			t.Errorf("安全なテンプレートに数字がある: %q", string(r))
		}
	}
	if len(findUnsupportedNumbers(SafeTemplate, nil)) != 0 {
		t.Error("安全なテンプレート自身が、検査に落ちる")
	}
}

// genericOf は、結果（Go の型）を、API が返す JSON と同じ値にする。float は小数点つきのまま区別できる。
func TestGenericOfKeepsIntegersAndFloatsApart(t *testing.T) {
	g := genericOf([]Result{MapFocusResult{Type: "map_focus", Title: "t", BBox: [4]pyjson.Float{1, 2, 3, 4}, CandidateIDs: []string{}}, CountResult{Total: 5}})
	list := g.([]any)
	bbox := list[0].(map[string]any)["bbox"].([]any)
	if n := bbox[0].(json.Number).String(); n != "1.0" {
		t.Errorf("float の 1 = %s", n)
	}
	if n := list[1].(map[string]any)["total"].(json.Number).String(); n != "5" {
		t.Errorf("整数の 5 = %s", n)
	}
	// 整数 5 は "5" だけ・float 5.0 は "5.0" から "5" も作る（どちらも 5 を許す）
	if bad := findUnsupportedNumbers("地図は 5 と 1 と 4 です", g); len(bad) != 0 {
		t.Errorf("bad = %v", bad)
	}
}
