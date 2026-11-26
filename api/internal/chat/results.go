package chat

import (
	"townscan/api/internal/pyjson"
	"townscan/api/internal/store"
)

// ツールの結果（仕様 §4.5 の ToolResult）。JSON のキーの名前・並びは、Python の dict と同じ（frontend/lib/types.ts の型）。
// 結果の値（件数・面積・座標）は、DB の値のまま。数字を LLM に書かせない。

// Result は、ツールの結果 1 件。下の型のどれか（新しいツールを足すときは、新しい型を足して、Render に文章化を足す）。
type Result any

// Args は、ツール呼び出しの引数（応答の tool_calls[].args）。使うキーだけが JSON に出る（並びは、Python の dict の並びと同じ）。
// 模擬モデルが作る。実 LLM の引数は、この型に写してから渡す。
type Args struct {
	CandidateID string   `json:"candidate_id,omitempty"`
	AreaIDs     []string `json:"area_ids,omitempty"`
	AreaID      string   `json:"area_id,omitempty"`
	Ward        string   `json:"ward,omitempty"`
	Wards       []string `json:"wards,omitempty"`
	Cls         string   `json:"cls,omitempty"`
	Limit       *int     `json:"limit,omitempty"` // nil = 指定なし（一覧は 10 件）
	Reason      string   `json:"reason,omitempty"`
	Message     string   `json:"message,omitempty"`
	Suggestions []string `json:"suggestions,omitempty"`
}

// FilterInfo は、結果の filter（どの絞り込みで数えたか）。area_id は 1 地区のとき、area_ids は複数のとき。scope は表示用の名前。
type FilterInfo struct {
	AreaID  string   `json:"area_id,omitempty"`
	AreaIDs []string `json:"area_ids,omitempty"`
	Cls     string   `json:"cls,omitempty"`
	Scope   string   `json:"scope"`
}

// Breakdown は、件数の内訳 1 行。
type Breakdown struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Value int64  `json:"value"`
}

// Overall は、分類で絞った件数に添える、同じ地区の候補の全体（絞り込み前）。
type Overall struct {
	Total     int64 `json:"total"`
	Uncertain int64 `json:"uncertain"` // うち未判定
}

// CountResult は、件数（type: count）。
type CountResult struct {
	Type       string           `json:"type"`
	Title      string           `json:"title"`
	Total      int64            `json:"total"`
	Breakdown  []Breakdown      `json:"breakdown"`
	Held       []Breakdown      `json:"held,omitempty"`    // 未判定を理由で分けた内訳。未判定を数えないときは無し
	Overall    *Overall         `json:"overall,omitempty"` // 分類で絞ったときだけ
	Filter     FilterInfo       `json:"filter"`
	Provenance store.Provenance `json:"provenance"`
}

// Column は、表の列。
type Column struct {
	Key   string `json:"key"`
	Label string `json:"label"`
}

// CandidateRow は、候補の一覧の 1 行。
type CandidateRow struct {
	ID     string       `json:"id"`
	Area   string       `json:"area"`
	Class  string       `json:"class"` // 分類の表示名
	AreaM2 pyjson.Float `json:"area_m2"`
}

// HelpRow は、使い方の表の 1 行。
type HelpRow struct {
	Example string `json:"example"`
	Result  string `json:"result"`
}

// TableResult は、表（type: table）。候補の一覧は Filter つき、使い方の表は Filter なし。
type TableResult struct {
	Type       string           `json:"type"`
	Title      string           `json:"title"`
	Columns    []Column         `json:"columns"`
	Rows       any              `json:"rows"` // []CandidateRow か []HelpRow
	Total      int64            `json:"total"`
	Shown      int              `json:"shown"`
	Provenance store.Provenance `json:"provenance"`
	Filter     *FilterInfo      `json:"filter,omitempty"`
}

// CompareItem は、地区の比較の 1 行。
type CompareItem struct {
	AreaID string           `json:"area_id"`
	Name   string           `json:"name"`
	Ward   string           `json:"ward"`
	Counts store.AreaCounts `json:"counts"`
}

// CompareResult は、地区の比較（type: compare）。
type CompareResult struct {
	Type       string           `json:"type"`
	Title      string           `json:"title"`
	Items      []CompareItem    `json:"items"`
	SortKey    string           `json:"sort_key"`
	Provenance store.Provenance `json:"provenance"`
	Filter     FilterInfo       `json:"filter"`
}

