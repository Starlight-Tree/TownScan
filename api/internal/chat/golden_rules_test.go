package chat

import "testing"

// 規則（語の表・正規表現）ごとに、書ける語を 1 つずつ、Python の re.IGNORECASE の search と同じ結果になるか（期待値は gen_golden.py の build_rules）。
// 語を 1 つずつ入れるので、規則の選択肢を 1 つ落とした書き換えも見つかる。ドット無しの i（ı・U+0131）と、点つきの大文字 İ（U+0130）は、
// Python の re.IGNORECASE では i と同じ。Go の (?i) は違うので、文の側で i にそろえている（foldDotlessI）。
func TestGoldenRulesMatchPythonIncludingDotlessI(t *testing.T) {
	g := loadGolden(t)
	rules := map[string]rule{
		"INJECTION": ruleInjection, "CHITCHAT": ruleChitchat, "SATELLITE": ruleSatellite, "PANEL": rulePanel, "RELATIVE_TIME": ruleRelativeTime,
		"CLS_NEW": ruleClsNew, "CLS_OMIT": ruleClsOmit, "CLS_UNC": ruleClsUnc, "ALL_AREAS": ruleAllAreas, "FOLLOWUP": ruleFollowup,
		"HELP": ruleHelp, "ACCURACY": ruleAccuracy, "PHOTO": rulePhoto, "MAP": ruleMap, "COMPARE_STRONG": ruleCompareStrong,
		"COMPARE_WEAK": ruleCompareWeak, "LIST": ruleList, "LIST_EXPLICIT": ruleListExplicit, "COUNT": ruleCount, "COUNT_STRONG": ruleCountStrong,
		"DISAPPEAR": ruleDisappear, "DOMAIN": ruleDomain, "OWN_VOCABULARY": ruleOwnVocabulary,
	}
	if len(g.Rules) < 600 {
		t.Fatalf("期待値が少ない: %d", len(g.Rules))
	}
	seen := map[string]int{}
	dotless := 0
	for _, e := range g.Rules {
		name, text, want := e[0].(string), e[1].(string), e[2].(bool)
		r, ok := rules[name]
		if !ok {
			t.Fatalf("Go に無い規則: %s", name)
		}
		seen[name]++
		if want && (containsRune(text, 'ı') || containsRune(text, 'İ')) {
			dotless++
		}
		// Python のあとに、意図して変えた語（対象をフランスに変えた。ADR 0015）。変えた語は rules_test.go の TestFranceWords で確かめる
		if name == "DOMAIN" && text == "熊本" {
			want = false
		}
		if got := r.matches(text); got != want {
			t.Errorf("%s.matches(%+q) = %v, Python は %v", name, text, got, want)
		}
	}
	for name := range rules {
		if seen[name] < 10 {
			t.Errorf("%s の期待値が %d 件しかない", name, seen[name])
		}
	}
	if dotless < 20 { // ı・İ を含む文で、Python が当たりとするものが、十分にある（i を含む語を持つ規則）
		t.Errorf("ı・İ を含んで当たる文が %d 件しかない", dotless)
	}
}

func containsRune(s string, r rune) bool {
	for _, c := range s {
		if c == r {
			return true
		}
	}
	return false
}
