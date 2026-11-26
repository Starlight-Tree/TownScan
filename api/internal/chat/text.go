package chat

import (
	"fmt"
	"strconv"
	"strings"
)

// 返答文の文面。数字は、文章のテンプレートに直接は書かない（固定の年を除く）。ツールの結果の値だけを入れる（さらに GuardNumbers が検査する）。
// backend/app/chat/mock_model.py の文面・render_* と同じ。

// 範囲外の返答文（数字は固定の年だけ。結果の message にそのまま入るので、guard は通る）
const (
	msgChitchat  = "このアプリは、熊本市中心部の空中写真から見つけた新築の候補（2018 年と 2023 年の写真の比較）についてだけ答えます。天気・雑談・設定の話などには答えられません。"
	msgSatellite = "衛星による「変化の当たり」は未実装です。いま答えられるのは、空中写真から棟ごとに見つけた候補の件数・一覧・写真の見比べ・精度です。"
	msgPanel     = "屋根の太陽光パネルの検出は未実装です。いま答えられるのは、空中写真から棟ごとに見つけた新築の候補についてです。"
	msgDisappear = "取り壊し・減少（2018 年にあって 2023 年に無い建物）は調べていません。" +
		"このアプリが答えるのは、建物データに載っていない建物の候補だけです。"
	msgYear = "写真があるのは 2018 年と 2023 年だけです。それ以外の年（2024 年以降を含む）の棟の確認はできません。"
)

// noDataMessage は、run が 1 つも無いときの断り（データの読み込み方の案内を含む）。
const noDataMessage = "データがまだ読み込まれていません。python -m pipeline.load で、pipeline の出力を読み込んでください。"

// commas は、整数を 3 桁ごとにコンマで区切る（Python の f"{v:,}"）。
func commas(v int64) string {
	s := strconv.FormatInt(v, 10)
	neg := strings.HasPrefix(s, "-")
	if neg {
		s = s[1:]
	}
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	if neg {
		s = "-" + s
	}
	return s
}

// ratio は、割合を小数 2 桁で（Python の f"{v:.2f}"）。
func ratio(v float64) string { return pyFixed(v, 2) }

// Compose は、結果から返答文を作る（結果ごとの文を、つなぐ）。
func Compose(results []Result) string {
	var b strings.Builder
	for _, r := range results {
		b.WriteString(Render(r))
	}
	return b.String()
}

// Titled は、タイトルを持つ結果。文章化の方法が無い型の結果は、タイトルだけの一般的な文になる。
type Titled interface{ ResultTitle() string }

// ResultTitle は、Titled を満たす。
func (r CountResult) ResultTitle() string          { return r.Title }
func (r TableResult) ResultTitle() string          { return r.Title }
func (r CompareResult) ResultTitle() string        { return r.Title }
func (r DetectionImageResult) ResultTitle() string { return r.Title }
func (r MapFocusResult) ResultTitle() string       { return r.Title }
func (r AccuracyResult) ResultTitle() string       { return r.Title }

// Render は、結果 1 件の文章。結果の型ごとに決まっていて、新しい型（例: 衛星の「変化の当たり」）には、ここに足す。
func Render(r Result) string {
	switch v := r.(type) {
	case CountResult:
		return renderCount(v)
	case TableResult:
		return renderTable(v)
	case CompareResult:
		return renderCompare(v)
	case DetectionImageResult:
		return renderDetectionImage(v)
	case MapFocusResult:
		return fmt.Sprintf("地図を合わせます: %s。", v.Title)
	case AccuracyResult:
		return renderAccuracy(v)
	case RefusalResult:
		return v.Message
	case Titled:
		if t := v.ResultTitle(); t != "" {
			return t + " を表示します。"
		}
	}
	return "結果を表示します。"
}

func scopeOf(f FilterInfo) string {
	if f.Scope == "" {
		return "全地区"
	}
	return f.Scope
}

func joinCounts(rows []Breakdown) string {
	parts := make([]string, len(rows))
	for i, b := range rows {
		parts[i] = fmt.Sprintf("%s %s 件", b.Label, commas(b.Value))
	}
	return strings.Join(parts, "、")
}

// tileSideM は、1 区画（地区＝地理院タイル z18 の 1 枚）の一辺の長さ（m。画面の area-scale.ts の TILE_SIDE_TEXT と同じ）。
// 地区の名前は丁目だが、数えたのは丁目の全体ではないので、件数の本文で言う。
const tileSideM = 130

