package chat

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"slices"
	"sort"
	"strconv"
	"strings"

	"townscan/api/internal/pyjson"
	"townscan/api/internal/store"
)

// チャットのツール: 登録表（Registry）と、組み込みのツール。backend/app/chat/tools.py と同じ。
//
// ツールは「名前・説明・引数の JSON Schema・ハンドラー」を持つ。後から衛星の道具を足すときは、Registry.Register を 1 回呼ぶだけ
// （模擬モデルの規則と、結果の文章化 Render を足す）。
// 数字・件数・座標は、ここ（DB の結果）からだけ出る。LLM に書かせない。SQL は、store のパラメーターつきの問い合わせだけを使う。

const (
	// 一覧の件数の上限（文から読んだ件数も、この上限に丸める）
	maxListLimit = 50
	// 地図に渡す候補 ID の上限（応答の大きさの保険。超えたら、件数は実数のまま「上位 N 件」と明示する）
	defaultMaxFocusIDs = 5000
	// 検出画像の URL に入る大きさ（検出画像の API の既定と同じ）
	imageSize = 512
)

// Data は、ツールが DB に求めること。*store.Store が満たす。テストは偽の実装を差し込む。
type Data interface {
	CurrentRun(ctx context.Context) (*store.Run, error)
	ListAreas(ctx context.Context, runID string) ([]store.Area, error)
	CountByClass(ctx context.Context, runID string, f store.Filter) (store.ClassCounts, error)
	ListCandidates(ctx context.Context, runID string, f store.Filter, sort store.Sort, limit, offset int) (int64, []store.Summary, error)
	GetCandidate(ctx context.Context, runID, candidateID string) (*store.Candidate, error)
	CandidateIDs(ctx context.Context, runID string, f store.Filter, limit int) ([]string, error)
	AreaUnionBBox(ctx context.Context, runID string, areaIDs []string) (*[4]pyjson.Float, error)
	GetMetrics(ctx context.Context, runID string) (json.RawMessage, error)
}

var _ Data = (*store.Store)(nil)

// ToolError は、ツールが続けられないとき（引数が不正・該当が無い）。断りの結果にして返す。DB のエラーなどは、これにしない。
type ToolError struct {
	Reason      string
	Message     string
	Suggestions []string // nil なら、既定の聞き方の例
}

func (e *ToolError) Error() string { return e.Reason + ": " + e.Message }

func toolErr(reason, message string) *ToolError { return &ToolError{Reason: reason, Message: message} }

// ToolContext は、ツールが 1 回の要求の間に使うもの。
type ToolContext struct {
	Data  Data
	Run   store.Run
	Areas []store.Area // store.ListAreas の結果（この要求の間だけ使う）
}

func (tc *ToolContext) areaByID(id string) *store.Area {
	for i := range tc.Areas {
		if tc.Areas[i].ID == id {
			return &tc.Areas[i]
		}
	}
	return nil
}

// Handler は、ツールの本体。Result を返すか、ToolError（断りになる）か、そのほかのエラー（DB の不調など。応答は 5xx）を返す。
type Handler func(ctx context.Context, tc *ToolContext, args Args) (Result, error)

// Tool は、登録するツール。Parameters は、実 LLM に渡す tool 定義にそのまま使える JSON Schema。
type Tool struct {
	Name        string
	Description string
	Parameters  map[string]any
	Handler     Handler
}

// Registry は、ツールの登録表。
type Registry struct {
	tools map[string]Tool
	order []string
}

// NewRegistry は、空の登録表。
func NewRegistry() *Registry { return &Registry{tools: map[string]Tool{}} }

// Register は、ツールを足す。同じ名前を 2 度足すとエラー。
func (r *Registry) Register(t Tool) error {
	if _, dup := r.tools[t.Name]; dup {
		return fmt.Errorf("ツール %q は既に登録されています", t.Name)
	}
	r.tools[t.Name] = t
	r.order = append(r.order, t.Name)
	return nil
}

// Names は、登録した順のツール名。
func (r *Registry) Names() []string { return append([]string(nil), r.order...) }

// Get は、名前のツール。無ければ ok=false。
func (r *Registry) Get(name string) (Tool, bool) {
	t, ok := r.tools[name]
	return t, ok
}

