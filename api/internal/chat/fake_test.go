package chat

import (
	"context"
	"encoding/json"
	"sort"
	"time"

	"townscan/api/internal/pyjson"
	"townscan/api/internal/store"
)

// fakeData は、DB の代わり（Data の偽の実装）。契約の検査の合成データと同じ形（3 地区・9 候補）を持つ。
// 絞り込み・並び順・件数の数え方は、SQL と同じ規則を、メモリーの上で書いたもの（SQL そのものは、store のテストと契約の検査が見る）。
type fakeData struct {
	run     *store.Run
	areas   []store.Area
	cands   []store.Candidate
	metrics json.RawMessage

	err      error // 設定すると、すべての問い合わせがこのエラーを返す
	runErr   error
	metrErr  error
	calls    []string
	lastList store.Filter
}

const (
	a1 = "z18-226249-105759"
	a2 = "z18-226250-105759"
	a3 = "z18-226249-105760"
)

func ptr[T any](v T) *T { return &v }

func syntheticRun() *store.Run {
	return &store.Run{RunID: "synthetic-test", Kind: "synthetic", CreatedAt: time.Date(2026, 11, 24, 3, 0, 0, 0, time.UTC), Model: "synthetic-fixture（モデルなし。合成データ）"}
}

func candidate(id, areaID, areaName, class string, area float64) store.Candidate {
	return store.Candidate{
		Summary: store.Summary{
			ID: id, AreaID: areaID, AreaName: ptr(areaName), Ward: ptr("中央区"), Class: class, AreaM2: pyjson.Float(area),
			BBox:     [4]pyjson.Float{130.70, 32.80, 130.71, 32.81},
			Centroid: [2]pyjson.Float{130.705, 32.805},
			Reason:   "new_absent_2018",
		},
	}
}

// newFakeData は、契約の検査の合成データと同じ内容。
func newFakeData() *fakeData {
	f := &fakeData{run: syntheticRun()}
	// 各地区の箱（西・南・東・北）は、少しずつずれた簡単な値
	f.areas = []store.Area{
		{ID: a1, Name: "合成町", Ward: "中央区", BBox: [4]pyjson.Float{130.70, 32.80, 130.71, 32.81}, Counts: store.AreaCounts{ConfirmedNew: 1, ExistingOmission: 1, Uncertain: 1, Total: 3}},
		{ID: a2, Name: "試験町", Ward: "中央区", BBox: [4]pyjson.Float{130.71, 32.80, 130.72, 32.81}, Counts: store.AreaCounts{ConfirmedNew: 2, Uncertain: 1, Total: 3}},
		{ID: a3, Name: "仮想町", Ward: "東区", BBox: [4]pyjson.Float{130.70, 32.79, 130.71, 32.80}, Counts: store.AreaCounts{ConfirmedNew: 1, ExistingOmission: 2, Total: 3}},
	}
	f.cands = []store.Candidate{
		candidate("c-226250-105759-1", a2, "試験町", "confirmed_new", 503.8),
		candidate("c-226249-105759-1", a1, "合成町", "uncertain", 362.8),
		candidate("c-226249-105759-2", a1, "合成町", "confirmed_new", 302.3),
		candidate("c-226249-105760-1", a3, "仮想町", "existing_omission", 188.9),
		candidate("c-226250-105759-2", a2, "試験町", "uncertain", 120.9),
		candidate("c-226249-105760-2", a3, "仮想町", "existing_omission", 100.8),
		candidate("c-226249-105759-3", a1, "合成町", "existing_omission", 75.6),
		candidate("c-226249-105760-3", a3, "仮想町", "confirmed_new", 75.6),
		candidate("c-226250-105759-3", a2, "試験町", "confirmed_new", 75.6),
	}
	f.metrics = json.RawMessage(`{"split":{"tune":["z18-226249-105759"],"holdout":["z18-226250-105759","z18-226249-105760"]},` +
		`"chosen":{"scale":1.5,"threshold":0.5},"holdout":{"pixel":{"iou":0.61,"precision":0.78,"recall":0.74,"f1":0.76},"object":{"f1":0.58,"precision":0.62,"recall":0.55}},` +
		`"tune":{"pixel":{"iou":0.66,"precision":0.8,"recall":0.79,"f1":0.79},"object":{"f1":0.6,"precision":0.64,"recall":0.57}},"new_building_recall":null}`)
	return f
}

