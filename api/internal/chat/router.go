package chat

import (
	"fmt"
	"sort"
	"strings"
	"unicode/utf8"

	"townscan/api/internal/store"
)

// 模擬モデル（既定の LLM）の規則: 質問の文から、呼ぶツール（と引数）を決める。backend/app/chat/mock_model.py の plan と同じ規則・同じ優先順位。
//
// - 地区名は DB の areas.name・ward との部分一致。文脈は、クライアントが送る messages だけから作る（保存しない）。
// - 数字・件数は、ここでは書かない。ツールの結果の値だけを、文面（text.go）が写し、guard が検査する。
// - 実 LLM を足すときも、同じ「ツール呼び出しの列 → 結果 → 文章 → guard」の形にする。

// Message は、会話の 1 件（クライアントが送る role と content だけを使う）。
type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// Call は、ツール呼び出し 1 回（応答の tool_calls の 1 件）。
type Call struct {
	Name string `json:"name"`
	Args Args   `json:"args"`
}

// MockModel は、規則で意図を決める模擬モデル。areas は、地区名・区名の一致に使う（store.ListAreas の結果）。
type MockModel struct {
	areas []store.Area
	wards []string // 区名（空でないもの。重複なし・文字コード順）
}

// NewMockModel は、模擬モデルを作る。
func NewMockModel(areas []store.Area) *MockModel {
	seen := map[string]bool{}
	var wards []string
	for _, a := range areas {
		if a.Ward != "" && !seen[a.Ward] {
			seen[a.Ward] = true
			wards = append(wards, a.Ward)
		}
	}
	sort.Strings(wards)
	return &MockModel{areas: areas, wards: wards}
}

// slots は、文から読み取った条件（地区・分類・候補 ID・件数）。
type slots struct {
	areaIDs     []string
	wards       []string // 文に出た順。1 つでも複数でも
	cls         string   // "" = 指定なし
	candidateID string   // "" = 指定なし
	limit       int      // 0 = 指定なし
	allAreas    bool
}

func (s *slots) hasArea() bool { return len(s.areaIDs) > 0 || len(s.wards) > 0 }

// slots は、normalize 済みの文から、条件を読み取る。
func (m *MockModel) slots(text string) slots {
	var s slots
	s.candidateID = findCandidateID(text)
	explicitIDs := findAreaIDs(text)
	s.allAreas = ruleAllAreas.matches(text)

	rest := text
	var found []string
	for _, w := range m.wards {
		if strings.Contains(rest, w) {
			found = append(found, w)
		}
	}
	// 複数の区が出たら、すべて使う（書いた順）
	s.wards = append([]string(nil), found...)
	sort.SliceStable(s.wards, func(i, j int) bool { return strings.Index(text, s.wards[i]) < strings.Index(text, s.wards[j]) })
	for _, w := range found {
		rest = strings.ReplaceAll(rest, w, " ")
	}
	var matched []string
	for _, a := range m.areas {
		name := normalize(a.Name)
		if name == "" {
			continue
		}
		core := nameSuffixRE.ReplaceAllString(name, "")
		if strings.Contains(rest, name) || (utf8.RuneCountInString(core) >= 2 && strings.Contains(rest, core)) {
			matched = append(matched, a.ID)
		}
	}
	known := map[string]bool{}
	for _, a := range m.areas {
		known[a.ID] = true
	}
	// Python は、matched に足す一覧を先に作ってから足す（同じ ID が 2 回書かれていれば、2 回入る）
	var extra []string
	for _, id := range explicitIDs {
		if known[id] && !contains(matched, id) {
			extra = append(extra, id)
		}
	}
	matched = append(matched, extra...)
	if len(matched) > 0 {
		s.areaIDs = matched
		s.wards = nil // 地区名が分かるなら、区名より地区名を優先する
	}
	if s.allAreas {
		s.areaIDs, s.wards = nil, nil
	}

	var foundCls []string
	for _, c := range []struct {
		key string
		r   rule
	}{{"confirmed_new", ruleClsNew}, {"existing_omission", ruleClsOmit}, {"uncertain", ruleClsUnc}} {
		if c.r.matches(text) {
			foundCls = append(foundCls, c.key)
		}
	}
	if len(foundCls) == 1 {
		s.cls = foundCls[0]
	}
	if g := limitARE.FindStringSubmatch(text); g != nil {
		s.limit = clampLimit(g[1])
	} else if g := limitBRE.FindStringSubmatch(text); g != nil {
		s.limit = clampLimit(g[1])
	}
	return s
}

