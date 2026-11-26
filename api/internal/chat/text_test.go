package chat

import (
	"context"
	"strings"
	"testing"

	"townscan/api/internal/pyjson"
	"townscan/api/internal/store"
)

// 返答文の文面（text.go）の単体テスト。結果の値だけが数字として文に出ること・数字の書式（3 桁区切り・小数 2 桁）・0 件の書き方を確かめる。

func TestCommas(t *testing.T) {
	for in, want := range map[int64]string{
		0: "0", 7: "7", 999: "999", 1000: "1,000", 12345: "12,345", 123456: "123,456", 1234567: "1,234,567",
		-1: "-1", -1000: "-1,000", -123456: "-123,456", 9223372036854775807: "9,223,372,036,854,775,807",
	} {
		if got := commas(in); got != want {
			t.Errorf("commas(%d) = %q, 期待 %q", in, got, want)
		}
	}
}

func TestRatioRoundsLikePython(t *testing.T) {
	for in, want := range map[float64]string{0.58: "0.58", 0.5: "0.50", 0: "0.00", 1: "1.00", 0.125: "0.12", 0.375: "0.38", 0.005: "0.01", 0.0049: "0.00", 0.7634: "0.76"} {
		if got := ratio(in); got != want {
			t.Errorf("ratio(%v) = %q, 期待 %q", in, got, want)
		}
	}
}

func TestRenderCount(t *testing.T) {
	f := newFakeData()
	all := callTool(t, f, "count_candidates", Args{})
	if got, want := Render(all), "全地区の候補は 9 件です。内訳は、新規出現（旧写真に無い） 4 件、既存の描き漏れ（旧写真に既にある） 3 件、判定保留 2 件 です。機械が写真から見つけた候補で、確定ではありません。"; got != want {
		t.Errorf("全分類\n got  %s\n want %s", got, want)
	}
	one := callTool(t, f, "count_candidates", Args{AreaIDs: []string{a1}, Cls: "confirmed_new"})
	if got, want := Render(one), "合成町の「新規出現（旧写真に無い）」は 1 件です。機械が写真から見つけた候補で、確定ではありません。"; got != want {
		t.Errorf("1 分類\n got  %s\n want %s", got, want)
	}
	// 0 件は、0 件と書く（内訳は書かない）
	zero := callTool(t, f, "count_candidates", Args{AreaIDs: []string{a3}, Cls: "uncertain"})
	if got, want := Render(zero), "仮想町には、該当する候補はありません。"; got != want {
		t.Errorf("0 件 = %s", got)
	}
	// 3 桁区切り
	big := CountResult{Type: "count", Total: 12345, Breakdown: []Breakdown{{"confirmed_new", "新規", 12345}}, Filter: FilterInfo{Cls: "confirmed_new", Scope: "全地区"}}
	if got := Render(big); !strings.Contains(got, "は 12,345 件です。") {
		t.Errorf("3 桁区切り = %s", got)
	}
	// scope が空なら「全地区」
	if got := Render(CountResult{Total: 0}); got != "全地区には、該当する候補はありません。" {
		t.Errorf("scope が空 = %s", got)
	}
}

func TestRenderTable(t *testing.T) {
	f := newFakeData()
	list := callTool(t, f, "list_candidates", Args{Limit: intp(3)})
	if got, want := Render(list), "全地区の候補を、面積の大きい順に 3 件表示します（該当は全部で 9 件）。候補の ID を使って、その写真を見せて、と聞けます。"; got != want {
		t.Errorf("一覧 = %s", got)
	}
	empty := callTool(t, f, "list_candidates", Args{AreaIDs: []string{a3}, Cls: "uncertain"})
	if got := Render(empty); got != "仮想町には、該当する候補はありません。" {
		t.Errorf("0 件の一覧 = %s", got)
	}
	help := callTool(t, f, "show_help", Args{})
	if got := Render(help); got != "このアプリは、熊本市中心部の空中写真から、新築の候補を棟ごとに見つけて答えます。次のように聞けます。" {
		t.Errorf("使い方 = %s", got)
	}
}

func TestRenderCompare(t *testing.T) {
	f := newFakeData()
	if got, want := Render(callTool(t, f, "compare_areas", Args{})), "全地区の地区ごとの件数を比べました。候補の合計が最も多いのは 仮想町 で、3 件です。"; got != want {
		t.Errorf("合計 = %s", got)
	}
	if got, want := Render(callTool(t, f, "compare_areas", Args{Cls: "confirmed_new"})), "全地区の地区ごとの件数を比べました。「新規出現（旧写真に無い）」が最も多いのは 試験町 で、2 件です。"; got != want {
		t.Errorf("新規出現 = %s", got)
	}
	if got := Render(CompareResult{Filter: FilterInfo{Scope: "東区"}}); got != "東区には、比べる地区がありません。" {
		t.Errorf("地区が無い = %s", got)
	}
	// 知らない並びのキーは、キーをそのまま書く
	r := CompareResult{Items: []CompareItem{{Name: "甲", Counts: store.AreaCounts{Total: 4}}}, SortKey: "total"}
	if got := Render(r); !strings.Contains(got, "候補の合計が最も多いのは 甲 で、4 件です。") {
		t.Errorf("= %s", got)
	}
}

func TestRenderDetectionImageAndMap(t *testing.T) {
	f := newFakeData()
	got := Render(callTool(t, f, "show_candidate", Args{CandidateID: "c-226249-105759-2"}))
	if want := "候補 c-226249-105759-2 の写真を、2018 年と 2023 年で並べます。合成町・新規出現（旧写真に無い）・面積 約 302 m²。輪郭は機械が抽出した範囲で、確定ではありません。"; got != want {
		t.Errorf("写真 = %s", got)
	}
	got = Render(callTool(t, f, "focus_map", Args{AreaIDs: []string{a1}}))
	if want := "地図を合わせます: 合成町の候補 3 件を地図で表示。"; got != want {
		t.Errorf("地図 = %s", got)
	}
}