// Schemas は、実 LLM に渡す定義（名前・説明・引数の JSON Schema）。
func (r *Registry) Schemas() []map[string]any {
	out := make([]map[string]any, 0, len(r.order))
	for _, n := range r.order {
		t := r.tools[n]
		out = append(out, map[string]any{"name": t.Name, "description": t.Description, "input_schema": t.Parameters})
	}
	return out
}

// Call は、ツールを呼ぶ。知らないツール・ToolError は、断りの結果にする。そのほかのエラーは、そのまま返す。
func (r *Registry) Call(ctx context.Context, tc *ToolContext, name string, args Args) (Result, error) {
	t, ok := r.tools[name]
	if !ok {
		return newRefusal("out_of_scope", "その操作はできません。", nil), nil
	}
	res, err := t.Handler(ctx, tc, args)
	var te *ToolError
	if errors.As(err, &te) {
		return newRefusal(te.Reason, te.Message, te.Suggestions), nil
	}
	return res, err
}

// ---- 部品 ----

// wardNames は、引数 ward（1 つ）と wards（複数）から、区名の一覧を作る（重複は除く）。空の区名は不正な引数。
func wardNames(args Args) ([]string, error) {
	var raw []string
	if args.Ward != "" {
		raw = append(raw, args.Ward)
	}
	raw = append(raw, args.Wards...)
	seen := map[string]bool{}
	var out []string
	for _, w := range raw {
		if w == "" {
			return nil, toolErr("out_of_scope", "市町村の指定が正しくありません。")
		}
		if !seen[w] {
			seen[w] = true
			out = append(out, w)
		}
	}
	return out, nil
}

// resolveAreas は、引数（area_ids / area_id / ward / wards）から、地区の id の一覧（nil = 全地区）と、表示用の名前を作る。
func resolveAreas(tc *ToolContext, args Args) ([]string, string, error) {
	var ids []string
	switch {
	case len(args.AreaIDs) > 0:
		ids = append([]string{}, args.AreaIDs...)
	case args.AreaID != "":
		ids = []string{args.AreaID}
	}
	wards, err := wardNames(args)
	if err != nil {
		return nil, "", err
	}
	if ids == nil && len(wards) > 0 {
		var missing []string
		var union []string
		for _, w := range wards {
			n := 0
			for _, a := range tc.Areas {
				if a.Ward == w {
					union = append(union, a.ID)
					n++
				}
			}
			if n == 0 {
				missing = append(missing, w)
			}
		}
		if len(missing) > 0 {
			return nil, "", toolErr("no_data", "「"+strings.Join(missing, "・")+"」の地区はありません。")
		}
		ids = union // 複数の区は、地区の和集合
	}
	if ids == nil {
		return nil, "全地区", nil
	}
	for _, id := range ids {
		if tc.areaByID(id) == nil {
			return nil, "", toolErr("no_data", "指定の地区が見つかりません。")
		}
	}
	ids = sortedUnique(ids)
	if len(wards) > 0 {
		return ids, strings.Join(wards, "・"), nil
	}
	names := make([]string, len(ids))
	for i, id := range ids {
		names[i] = tc.areaByID(id).Name // 名前が無い地区は、読み込みの時点で id が入っている
	}
	if len(names) > 3 {
		return ids, strings.Join(names[:3], "・") + "ほか", nil
	}
	return ids, strings.Join(names, "・"), nil
}

func sortedUnique(in []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(in))
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	sort.Strings(out)
	return out
}

// cleanCls は、分類の引数。空なら指定なし。知らない分類は不正な引数。
func cleanCls(args Args) (string, error) {
	if args.Cls == "" {
		return "", nil
	}
	if _, ok := classLabels[args.Cls]; !ok {
		return "", toolErr("out_of_scope", "その分類はありません。")
	}
	return args.Cls, nil
}

func filterInfo(ids []string, cls, scope string) FilterInfo {
	info := FilterInfo{Cls: cls, Scope: scope} // scope は、表示用の名前（仕様の filter に足した項目）
	switch {
	case len(ids) == 1:
		info.AreaID = ids[0]
	case len(ids) > 1:
		info.AreaIDs = ids
	}
	return info
}

func imageURL(candidateID string, year int) string {
	return "/api/candidates/" + candidateID + "/image?year=" + strconv.Itoa(year) + "&size=" + strconv.Itoa(imageSize)
}

func provenance(tc *ToolContext) store.Provenance { return store.CandidateProvenance(tc.Run) }

