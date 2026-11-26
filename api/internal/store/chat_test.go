package store

import (
	"context"
	"slices"
	"strings"
	"testing"
	"time"

	"townscan/api/internal/pyjson"
)

// チャットのツールが使う問い合わせ（chat.go）。DB を使うテストは、TEST_DATABASE_URL が無いと skip する（scripts/test-go.sh は設定する）。

// seedChatData は、2 つの run に、地区と候補を入れる。r1 が対象で、r2 は、混ざらないことを確かめるためのもの。
func seedChatData(t *testing.T, s *Store) (a1, a2 string) {
	t.Helper()
	seedRun(t, s, "r1", "synthetic", "2026-11-24T03:00:00Z", "m")
	seedRun(t, s, "r2", "real", "2026-11-23T03:00:00Z", "m")
	a1 = seedArea(t, s, "r1", 1, 1, "試験町", "中央区", nil)
	a2 = seedArea(t, s, "r1", 2, 1, "仮想町", "東区", nil)
	b1 := seedArea(t, s, "r2", 1, 1, "別の run", "北区", nil)
	g, ev := `{"type":"Polygon","coordinates":[]}`, `{}`
	seedCandidate(t, s, "r1", a1, "c-1-1-1", "confirmed_new", 300.5, g, ev)
	seedCandidate(t, s, "r1", a1, "c-1-1-2", "existing_omission", 100, g, ev)
	seedCandidate(t, s, "r1", a1, "c-1-1-3", "uncertain", 100, g, ev) // 同じ面積は、id の昇順
	seedCandidate(t, s, "r1", a2, "c-2-1-1", "confirmed_new", 50.25, g, ev)
	seedCandidate(t, s, "r1", a2, "c-2-1-2", "confirmed_new", 400, g, ev)
	seedCandidate(t, s, "r2", b1, "c-9-9-9", "confirmed_new", 9999, g, ev)
	return a1, a2
}

func TestCountByClassSplitsUncertainByReason(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	a1, _ := seedChatData(t, s) // a1 の未判定は c-1-1-3 の 1 件
	for _, c := range []struct{ id, reason string }{{"c-1-1-3", "edge"}, {"c-1-1-4", "ambiguous"}, {"c-1-1-5", "edge"}, {"c-1-1-6", "something_new"}} {
		if c.id != "c-1-1-3" {
			seedCandidate(t, s, "r1", a1, c.id, "uncertain", 10, `{}`, `{}`)
		}
		exec(t, s, "UPDATE candidates SET reason = $1 WHERE run_id = 'r1' AND id = $2", c.reason, c.id)
	}
	got, err := s.CountByClass(ctx, "r1", Filter{AreaIDs: []string{a1}})
	want := ClassCounts{ConfirmedNew: 1, ExistingOmission: 1, Uncertain: 4, UncertainEdge: 2, UncertainReview: 1}
	if err != nil || got != want {
		t.Errorf("理由ごと: %+v, %v; 期待 %+v", got, err, want)
	}
}

func TestCountByClass(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	a1, a2 := seedChatData(t, s)
	cases := []struct {
		name string
		run  string
		f    Filter
		want ClassCounts
	}{
		{"全部", "r1", Filter{}, ClassCounts{ConfirmedNew: 3, ExistingOmission: 1, Uncertain: 1}},
		{"1 地区", "r1", Filter{AreaIDs: []string{a1}}, ClassCounts{ConfirmedNew: 1, ExistingOmission: 1, Uncertain: 1}},
		{"2 地区", "r1", Filter{AreaIDs: []string{a1, a2}}, ClassCounts{ConfirmedNew: 3, ExistingOmission: 1, Uncertain: 1}},
		{"分類", "r1", Filter{Class: "confirmed_new"}, ClassCounts{ConfirmedNew: 3}}, // 分類の外は 0
		{"地区と分類", "r1", Filter{AreaIDs: []string{a2}, Class: "uncertain"}, ClassCounts{}},
		{"空の地区の一覧（nil ではない）は、何にも合わない", "r1", Filter{AreaIDs: []string{}}, ClassCounts{}},
		{"知らない地区", "r1", Filter{AreaIDs: []string{"z18-9-9"}}, ClassCounts{}},
		{"知らない分類", "r1", Filter{Class: "bogus"}, ClassCounts{}},
		{"別の run は混ざらない", "r2", Filter{}, ClassCounts{ConfirmedNew: 1}},
		{"知らない run", "none", Filter{}, ClassCounts{}},
	}
	for _, c := range cases {
		got, err := s.CountByClass(ctx, c.run, c.f)
		if err != nil || got != c.want {
			t.Errorf("%s: %+v, %v; 期待 %+v", c.name, got, err, c.want)
		}
	}
	if c := (ClassCounts{ConfirmedNew: 3, ExistingOmission: 1, Uncertain: 2}); c.Sum() != 6 || c.Of("uncertain") != 2 || c.Of("existing_omission") != 1 || c.Of("confirmed_new") != 3 || c.Of("total") != 0 {
		t.Errorf("ClassCounts = %+v", c)
	}
}

