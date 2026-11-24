// Package handlers は、読み取りのエンドポイント（backend/app/routes.py の GET /api/health・/api/areas・/api/candidates・
// /api/candidates.geojson・/api/candidates/{candidate_id}・/api/metrics）。
//
// 応答の JSON のキー・型・並び順・件数の上限・検証エラーの形と文言・ページ分け・null の扱い・Content-Type は、Python の API と同じ。
// 検証 →（run が無ければ 503）→ 問い合わせ →（無ければ 404）の順も同じ。
// 認証（/api/me）・検出画像（/api/candidates/{id}/image）・チャット（/api/chat）は、あとの段で足す（ルートを足すだけでよい形）。
package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"townscan/api/internal/apierr"
	"townscan/api/internal/httpx"
	"townscan/api/internal/pyjson"
	"townscan/api/internal/store"
)

// Reader は、ハンドラーが DB に求めること。*store.Store が満たす。テストは偽の実装を差し込む。
type Reader interface {
	CurrentRun(ctx context.Context) (*store.Run, error)
	RunCounts(ctx context.Context, runID string) (store.Counts, error)
	ListAreas(ctx context.Context, runID string) ([]store.Area, error)
	ListCandidates(ctx context.Context, runID string, f store.Filter, sort store.Sort, limit, offset int) (int64, []store.Summary, error)
	CandidateFeatures(ctx context.Context, runID string, f store.Filter) ([]store.Feature, error)
	GetCandidate(ctx context.Context, runID, candidateID string) (*store.Candidate, error)
	GetMetrics(ctx context.Context, runID string) (json.RawMessage, error)
}

var _ Reader = (*store.Store)(nil)

// Deps は、ハンドラーが使うもの。
type Deps struct {
	Store Reader
	// /api/health が返す LLM の名前（"mock" か "gemini"）。GeminiModel は gemini のときだけ返す（キーは持たない）
	LLMProvider string
	GeminiModel string
	Logf        httpx.Logf
}

// 検証の形（routes.py の AREA_ID_PATTERN・CANDIDATE_ID_PATTERN・ClassKey・Query の範囲）
var (
	areaIDPattern      = httpx.NewPattern(`^z[0-9]{1,2}-[0-9]{1,7}-[0-9]{1,7}$`)
	candidateIDPattern = httpx.NewPattern(`^c-[0-9]{1,7}-[0-9]{1,7}-[0-9]{1,7}$`)
	classLiteral       = httpx.Literal(store.ClassKeys)
	sortLiteral        = httpx.Literal{string(store.SortAreaDesc), string(store.SortAreaAsc)}
	limitRange         = httpx.IntRange{Ge: 1, Le: 500}
	offsetRange        = httpx.IntRange{Ge: 0, Le: 1_000_000}
)

const (
	defaultLimit = 50
	// 詳細の images の URL に入る大きさ（backend/app/chat/tools.py の IMAGE_SIZE）と、写真の年（imaging.py の YEARS）
	imageSize = 512
)

var imageYears = []int{2018, 2023}

// New は、読み取りのルートを持つルーターを返す。
func New(d Deps) *httpx.Router {
	a := &api{d}
	rt := &httpx.Router{}
	rt.Handle(http.MethodGet, "/api/health", a.health)
	rt.Handle(http.MethodGet, "/api/areas", a.areas)
	rt.Handle(http.MethodGet, "/api/candidates", a.candidates)
	rt.Handle(http.MethodGet, "/api/candidates.geojson", a.candidatesGeoJSON)
	rt.Handle(http.MethodGet, "/api/candidates/{candidate_id}", a.candidateDetail)
	rt.Handle(http.MethodGet, "/api/metrics", a.metrics)
	return rt
}

type api struct{ d Deps }

func (a *api) logf(format string, args ...any) {
	if a.d.Logf != nil {
		a.d.Logf(format, args...)
	}
}

// fail は、DB・書き出しのエラーを応答にする。DB に届かなければ 503（db_unavailable）、それ以外は 500。
// ログに出すのは型（と SQLSTATE）だけ。エラーの文には、値・接続先が入りうる。
func (a *api) fail(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, context.Canceled):
		return // クライアントが切った。書く相手がいない
	case errors.Is(err, store.ErrUnavailable):
		a.logf("DB に接続できません: %s", store.Kind(err))
		httpx.WriteError(w, apierr.DBUnavailable())
	default:
		a.logf("想定外のエラー: %s", store.Kind(err))
		httpx.WriteError(w, apierr.Internal())
	}
}