// maxNamedAreas は、件数の本文で、同じ順位の地区の名前を並べる上限。
const maxNamedAreas = 3

// countSubjects は、分類を指定した件数の呼び名。分類の名前は本文に出さず、何の条件かは分かるように、モデルが確認した事実で言う。
var countSubjects = map[string]string{
	"confirmed_new":     "モデルが 2023 年の写真だけで見つけた候補",
	"existing_omission": "モデルが 2018 年の写真でも見つけた候補",
	"uncertain":         "判定できていない候補",
}

// renderCount は、件数の本文。件数だけの回答では、実 LLM の文も使わず、これを返す（毎回同じ形にする）。
func renderCount(r CountResult) string {
	subject := "建物データに載っていない建物の候補"
	if named, ok := countSubjects[r.Filter.Cls]; ok {
		subject = named
	}
	if scope := scopeOf(r.Filter); scope != "全地区" {
		subject = scope + "で、" + subject
	}
	side := fmt.Sprintf("約 %d m 四方", tileSideM)
	oneArea := r.Filter.AreaID != ""
	if r.Total == 0 {
		if oneArea {
			return subject + "はありません。対象は、" + side + "の区画です。"
		}
		return subject + "はありません。解析したのは、各" + side + "の区画だけです。"
	}
	head := fmt.Sprintf("%sは %s 件です。", subject, commas(r.Total))
	if r.Overall != nil {
		head = fmt.Sprintf("%sは %s 件です（候補は全部で %s 件）。", subject, commas(r.Total), commas(r.Overall.Total))
	}
	switch {
	case r.Ranking != nil:
		return head + rankingText(*r.Ranking, side)
	case oneArea:
		return head + "対象は、" + side + "の区画です。"
	}
	return head
}

// rankingText は、候補がある区画の数と、多い地区（2 番目の順位まで）の文。
func rankingText(a AreaRanking, side string) string {
	if a.WithCandidates == 1 {
		return fmt.Sprintf("解析した %d 区画（各%s）のうち、%sの区画だけにあります。", a.Searched, side, a.Top[0].Name)
	}
	head := fmt.Sprintf("解析した %d 区画（各%s）のうち %d 区画にあり、", a.Searched, side, a.WithCandidates)
	if a.WithCandidates == a.Searched {
		head = fmt.Sprintf("解析した %d 区画（各%s）のすべてにあり、", a.Searched, side)
	}
	first := a.Top[:sameCount(a.Top)]
	switch {
	case len(first) == a.WithCandidates:
		return head + fmt.Sprintf("どの区画も %s 件です。", commas(first[0].Count))
	case len(first) > maxNamedAreas:
		return head + fmt.Sprintf("最も多い区画は %s 件です。", commas(first[0].Count))
	}
	text := "最も多いのは" + namedCount(first)
	if rest := a.Top[len(first):]; len(rest) > 0 {
		if second := rest[:sameCount(rest)]; len(second) <= maxNamedAreas {
			text += "、次が" + namedCount(second)
		}
	}
	return head + text + "です。"
}

// sameCount は、先頭と同じ件数が続く数。
func sameCount(items []AreaCount) int {
	n := 0
	for n < len(items) && items[n].Count == items[0].Count {
		n++
	}
	return n
}

// namedCount は、同じ件数の地区を「A の 6 件」「A・B の各 3 件」の形にする。
func namedCount(items []AreaCount) string {
	names := make([]string, len(items))
	for i, it := range items {
		names[i] = it.Name
	}
	each := ""
	if len(items) > 1 {
		each = "各 "
	} else {
		each = " "
	}
	return strings.Join(names, "・") + "の" + each + commas(items[0].Count) + " 件"
}

func renderTable(r TableResult) string {
	if r.Filter == nil { // 使い方の表（候補の表には filter がある）
		return "このアプリは、熊本市中心部の空中写真から、新築の候補を棟ごとに見つけて答えます。次のように聞けます。"
	}
	scope := scopeOf(*r.Filter)
	if r.Total == 0 {
		return scope + "には、該当する候補はありません。"
	}
	return fmt.Sprintf("%sの候補を、面積の大きい順に %s 件表示します（該当は全部で %s 件）。", scope, commas(int64(r.Shown)), commas(r.Total)) +
		"候補の ID を使って、その写真を見せて、と聞けます。"
}