func countOf(c store.AreaCounts, key string) int64 {
	switch key {
	case "confirmed_new":
		return c.ConfirmedNew
	case "existing_omission":
		return c.ExistingOmission
	case "uncertain":
		return c.Uncertain
	}
	return c.Total
}

// ---- ツール ----

func countCandidates(ctx context.Context, tc *ToolContext, args Args) (Result, error) {
	ids, scope, err := resolveAreas(tc, args)
	if err != nil {
		return nil, err
	}
	cls, err := cleanCls(args)
	if err != nil {
		return nil, err
	}
	counts, err := tc.Data.CountByClass(ctx, tc.Run.RunID, store.Filter{AreaIDs: ids, Class: cls})
	if err != nil {
		return nil, err
	}
	keys := store.ClassKeys
	if cls != "" {
		keys = []string{cls}
	}
	breakdown := make([]Breakdown, 0, len(keys))
	var total int64
	for _, k := range keys {
		breakdown = append(breakdown, Breakdown{Key: k, Label: classLabels[k], Value: counts.Of(k)})
		total += counts.Of(k)
	}
	var held []Breakdown
	if cls == "" || cls == "uncertain" {
		held = heldBreakdown(counts)
	}
	title := "候補の件数（" + scope + "）"
	var overall *Overall
	if cls != "" {
		title = "「" + classLabels[cls] + "」の件数（" + scope + "）"
		all, err := tc.Data.CountByClass(ctx, tc.Run.RunID, store.Filter{AreaIDs: ids})
		if err != nil {
			return nil, err
		}
		overall = &Overall{Total: all.Sum(), Uncertain: all.Uncertain}
	}
	return CountResult{
		Type: "count", Title: title, Total: total, Breakdown: breakdown, Held: held, Overall: overall,
		Filter: filterInfo(ids, cls, scope), Provenance: provenance(tc), Ranking: rankAreas(tc.Areas, ids, cls), TileSideM: tileSideM,
	}, nil
}

// rankAreas は、対象の地区（ids が nil なら全地区）を、件数（cls があればその分類の件数）の多い順（同数は名前順）に並べる。
// 対象が 2 地区未満か、候補が 1 件も無いときは nil。
func rankAreas(areas []store.Area, ids []string, cls string) *AreaRanking {
	searched := 0
	var items []AreaCount
	for _, a := range areas {
		if ids != nil && !slices.Contains(ids, a.ID) {
			continue
		}
		searched++
		if n := countOf(a.Counts, cls); n > 0 {
			items = append(items, AreaCount{Name: a.Name, Count: n})
		}
	}
	if searched < 2 || len(items) == 0 {
		return nil
	}
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].Count != items[j].Count {
			return items[i].Count > items[j].Count
		}
		return items[i].Name < items[j].Name
	})
	end, ranks := len(items), 0
	for i := range items {
		if i == 0 || items[i].Count != items[i-1].Count {
			if ranks++; ranks > 2 {
				end = i
				break
			}
		}
	}
	return &AreaRanking{Searched: searched, WithCandidates: len(items), Top: items[:end]}
}

// listLimit は、一覧の件数の引数。無ければ 10、あれば 1〜maxListLimit に丸める。
func listLimit(args Args) int {
	if args.Limit == nil {
		return 10
	}
	return min(max(*args.Limit, 1), maxListLimit)
}

func listCandidates(ctx context.Context, tc *ToolContext, args Args) (Result, error) {
	ids, scope, err := resolveAreas(tc, args)
	if err != nil {
		return nil, err
	}
	cls, err := cleanCls(args)
	if err != nil {
		return nil, err
	}
	total, items, err := tc.Data.ListCandidates(ctx, tc.Run.RunID, store.Filter{AreaIDs: ids, Class: cls}, store.SortAreaDesc, listLimit(args), 0)
	if err != nil {
		return nil, err
	}
	rows := make([]CandidateRow, 0, len(items))
	for _, c := range items {
		area := c.AreaID
		if c.AreaName != nil && *c.AreaName != "" {
			area = *c.AreaName
		}
		rows = append(rows, CandidateRow{ID: c.ID, Area: area, Class: candidateLabel(c.Class, c.Reason), AreaM2: c.AreaM2})
	}
	what := "候補"
	if cls != "" {
		what = "「" + classLabels[cls] + "」"
	}
	info := filterInfo(ids, cls, scope)
	return TableResult{
		Type: "table", Title: what + "の一覧（" + scope + "・面積の大きい順）",
		Columns: []Column{{"id", "候補 ID"}, {"area", "地区"}, {"class", "分類"}, {"area_m2", "面積（m²）"}},
		Rows:    rows, Total: total, Shown: len(rows), Provenance: provenance(tc), Filter: &info,
	}, nil
}