// requireRun は、現在の run。無ければ 503（no_data）を書いて nil。エラーのときも書いて nil。
func (a *api) requireRun(w http.ResponseWriter, r *http.Request) *store.Run {
	run, err := a.d.Store.CurrentRun(r.Context())
	if err != nil {
		a.fail(w, err)
		return nil
	}
	if run == nil {
		httpx.WriteError(w, apierr.NoData())
		return nil
	}
	return run
}

// writeJSON は、JSON を書く。本文を作れなかったら 500。
func (a *api) writeJSON(w http.ResponseWriter, contentType string, v any) {
	if err := httpx.WriteJSON(w, http.StatusOK, contentType, v); err != nil {
		a.fail(w, err)
	}
}

// ---- GET /api/health ----

type runInfo struct {
	RunID     string `json:"run_id"`
	Kind      string `json:"kind"`
	CreatedAt string `json:"created_at"`
}

type healthBody struct {
	Status   string       `json:"status"`
	DB       string       `json:"db"`
	LLM      string       `json:"llm"`
	Run      *runInfo     `json:"run"`
	Counts   store.Counts `json:"counts"`
	LLMModel *string      `json:"llm_model,omitempty"`
}

func (a *api) health(w http.ResponseWriter, r *http.Request, _ httpx.Params) {
	body := healthBody{Status: "ok", DB: "ok", LLM: a.d.LLMProvider}
	if a.d.LLMProvider == "gemini" {
		m := a.d.GeminiModel // モデル名は出してよい（キーは出さない）
		body.LLMModel = &m
	}
	// ヘルスチェックは、原因を問わず「DB が使えない」と返す
	run, err := a.d.Store.CurrentRun(r.Context())
	if err == nil && run != nil {
		body.Run = &runInfo{RunID: run.RunID, Kind: run.Kind, CreatedAt: run.CreatedAtISO()}
		body.Counts, err = a.d.Store.RunCounts(r.Context(), run.RunID)
	}
	if err != nil {
		if errors.Is(err, context.Canceled) {
			return
		}
		a.logf("health: DB に届きません: %s", store.Kind(err))
		body.Status, body.DB = "error", "error"
		if werr := httpx.WriteJSON(w, http.StatusServiceUnavailable, httpx.ContentTypeJSON, body); werr != nil {
			a.fail(w, werr)
		}
		return
	}
	a.writeJSON(w, httpx.ContentTypeJSON, body)
}

// ---- GET /api/areas ----

func (a *api) areas(w http.ResponseWriter, r *http.Request, _ httpx.Params) {
	run := a.requireRun(w, r)
	if run == nil {
		return
	}
	items, err := a.d.Store.ListAreas(r.Context(), run.RunID)
	if err != nil {
		a.fail(w, err)
		return
	}
	if items == nil {
		items = []store.Area{}
	}
	a.writeJSON(w, httpx.ContentTypeJSON, items)
}

// ---- GET /api/candidates ----

// filterParams は、area_id・cls（候補の絞り込み）の検証。宣言の順（area_id, cls）に検証し、エラーは errs に足す。
func filterParams(q httpx.Query, errs *httpx.Errors) store.Filter {
	var f store.Filter
	if v, ok := q.Get("area_id"); ok {
		if msg := areaIDPattern.Check(v); msg != "" {
			errs.Add("query", "area_id", msg)
		} else {
			f.AreaIDs = []string{v}
		}
	}
	if v, ok := q.Get("cls"); ok {
		if msg := classLiteral.Check(v); msg != "" {
			errs.Add("query", "cls", msg)
		} else {
			f.Class = v
		}
	}
	return f
}

func (a *api) candidates(w http.ResponseWriter, r *http.Request, _ httpx.Params) {
	q := httpx.ParseQuery(r.URL.RawQuery)
	var errs httpx.Errors
	f := filterParams(q, &errs)
	sort := store.SortAreaDesc
	if v, ok := q.Get("sort"); ok {
		if msg := sortLiteral.Check(v); msg != "" {
			errs.Add("query", "sort", msg)
		} else {
			sort = store.Sort(v)
		}
	}
	limit, offset := defaultLimit, 0
	if v, ok := q.Get("limit"); ok {
		n, msg := limitRange.Check(v)
		if msg != "" {
			errs.Add("query", "limit", msg)
		}
		limit = int(n)
	}
	if v, ok := q.Get("offset"); ok {
		n, msg := offsetRange.Check(v)
		if msg != "" {
			errs.Add("query", "offset", msg)
		}
		offset = int(n)
	}
	if e := errs.Err(); e != nil {
		httpx.WriteError(w, e)
		return
	}
	run := a.requireRun(w, r)
	if run == nil {
		return
	}
	total, items, err := a.d.Store.ListCandidates(r.Context(), run.RunID, f, sort, limit, offset)
	if err != nil {
		a.fail(w, err)
		return
	}
	if items == nil {
		items = []store.Summary{}
	}
	a.writeJSON(w, httpx.ContentTypeJSON, struct {
		Total int64           `json:"total"`
		Items []store.Summary `json:"items"`
	}{total, items})
}