func TestCandidateIDs(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	a1, a2 := seedChatData(t, s)
	cases := []struct {
		name  string
		f     Filter
		limit int
		want  []string
	}{
		{"面積の降順・同じなら id の昇順", Filter{}, 100, []string{"c-2-1-2", "c-1-1-1", "c-1-1-2", "c-1-1-3", "c-2-1-1"}},
		{"件数の上限", Filter{}, 2, []string{"c-2-1-2", "c-1-1-1"}},
		{"上限 0", Filter{}, 0, []string{}},
		{"地区", Filter{AreaIDs: []string{a2}}, 100, []string{"c-2-1-2", "c-2-1-1"}},
		{"分類", Filter{Class: "existing_omission"}, 100, []string{"c-1-1-2"}},
		{"地区と分類", Filter{AreaIDs: []string{a1, a2}, Class: "confirmed_new"}, 2, []string{"c-2-1-2", "c-1-1-1"}},
		{"合うものが無い", Filter{AreaIDs: []string{}}, 100, []string{}},
	}
	for _, c := range cases {
		got, err := s.CandidateIDs(ctx, "r1", c.f, c.limit)
		if err != nil || !slices.Equal(got, c.want) || got == nil {
			t.Errorf("%s: %v, %v; 期待 %v", c.name, got, err, c.want)
		}
	}
	// 空でも、JSON の [] になる（null にならない）
	if got, _ := s.CandidateIDs(ctx, "none", Filter{}, 10); got == nil || len(got) != 0 {
		t.Errorf("run が無い = %#v", got)
	}
}

func TestAreaUnionBBox(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	a1, a2 := seedChatData(t, s)
	// 地区の箱を、地区ごとに変える（西・南・東・北）
	exec(t, s, "UPDATE areas SET west = 130.50, south = 32.50, east = 130.60, north = 32.60 WHERE run_id = 'r1' AND id = $1", a1)
	exec(t, s, "UPDATE areas SET west = 130.55, south = 32.40, east = 130.80, north = 32.55 WHERE run_id = 'r1' AND id = $1", a2)
	b, err := s.AreaUnionBBox(ctx, "r1", nil)
	if err != nil || b == nil || *b != [4]pyjson.Float{130.50, 32.40, 130.80, 32.60} {
		t.Errorf("全地区 = %v, %v", b, err)
	}
	if b, _ := s.AreaUnionBBox(ctx, "r1", []string{a1}); b == nil || *b != [4]pyjson.Float{130.50, 32.50, 130.60, 32.60} {
		t.Errorf("1 地区 = %v", b)
	}
	if b, _ := s.AreaUnionBBox(ctx, "r1", []string{a2, a1}); b == nil || *b != [4]pyjson.Float{130.50, 32.40, 130.80, 32.60} {
		t.Errorf("2 地区 = %v", b)
	}
	// 地区が 1 つも無い（知らない id・空の一覧・run が無い）→ nil
	for name, ids := range map[string][]string{"知らない id": {"z18-9-9"}, "空の一覧": {}} {
		if b, err := s.AreaUnionBBox(ctx, "r1", ids); b != nil || err != nil {
			t.Errorf("%s = %v, %v", name, b, err)
		}
	}
	if b, err := s.AreaUnionBBox(ctx, "none", nil); b != nil || err != nil {
		t.Errorf("run が無い = %v, %v", b, err)
	}
	// 別の run の地区は混ざらない
	if b, _ := s.AreaUnionBBox(ctx, "r2", nil); b == nil || *b != [4]pyjson.Float{130.5, 32.5, 130.75, 32.75} {
		t.Errorf("r2 = %v", b)
	}
}

