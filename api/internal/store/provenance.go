package store

import "strings"

// 結果の出どころ（Provenance）。仕様 §4.5: { source, photo_years, model, metric?, run_id, run_kind, note? }。backend/app/provenance.py と同じ。

var photoYears = []int{2014, 2024}

const (
	sourceCandidates = "IGN（フランス国土地理院）の空中写真（BD ORTHO 2014・2024 年）から建物を抽出し、2 時点を比較した結果"
	sourceMeasured   = "%d 年の写真での建物抽出の評価"
	sourceUnmeasured = "建物抽出の評価（まだ測っていません）"

	noteSynthetic = "合成データ（テスト用）です。実データではありません。"

	metricsMetric  = "物体単位 F1・画素 IoU"
	noteMeasured   = "数字は %d 年の写真で測った値。分類の閾値は未検証の初期値。"
	noteUnmeasured = "建物の抽出と新築の精度は、まだ測っていない。分類の閾値は未検証の初期値。"
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

// CandidateProvenance は、候補・詳細の出どころ（写真 2014・2024 年）。
func CandidateProvenance(run Run) Provenance {
	return newProvenance(run, sourceCandidates, photoYears, "", "")
}

// AccuracyProvenance は、精度（/api/metrics）の出どころ（測っていれば、2014 年の写真での評価）。
func AccuracyProvenance(run Run, measured bool) Provenance {
	return AccuracyProvenanceForYear(run, 2014, measured)
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