func compareAreas(_ context.Context, tc *ToolContext, args Args) (Result, error) {
	ids, scope, err := resolveAreas(tc, args)
	if err != nil {
		return nil, err
	}
	cls, err := cleanCls(args)
	if err != nil {
		return nil, err
	}
	var areas []store.Area // 地区の並び（タイルの行・列の順）のまま、絞り込む
	for _, a := range tc.Areas {
		if ids == nil || contains(ids, a.ID) {
			areas = append(areas, a)
		}
	}
	key := cls
	if key == "" {
		key = "total"
	}
	// 多い順。同数は、地区名の昇順（SQL の照合順序に依らない）
	sort.SliceStable(areas, func(i, j int) bool {
		ci, cj := countOf(areas[i].Counts, key), countOf(areas[j].Counts, key)
		if ci != cj {
			return ci > cj
		}
		return areas[i].Name < areas[j].Name
	})
	items := make([]CompareItem, 0, len(areas))
	for _, a := range areas {
		items = append(items, CompareItem{AreaID: a.ID, Name: a.Name, Ward: a.Ward, Counts: a.Counts})
	}
	by := "候補の合計"
	if cls != "" {
		by = "「" + classLabels[cls] + "」"
	}
	return CompareResult{
		Type: "compare", Title: "地区ごとの比較（" + scope + "・" + by + "の多い順）", Items: items, SortKey: key,
		Provenance: provenance(tc), Filter: filterInfo(ids, cls, scope),
	}, nil
}

// pickCandidate は、写真の対象の候補。candidate_id があればそれ。無ければ、地区・分類の条件で面積が最大のもの。
// 分類の指定が無ければ、全分類で最大（言葉どおりに選ぶ。誤検出が出ることもある。ADR 0013）。
func pickCandidate(ctx context.Context, tc *ToolContext, args Args) (*store.Candidate, error) {
	if args.CandidateID != "" {
		cand, err := tc.Data.GetCandidate(ctx, tc.Run.RunID, args.CandidateID)
		if err != nil {
			return nil, err
		}
		if cand == nil {
			return nil, toolErr("no_data", "その候補は見つかりません。")
		}
		return cand, nil
	}
	ids, _, err := resolveAreas(tc, args)
	if err != nil {
		return nil, err
	}
	cls, err := cleanCls(args)
	if err != nil {
		return nil, err
	}
	_, items, err := tc.Data.ListCandidates(ctx, tc.Run.RunID, store.Filter{AreaIDs: ids, Class: cls}, store.SortAreaDesc, 1, 0)
	if err != nil {
		return nil, err
	}
	if len(items) > 0 {
		cand, err := tc.Data.GetCandidate(ctx, tc.Run.RunID, items[0].ID)
		if err != nil {
			return nil, err
		}
		if cand != nil {
			return cand, nil
		}
	}
	return nil, toolErr("no_data", "該当する候補がありません。")
}

func showCandidate(ctx context.Context, tc *ToolContext, args Args) (Result, error) {
	cand, err := pickCandidate(ctx, tc, args)
	if err != nil {
		return nil, err
	}
	areaName := cand.AreaID
	if cand.AreaName != nil && *cand.AreaName != "" {
		areaName = *cand.AreaName
	}
	caption := fmt.Sprintf("%s・面積 約 %s m²。", areaName, pyFixed(float64(cand.AreaM2), 0)) +
		"輪郭は機械が抽出した範囲で、確定ではありません。"
	return DetectionImageResult{
		Type: "detection_image", Title: "候補 " + cand.ID + " の写真（2014 年と 2024 年）", CandidateID: cand.ID, Class: cand.Class,
		Images:  []ImageRef{{2014, imageURL(cand.ID, 2014)}, {2024, imageURL(cand.ID, 2024)}},
		Caption: caption, Provenance: provenance(tc),
	}, nil
}