func TestRenderAccuracy(t *testing.T) {
	f := newFakeData()
	got := Render(callTool(t, f, "get_accuracy", Args{}))
	want := "建物抽出の精度を、基盤地図情報を参照にして、2018 年の写真で実測しました。評価用の地区での物体単位 F1 は 0.58 です。" +
		"建物の抽出の適合率は 0.62、建物の抽出の再現率（基盤地図情報に対する値）は 0.55 です。" +
		"調整用の地区の F1 は 0.60（倍率と閾値を選ぶのに使ったので、参考値）です。" +
		"「新築の再現率」（本当の新築のうち候補に出せた割合）は、手ラベルが無いため未測定で、上の建物の抽出の再現率とは別の値です。分類の閾値は未検証の初期値です。" +
		"なお、これは合成データ（テスト用）の値です。"
	if got != want {
		t.Errorf("精度\n got  %s\n want %s", got, want)
	}
	// 「再現率」を修飾なしで書かない（建物の抽出の再現率と新築の再現率を取り違えさせない）
	stripped := strings.NewReplacer("建物の抽出の再現率", "", "新築の再現率", "").Replace(got)
	if strings.Contains(stripped, "再現率") {
		t.Errorf("修飾の無い「再現率」がある: %s", stripped)
	}
	// 値が無い: 「ありません」と書き、適合率・再現率は書かない。実データ（合成でない）なら、合成データの注記は付かない
	f.metrics = []byte(`{}`)
	f.run.Kind = "real"
	got = Render(callTool(t, f, "get_accuracy", Args{}))
	if !strings.HasPrefix(got, "建物抽出の精度の値が、評価ファイルにありません。「新築の再現率」") || strings.Contains(got, "合成データ") || strings.Contains(got, "適合率") {
		t.Errorf("値が無い = %s", got)
	}
	// F1 だけがある: 適合率・再現率は、2 つそろったときだけ書く
	f.metrics = []byte(`{"holdout":{"object":{"f1":0.5,"precision":0.4}}}`)
	got = Render(callTool(t, f, "get_accuracy", Args{}))
	if !strings.Contains(got, "物体単位 F1 は 0.50 です。「新築の再現率」") || strings.Contains(got, "適合率") {
		t.Errorf("F1 だけ = %s", got)
	}
	// 写真の年が分からなければ「…年の写真で」を書かない
	r := AccuracyResult{Metrics: []Metric{{Key: "holdout_object_f1", Value: ptr(pyjson.Float(0.5))}}}
	if got := Render(r); !strings.Contains(got, "基盤地図情報を参照にして、実測しました。") {
		t.Errorf("年が無い = %s", got)
	}
}

func TestRenderRefusalIsTheMessageAndComposeJoinsInOrder(t *testing.T) {
	if got := Render(newRefusal("out_of_scope", "答えられません。", nil)); got != "答えられません。" {
		t.Errorf("断り = %q", got)
	}
	f := newFakeData()
	reg := DefaultRegistry(0)
	var results []Result
	for _, c := range []Call{{Name: "count_candidates", Args: Args{Cls: "confirmed_new"}}, {Name: "list_candidates", Args: Args{Limit: intp(2), Cls: "confirmed_new"}}} {
		r, err := reg.Call(context.Background(), toolCtx(f), c.Name, c.Args)
		if err != nil {
			t.Fatal(err)
		}
		results = append(results, r)
	}
	want := Render(results[0]) + Render(results[1])
	if got := Compose(results); got != want || !strings.HasPrefix(got, "全地区の「新規出現（旧写真に無い）」は 4 件です。") || !strings.HasSuffix(got, "と聞けます。") {
		t.Errorf("Compose = %s", got)
	}
	if got := Compose(nil); got != "" {
		t.Errorf("結果なし = %q", got)
	}
}

// 返答文の数字は、結果の値から出る。どの種類の結果の文も、数字の検査に通る（模擬モデルが安全なテンプレートに落ちない）。
func TestEveryRenderedTextPassesTheNumberGuard(t *testing.T) {
	f := newFakeData()
	for _, c := range []Call{
		{Name: "count_candidates", Args: Args{}}, {Name: "count_candidates", Args: Args{Ward: "中央区", Cls: "uncertain"}},
		{Name: "list_candidates", Args: Args{Limit: intp(4)}}, {Name: "compare_areas", Args: Args{}}, {Name: "compare_areas", Args: Args{Cls: "existing_omission"}},
		{Name: "show_candidate", Args: Args{}}, {Name: "show_candidate", Args: Args{CandidateID: "c-226249-105760-3"}},
		{Name: "focus_map", Args: Args{}}, {Name: "focus_map", Args: Args{AreaIDs: []string{a2}, Cls: "uncertain"}}, {Name: "get_accuracy"}, {Name: "show_help"},
	} {
		r, err := DefaultRegistry(0).Call(context.Background(), toolCtx(f), c.Name, c.Args)
		if err != nil {
			t.Fatal(err)
		}
		text := Render(r)
		if text == "" {
			t.Errorf("%s: 文が空", c.Name)
		}
		if bad := findUnsupportedNumbers(text, genericOf([]Result{r})); len(bad) != 0 {
			t.Errorf("%s %+v: 結果から出せない数字 %v\n%s", c.Name, c.Args, bad, text)
		}
	}
}
