package handlers

import (
	"runtime"
	"strings"
	"testing"
	"time"
)

// 入れ子が深すぎる壊れた本文は、認証なしの POST /api/chat で送れる（本文の上限の内側で、100 万段にできる）。
// 読み取りが段ごとに再帰して、スタックを使い切ると、Recover でも止められない致命的エラーでプロセスごと落ちる。
// 上限（httpx の maxPyJSONDepth）で位置を探すのをやめるので、すぐ 422 になり、スタックもメモリーも増えない。
// （Python は、9992 段ほどを超える本文に 400 "There was an error parsing the body" を返す。Go は 422。README の「Python との意図した違い」）
func TestChatDeeplyNestedBodyIs422QuicklyWithoutGrowingTheStack(t *testing.T) {
	for name, body := range map[string]string{
		"100 万段の配列（閉じない）":     strings.Repeat("[", 1_000_000),
		"messages の中で 100 万段": `{"messages":[{"role":"user","content":"x","a":` + strings.Repeat("[", 1_000_000),
		"50 万段の配列（閉じる）":       strings.Repeat("[", 500_000) + strings.Repeat("]", 500_000),
		"20 万段のオブジェクト":        strings.Repeat(`{"a":`, 200_000) + "1" + strings.Repeat("}", 200_000),
	} {
		fc := &fakeChat{reply: okReply()}
		tt := chatTester(t, fc)
		runtime.GC()
		var before, after runtime.MemStats
		runtime.ReadMemStats(&before)
		start := time.Now()
		rec := tt.post(body, jsonCT)
		took := time.Since(start)
		runtime.ReadMemStats(&after) // このテストの goroutine がまだ生きているので、伸びたスタックが数えられる

		if rec.Code != 422 || !strings.Contains(rec.Body.String(), `"msg":"JSON decode error"`) || !strings.Contains(rec.Body.String(), `"loc":["body","`) {
			t.Errorf("%s: %d %s", name, rec.Code, rec.Body)
			continue
		}
		if fc.calls != 0 {
			t.Errorf("%s: 壊れた本文なのにチャットを呼んだ", name)
		}
		if took > time.Second {
			t.Errorf("%s: %v かかった（1 秒以内のはず）", name, took)
		}
		// 上限の深さ（9990 段）の再帰で数 MB。上限が無いと、100 万段で数百 MB になる
		if grown := int64(after.StackInuse) - int64(before.StackInuse); grown > 24<<20 {
			t.Errorf("%s: スタックが %d MiB 増えた", name, grown>>20)
		}
		// 本文の大きさに比例する分だけ（段ごとには確保しない）
		if alloc := after.TotalAlloc - before.TotalAlloc; alloc > uint64(len(body))*16 {
			t.Errorf("%s: %d MiB を確保した（本文 %d MiB）", name, alloc>>20, len(body)>>20)
		}
	}
}