// focusMap の maxIDs は、地図に渡す候補 ID の上限。
func focusMap(maxIDs int) Handler {
	return func(ctx context.Context, tc *ToolContext, args Args) (Result, error) {
		if args.CandidateID != "" {
			cand, err := tc.Data.GetCandidate(ctx, tc.Run.RunID, args.CandidateID)
			if err != nil {
				return nil, err
			}
			if cand == nil {
				return nil, toolErr("no_data", "その候補は見つかりません。")
			}
			return MapFocusResult{
				Type: "map_focus", Title: "候補 " + cand.ID + " を地図で表示", BBox: cand.BBox,
				CandidateIDs: []string{cand.ID}, Provenance: provenance(tc),
			}, nil
		}
		ids, scope, err := resolveAreas(tc, args)
		if err != nil {
			return nil, err
		}
		cls, err := cleanCls(args)
		if err != nil {
			return nil, err
		}
		f := store.Filter{AreaIDs: ids, Class: cls}
		candIDs, err := tc.Data.CandidateIDs(ctx, tc.Run.RunID, f, maxIDs)
		if err != nil {
			return nil, err
		}
		bbox, err := tc.Data.AreaUnionBBox(ctx, tc.Run.RunID, ids)
		if err != nil {
			return nil, err
		}
		if bbox == nil {
			return nil, toolErr("no_data", "地図に出せる地区がありません。")
		}
		// 件数は、地図に渡す ID の数ではなく、DB の実数（仕様 E6: DB の件数 = UI の件数）。ID を上限で切ったときは、そう書く
		counts, err := tc.Data.CountByClass(ctx, tc.Run.RunID, f)
		if err != nil {
			return nil, err
		}
		total := counts.Sum()
		if cls != "" {
			total = counts.Of(cls)
		}
		what := "候補"
		if cls != "" {
			what = "「" + classLabels[cls] + "」"
		}
		title := fmt.Sprintf("%sの%s %d 件を地図で表示", scope, what, total)
		if int64(len(candIDs)) < total {
			title = fmt.Sprintf("%sの%s %d 件のうち、面積の大きい上位 %d 件を地図で表示", scope, what, total, len(candIDs))
		}
		return MapFocusResult{Type: "map_focus", Title: title, BBox: *bbox, CandidateIDs: candIDs, Provenance: provenance(tc)}, nil
	}
}

// ---- 精度（評価ファイルの値を、そのまま見せる） ----

// pick は、JSON の値の入れ子（オブジェクトだけをたどる）から、path の先の値。たどれなければ nil。
func pick(d any, path ...string) any {
	for _, key := range path {
		m, ok := d.(map[string]any)
		if !ok {
			return nil
		}
		d = m[key]
	}
	return d
}

// asFloat は、JSON の数（整数も小数も）を float64 にする。真偽・文字列・null は ok=false（Python の isinstance(v, (int, float)) and not bool）。
func asFloat(v any) (float64, bool) {
	n, ok := v.(json.Number)
	if !ok {
		return 0, false
	}
	f, err := strconv.ParseFloat(n.String(), 64)
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
		return 0, false
	}
	return f, true
}

// firstPresent は、base の下の names のうち、最初に数であるものの値。
func firstPresent(d any, base []string, names ...string) *pyjson.Float {
	for _, name := range names {
		if f, ok := asFloat(pick(d, append(append([]string{}, base...), name)...)); ok {
			v := pyjson.Float(f)
			return &v
		}
	}
	return nil
}

// sizeOf は、Python の len(x or [])。配列・オブジェクト・文字列の大きさ。空や、それ以外は 0。
func sizeOf(v any) int {
	switch x := v.(type) {
	case []any:
		return len(x)
	case map[string]any:
		return len(x)
	case string:
		return len([]rune(x))
	}
	return 0
}

// evalYear は、精度を測った写真の年。評価ファイルに無ければ 2014（選んだ設定は 2014 年の抽出で決めている）。
func evalYear(body any) int {
	for _, path := range [][]string{{"year_compare", "selected_on_year"}, {"protocol", "year"}} {
		if n, ok := pick(body, path...).(json.Number); ok && !strings.ContainsAny(n.String(), ".eE") {
			if y, err := strconv.Atoi(n.String()); err == nil {
				return y
			}
		}
	}
	return 2014
}

