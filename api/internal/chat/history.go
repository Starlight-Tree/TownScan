package chat

import "strings"

// 会話の履歴の題名（仕様 §4.4「履歴の題名の規則」。DocuNavi の MAX_TITLE_LENGTH と同じ規則）。

// MaxTitleChars は、題名の最大の長さ（コードポイント）。表の CHECK（1〜40）と同じ。
const MaxTitleChars = 40

// untitled は、題名が空になったとき（空白の集合をそろえてあるので起きない。防御）の題名。
const untitled = "（題名なし）"

// HistoryTitle は、会話を作るときの最後のユーザー発言から、題名を作る。
// Python の str.strip() と同じ空白の集合の連続（空白・タブ・改行・全角空白・NBSP を含む）を、半角空白 1 つにまとめ、前後は除く。
// MaxTitleChars 文字（コードポイントで数える）まで。超えたら、先頭 MaxTitleChars-1 文字＋「…」。空になったら「（題名なし）」。
func HistoryTitle(text string) string {
	s := strings.Join(strings.FieldsFunc(text, isPySpace), " ")
	if s == "" {
		return untitled
	}
	r := []rune(s)
	if len(r) > MaxTitleChars {
		return string(r[:MaxTitleChars-1]) + "…"
	}
	return s
}
