package chat

import (
	"testing"
)

// goldenAnswerStride は、Python が作った質問（golden の 7810 件）のうち、何件ごとに 1 件を流すか。全件（1）は、-race で約 10 秒かかるので、
// 常用は 4 件に 1 件に間引く（全件は、作ったときに 1 回流して、落ちないことを確かめた）。
const goldenAnswerStride = 4

// Python が作った質問（地区名に漢数字を含む実データの 6 地区と、合成データの 3 地区）で、模擬モデルの返答が、
// 数字の検査（guardTemplateNumbers。Python と同じ範囲）に落ちて、安全なテンプレートに替わらないこと。
// 模擬モデルは、返答の数字を結果からだけ作る。落ちるなら、検査が正当な返答を誤って落としている（地区名の漢数字など）。
func TestGoldenQuestionsNeverFallToTheSafeTemplate(t *testing.T) {
	g := loadGolden(t)
	services := map[string]*Service{}
	for key := range g.Areas {
		d := newFakeData()
		d.areas = goldenAreas(g, key)
		if len(d.areas) == 0 {
			t.Fatalf("%s: 地区が無い", key)
		}
		// 候補を、その地区の先頭の 3 つに割り当てる（結果に出す件数・面積の元）
		for i := range d.cands {
			a := d.areas[i%len(d.areas)]
			d.cands[i].AreaID, d.cands[i].AreaName = a.ID, &a.Name
		}
		s, _ := newTestService(t, d)
		services[key] = s
	}
	replaced := 0
	for i, c := range g.Cases {
		if i%goldenAnswerStride != 0 {
			continue
		}
		var msgs []Message
		for _, h := range c.H {
			msgs = append(msgs, Message{Role: h[0], Content: h[1]})
		}
		msgs = append(msgs, Message{Role: "user", Content: c.Q})
		r, err := services[c.A].Answer(t.Context(), msgs)
		if err != nil {
			t.Fatalf("#%d [%s] %q: %v", i, c.A, c.Q, err)
		}
		if r.Content == SafeTemplate {
			replaced++
			if replaced <= 10 {
				t.Errorf("#%d [%s] %q（履歴 %d 件）: 安全なテンプレートに替わった。tool_calls = %s", i, c.A, c.Q, len(c.H), jsonOf(t, r.ToolCalls))
			}
		}
	}
	if replaced > 0 {
		t.Errorf("安全なテンプレートに替わった質問: %d / %d 件", replaced, len(g.Cases)/goldenAnswerStride)
	}
}