func getAccuracy(ctx context.Context, tc *ToolContext, _ Args) (Result, error) {
	raw, err := tc.Data.GetMetrics(ctx, tc.Run.RunID)
	if err != nil {
		return nil, err
	}
	if raw == nil {
		return nil, toolErr("no_data", "評価の結果が読み込まれていません。")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var parsed any
	if err := dec.Decode(&parsed); err != nil {
		return nil, fmt.Errorf("評価ファイルを読めません: %w", err)
	}
	if parsed == nil { // jsonb の null（Python は body is None と同じに扱い、断りにする）
		return nil, toolErr("no_data", "評価の結果が読み込まれていません。")
	}
	body, ok := parsed.(map[string]any)
	if !ok {
		return nil, errors.New("評価ファイルが JSON のオブジェクトではありません")
	}

	holdoutN, tuneN := sizeOf(pick(body, "split", "holdout")), sizeOf(pick(body, "split", "tune"))
	held, tuned := "評価用の地区", "調整用の地区"
	if holdoutN > 0 {
		held = fmt.Sprintf("評価用 %d 地区", holdoutN)
	}
	if tuneN > 0 {
		tuned = fmt.Sprintf("調整用 %d 地区", tuneN)
	}
	const missing = "まだ測っていません"
	year := evalYear(body)
	yr := fmt.Sprintf("%d 年の写真", year)

	metric := func(key, label string, base []string, name, note string) Metric {
		v := firstPresent(body, base, name)
		if v == nil {
			note = missing
		}
		return Metric{Key: key, Label: label, Value: v, Note: note}
	}
	metrics := []Metric{
		metric("holdout_object_f1", fmt.Sprintf("物体単位 F1（評価用・%s）", yr), []string{"holdout", "object"}, "f1",
			held+"。IoU 0.5 以上の 1 対 1 対応。タイルの縁に接する物体は除く"),
		metric("holdout_object_precision", fmt.Sprintf("建物の抽出の適合率・物体単位（評価用・%s）", yr), []string{"holdout", "object"}, "precision", held),
		metric("holdout_object_recall", fmt.Sprintf("建物の抽出の再現率・物体単位（評価用・%s）", yr), []string{"holdout", "object"}, "recall", held),
		metric("holdout_pixel_iou", fmt.Sprintf("画素 IoU（評価用・%s）", yr), []string{"holdout", "pixel"}, "iou", held),
		metric("holdout_pixel_f1", fmt.Sprintf("画素 F1（評価用・%s）", yr), []string{"holdout", "pixel"}, "f1", held),
		metric("tune_object_f1", fmt.Sprintf("物体単位 F1（調整用・%s）", yr), []string{"tune", "object"}, "f1",
			tuned+"。倍率と閾値を選ぶのに使ったので、参考値"),
	}
	recallNote := "新築の正解データで測った値"
	if body["new_building_recall"] == nil {
		recallNote = "まだ測っていません。建物の抽出の再現率とは別の値"
	}
	metrics = append(metrics, Metric{Key: "new_building_recall", Label: "新築の再現率", Value: firstPresent(body, nil, "new_building_recall"), Note: recallNote})
	chosen, _ := body["chosen"].(map[string]any)
	for _, c := range []struct{ k, label string }{{"scale", "選んだ倍率"}, {"threshold", "選んだ閾値"}} {
		if f, ok := asFloat(chosen[c.k]); ok {
			v := pyjson.Float(f)
			note := "調整用の地区だけで選んだ値"
			if chosen["selected_by"] == "fixed" {
				note = "固定の値（このアプリの写真では確かめていない）"
			}
			metrics = append(metrics, Metric{Key: "chosen_" + c.k, Label: c.label, Value: &v, Note: note})
		}
	}
	title := "このアプリの精度（建物抽出の実測）"
	_, measured := body["holdout"]
	if !measured {
		title = "このアプリの精度（まだ測っていません）"
	}
	return AccuracyResult{
		Type: "accuracy", Title: title, Metrics: metrics,
		Provenance: store.AccuracyProvenanceForYear(tc.Run, year, measured),
	}, nil
}

func showHelp(_ context.Context, tc *ToolContext, _ Args) (Result, error) {
	examples := []HelpRow{
		{"候補は何件ありますか？", "件数と候補の写真"},
		{"地区ごとに候補数を比べてください", "地区の比較"},
		{"面積の大きい候補を一覧で見せてください", "候補の一覧（表）"},
		{"いちばん大きい候補の写真を見せてください", "2014 年と 2024 年の写真の見比べ"},
		{"その地図での位置は？", "地図で場所を示す"},
		{"このアプリの精度は？", "実測した精度の数字"},
	}
	return TableResult{
		Type: "table", Title: "このアプリでできること（聞き方の例）",
		Columns: []Column{{"example", "聞き方の例"}, {"result", "返ってくるもの"}},
		Rows:    examples, Total: int64(len(examples)), Shown: len(examples),
		Provenance: store.CandidateProvenanceWithNote(tc.Run, "結果はすべて、写真から機械が見つけた候補です。"),
	}, nil
}

// refuseTool は、範囲外の質問を断る。reason が表に無ければ out_of_scope にする。
func refuseTool(_ context.Context, _ *ToolContext, args Args) (Result, error) {
	reason := args.Reason
	if !contains(refusalReasons, reason) {
		reason = "out_of_scope"
	}
	message := args.Message
	if message == "" {
		message = "その質問には答えられません。"
	}
	return newRefusal(reason, message, args.Suggestions), nil
}

// ---- 登録 ----

func objectSchema(props map[string]any, required ...string) map[string]any {
	s := map[string]any{"type": "object", "properties": props}
	if len(required) > 0 {
		s["required"] = required
	}
	return s
}

func areaProps() map[string]any {
	return map[string]any{
		"area_ids": map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "地区の id（z18-x-y）の配列。省略すると全地区"},
		"ward":     map[string]any{"type": "string", "description": "市町村名（例: ナンテール・ムードン）。area_ids の代わりに使える"},
		"wards":    map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "市町村名の配列（2 つ以上の市町村をまとめて見るとき）。その市町村の地区の和集合"},
	}
}

