package chat

import (
	"context"
	"errors"
	"slices"
	"testing"

	"townscan/api/internal/pyjson"
	"townscan/api/internal/store"
)

// Python の実装が出した期待値（testdata/golden.json.gz の pick・safe_template。作り方は git 履歴 e9a6614 の gen_golden.py）と、Go の実装が同じになるか。
// 変異テストで、規則の 1 か所を書き換えても落ちなかった所（L18・G14）を、Python の実装に合わせる検査。

// 数字の検査に落ちたときの、安全なテンプレートの文面が、Python と同じ（文面が変わると、画面に出る文が変わる）。
func TestGoldenSafeTemplateMatchesPython(t *testing.T) {
	g := loadGolden(t)
	if g.SafeTemplate == "" {
		t.Fatal("期待値が無い（testdata を作り直したときに、safe_template が消えていないか）")
	}
	if SafeTemplate != g.SafeTemplate {
		t.Errorf("SafeTemplate = %q\n  Python   = %q", SafeTemplate, g.SafeTemplate)
	}
	if out, replaced := GuardNumbers("候補は 424242 件です", nil); out != g.SafeTemplate || !replaced {
		t.Errorf("差し替えた文 = %q (replaced=%v)、Python は %q", out, replaced, g.SafeTemplate)
	}
}

// 写真の対象の候補の選び方が、Python の _pick_candidate と同じ。分類を指定したのに無いときは、ほかの分類を探さず断る。
// Python のあとに、意図して変えた点が 1 つ: 分類の指定が無ければ、全分類で最大を選ぶ（Python は「新規出現」を先に探した。ADR 0013）。
// 期待値は凍結したまま、この組だけ、地区の条件に合う候補の最大（同じ面積は id の昇順）に読み替える。
func TestGoldenPickCandidateMatchesPython(t *testing.T) {
	g := loadGolden(t)
	p := g.Pick
	if len(p.Cases) < 60 {
		t.Fatalf("期待値が少ない: %d", len(p.Cases))
	}
	f := newFakeData()
	f.areas = nil
	for _, a := range p.Areas {
		f.areas = append(f.areas, store.Area{ID: a.ID, Name: a.Name, Ward: a.Ward})
	}
	f.cands = nil
	for _, c := range p.Cands {
		area, _ := c[3].(float64)
		name := ""
		for _, a := range p.Areas {
			if a.ID == c[1].(string) {
				name = a.Name
			}
		}
		f.cands = append(f.cands, candidate(c[0].(string), c[1].(string), name, c[2].(string), area))
	}
	largest := func(ids []string) string { // ids が nil なら全地区
		best := -1
		for i, c := range f.cands {
			if ids != nil && !slices.Contains(ids, c.AreaID) {
				continue
			}
			if best < 0 || c.AreaM2 > f.cands[best].AreaM2 || (c.AreaM2 == f.cands[best].AreaM2 && c.ID < f.cands[best].ID) {
				best = i
			}
		}
		if best < 0 {
			return ""
		}
		return f.cands[best].ID
	}
	sawNoDataForGivenClass, changed := 0, 0
	for _, c := range p.Cases {
		if c.Res.ID != "" && c.Args.CandidateID == "" && c.Args.Cls == "" {
			ids, _, err := resolveAreas(toolCtx(f), c.Args)
			if err != nil {
				t.Fatal(err)
			}
			if want := largest(ids); want != c.Res.ID {
				changed++
				c.Res.ID = want
			}
		}
		got, err := pickCandidate(context.Background(), toolCtx(f), c.Args)
		args, _ := pyjson.Marshal(c.Args)
		switch {
		case c.Res.ID != "":
			if err != nil || got == nil || got.ID != c.Res.ID {
				t.Errorf("%s: Go = %v (%v)、Python は %s", args, got, err, c.Res.ID)
			}
		default:
			var te *ToolError
			if !errors.As(err, &te) || te.Reason != c.Res.Err || te.Message != c.Res.Msg {
				t.Errorf("%s: Go = %v (%v)、Python は %s / %s", args, got, err, c.Res.Err, c.Res.Msg)
			}
			if c.Args.Cls != "" && c.Res.Msg == "該当する候補がありません。" {
				sawNoDataForGivenClass++
			}
		}
	}
	// 読み替えが効く組（新規出現より大きい、ほかの分類の候補がある地区）が、期待値に入っている
	if changed == 0 {
		t.Error("Python と選び方が分かれる組が無い（読み替えの検査が意味を持たない）")
	}
	// 分類を指定して、その分類が無い（ほかの分類はある）組が、期待値に入っている（入っていないと、この検査が意味を持たない）
	if sawNoDataForGivenClass < 3 {
		t.Errorf("分類を指定して該当が無い組が %d 件しかない", sawNoDataForGivenClass)
	}
}
