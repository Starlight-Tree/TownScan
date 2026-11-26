package store

import (
	"context"
	"fmt"
	"strconv"

	"townscan/api/internal/pyjson"
)

// チャットのツールが使う問い合わせ（backend/app/queries.py の count_by_class・candidate_ids・area_union_bbox）と、
// チャットの結果に付ける出どころ。SQL は、store.go と同じく、値を必ずパラメータ（$1…）で渡す。

// ClassCounts は、分類ごとの候補数。
type ClassCounts struct {
	ConfirmedNew     int64
	ExistingOmission int64
	Uncertain        int64
	UncertainEdge    int64 // Uncertain のうち、理由が edge
	UncertainReview  int64 // Uncertain のうち、理由が ambiguous
}

// Of は、分類（candidates.class の値）の件数。知らない分類は 0。
func (c ClassCounts) Of(class string) int64 {
	switch class {
	case "confirmed_new":
		return c.ConfirmedNew
	case "existing_omission":
		return c.ExistingOmission
	case "uncertain":
		return c.Uncertain
	}
	return 0
}

// Sum は、全分類の合計。
func (c ClassCounts) Sum() int64 { return c.ConfirmedNew + c.ExistingOmission + c.Uncertain }

// CountByClass は、絞り込みに合う候補を、分類ごとに数える（絞り込みの外の分類は 0）。
func (s *Store) CountByClass(ctx context.Context, runID string, f Filter) (ClassCounts, error) {
	c, err := s.conn(ctx)
	if err != nil {
		return ClassCounts{}, err
	}
	defer c.Release()
	where, args := filterSQL(runID, f)
	rows, err := c.Query(ctx, "SELECT c.class, count(*), count(*) FILTER (WHERE c.reason = 'edge'), count(*) FILTER (WHERE c.reason = 'ambiguous')"+
		" FROM candidates c WHERE "+where+" GROUP BY c.class", args...)
	if err != nil {
		return ClassCounts{}, classify(err)
	}
	defer rows.Close()
	var out ClassCounts
	for rows.Next() {
		var class string
		var n, edge, review int64
		if err := rows.Scan(&class, &n, &edge, &review); err != nil {
			return ClassCounts{}, classify(err)
		}
		switch class {
		case "confirmed_new":
			out.ConfirmedNew = n
		case "existing_omission":
			out.ExistingOmission = n
		case "uncertain":
			out.Uncertain, out.UncertainEdge, out.UncertainReview = n, edge, review
		}
	}
	return out, classify(rows.Err())
}

// CandidateIDs は、絞り込みに合う候補の id を、面積の大きい順（同じなら id の昇順）に、limit 件まで返す。
func (s *Store) CandidateIDs(ctx context.Context, runID string, f Filter, limit int) ([]string, error) {
	c, err := s.conn(ctx)
	if err != nil {
		return nil, err
	}
	defer c.Release()
	where, args := filterSQL(runID, f)
	args = append(args, limit)
	rows, err := c.Query(ctx,
		"SELECT c.id FROM candidates c WHERE "+where+" ORDER BY c.area_m2 DESC, c.id ASC LIMIT $"+strconv.Itoa(len(args)), args...)
	if err != nil {
		return nil, classify(err)
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, classify(err)
		}
		ids = append(ids, id)
	}
	return ids, classify(rows.Err())
}

// AreaUnionBBox は、地区（areaIDs。nil なら run の全地区）をすべて含む箱（西・南・東・北）。地区が 1 つも無ければ nil。
func (s *Store) AreaUnionBBox(ctx context.Context, runID string, areaIDs []string) (*[4]pyjson.Float, error) {
	c, err := s.conn(ctx)
	if err != nil {
		return nil, err
	}
	defer c.Release()
	sql := "SELECT min(west), min(south), max(east), max(north) FROM areas WHERE run_id = $1"
	args := []any{runID}
	if areaIDs != nil {
		sql += " AND id = ANY($2)"
		args = append(args, areaIDs)
	}
	var w, so, e, n *float64
	if err := c.QueryRow(ctx, sql, args...).Scan(&w, &so, &e, &n); err != nil {
		return nil, classify(err)
	}
	if w == nil || so == nil || e == nil || n == nil {
		return nil, nil
	}
	return &[4]pyjson.Float{pyjson.Float(*w), pyjson.Float(*so), pyjson.Float(*e), pyjson.Float(*n)}, nil
}

// ---- 出どころ（チャットの結果に付ける） ----

// CandidateProvenanceWithNote は、候補の出どころ（写真 2014・2024 年）に、注記を足したもの。
func CandidateProvenanceWithNote(run Run, note string) Provenance {
	return newProvenance(run, sourceCandidates, photoYears, "", note)
}

// AccuracyProvenanceForYear は、精度の出どころ。year は、精度を測った写真の年（評価ファイルにある年。無ければ 2014）。
// measured は、評価の結果に数字（holdout）があるか。無ければ、測った年を言わず「まだ測っていない」とする。
// /api/metrics の出どころ（AccuracyProvenance）は、年が 2014 に決まっている版。
func AccuracyProvenanceForYear(run Run, year int, measured bool) Provenance {
	if !measured {
		return newProvenance(run, sourceUnmeasured, []int{year}, metricsMetric, noteUnmeasured)
	}
	return newProvenance(run, fmt.Sprintf(sourceMeasured, year), []int{year}, metricsMetric, fmt.Sprintf(noteMeasured, year))
}