func renderCompare(r CompareResult) string {
	scope := scopeOf(r.Filter)
	if len(r.Items) == 0 {
		return scope + "には、比べる地区がありません。"
	}
	top := r.Items[0]
	var what string
	if r.SortKey == "total" {
		what = "候補の合計"
	} else {
		label, ok := classLabels[r.SortKey]
		if !ok {
			label = r.SortKey
		}
		what = "「" + label + "」"
	}
	return fmt.Sprintf("%sの地区ごとの件数を比べました。%sが最も多いのは %s で、%s 件です。", scope, what, top.Name, commas(countOf(top.Counts, r.SortKey)))
}

func renderDetectionImage(r DetectionImageResult) string {
	return fmt.Sprintf("候補 %s の写真を、%d 年と %d 年で並べます。%s", r.CandidateID, r.Images[0].Year, r.Images[1].Year, r.Caption)
}

// renderAccuracyBrief は、精度の結果 1 件だけの回答の本文（実 LLM のとき。service.go）。
// 実 LLM の文は、F1 と「新築の再現率は未測定」を言わない回があったので、この 2 つを必ず言う。ほかの数字はカードが出す。
func renderAccuracyBrief(r AccuracyResult) string {
	byKey := map[string]Metric{}
	for _, m := range r.Metrics {
		byKey[m.Key] = m
	}
	var text string
	if f1 := byKey["holdout_object_f1"].Value; f1 == nil {
		text = "建物抽出の精度の値が、評価ファイルにありません。"
	} else {
		measured := ""
		if len(r.Provenance.PhotoYears) > 0 {
			measured = fmt.Sprintf("（基盤地図情報を参照にして、%d 年の写真で測った値）", r.Provenance.PhotoYears[0])
		}
		text = fmt.Sprintf("建物抽出の物体単位 F1 は、評価用の地区で %s です%s。", ratio(float64(*f1)), measured)
	}
	if recall := byKey["new_building_recall"].Value; recall == nil {
		text += "新築の再現率（本当の新築のうち候補に出せた割合）は、正解になる新築のデータが無いため未測定です。"
	} else {
		text += fmt.Sprintf("新築の再現率（本当の新築のうち候補に出せた割合）は %s です。", ratio(float64(*recall)))
	}
	if r.Provenance.RunKind == "synthetic" {
		text += "なお、これは合成データ（テスト用）の値です。"
	}
	return text
}

func renderAccuracy(r AccuracyResult) string {
	byKey := map[string]Metric{}
	for _, m := range r.Metrics {
		byKey[m.Key] = m
	}
	val := func(key string) *float64 {
		m, ok := byKey[key]
		if !ok || m.Value == nil {
			return nil
		}
		v := float64(*m.Value)
		return &v
	}
	f1, pr, rc, tune := val("holdout_object_f1"), val("holdout_object_precision"), val("holdout_object_recall"), val("tune_object_f1")
	var head string
	if f1 == nil {
		head = "建物抽出の精度の値が、評価ファイルにありません。"
	} else {
		when := ""
		if len(r.Provenance.PhotoYears) > 0 {
			when = fmt.Sprintf("%d 年の写真で", r.Provenance.PhotoYears[0])
		}
		head = fmt.Sprintf("建物抽出の精度を、基盤地図情報を参照にして、%s実測しました。評価用の地区での物体単位 F1 は %s です。", when, ratio(*f1))
		if pr != nil && rc != nil {
			head += fmt.Sprintf("建物の抽出の適合率は %s、建物の抽出の再現率（基盤地図情報に対する値）は %s です。", ratio(*pr), ratio(*rc))
		}
	}
	if tune != nil {
		head += fmt.Sprintf("調整用の地区の F1 は %s（倍率と閾値を選ぶのに使ったので、参考値）です。", ratio(*tune))
	}
	tail := "「新築の再現率」（本当の新築のうち候補に出せた割合）は、正解になる新築のデータが無いため未測定で、上の建物の抽出の再現率とは別の値です。分類の閾値は未検証の初期値です。"
	if r.Provenance.RunKind == "synthetic" {
		tail += "なお、これは合成データ（テスト用）の値です。"
	}
	return head + tail
}