// 質問の文字列から作った値は、必ずパラメーターで渡る。SQL の断片として解釈されない。
func TestChatQueriesTreatInputAsValuesNotSQL(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	seedChatData(t, s)
	evil := []string{"'; DROP TABLE candidates; --", "z18-1-1' OR '1'='1", `"; DELETE FROM areas; --`, "') OR 1=1 --", "\x00", "$1", "%", "ANY('{}')"}
	for _, e := range evil {
		if c, err := s.CountByClass(ctx, "r1", Filter{AreaIDs: []string{e}}); err != nil && !strings.Contains(e, "\x00") || c != (ClassCounts{}) {
			t.Errorf("CountByClass(%q) = %+v, %v", e, c, err)
		}
		if c, err := s.CountByClass(ctx, "r1", Filter{Class: e}); err != nil && !strings.Contains(e, "\x00") || c != (ClassCounts{}) {
			t.Errorf("CountByClass(class=%q) = %+v, %v", e, c, err)
		}
		if ids, err := s.CandidateIDs(ctx, e, Filter{AreaIDs: []string{e}, Class: e}, 5); err != nil && !strings.Contains(e, "\x00") || len(ids) != 0 {
			t.Errorf("CandidateIDs(%q) = %v, %v", e, ids, err)
		}
		if b, err := s.AreaUnionBBox(ctx, "r1", []string{e}); err != nil && !strings.Contains(e, "\x00") || b != nil {
			t.Errorf("AreaUnionBBox(%q) = %v, %v", e, b, err)
		}
	}
	// 表も行も、そのまま
	var n int
	if err := s.pool.QueryRow(ctx, "SELECT (SELECT count(*) FROM candidates) + (SELECT count(*) FROM areas) + (SELECT count(*) FROM runs)").Scan(&n); err != nil || n != 6+3+2 {
		t.Errorf("行の数 = %d, %v", n, err)
	}
}

func TestChatQueriesReportAnUnreachableDatabaseAsUnavailable(t *testing.T) {
	s := testStore(t)
	seedChatData(t, s)
	s.Close()
	ctx := context.Background()
	if _, err := s.CountByClass(ctx, "r1", Filter{}); !isUnavailable(err) {
		t.Errorf("CountByClass: %v", err)
	}
	if _, err := s.CandidateIDs(ctx, "r1", Filter{}, 1); !isUnavailable(err) {
		t.Errorf("CandidateIDs: %v", err)
	}
	if _, err := s.AreaUnionBBox(ctx, "r1", nil); !isUnavailable(err) {
		t.Errorf("AreaUnionBBox: %v", err)
	}
}

func isUnavailable(err error) bool {
	return err != nil && strings.Contains(err.Error(), "DB に接続できません")
}

// ---- 出どころ（チャットの結果に付ける） ----

func TestChatProvenance(t *testing.T) {
	synthetic := Run{RunID: "synthetic-test", Kind: "synthetic", CreatedAt: time.Date(2026, 11, 24, 3, 0, 0, 0, time.UTC), Model: "m"}
	real := Run{RunID: "run-1", Kind: "real", Model: ""}

	p := CandidateProvenanceWithNote(synthetic, "結果はすべて、写真から機械が見つけた候補です。")
	if p.Source != sourceCandidates || !slices.Equal(p.PhotoYears, []int{2018, 2023}) || p.Model != "m" || p.RunID != "synthetic-test" || p.RunKind != "synthetic" || p.Metric != "" ||
		p.Note != "合成データ（テスト用）です。実データではありません。 結果はすべて、写真から機械が見つけた候補です。" {
		t.Errorf("候補（合成）= %+v", p)
	}
	// 実データなら、合成データの注記は付かない。モデルが空なら「不明」
	p = CandidateProvenanceWithNote(real, "メモ")
	if p.Note != "メモ" || p.Model != "不明" || p.RunKind != "real" {
		t.Errorf("候補（実）= %+v", p)
	}
	// 年は、評価ファイルにある年（2018 以外もありうる）。書き換えても、元の表（photoYears）は変わらない
	p = AccuracyProvenanceForYear(real, 2023)
	if p.Source != sourceAccuracy || !slices.Equal(p.PhotoYears, []int{2023}) || p.Metric != "物体単位 F1・画素 IoU" ||
		p.Note != "数字は 2023 年の写真で測った値。新築の再現率は正解になる新築のデータが無く未測定。分類の閾値は未検証の初期値。" {
		t.Errorf("精度 = %+v", p)
	}
	// 2018 年なら、/api/metrics の出どころ（AccuracyProvenance）と同じ
	if a, b := AccuracyProvenanceForYear(synthetic, 2018), AccuracyProvenance(synthetic); a.Note != b.Note || !slices.Equal(a.PhotoYears, b.PhotoYears) || a.Source != b.Source || a.Metric != b.Metric {
		t.Errorf("2018 年: %+v / %+v", a, b)
	}
	p = CandidateProvenanceWithNote(synthetic, "")
	p.PhotoYears[0] = 1
	if !slices.Equal(photoYears, []int{2018, 2023}) {
		t.Errorf("共有の年の表が書き換わった: %v", photoYears)
	}
}
