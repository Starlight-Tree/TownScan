package store

import "strings"

// 結果の出どころ（Provenance）。仕様 §4.5: { source, photo_years, model, metric?, run_id, run_kind, note? }。backend/app/provenance.py と同じ。

var photoYears = []int{2018, 2023}

const (
	sourceCandidates = "国土地理院 空中写真（年度別 2018・2023 年）から建物を抽出し、2 時点を比較した結果"
	sourceAccuracy   = "基盤地図情報（2018-10 版）を参照にした、2018 年の写真での建物抽出の評価"

	noteSynthetic = "合成データ（テスト用）です。実データではありません。"

	metricsMetric = "物体単位 F1・画素 IoU"
	metricsNote   = "数字は 2018 年の写真で測った値。新築の再現率は正解になる新築のデータが無く未測定。分類の閾値は未検証の初期値。"
)

// Provenance は、結果の出どころ。Metric と Note は、空なら書かない。
type Provenance struct {
	Source     string `json:"source"`
	PhotoYears []int  `json:"photo_years"`
	Model      string `json:"model"`
	RunID      string `json:"run_id"`
	RunKind    string `json:"run_kind"`
	Metric     string `json:"metric,omitempty"`
	Note       string `json:"note,omitempty"`
}

// CandidateProvenance は、候補・詳細の出どころ（写真 2018・2023 年）。
func CandidateProvenance(run Run) Provenance {
	return newProvenance(run, sourceCandidates, photoYears, "", "")
}

// AccuracyProvenance は、精度（/api/metrics）の出どころ（2018 年の写真での評価）。
func AccuracyProvenance(run Run) Provenance {
	return newProvenance(run, sourceAccuracy, []int{2018}, metricsMetric, metricsNote)
}

func newProvenance(run Run, source string, years []int, metric, note string) Provenance {
	var notes []string
	if run.Kind == "synthetic" {
		notes = append(notes, noteSynthetic)
	}
	if note != "" {
		notes = append(notes, note)
	}
	model := run.Model
	if model == "" {
		model = "不明"
	}
	return Provenance{
		Source:     source,
		PhotoYears: append([]int(nil), years...),
		Model:      model,
		RunID:      run.RunID,
		RunKind:    run.Kind,
		Metric:     metric,
		Note:       strings.Join(notes, " "),
	}
}