func clsProp() map[string]any {
	return map[string]any{"type": "string", "enum": store.ClassKeys, "description": "分類。省略すると全分類"}
}

func withProps(base map[string]any, extra map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range base {
		out[k] = v
	}
	for k, v := range extra {
		out[k] = v
	}
	return out
}

// DefaultRegistry は、組み込みのツールを登録した表。maxFocusIDs は、地図に渡す候補 ID の上限（0 以下なら既定の 5000）。
func DefaultRegistry(maxFocusIDs int) *Registry {
	if maxFocusIDs <= 0 {
		maxFocusIDs = defaultMaxFocusIDs
	}
	r := NewRegistry()
	must := func(t Tool) {
		if err := r.Register(t); err != nil {
			panic(err) // 組み込みの名前の重複は、書き間違い
		}
	}
	area, cls := areaProps(), clsProp()
	must(Tool{"count_candidates", "候補の件数を返す（cls が無ければ全体と分類ごとの内訳、あればその分類の件数と全体の件数）",
		objectSchema(withProps(area, map[string]any{"cls": cls})), countCandidates})
	must(Tool{"list_candidates", "候補を面積の大きい順に表で返す",
		objectSchema(withProps(area, map[string]any{"cls": cls, "limit": map[string]any{"type": "integer", "minimum": 1, "maximum": maxListLimit}})), listCandidates})
	must(Tool{"compare_areas", "地区ごとの候補数を比べる",
		objectSchema(withProps(area, map[string]any{"cls": cls})), compareAreas})
	must(Tool{"show_candidate", "候補 1 棟の 2014・2024 年の写真（輪郭つき）を返す。id を省略すると条件に合う最大の候補",
		objectSchema(withProps(area, map[string]any{"candidate_id": map[string]any{"type": "string"}, "cls": cls})), showCandidate})
	must(Tool{"get_accuracy", "実測した建物抽出の精度（評価用・調整用）を返す", objectSchema(map[string]any{}), getAccuracy})
	must(Tool{"focus_map", "地図を地区・候補に合わせる",
		objectSchema(withProps(area, map[string]any{"candidate_id": map[string]any{"type": "string"}, "cls": cls})), focusMap(maxFocusIDs)})
	must(Tool{"show_help", "このアプリでできることと、聞き方の例を返す", objectSchema(map[string]any{}), showHelp})
	must(Tool{"refuse", "範囲外の質問を断る",
		objectSchema(map[string]any{"reason": map[string]any{"type": "string", "enum": refusalReasons}, "message": map[string]any{"type": "string"}}, "reason"), refuseTool})
	return r
}
