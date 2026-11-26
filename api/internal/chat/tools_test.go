package chat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"testing"

	"townscan/api/internal/pyjson"
	"townscan/api/internal/store"
)

// ツール（tools.go）の単体テスト。DB の代わりに fakeData（契約の検査と同じ 3 地区・9 候補）を使う。
// SQL そのものは store のテストが、HTTP から見える結果は契約の検査が確かめる。ここでは、引数の検証・並び・丸め・上限・断りの文を確かめる
// （backend/tests/test_chat.py の「ツールの登録表」の節と、ツール別の節に当たる）。

func toolCtx(f *fakeData) *ToolContext { return &ToolContext{Data: f, Run: *f.run, Areas: f.areas} }

// callTool は、登録表（既定）からツールを呼ぶ。エラーは、テストの失敗。
func callTool(t *testing.T, f *fakeData, name string, args Args) Result {
	t.Helper()
	r, err := DefaultRegistry(0).Call(context.Background(), toolCtx(f), name, args)
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	return r
}

// jsonOf は、結果を、API が返す JSON の文字列にする。
func jsonOf(t *testing.T, v any) string {
	t.Helper()
	b, err := pyjson.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func wantRefusal(t *testing.T, r Result, reason, message string) {
	t.Helper()
	ref, ok := r.(RefusalResult)
	if !ok {
		t.Fatalf("断りのはずが %T: %s", r, jsonOf(t, r))
	}
	if ref.Reason != reason || ref.Message != message {
		t.Errorf("断り = %s / %q, 期待 %s / %q", ref.Reason, ref.Message, reason, message)
	}
}

func intp(n int) *int { return &n }

// ---- 地区の解決 ----

func TestResolveAreas(t *testing.T) {
	f := newFakeData()
	// 4 地区目（「ほか」の省略を確かめる）。名前の無い地区は、読み込みの時点で id が名前に入っている
	f.areas = append(f.areas, store.Area{ID: "z18-226251-105759", Name: "四番町", Ward: "西区"})
	tc := toolCtx(f)
	cases := []struct {
		name    string
		args    Args
		ids     []string
		label   string
		reason  string // 空でなければ、断り（ToolError）
		message string
	}{
		{name: "指定なし = 全地区", label: "全地区"},
		{name: "地区の id（重複は 1 つ・並びは id の昇順）", args: Args{AreaIDs: []string{a2, a1, a2}}, ids: []string{a1, a2}, label: "合成町・試験町"},
		{name: "id の昇順（地区の並びではない）", args: Args{AreaIDs: []string{a2, a1, a3}}, ids: []string{a1, a3, a2}, label: "合成町・仮想町・試験町"},
		{name: "4 つ以上は、3 つで「ほか」", args: Args{AreaIDs: []string{a1, a2, a3, "z18-226251-105759"}}, ids: []string{a1, a3, a2, "z18-226251-105759"}, label: "合成町・仮想町・試験町ほか"},
		{name: "area_id（単数）", args: Args{AreaID: a3}, ids: []string{a3}, label: "仮想町"},
		{name: "area_ids が空なら area_id を見る", args: Args{AreaIDs: []string{}, AreaID: a3}, ids: []string{a3}, label: "仮想町"},
		{name: "区", args: Args{Ward: "中央区"}, ids: []string{a1, a2}, label: "中央区"},
		{name: "複数の区は和集合", args: Args{Wards: []string{"中央区", "東区"}}, ids: []string{a1, a3, a2}, label: "中央区・東区"},
		{name: "ward と wards の重複は 1 つ", args: Args{Ward: "中央区", Wards: []string{"中央区", "東区"}}, ids: []string{a1, a3, a2}, label: "中央区・東区"},
		{name: "地区の id があれば、区は表示名にだけ使う（Python と同じ）", args: Args{AreaIDs: []string{a3}, Ward: "中央区"}, ids: []string{a3}, label: "中央区"},
		{name: "存在しない区", args: Args{Ward: "北区"}, reason: "no_data", message: "「北区」の地区はありません。"},
		{name: "存在しない区が複数", args: Args{Wards: []string{"北区", "中央区", "南区"}}, reason: "no_data", message: "「北区・南区」の地区はありません。"},
		{name: "空の区名", args: Args{Wards: []string{""}}, reason: "out_of_scope", message: "区の指定が正しくありません。"},
		{name: "知らない地区の id", args: Args{AreaIDs: []string{a1, "z18-1-1"}}, reason: "no_data", message: "指定の地区が見つかりません。"},
	}
	for _, c := range cases {
		ids, label, err := resolveAreas(tc, c.args)
		if c.reason != "" {
			var te *ToolError
			if !errors.As(err, &te) || te.Reason != c.reason || te.Message != c.message {
				t.Errorf("%s: err = %v, 期待 %s / %s", c.name, err, c.reason, c.message)
			}
			continue
		}
		if err != nil || label != c.label || strings.Join(ids, ",") != strings.Join(c.ids, ",") || (c.ids == nil) != (ids == nil) {
			t.Errorf("%s: ids=%v label=%q err=%v, 期待 %v / %q", c.name, ids, label, err, c.ids, c.label)
		}
	}
}

func TestCleanCls(t *testing.T) {
	for _, k := range []string{"", "confirmed_new", "existing_omission", "uncertain"} {
		if got, err := cleanCls(Args{Cls: k}); err != nil || got != k {
			t.Errorf("cleanCls(%q) = %q, %v", k, got, err)
		}
	}
	for _, k := range []string{"bogus", "CONFIRMED_NEW", "confirmed_new ", "total"} {
		var te *ToolError
		if _, err := cleanCls(Args{Cls: k}); !errors.As(err, &te) || te.Reason != "out_of_scope" || te.Message != "その分類はありません。" {
			t.Errorf("cleanCls(%q): %v", k, err)
		}
	}
}

// ---- 未判定の呼び分け ----

func TestHeldBreakdownAndCandidateLabel(t *testing.T) {
	mixed := heldBreakdown(store.ClassCounts{Uncertain: 10, UncertainEdge: 9, UncertainReview: 1})
	if got := jsonOf(t, mixed); got != `[{"key":"ambiguous","label":"要確認","value":1},{"key":"edge","label":"端のため未判定","value":9}]` {
		t.Errorf("内訳 = %s", got)
	}
	// 0 件の理由の行は出さない。未判定が無い・理由の合計が合わない（知らない理由が混ざる）ときは、分けない
	if got := jsonOf(t, heldBreakdown(store.ClassCounts{Uncertain: 2, UncertainReview: 2})); got != `[{"key":"ambiguous","label":"要確認","value":2}]` {
		t.Errorf("片方だけ = %s", got)
	}
	for _, c := range []store.ClassCounts{{}, {Uncertain: 3, UncertainEdge: 2}} {
		if got := heldBreakdown(c); got != nil {
			t.Errorf("heldBreakdown(%+v) = %+v, 期待 nil", c, got)
		}
	}
	for _, c := range []struct{ class, reason, want string }{
		{"uncertain", "edge", "端のため未判定"},
		{"uncertain", "ambiguous", "要確認"},
		{"uncertain", "something_new", "未判定"},
		{"confirmed_new", "edge", "2018 年は未検出"},
		{"existing_omission", "present_2018", "2018 年も検出"},
	} {
		if got := candidateLabel(c.class, c.reason); got != c.want {
			t.Errorf("candidateLabel(%q, %q) = %q, 期待 %q", c.class, c.reason, got, c.want)
		}
	}
}

// ---- 件数 ----

func TestCountCandidates(t *testing.T) {
	f := newFakeData()
	got := jsonOf(t, callTool(t, f, "count_candidates", Args{}))
	want := `{"type":"count","title":"候補の件数（全地区）","total":9,"breakdown":[` +
		`{"key":"confirmed_new","label":"2018 年は未検出","value":4},` +
		`{"key":"existing_omission","label":"2018 年も検出","value":3},` +
		`{"key":"uncertain","label":"未判定","value":2}],"held":[{"key":"edge","label":"端のため未判定","value":2}],"filter":{"scope":"全地区"},` +
		`"provenance":{"source":"国土地理院 空中写真（年度別 2018・2023 年）から建物を抽出し、2 時点を比較した結果","photo_years":[2018,2023],` +
		`"model":"synthetic-fixture（モデルなし。合成データ）","run_id":"synthetic-test","run_kind":"synthetic","note":"合成データ（テスト用）です。実データではありません。"}}`
	if got != want {
		t.Errorf("全地区の件数\n got  %s\n want %s", got, want)
	}

	r := callTool(t, f, "count_candidates", Args{AreaIDs: []string{a1}, Cls: "confirmed_new"}).(CountResult)
	if r.Total != 1 || len(r.Breakdown) != 1 || r.Breakdown[0].Key != "confirmed_new" || r.Title != "「2018 年は未検出」の件数（合成町）" {
		t.Errorf("1 地区・1 分類: %s", jsonOf(t, r))
	}
	if r.Filter.AreaID != a1 || r.Filter.AreaIDs != nil || r.Filter.Cls != "confirmed_new" || r.Filter.Scope != "合成町" {
		t.Errorf("filter = %+v", r.Filter)
	}
	// 分類で絞った件数には、同じ地区の絞り込み前の全体と、うち未判定を添える（分類を絞らなければ添えない）
	same := callTool(t, f, "count_candidates", Args{AreaIDs: []string{a1}}).(CountResult)
	var held int64
	for _, b := range same.Breakdown {
		if b.Key == "uncertain" {
			held = b.Value
		}
	}
	if same.Overall != nil || r.Overall == nil || *r.Overall != (Overall{Total: same.Total, Uncertain: held}) || same.Total <= r.Total {
		t.Errorf("全体の件数: 絞り込み %s / 絞らない %s", jsonOf(t, r), jsonOf(t, same))
	}
	if got := jsonOf(t, r); !strings.Contains(got, fmt.Sprintf(`],"overall":{"total":%d,"uncertain":%d},"filter":`, same.Total, held)) {
		t.Errorf("overall の JSON = %s", got)
	}
	// 2 地区以上は area_ids
	r = callTool(t, f, "count_candidates", Args{Ward: "中央区"}).(CountResult)
	if r.Total != 6 || r.Filter.AreaID != "" || len(r.Filter.AreaIDs) != 2 {
		t.Errorf("区: %s", jsonOf(t, r))
	}
	// 0 件も 0 として返す（隠さない）
	r = callTool(t, f, "count_candidates", Args{AreaIDs: []string{a3}, Cls: "uncertain"}).(CountResult)
	if r.Total != 0 || r.Breakdown[0].Value != 0 {
		t.Errorf("0 件: %s", jsonOf(t, r))
	}
	// 内訳の合計 = total
	for _, args := range []Args{{}, {Ward: "東区"}, {AreaIDs: []string{a1, a2}}} {
		r := callTool(t, f, "count_candidates", args).(CountResult)
		var sum int64
		for _, b := range r.Breakdown {
			sum += b.Value
		}
		if sum != r.Total {
			t.Errorf("%+v: 内訳の合計 %d ≠ total %d", args, sum, r.Total)
		}
	}
}

func TestToolArgumentsAreValidated(t *testing.T) {
	f := newFakeData()
	cases := []struct {
		name, tool string
		args       Args
		reason     string
		message    string
	}{
		{"count: 知らない分類", "count_candidates", Args{Cls: "bogus"}, "out_of_scope", "その分類はありません。"},
		{"count: 知らない地区", "count_candidates", Args{AreaIDs: []string{"z18-1-1"}}, "no_data", "指定の地区が見つかりません。"},
		{"count: 知らない区", "count_candidates", Args{Ward: "存在しない区"}, "no_data", "「存在しない区」の地区はありません。"},
		{"list: 知らない分類", "list_candidates", Args{Cls: "x"}, "out_of_scope", "その分類はありません。"},
		{"compare: 知らない地区", "compare_areas", Args{AreaID: "z18-1-1"}, "no_data", "指定の地区が見つかりません。"},
		{"show: 知らない候補", "show_candidate", Args{CandidateID: "c-1-1-1"}, "no_data", "その候補は見つかりません。"},
		{"focus: 知らない候補", "focus_map", Args{CandidateID: "c-1-1-1"}, "no_data", "その候補は見つかりません。"},
		{"focus: 知らない分類", "focus_map", Args{Cls: "x"}, "out_of_scope", "その分類はありません。"},
	}
	for _, c := range cases {
		wantRefusal(t, callTool(t, f, c.tool, c.args), c.reason, c.message)
	}
	// 既定の聞き方の例が付く
	if r := callTool(t, f, "count_candidates", Args{Cls: "x"}).(RefusalResult); len(r.Suggestions) != 4 || r.Suggestions[0] != "候補は何件ありますか？" {
		t.Errorf("suggestions = %v", r.Suggestions)
	}
}

// ---- 一覧 ----

func TestListCandidatesLimitIsClamped(t *testing.T) {
	f := newFakeData()
	f.cands = nil
	for i := 1; i <= 60; i++ {
		f.cands = append(f.cands, candidate(fmt.Sprintf("c-226249-105759-%d", i), a1, "合成町", "confirmed_new", float64(1000-i)))
	}
	for _, c := range []struct {
		limit *int
		shown int
	}{{nil, 10}, {intp(3), 3}, {intp(50), 50}, {intp(51), 50}, {intp(9999), 50}, {intp(0), 1}, {intp(-5), 1}, {intp(1), 1}} {
		r := callTool(t, f, "list_candidates", Args{Limit: c.limit}).(TableResult)
		if r.Shown != c.shown || len(r.Rows.([]CandidateRow)) != c.shown || r.Total != 60 {
			lim := "nil"
			if c.limit != nil {
				lim = fmt.Sprint(*c.limit)
			}
			t.Errorf("limit=%s: shown=%d total=%d, 期待 shown=%d", lim, r.Shown, r.Total, c.shown)
		}
	}
}

func TestListCandidatesRowsAndOrder(t *testing.T) {
	f := newFakeData()
	r := callTool(t, f, "list_candidates", Args{}).(TableResult)
	rows := r.Rows.([]CandidateRow)
	if r.Title != "候補の一覧（全地区・面積の大きい順）" || r.Total != 9 || r.Shown != 9 {
		t.Errorf("表: %s", jsonOf(t, r))
	}
	// 面積の降順、同じ面積（75.6 が 3 件）は id の昇順
	var ids []string
	for _, row := range rows {
		ids = append(ids, row.ID)
	}
	wantIDs := "c-226250-105759-1 c-226249-105759-1 c-226249-105759-2 c-226249-105760-1 c-226250-105759-2 c-226249-105760-2 c-226249-105759-3 c-226249-105760-3 c-226250-105759-3"
	if strings.Join(ids, " ") != wantIDs {
		t.Errorf("並び = %v", ids)
	}
	if got := jsonOf(t, rows[0]); got != `{"id":"c-226250-105759-1","area":"試験町","class":"2018 年は未検出","area_m2":503.8}` {
		t.Errorf("1 行目 = %s", got)
	}
	if got := jsonOf(t, r.Columns); got != `[{"key":"id","label":"候補 ID"},{"key":"area","label":"地区"},{"key":"class","label":"分類"},{"key":"area_m2","label":"面積（m²）"}]` {
		t.Errorf("列 = %s", got)
	}
	// 分類・地区の絞り込みは、DB への条件になる
	r = callTool(t, f, "list_candidates", Args{AreaIDs: []string{a1}, Cls: "uncertain"}).(TableResult)
	if r.Title != "「未判定」の一覧（合成町・面積の大きい順）" || r.Total != 1 || r.Filter == nil || r.Filter.AreaID != a1 || r.Filter.Cls != "uncertain" {
		t.Errorf("絞り込み: %s", jsonOf(t, r))
	}
	if f.lastList.Class != "uncertain" || len(f.lastList.AreaIDs) != 1 || f.lastList.AreaIDs[0] != a1 {
		t.Errorf("DB へ渡した条件 = %+v", f.lastList)
	}
	// 名前の無い地区は、id を地区の列に出す
	f.cands[0].AreaName = nil
	r = callTool(t, f, "list_candidates", Args{Limit: intp(1)}).(TableResult)
	if row := r.Rows.([]CandidateRow)[0]; row.Area != a2 {
		t.Errorf("名前が無いときの地区の列 = %q", row.Area)
	}
}

// ---- 比較 ----

func TestCompareAreasSortsByCountThenName(t *testing.T) {
	f := newFakeData()
	names := func(r CompareResult) string {
		var ns []string
		for _, it := range r.Items {
			ns = append(ns, it.Name)
		}
		return strings.Join(ns, " ")
	}
	// 合計は 3 地区とも 3 件: 同数は、地区名の昇順（仮想町・合成町・試験町）
	r := callTool(t, f, "compare_areas", Args{}).(CompareResult)
	if names(r) != "仮想町 合成町 試験町" || r.SortKey != "total" || r.Title != "地区ごとの比較（全地区・候補の合計の多い順）" {
		t.Errorf("合計: %s", jsonOf(t, r))
	}
	// 新規出現: 試験町 2・仮想町 1・合成町 1（同数は名前の昇順）
	r = callTool(t, f, "compare_areas", Args{Cls: "confirmed_new"}).(CompareResult)
	if names(r) != "試験町 仮想町 合成町" || r.SortKey != "confirmed_new" || r.Title != "地区ごとの比較（全地区・「2018 年は未検出」の多い順）" {
		t.Errorf("新規出現: %s", jsonOf(t, r))
	}
	// 区で絞る
	r = callTool(t, f, "compare_areas", Args{Ward: "中央区"}).(CompareResult)
	if len(r.Items) != 2 || r.Filter.AreaIDs[0] != a1 || r.Filter.Scope != "中央区" {
		t.Errorf("区: %s", jsonOf(t, r))
	}
	if got := jsonOf(t, r.Items[0]); !strings.HasPrefix(got, `{"area_id":"`+a1+`","name":"合成町","ward":"中央区","counts":{"confirmed_new":1,"existing_omission":1,"uncertain":1,"total":3}}`) {
		t.Errorf("1 件目 = %s", got)
	}
	// 並べ替えは、地区の表（f.areas）を壊さない
	if f.areas[0].ID != a1 || f.areas[1].ID != a2 || f.areas[2].ID != a3 {
		t.Errorf("地区の表の並びが変わった: %v", f.areas)
	}
}

// ---- 写真 ----

func TestShowCandidate(t *testing.T) {
	f := newFakeData()
	r := callTool(t, f, "show_candidate", Args{CandidateID: "c-226249-105759-2"}).(DetectionImageResult)
	want := `{"type":"detection_image","title":"候補 c-226249-105759-2 の写真（2018 年と 2023 年）","candidate_id":"c-226249-105759-2","class":"confirmed_new",` +
		`"images":[{"year":2018,"url":"/api/candidates/c-226249-105759-2/image?year=2018&size=512"},{"year":2023,"url":"/api/candidates/c-226249-105759-2/image?year=2023&size=512"}],` +
		`"caption":"合成町・2018 年は未検出・面積 約 302 m²。輪郭は機械が抽出した範囲で、確定ではありません。","provenance":`
	if got := jsonOf(t, r); !strings.HasPrefix(got, want) {
		t.Errorf("候補を指定\n got  %s\n want %s…", got, want)
	}

	pick := func(args Args) string {
		return callTool(t, f, "show_candidate", args).(DetectionImageResult).CandidateID
	}
	// 指定が無ければ、条件に合う最大の候補。分類の指定が無いときは、新規出現を先に探す
	if got := pick(Args{}); got != "c-226250-105759-1" {
		t.Errorf("全体の最大 = %s", got)
	}
	if got := pick(Args{AreaIDs: []string{a1}}); got != "c-226249-105759-2" { // 合成町の新規出現（uncertain の方が大きくても）
		t.Errorf("合成町の新規出現 = %s", got)
	}
	if got := pick(Args{AreaIDs: []string{a3}, Cls: "existing_omission"}); got != "c-226249-105760-1" {
		t.Errorf("仮想町の描き漏れ = %s", got)
	}
	// 新規出現が無い地区は、全分類から最大のものを選ぶ
	f2 := newFakeData()
	f2.cands = f2.cands[:0]
	f2.cands = append(f2.cands, candidate("c-226249-105760-1", a3, "仮想町", "existing_omission", 188.9), candidate("c-226249-105760-2", a3, "仮想町", "uncertain", 100.8))
	if got := callTool(t, f2, "show_candidate", Args{AreaIDs: []string{a3}}).(DetectionImageResult).CandidateID; got != "c-226249-105760-1" {
		t.Errorf("新規出現が無い地区 = %s", got)
	}
	// 該当が無い
	wantRefusal(t, callTool(t, f2, "show_candidate", Args{AreaIDs: []string{a1}, Cls: "confirmed_new"}), "no_data", "該当する候補がありません。")
	wantRefusal(t, callTool(t, f, "show_candidate", Args{CandidateID: "c-9-9-9"}), "no_data", "その候補は見つかりません。")
}

// 面積の丸めは、Python の f"{v:.0f}"（厳密な値の最近接偶数）と同じ。
func TestShowCandidateCaptionRoundsLikePython(t *testing.T) {
	for area, want := range map[float64]string{0.5: "0", 1.5: "2", 2.5: "2", 3.5: "4", 302.3: "302", 302.5: "302", 1234567.49: "1234567", 99.999: "100"} {
		f := newFakeData()
		f.cands = []store.Candidate{candidate("c-226249-105759-1", a1, "合成町", "confirmed_new", area)}
		cap := callTool(t, f, "show_candidate", Args{}).(DetectionImageResult).Caption
		if !strings.Contains(cap, "面積 約 "+want+" m²。") {
			t.Errorf("面積 %v の説明 = %s, 期待 約 %s", area, cap, want)
		}
	}
	// DB の double precision には、NaN・無限大も入る。Python の f"{v:.0f}" は "nan"・"inf"・"-inf"（Go の strconv の "NaN"・"+Inf" とは違う綴り）
	for _, c := range []struct {
		area float64
		want string
	}{{math.NaN(), "nan"}, {math.Inf(1), "inf"}, {math.Inf(-1), "-inf"}, {math.Copysign(0, -1), "-0"}} {
		f := newFakeData()
		f.cands = []store.Candidate{candidate("c-226249-105759-1", a1, "合成町", "confirmed_new", c.area)}
		if cap := callTool(t, f, "show_candidate", Args{}).(DetectionImageResult).Caption; !strings.Contains(cap, "面積 約 "+c.want+" m²。") {
			t.Errorf("面積 %v の説明 = %s, 期待 約 %s", c.area, cap, c.want)
		}
	}
	// 名前の無い地区は id
	f := newFakeData()
	f.cands[0].AreaName = nil
	if cap := callTool(t, f, "show_candidate", Args{}).(DetectionImageResult).Caption; !strings.HasPrefix(cap, a2+"・") {
		t.Errorf("名前が無いときの説明 = %s", cap)
	}
}

// ---- 地図 ----

func TestFocusMap(t *testing.T) {
	f := newFakeData()
	r := callTool(t, f, "focus_map", Args{AreaIDs: []string{a1}}).(MapFocusResult)
	if r.Title != "合成町の候補 3 件を地図で表示" || len(r.CandidateIDs) != 3 || r.BBox != f.areas[0].BBox {
		t.Errorf("1 地区: %s", jsonOf(t, r))
	}
	// 全地区: 箱は全地区の和
	r = callTool(t, f, "focus_map", Args{}).(MapFocusResult)
	if want := [4]pyjson.Float{130.70, 32.79, 130.72, 32.81}; r.BBox != want || len(r.CandidateIDs) != 9 || r.Title != "全地区の候補 9 件を地図で表示" {
		t.Errorf("全地区: %s", jsonOf(t, r))
	}
	// 分類つき。候補 ID は面積の大きい順
	r = callTool(t, f, "focus_map", Args{Cls: "confirmed_new"}).(MapFocusResult)
	if r.Title != "全地区の「2018 年は未検出」 4 件を地図で表示" || strings.Join(r.CandidateIDs, " ") != "c-226250-105759-1 c-226249-105759-2 c-226249-105760-3 c-226250-105759-3" {
		t.Errorf("新規出現: %s", jsonOf(t, r))
	}
	// 候補 1 件
	r = callTool(t, f, "focus_map", Args{CandidateID: "c-226249-105759-3"}).(MapFocusResult)
	if r.Title != "候補 c-226249-105759-3 を地図で表示" || len(r.CandidateIDs) != 1 || r.BBox != f.cands[6].BBox {
		t.Errorf("候補: %s", jsonOf(t, r))
	}
	// 地区が 1 つも無い run
	f.areas = nil
	wantRefusal(t, callTool(t, f, "focus_map", Args{}), "no_data", "地図に出せる地区がありません。")
}

// 地図に渡す候補 ID の上限を超えたら、件数は実数のまま「上位 N 件」と書く（仕様 E6: DB の件数 = 画面の件数）。
func TestFocusMapStatesTheRealCountWhenItCutsTheIDs(t *testing.T) {
	f := newFakeData()
	ctx := context.Background()
	reg := DefaultRegistry(2)
	r, err := reg.Call(ctx, toolCtx(f), "focus_map", Args{})
	if err != nil {
		t.Fatal(err)
	}
	m := r.(MapFocusResult)
	if len(m.CandidateIDs) != 2 || m.Title != "全地区の候補 9 件のうち、面積の大きい上位 2 件を地図で表示" {
		t.Errorf("上限 2: %s", jsonOf(t, m))
	}
	r, _ = reg.Call(ctx, toolCtx(f), "focus_map", Args{Cls: "confirmed_new"})
	if m := r.(MapFocusResult); len(m.CandidateIDs) != 2 || m.Title != "全地区の「2018 年は未検出」 4 件のうち、面積の大きい上位 2 件を地図で表示" {
		t.Errorf("上限 2・新規出現: %s", jsonOf(t, m))
	}
	// 切っていない（ちょうど上限）ときは、「のうち」を書かない
	r, _ = DefaultRegistry(9).Call(ctx, toolCtx(f), "focus_map", Args{})
	if m := r.(MapFocusResult); len(m.CandidateIDs) != 9 || strings.Contains(m.Title, "のうち") {
		t.Errorf("上限 9: %s", jsonOf(t, m))
	}
	// 既定の上限は 5000 件
	big := newFakeData()
	big.cands = nil
	for i := 1; i <= 5001; i++ {
		big.cands = append(big.cands, candidate(fmt.Sprintf("c-226249-105759-%d", i), a1, "合成町", "confirmed_new", float64(10000-i)))
	}
	r, _ = DefaultRegistry(0).Call(ctx, toolCtx(big), "focus_map", Args{})
	if m := r.(MapFocusResult); len(m.CandidateIDs) != 5000 || m.Title != "全地区の候補 5001 件のうち、面積の大きい上位 5000 件を地図で表示" {
		t.Errorf("既定の上限: %d 件 %s", len(m.CandidateIDs), m.Title)
	}
}

// ---- 精度 ----

func metricsByKey(r AccuracyResult) map[string]Metric {
	out := map[string]Metric{}
	for _, m := range r.Metrics {
		out[m.Key] = m
	}
	return out
}

func TestGetAccuracy(t *testing.T) {
	f := newFakeData()
	r := callTool(t, f, "get_accuracy", Args{}).(AccuracyResult)
	by := metricsByKey(r)
	if got := len(r.Metrics); got != 9 { // 6 + 新築の再現率 + 選んだ倍率・閾値
		t.Errorf("項目数 = %d", got)
	}
	var keys []string
	for _, m := range r.Metrics {
		keys = append(keys, m.Key)
	}
	if want := "holdout_object_f1 holdout_object_precision holdout_object_recall holdout_pixel_iou holdout_pixel_f1 tune_object_f1 new_building_recall chosen_scale chosen_threshold"; strings.Join(keys, " ") != want {
		t.Errorf("並び = %v", keys)
	}
	if v := by["holdout_object_f1"]; v.Value == nil || *v.Value != 0.58 || v.Label != "物体単位 F1（評価用・2018 年の写真）" ||
		v.Note != "評価用 2 地区。IoU 0.5 以上の 1 対 1 対応。タイルの縁に接する物体は除く" {
		t.Errorf("物体単位 F1 = %+v", v)
	}
	if v := by["tune_object_f1"]; v.Note != "調整用 1 地区。倍率と閾値を選ぶのに使ったので、参考値" {
		t.Errorf("調整用 = %+v", v)
	}
	if v := by["holdout_object_recall"]; !strings.HasPrefix(v.Label, "建物の抽出の再現率") || v.Note != "評価用 2 地区" {
		t.Errorf("再現率 = %+v", v)
	}
	if v := by["new_building_recall"]; v.Value != nil || v.Note != "未測定（手ラベルが無いため）。建物の抽出の再現率とは別の値" {
		t.Errorf("新築の再現率 = %+v", v)
	}
	if v := by["chosen_scale"]; v.Value == nil || *v.Value != 1.5 || v.Note != "調整用の地区だけで選んだ値" || v.Label != "選んだ倍率" {
		t.Errorf("選んだ倍率 = %+v", v)
	}
	if got := jsonOf(t, r.Provenance); !strings.Contains(got, `"photo_years":[2018]`) || !strings.Contains(got, `"metric":"物体単位 F1・画素 IoU"`) ||
		!strings.Contains(got, "数字は 2018 年の写真で測った値。") {
		t.Errorf("出どころ = %s", got)
	}
	if !strings.Contains(jsonOf(t, by["holdout_object_f1"]), `"value":0.58,`) {
		t.Errorf("値の書式 = %s", jsonOf(t, by["holdout_object_f1"]))
	}
	if got := jsonOf(t, by["new_building_recall"]); !strings.Contains(got, `"value":null,`) {
		t.Errorf("未測定は null = %s", got)
	}
}

func TestGetAccuracyVariants(t *testing.T) {
	get := func(metrics string) (AccuracyResult, Result) {
		f := newFakeData()
		f.metrics = json.RawMessage(metrics)
		res := callTool(t, f, "get_accuracy", Args{})
		r, _ := res.(AccuracyResult)
		return r, res
	}
	// 評価した年: year_compare.selected_on_year → protocol.year → 2018。整数だけ（小数・文字列・真偽値は読まない）
	for _, c := range []struct {
		metrics string
		year    int
	}{
		{`{"year_compare":{"selected_on_year":2023}}`, 2023},
		{`{"protocol":{"year":2023}}`, 2023},
		{`{"year_compare":{"selected_on_year":2023},"protocol":{"year":2018}}`, 2023},
		{`{"year_compare":{"selected_on_year":2023.0},"protocol":{"year":2023}}`, 2023},
		{`{"year_compare":{"selected_on_year":2023.0}}`, 2018},
		{`{"year_compare":{"selected_on_year":"2023"}}`, 2018},
		{`{"year_compare":{"selected_on_year":true}}`, 2018},
		{`{"year_compare":[1,2]}`, 2018},
		{`{}`, 2018},
	} {
		r, _ := get(c.metrics)
		if got := r.Provenance.PhotoYears; len(got) != 1 || got[0] != c.year || !strings.Contains(r.Metrics[0].Label, fmt.Sprintf("%d 年の写真", c.year)) {
			t.Errorf("%s: 年 = %v・%s", c.metrics, got, r.Metrics[0].Label)
		}
	}
	// 値が無い項目: null と「評価ファイルに値がありません」。地区の数が分からなければ「評価用の地区」
	r, _ := get(`{}`)
	by := metricsByKey(r)
	if v := by["holdout_object_f1"]; v.Value != nil || v.Note != "評価ファイルに値がありません" {
		t.Errorf("値が無い = %+v", v)
	}
	if len(r.Metrics) != 7 { // 選んだ倍率・閾値は、値があるときだけ
		t.Errorf("項目数 = %d", len(r.Metrics))
	}
	r, _ = get(`{"holdout":{"object":{"f1":0.5}}}`)
	if v := metricsByKey(r)["holdout_object_f1"]; v.Value == nil || v.Note != "評価用の地区。IoU 0.5 以上の 1 対 1 対応。タイルの縁に接する物体は除く" {
		t.Errorf("地区の数が無い = %+v", v)
	}
	// 整数の値は小数として返す（Python の float(v)）
	r, _ = get(`{"holdout":{"object":{"f1":1,"precision":0}},"new_building_recall":0,"chosen":{"scale":2,"threshold":"x"}}`)
	by = metricsByKey(r)
	if got := jsonOf(t, by["holdout_object_f1"]); !strings.Contains(got, `"value":1.0,`) {
		t.Errorf("整数 1 = %s", got)
	}
	if got := jsonOf(t, by["holdout_object_precision"]); !strings.Contains(got, `"value":0.0,`) {
		t.Errorf("整数 0 = %s", got)
	}
	// 新築の再現率: null 以外（0 を含む）なら「手ラベルによる値」
	if v := by["new_building_recall"]; v.Value == nil || *v.Value != 0 || v.Note != "手ラベルによる値" {
		t.Errorf("新築の再現率 = %+v", v)
	}
	if _, ok := by["chosen_scale"]; !ok {
		t.Error("数の chosen.scale は項目になる")
	}
	if _, ok := by["chosen_threshold"]; ok {
		t.Error("文字列の chosen.threshold は項目にならない")
	}
	// 真偽値・文字列は数として読まない
	r, _ = get(`{"holdout":{"object":{"f1":true,"precision":"0.5"}}}`)
	if v := metricsByKey(r)["holdout_object_f1"]; v.Value != nil {
		t.Errorf("真偽値を数として読んだ: %+v", v)
	}
	if v := metricsByKey(r)["holdout_object_precision"]; v.Value != nil {
		t.Errorf("文字列を数として読んだ: %+v", v)
	}
}

func TestGetAccuracyWithoutMetricsOrWithBrokenMetrics(t *testing.T) {
	f := newFakeData()
	f.metrics = nil
	wantRefusal(t, callTool(t, f, "get_accuracy", Args{}), "no_data", "評価の結果が読み込まれていません。")
	f.metrics = json.RawMessage(`null`) // jsonb の null は、Python の body is None と同じ
	wantRefusal(t, callTool(t, f, "get_accuracy", Args{}), "no_data", "評価の結果が読み込まれていません。")
	// 評価ファイルが JSON のオブジェクトでない（Python は例外 → 500）: 断りではなく、エラー
	for _, bad := range []string{`[1,2]`, `"x"`, `5`, `true`} {
		f := newFakeData()
		f.metrics = json.RawMessage(bad)
		if _, err := DefaultRegistry(0).Call(context.Background(), toolCtx(f), "get_accuracy", Args{}); err == nil {
			t.Errorf("%s: エラーのはず", bad)
		}
	}
	// DB のエラーは、断りにしない
	f = newFakeData()
	f.metrErr = store.ErrUnavailable
	if _, err := DefaultRegistry(0).Call(context.Background(), toolCtx(f), "get_accuracy", Args{}); !errors.Is(err, store.ErrUnavailable) {
		t.Errorf("err = %v", err)
	}
}

func TestSizeOfLikePythonLen(t *testing.T) {
	for _, c := range []struct {
		in   string
		want int
	}{{`["a","b"]`, 2}, {`{"a":1}`, 1}, {`"あい"`, 2}, {`null`, 0}, {`5`, 0}, {`true`, 0}, {`[]`, 0}} {
		var v any
		if err := json.Unmarshal([]byte(c.in), &v); err != nil {
			t.Fatal(err)
		}
		if got := sizeOf(v); got != c.want {
			t.Errorf("sizeOf(%s) = %d", c.in, got)
		}
	}
}

// ---- 使い方・断り ----

func TestShowHelp(t *testing.T) {
	r := callTool(t, newFakeData(), "show_help", Args{}).(TableResult)
	rows := r.Rows.([]HelpRow)
	if r.Total != 6 || r.Shown != 6 || len(rows) != 6 || r.Filter != nil || r.Title != "このアプリでできること（聞き方の例）" {
		t.Errorf("使い方: %s", jsonOf(t, r))
	}
	if got := jsonOf(t, rows[0]); got != `{"example":"候補は何件ありますか？","result":"件数と分類ごとの内訳"}` {
		t.Errorf("1 行目 = %s", got)
	}
	if got := jsonOf(t, r.Provenance); !strings.Contains(got, `"note":"合成データ（テスト用）です。実データではありません。 結果はすべて、写真から機械が見つけた候補です。"`) {
		t.Errorf("出どころ = %s", got)
	}
	if strings.Contains(jsonOf(t, r), `"filter"`) {
		t.Error("使い方の表に filter は無い")
	}
}

func TestRefuseTool(t *testing.T) {
	f := newFakeData()
	// 知らない reason は out_of_scope に直す。message が無ければ固定の文
	wantRefusal(t, callTool(t, f, "refuse", Args{Reason: "bogus", Message: "だめ"}), "out_of_scope", "だめ")
	wantRefusal(t, callTool(t, f, "refuse", Args{Reason: "no_photo_period"}), "no_photo_period", "その質問には答えられません。")
	wantRefusal(t, callTool(t, f, "refuse", Args{}), "out_of_scope", "その質問には答えられません。")
	for _, reason := range refusalReasons {
		wantRefusal(t, callTool(t, f, "refuse", Args{Reason: reason, Message: "x"}), reason, "x")
	}
	// 提案: 無ければ既定、あればそのまま
	if r := callTool(t, f, "refuse", Args{Reason: "out_of_scope"}).(RefusalResult); len(r.Suggestions) != 4 {
		t.Errorf("既定の提案 = %v", r.Suggestions)
	}
	if r := callTool(t, f, "refuse", Args{Reason: "out_of_scope", Suggestions: []string{"a"}}).(RefusalResult); len(r.Suggestions) != 1 || r.Suggestions[0] != "a" {
		t.Errorf("渡した提案 = %v", r.Suggestions)
	}
}

// ---- 登録表 ----

func TestDefaultRegistryHasTheSpecifiedTools(t *testing.T) {
	reg := DefaultRegistry(0)
	want := "count_candidates list_candidates compare_areas show_candidate get_accuracy focus_map show_help refuse"
	if got := strings.Join(reg.Names(), " "); got != want {
		t.Errorf("Names = %s", got)
	}
	schemas := reg.Schemas()
	if len(schemas) != 8 {
		t.Fatalf("Schemas = %d 件", len(schemas))
	}
	b := jsonOf(t, schemas)
	for _, s := range []string{`"input_schema":{"properties":{},"type":"object"}`, `"maximum":50`, `"enum":["confirmed_new","existing_omission","uncertain"]`, `"required":["reason"]`} {
		if !strings.Contains(b, s) {
			t.Errorf("定義に %s が無い: %s", s, b)
		}
	}
	if _, ok := reg.Get("count_candidates"); !ok {
		t.Error("Get")
	}
	if _, ok := reg.Get("rm_rf"); ok {
		t.Error("知らないツールがある")
	}
}

type heatmapResult struct{ title string }

func (h heatmapResult) ResultTitle() string { return h.title }

type untitledResult struct{}

func TestRegistryAcceptsANewToolLater(t *testing.T) {
	reg := DefaultRegistry(0)
	tool := Tool{
		Name: "gee_change_hint", Description: "衛星の変化の当たり（後から足す道具の例）", Parameters: objectSchema(map[string]any{}),
		Handler: func(context.Context, *ToolContext, Args) (Result, error) {
			return heatmapResult{"変化の当たり（例）"}, nil
		},
	}
	if err := reg.Register(tool); err != nil {
		t.Fatal(err)
	}
	if err := reg.Register(tool); err == nil || !strings.Contains(err.Error(), "既に登録されています") {
		t.Errorf("同じ名前の 2 度目の登録は失敗: %v", err)
	}
	if !strings.Contains(strings.Join(reg.Names(), " "), "gee_change_hint") || !strings.Contains(jsonOf(t, reg.Schemas()), "gee_change_hint") {
		t.Error("足したツールが一覧に無い")
	}
	r, err := reg.Call(context.Background(), toolCtx(newFakeData()), "gee_change_hint", Args{})
	if err != nil || r.(heatmapResult).title != "変化の当たり（例）" {
		t.Errorf("呼び出し: %v %v", r, err)
	}
	// 文章化を足していない型は、タイトルだけの一般的な文。タイトルも無ければ固定の文
	if got := Render(r); got != "変化の当たり（例） を表示します。" {
		t.Errorf("Render = %q", got)
	}
	if got := Render(heatmapResult{}); got != "結果を表示します。" {
		t.Errorf("タイトルが空 = %q", got)
	}
	if got := Render(untitledResult{}); got != "結果を表示します。" {
		t.Errorf("型が不明 = %q", got)
	}
}

func TestRegistryCallRefusesUnknownToolsAndKeepsOtherErrors(t *testing.T) {
	reg := DefaultRegistry(0)
	r, err := reg.Call(context.Background(), toolCtx(newFakeData()), "rm_rf", Args{})
	if err != nil {
		t.Fatal(err)
	}
	wantRefusal(t, r, "out_of_scope", "その操作はできません。")
	if len(r.(RefusalResult).Suggestions) != 4 {
		t.Errorf("提案 = %v", r.(RefusalResult).Suggestions)
	}
	// ToolError は、提案ごと断りの結果にする（nil は既定・空は空のまま）
	custom := NewRegistry()
	_ = custom.Register(Tool{Name: "a", Handler: func(context.Context, *ToolContext, Args) (Result, error) {
		return nil, &ToolError{Reason: "no_data", Message: "m", Suggestions: []string{}}
	}})
	_ = custom.Register(Tool{Name: "b", Handler: func(context.Context, *ToolContext, Args) (Result, error) {
		return nil, fmt.Errorf("包まれた: %w", &ToolError{Reason: "no_data", Message: "m2"})
	}})
	boom := errors.New("DB の不調")
	_ = custom.Register(Tool{Name: "c", Handler: func(context.Context, *ToolContext, Args) (Result, error) { return nil, boom }})
	ra, _ := custom.Call(context.Background(), nil, "a", Args{})
	if got := jsonOf(t, ra); got != `{"type":"refusal","reason":"no_data","message":"m","suggestions":[]}` {
		t.Errorf("提案が空 = %s", got)
	}
	rb, _ := custom.Call(context.Background(), nil, "b", Args{})
	if len(rb.(RefusalResult).Suggestions) != 4 {
		t.Errorf("提案が nil = %v", rb)
	}
	if _, err := custom.Call(context.Background(), nil, "c", Args{}); !errors.Is(err, boom) {
		t.Errorf("ToolError 以外はそのまま返す: %v", err)
	}
}

// DB の不調は、どのツールでも断りにせず、エラーで返す（API は 503・500 にする）。
func TestDatabaseErrorsAreNotRefusals(t *testing.T) {
	for _, tc := range []struct {
		tool string
		args Args
	}{
		{"count_candidates", Args{}}, {"list_candidates", Args{}}, {"show_candidate", Args{}}, // compare_areas は、要求の最初に読んだ地区の表（件数つき）だけを使い、DB に聞かない
		{"show_candidate", Args{CandidateID: "c-226249-105759-1"}}, {"focus_map", Args{}}, {"focus_map", Args{CandidateID: "c-226249-105759-1"}}, {"get_accuracy", Args{}},
	} {
		f := newFakeData()
		f.err = store.ErrUnavailable
		if _, err := DefaultRegistry(0).Call(context.Background(), toolCtx(f), tc.tool, tc.args); !errors.Is(err, store.ErrUnavailable) {
			t.Errorf("%s: err = %v", tc.tool, err)
		}
	}
}
