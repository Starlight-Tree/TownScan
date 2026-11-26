package store

// 候補の説明文（平易な日本語）。reason ごとの固定文。詳細 API の explanation に使う。backend/app/explanations.py と同じ文。
var explanations = map[string]string{
	"new_absent_2018": "2023 年の写真では建物を検出し、2018 年の写真では検出していません。前からある建物の場合もあるので、写真で確かめてください。",
	"present_2018":    "2018 年の写真にも既に建物があります。建物データ（基盤地図情報）の描き漏れの可能性が高く、新築とは限りません。",
	"ambiguous":       "2018 年の写真では、建物があるとも無いとも言い切れません。目で確かめてください。",
	"edge":            "写真（タイル）の端に接していて建物が切れている可能性があるため、分けていません。面積は実際より小さい場合があります。",
	"small":           "面積が小さいため、分けていません。",
}

// 知らない reason のときの文
const explanationFallback = "機械が抽出した候補です。目で確かめてください。"

// Explanation は、reason に対応する説明文（知らない reason なら、固定の代わりの文）。
func Explanation(reason string) string {
	if s, ok := explanations[reason]; ok {
		return s
	}
	return explanationFallback
}