// ImageRef は、検出画像の URL（年ごと）。
type ImageRef struct {
	Year int    `json:"year"`
	URL  string `json:"url"`
}

// DetectionImageResult は、候補 1 棟の 2018・2023 年の写真（type: detection_image）。
type DetectionImageResult struct {
	Type        string           `json:"type"`
	Title       string           `json:"title"`
	CandidateID string           `json:"candidate_id"`
	Class       string           `json:"class"`
	Images      []ImageRef       `json:"images"`
	Caption     string           `json:"caption"`
	Provenance  store.Provenance `json:"provenance"`
}

// MapFocusResult は、地図を合わせる範囲と候補（type: map_focus）。
type MapFocusResult struct {
	Type         string           `json:"type"`
	Title        string           `json:"title"`
	BBox         [4]pyjson.Float  `json:"bbox"` // 西・南・東・北
	CandidateIDs []string         `json:"candidate_ids"`
	Provenance   store.Provenance `json:"provenance"`
}

// Metric は、精度の 1 項目。Value が nil なら未測定（null）。
type Metric struct {
	Key   string        `json:"key"`
	Label string        `json:"label"`
	Value *pyjson.Float `json:"value"`
	Note  string        `json:"note"`
}

// AccuracyResult は、実測した精度（type: accuracy）。
type AccuracyResult struct {
	Type       string           `json:"type"`
	Title      string           `json:"title"`
	Metrics    []Metric         `json:"metrics"`
	Provenance store.Provenance `json:"provenance"`
}

// RefusalResult は、断り（type: refusal）。reason は out_of_scope・no_photo_period・not_implemented・no_data のどれか。
type RefusalResult struct {
	Type        string   `json:"type"`
	Reason      string   `json:"reason"`
	Message     string   `json:"message"`
	Suggestions []string `json:"suggestions"`
}

// 断りの理由（仕様 §4.5）
var refusalReasons = []string{"out_of_scope", "no_photo_period", "not_implemented", "no_data"}

// defaultSuggestions は、断りに添える、聞き方の例（提案が無いときの既定）。
var defaultSuggestions = []string{
	"候補は何件ありますか？",
	"地区ごとに候補数を比べてください",
	"2018 年は未検出で一番大きい候補の写真を見せてください",
	"このアプリの精度は？",
}

// newRefusal は、断りの結果。suggestions が nil なら、既定の聞き方の例（空の一覧を渡せば、空のまま）。
func newRefusal(reason, message string, suggestions []string) RefusalResult {
	if suggestions == nil {
		suggestions = defaultSuggestions
	}
	return RefusalResult{Type: "refusal", Reason: reason, Message: message, Suggestions: append([]string{}, suggestions...)}
}

// 分類の表示名（candidates.class → 画面・返答文に出す名前）。backend/app/queries.py の CLASS_LABELS と同じ
var classLabels = map[string]string{
	"confirmed_new":     "2018 年は未検出",
	"existing_omission": "2018 年も検出",
	"uncertain":         "未判定",
}

// 未判定の候補は、理由（candidates.reason）で呼び分ける
var heldLabels = map[string]string{
	"ambiguous": "要確認",
	"edge":      "端のため未判定",
}

// candidateLabel は、候補 1 件の呼び名。未判定で理由が分かるときは、理由の呼び名。
func candidateLabel(class, reason string) string {
	if class == "uncertain" {
		if label, ok := heldLabels[reason]; ok {
			return label
		}
	}
	return classLabels[class]
}

// heldBreakdown は、未判定を理由で分けた内訳（0 件の行は出さない）。理由の合計が未判定の件数と合わないときは、分けない。
func heldBreakdown(c store.ClassCounts) []Breakdown {
	if c.Uncertain == 0 || c.UncertainReview+c.UncertainEdge != c.Uncertain {
		return nil
	}
	var out []Breakdown
	for _, h := range []struct {
		key string
		n   int64
	}{{"ambiguous", c.UncertainReview}, {"edge", c.UncertainEdge}} {
		if h.n > 0 {
			out = append(out, Breakdown{Key: h.key, Label: heldLabels[h.key], Value: h.n})
		}
	}
	return out
}