// ---- GET /api/candidates.geojson ----

func (a *api) candidatesGeoJSON(w http.ResponseWriter, r *http.Request, _ httpx.Params) {
	var errs httpx.Errors
	f := filterParams(httpx.ParseQuery(r.URL.RawQuery), &errs)
	if e := errs.Err(); e != nil {
		httpx.WriteError(w, e)
		return
	}
	run := a.requireRun(w, r)
	if run == nil {
		return
	}
	features, err := a.d.Store.CandidateFeatures(r.Context(), run.RunID, f)
	if err != nil {
		a.fail(w, err)
		return
	}
	if features == nil {
		features = []store.Feature{}
	}
	a.writeJSON(w, httpx.ContentTypeGeoJSON, struct {
		Type     string          `json:"type"`
		Features []store.Feature `json:"features"`
	}{"FeatureCollection", features})
}

// ---- GET /api/candidates/{candidate_id} ----

type imageRef struct {
	Year int    `json:"year"`
	URL  string `json:"url"`
}

// candidateDetail は、詳細。Summary の項目のあとに、根拠・形・説明・画像の URL・出どころ（Python の dict の並びと同じ）。
// 写真の切り出しに要る地区のタイル番号（tile_x・tile_y）は、応答に含めない。
type candidateDetail struct {
	store.Summary
	Evidence       json.RawMessage  `json:"evidence"`
	Geometry       json.RawMessage  `json:"geometry"`
	ExplanationKey string           `json:"explanation_key"`
	Explanation    string           `json:"explanation"`
	Images         []imageRef       `json:"images"`
	Provenance     store.Provenance `json:"provenance"`
}

func (a *api) candidateDetail(w http.ResponseWriter, r *http.Request, p httpx.Params) {
	var errs httpx.Errors
	id := p["candidate_id"]
	if msg := candidateIDPattern.Check(id); msg != "" {
		errs.Add("path", "candidate_id", msg)
	}
	if e := errs.Err(); e != nil {
		httpx.WriteError(w, e)
		return
	}
	run := a.requireRun(w, r)
	if run == nil {
		return
	}
	cand, err := a.d.Store.GetCandidate(r.Context(), run.RunID, id)
	if err != nil {
		a.fail(w, err)
		return
	}
	if cand == nil {
		httpx.WriteError(w, apierr.CandidateNotFound())
		return
	}
	images := make([]imageRef, 0, len(imageYears))
	for _, y := range imageYears {
		images = append(images, imageRef{Year: y, URL: fmt.Sprintf("/api/candidates/%s/image?year=%d&size=%d", cand.ID, y, imageSize)})
	}
	a.writeJSON(w, httpx.ContentTypeJSON, candidateDetail{
		Summary:        cand.Summary,
		Evidence:       cand.Evidence,
		Geometry:       cand.Geometry,
		ExplanationKey: cand.Reason,
		Explanation:    store.Explanation(cand.Reason),
		Images:         images,
		Provenance:     store.CandidateProvenance(*run),
	})
}

// ---- GET /api/metrics ----

func (a *api) metrics(w http.ResponseWriter, r *http.Request, _ httpx.Params) {
	run := a.requireRun(w, r)
	if run == nil {
		return
	}
	raw, err := a.d.Store.GetMetrics(r.Context(), run.RunID)
	if err != nil {
		a.fail(w, err)
		return
	}
	if raw == nil {
		httpx.WriteError(w, apierr.MetricsNotFound())
		return
	}
	// {**body, "provenance": prov}: body のキーの並びを保ち、provenance は（body に同名があればその位置で）置き換えるか末尾に足す
	obj, err := pyjson.ParseObject(raw)
	if err != nil {
		a.fail(w, err)
		return
	}
	prov, err := pyjson.Marshal(store.AccuracyProvenance(*run))
	if err != nil {
		a.fail(w, err)
		return
	}
	obj.Set("provenance", prov)
	a.writeJSON(w, httpx.ContentTypeJSON, obj)
}