func (f *fakeData) note(name string) { f.calls = append(f.calls, name) }

func (f *fakeData) CurrentRun(context.Context) (*store.Run, error) {
	f.note("CurrentRun")
	if f.runErr != nil {
		return nil, f.runErr
	}
	return f.run, f.err
}

func (f *fakeData) ListAreas(context.Context, string) ([]store.Area, error) {
	f.note("ListAreas")
	return f.areas, f.err
}

func (f *fakeData) matching(flt store.Filter) []store.Candidate {
	var out []store.Candidate
	for _, c := range f.cands {
		if flt.AreaIDs != nil && !contains(flt.AreaIDs, c.AreaID) {
			continue
		}
		if flt.Class != "" && c.Class != flt.Class {
			continue
		}
		out = append(out, c)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].AreaM2 != out[j].AreaM2 {
			return out[i].AreaM2 > out[j].AreaM2
		}
		return out[i].ID < out[j].ID
	})
	return out
}

func (f *fakeData) CountByClass(_ context.Context, _ string, flt store.Filter) (store.ClassCounts, error) {
	f.note("CountByClass")
	var n store.ClassCounts
	for _, c := range f.matching(flt) {
		switch c.Class {
		case "confirmed_new":
			n.ConfirmedNew++
		case "existing_omission":
			n.ExistingOmission++
		case "uncertain":
			n.Uncertain++
		}
	}
	return n, f.err
}

func (f *fakeData) ListCandidates(_ context.Context, _ string, flt store.Filter, _ store.Sort, limit, offset int) (int64, []store.Summary, error) {
	f.note("ListCandidates")
	f.lastList = flt
	all := f.matching(flt)
	var items []store.Summary
	for i, c := range all {
		if i >= offset && len(items) < limit {
			items = append(items, c.Summary)
		}
	}
	return int64(len(all)), items, f.err
}

func (f *fakeData) GetCandidate(_ context.Context, _, id string) (*store.Candidate, error) {
	f.note("GetCandidate")
	for i := range f.cands {
		if f.cands[i].ID == id {
			return &f.cands[i], f.err
		}
	}
	return nil, f.err
}

func (f *fakeData) CandidateIDs(_ context.Context, _ string, flt store.Filter, limit int) ([]string, error) {
	f.note("CandidateIDs")
	ids := []string{}
	for _, c := range f.matching(flt) {
		if len(ids) < limit {
			ids = append(ids, c.ID)
		}
	}
	return ids, f.err
}

func (f *fakeData) AreaUnionBBox(_ context.Context, _ string, areaIDs []string) (*[4]pyjson.Float, error) {
	f.note("AreaUnionBBox")
	var out *[4]pyjson.Float
	for _, a := range f.areas {
		if areaIDs != nil && !contains(areaIDs, a.ID) {
			continue
		}
		if out == nil {
			b := a.BBox
			out = &b
			continue
		}
		out[0], out[1] = min(out[0], a.BBox[0]), min(out[1], a.BBox[1])
		out[2], out[3] = max(out[2], a.BBox[2]), max(out[3], a.BBox[3])
	}
	return out, f.err
}

func (f *fakeData) GetMetrics(context.Context, string) (json.RawMessage, error) {
	f.note("GetMetrics")
	if f.metrErr != nil {
		return nil, f.metrErr
	}
	return f.metrics, f.err
}

var _ Data = (*fakeData)(nil)
