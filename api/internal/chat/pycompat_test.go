package chat

import (
	"math"
	"testing"
	"unicode"
)

func TestIsPySpace(t *testing.T) {
	for _, r := range []rune{' ', '\t', '\n', '\v', '\f', '\r', 0x1c, 0x1d, 0x1e, 0x1f, 0x85, 0xa0, 0x1680, 0x2000, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000} {
		if !isPySpace(r) {
			t.Errorf("isPySpace(%U) = false", r)
		}
	}
	// 空白ではないもの（ゼロ幅の文字・BOM・モンゴル語の母音区切り・普通の文字）
	for _, r := range []rune{'a', 'あ', '0', 0x200b, 0xfeff, 0x180e, 0x00ad, 0x1b, 0x21, 0x2007 + 0x100} {
		if isPySpace(r) {
			t.Errorf("isPySpace(%U) = true", r)
		}
	}
}

func TestIsBlank(t *testing.T) {
	for s, want := range map[string]bool{
		"": true, " ": true, "　\n\t": true, "\x1c\u0085\u2028": true, "あ": false, " あ ": false, "​": false,
	} {
		if got := IsBlank(s); got != want {
			t.Errorf("IsBlank(%+q) = %v", s, got)
		}
	}
}

// \b は、日本語の文字も語の文字と見る（Python の re）。RE2 の \b とは違う。
func TestContainsWord(t *testing.T) {
	cases := []struct {
		text, word string
		want       bool
	}{
		{"gee", "gee", true},
		{"衛星 gee", "gee", true},
		{"衛星geeの話", "gee", false}, // 日本語の文字に挟まれる: 語の一部
		{"gee衛星", "gee", false},
		{"(gee)", "gee", true},
		{"agee", "gee", false},
		{"geek", "gee", false},
		{"gee_", "gee", false},
		{"gee1", "gee", false},
		{"x gee y", "gee", true},
		{"geegee gee", "gee", true}, // 先頭の出現は語の一部、あとの出現は語
		{"gee-x", "gee", true},
		{"f1は", "f1", false},
		{"f1 は", "f1", true},
		{"f12", "f1", false},
		{"", "gee", false},
	}
	for _, c := range cases {
		if got := containsWord(c.text, c.word); got != c.want {
			t.Errorf("containsWord(%q, %q) = %v, 期待 %v", c.text, c.word, got, c.want)
		}
	}
}

// Unicode の十進数字（Nd）は、すべて 0〜9 の 10 字ずつの連なり。値は、連なりの中の位置。
func TestDigitValueCoversEveryDecimalDigit(t *testing.T) {
	n := 0
	for r := rune(0); r <= unicode.MaxRune; r++ {
		if !unicode.IsDigit(r) {
			if isDecimal(r) {
				t.Fatalf("%U は十進数字ではないのに、isDecimal が真", r)
			}
			continue
		}
		n++
		v, ok := digitValue(r)
		if !ok || v < 0 || v > 9 {
			t.Fatalf("digitValue(%U) = %d, %v", r, v, ok)
		}
		if v > 0 {
			if pv, _ := digitValue(r - 1); pv != v-1 {
				t.Fatalf("%U の値 %d の直前の字の値が %d（連なっていない）", r, v, pv)
			}
		}
	}
	if n < 600 {
		t.Errorf("十進数字の数が少ない: %d", n)
	}
	for r, want := range map[rune]int{'0': 0, '9': 9, '０': 0, '９': 9, '٣': 3, '۷': 7, '𝟑': 3, '𝟗': 9} {
		if v, ok := digitValue(r); !ok || v != want {
			t.Errorf("digitValue(%q) = %d, %v", r, v, ok)
		}
	}
	for _, r := range []rune{'a', '一', '〇', '①', '²', '½', 'Ⅳ'} { // 漢数字・丸数字・上付き・ローマ数字は、\d ではない
		if isDecimal(r) {
			t.Errorf("isDecimal(%q) = true", r)
		}
	}
}

func TestDecimalIntAndAsciiDigits(t *testing.T) {
	for s, want := range map[string]int{"0": 0, "007": 7, "２０２４": 2024, "٢٠٢٤": 2024, "99": 99} {
		if got, ok := decimalInt(s); !ok || got != want {
			t.Errorf("decimalInt(%q) = %d, %v", s, got, ok)
		}
	}
	for _, s := range []string{"", "a", "1a", "一"} {
		if _, ok := decimalInt(s); ok {
			t.Errorf("decimalInt(%q) は読めないはず", s)
		}
	}
	// 桁が多くても、あふれずに「大きい」ままになる
	if got, ok := decimalInt("99999999999999999999999999999999"); !ok || got < 1<<40 {
		t.Errorf("大きい値 = %d, %v", got, ok)
	}
	for s, want := range map[string]string{"0": "0", "000": "0", "007": "7", "１２３": "123", "٠٠٣": "3", "10": "10"} {
		if got, ok := asciiDigits(s); !ok || got != want {
			t.Errorf("asciiDigits(%q) = %q, %v", s, got, ok)
		}
	}
	if _, ok := asciiDigits("1x"); ok {
		t.Error("数字でない字が混ざる文字列は ok=false のはず")
	}
}

// Python の f"{v:.{prec}f}"。NaN・無限大の綴りは、Go の strconv と違う。
func TestPyFixed(t *testing.T) {
	for _, c := range []struct {
		v    float64
		prec int
		want string
	}{
		{302.3, 0, "302"}, {0.5, 0, "0"}, {1.5, 0, "2"}, {2.5, 0, "2"}, {0.6, 2, "0.60"}, {0.125, 2, "0.12"}, {0.375, 2, "0.38"}, {1234567.891, 1, "1234567.9"}, {-2.5, 0, "-2"},
		{math.Copysign(0, -1), 0, "-0"}, {math.NaN(), 0, "nan"}, {math.NaN(), 2, "nan"}, {math.Inf(1), 0, "inf"}, {math.Inf(-1), 2, "-inf"},
	} {
		if got := pyFixed(c.v, c.prec); got != c.want {
			t.Errorf("pyFixed(%v, %d) = %q, 期待 %q", c.v, c.prec, got, c.want)
		}
	}
	if got := ratio(math.NaN()); got != "nan" {
		t.Errorf("ratio(NaN) = %q", got)
	}
}