func clampLimit(digits string) int {
	n, _ := decimalInt(digits)
	return min(max(n, 1), maxListLimit)
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// refuse は、断りのツール呼び出し。
func refuse(reason, message string, suggestions []string) *Call {
	return &Call{Name: "refuse", Args: Args{Reason: reason, Message: message, Suggestions: suggestions}}
}

// refusal は、範囲外・未実装の質問なら、断りのツール呼び出し。範囲内なら nil。優先順位は、上から。
func (m *MockModel) refusal(text string, s *slots) *Call {
	if ruleInjection.matches(text) || ruleChitchat.matches(text) {
		return refuse("out_of_scope", msgChitchat, nil)
	}
	if ruleSatellite.matches(text) {
		return refuse("not_implemented", msgSatellite, nil)
	}
	if rulePanel.matches(text) {
		return refuse("not_implemented", msgPanel, nil)
	}
	if ruleDisappear.matches(text) {
		return refuse("not_implemented", msgDisappear, nil)
	}
	// ID の中の数字（c-226249-…）を、年と取り違えない
	bare := replaceIDs(areaIDRE, replaceIDs(candidateIDRE, text, " "), " ")
	if hasUnphotographedYear(bare) || ruleRelativeTime.matches(bare) {
		return refuse("no_photo_period", msgYear, nil)
	}
	if !s.hasArea() && !s.allAreas {
		placeText := stripYears(text)
		var token string
		for _, t := range placeTokenRE.FindAllString(placeText, -1) {
			if !strings.HasSuffix(t, "地区") && !placeOKWords[t] {
				token = t
				break
			}
		}
		hit := otherPlaces(placeText)
		var nounPlace string
		for _, g := range placeNounRE.FindAllStringSubmatch(placeText, -1) {
			if !isOwnPlaceWord(g[1]) {
				nounPlace = g[1]
				break
			}
		}
		if token != "" || hit != "" || nounPlace != "" {
			label := token
			if label == "" {
				label = hit
			}
			if label == "" {
				label = nounPlace
			}
			var names []string
			for _, a := range m.areas {
				if a.Name != "" {
					names = append(names, a.Name)
				}
			}
			if len(names) > 12 {
				names = names[:12]
			}
			listing := ""
			if len(names) > 0 {
				listing = fmt.Sprintf("解析した地区は、%s です。", strings.Join(names, "、"))
			}
			msg := fmt.Sprintf("「%s」は、解析した地区に含まれていません。対象は熊本市中心部の、解析した地区だけです。%s", label, listing)
			if len(findUnsupportedNumbersLikePython(msg, genericOf(map[string]string{"message": msg}))) > 0 {
				// 利用者の語に漢数字+助数詞（三年町など）が入ると、数字の検査で本文だけが差し替わる。語を写さない形にする
				// （検査は、service が模擬モデルの返答にかける guardTemplateNumbers と同じ。Python と同じ範囲）
				msg = "その場所は、解析した地区に含まれていません。対象は熊本市中心部の、解析した地区だけです。" + listing
			}
			var sug []string
			if len(names) > 0 {
				sug = []string{names[0] + "の新規出現候補は何件ですか？"}
			}
			return refuse("out_of_scope", msg, sug)
		}
	}
	return nil
}

// inherit は、直前までの会話から、今回の文に無い条件（地区・分類・候補 ID）を引き継ぐ（follow = 「その」「では」などの語があるとき）。
// 新しい方から見て、最初に見つかったものを使う。
func (m *MockModel) inherit(s *slots, history []Message, follow bool) {
	if !follow {
		return
	}
	for i := len(history) - 1; i >= 0; i-- {
		msg := history[i]
		text := normalize(msg.Content)
		if msg.Role == "user" {
			prev := m.slots(text)
			if !s.hasArea() && !s.allAreas && prev.hasArea() {
				s.areaIDs, s.wards = prev.areaIDs, prev.wards
			}
			if s.cls == "" && prev.cls != "" {
				s.cls = prev.cls
			}
		}
		if s.candidateID == "" {
			if c := findCandidateID(text); c != "" {
				s.candidateID = c
			}
		}
		if (s.hasArea() || s.allAreas) && s.cls != "" && s.candidateID != "" {
			break
		}
	}
}

// areaArgs は、地区の条件を、ツールの引数にする。地区の id があればそれ、区が 1 つなら ward、複数なら wards。
func areaArgs(s *slots) Args {
	var a Args
	switch {
	case len(s.areaIDs) > 0:
		a.AreaIDs = s.areaIDs
	case len(s.wards) == 1:
		a.Ward = s.wards[0]
	case len(s.wards) > 1:
		a.Wards = append([]string(nil), s.wards...)
	}
	return a
}

// withCls は、引数に分類を足す。
func withCls(a Args, cls string) Args {
	a.Cls = cls
	return a
}

// Plan は、会話（最後が利用者の質問）から、呼ぶツールの列を決める。
func (m *MockModel) Plan(messages []Message) []Call {
	text := normalize(messages[len(messages)-1].Content)
	s := m.slots(text)
	if r := m.refusal(text, &s); r != nil {
		return []Call{*r}
	}

	ownCandidate := s.candidateID
	ownFilter := s.hasArea() || s.allAreas || s.cls != "" // 今回の文に、地区・分類の指定がある
	follow := ruleFollowup.matches(text)
	m.inherit(&s, messages[:len(messages)-1], follow)
	area := areaArgs(&s)
	areaCls := withCls(area, s.cls)

	compare := ruleCompareStrong.matches(text) ||
		(ruleCompareWeak.matches(text) && (len(s.areaIDs) >= 2 || len(s.wards) >= 2 || !ruleCountStrong.matches(text)))

	// target は、候補 ID があればそれ（今回の文のもの、または文脈の直前の候補）。無ければ地区・分類の条件で最大の候補
	target := func() Args {
		if s.candidateID != "" && (ownCandidate != "" || !ownFilter) {
			return Args{CandidateID: s.candidateID}
		}
		return areaCls
	}
	call := func(name string, args Args) []Call { return []Call{{Name: name, Args: args}} }

	switch {
	case ownCandidate != "" && !ruleMap.matches(text):
		return call("show_candidate", Args{CandidateID: ownCandidate})
	case ruleHelp.matches(text) && !ruleAccuracy.matches(text):
		return call("show_help", Args{})
	case ruleAccuracy.matches(text):
		return call("get_accuracy", Args{})
	case ruleMap.matches(text) && !compare:
		return call("focus_map", target())
	case rulePhoto.matches(text) && !ruleListExplicit.matches(text) && !compare && !ruleCountStrong.matches(text):
		return call("show_candidate", target())
	case compare:
		return call("compare_areas", areaCls)
	case ruleList.matches(text):
		list := areaCls
		if s.limit > 0 {
			l := s.limit
			list.Limit = &l
		}
		calls := call("list_candidates", list)
		if ruleCount.matches(text) {
			calls = append([]Call{{Name: "count_candidates", Args: areaCls}}, calls...)
		}
		return calls
	case s.hasArea() || s.cls != "" || ruleDomain.matches(text) || ruleCountStrong.matches(text) || (ruleCount.matches(text) && follow):
		return call("count_candidates", areaCls)
	}
	return []Call{*refuse("out_of_scope", msgChitchat, nil)}
}
