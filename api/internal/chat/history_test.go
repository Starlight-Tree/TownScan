package chat

import (
	"strings"
	"testing"
)

func TestHistoryTitle(t *testing.T) {
	forty := strings.Repeat("あ", 40)
	cases := []struct{ name, in, want string }{
		{"plain", "新規出現の候補は何件ありますか？", "新規出現の候補は何件ありますか？"},
		{"collapses runs of spaces, tabs, newlines", "  新規出現の\t\t候補は\n\n何件  ", "新規出現の 候補は 何件"},
		{"ideographic space and NBSP", "候補　は 何件", "候補 は 何件"},
		// Python の str.strip() と同じ集合: U+001C〜U+001F と U+0085 も空白（Go の unicode.IsSpace だけでは足りない）
		{"python whitespace set", "\u001f候補\u001c\u001d\u001eは\u0085何件\u001f", "候補 は 何件"},
		{"exactly 40 characters stays", forty, forty},
		{"41 characters becomes 39 plus an ellipsis", forty + "あ", strings.Repeat("あ", 39) + "…"},
		{"counted in code points, not bytes", strings.Repeat("😀", 41), strings.Repeat("😀", 39) + "…"},
		{"only whitespace falls back", " \t\n　", "（題名なし）"},
		{"empty falls back", "", "（題名なし）"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := HistoryTitle(c.in)
			if got != c.want {
				t.Errorf("HistoryTitle(%q) = %q, want %q", c.in, got, c.want)
			}
			if n := len([]rune(got)); n < 1 || n > MaxTitleChars {
				t.Errorf("長さ %d は、表の CHECK（1〜%d）に合わない", n, MaxTitleChars)
			}
		})
	}
}

// 空でない発言（IsBlank が偽）からは、題名が「（題名なし）」にならない（空白の集合が IsBlank と同じ）。
func TestAMessageThatIsNotBlankNeverGetsTheFallbackTitle(t *testing.T) {
	for r := rune(0); r <= 0x3100; r++ {
		s := "x" + string(r) + "y"
		if IsBlank(s) {
			t.Fatalf("U+%04X を含む発言が空と判定された", r)
		}
		if HistoryTitle(s) == untitled {
			t.Errorf("U+%04X で題名が空になる", r)
		}
		if blank := string(r); IsBlank(blank) != (HistoryTitle(blank) == untitled) {
			t.Errorf("U+%04X: IsBlank = %v だが、題名の判定が違う", r, IsBlank(blank))
		}
	}
}
