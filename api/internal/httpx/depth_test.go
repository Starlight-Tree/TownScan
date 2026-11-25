package httpx

import (
	"runtime"
	"strings"
	"testing"
	"time"
)

// 入れ子が深い本文の読み方。位置を探す読み取り（jsonpos.go）の深さの上限は jsonpos_test.go が見る。ここは、本文を読む入口（ReadJSONBody）から見た振る舞い。
//
// Go の encoding/json の入れ子の上限は 10,000 段（超えると "exceeded max depth"）。Python の json.loads は、素のままで 9998 段まで
// （FastAPI の POST では 9992 段ほど。Python 3.13.18・FastAPI 0.165・uvicorn 0.54 で測った）で、超えると RecursionError になり、FastAPI は
// 400 "There was an error parsing the body" を返す。Go は、超えたら 422（README の「Python との意図した違い」。frontend は、こんな本文を送らない）。

func nested(n int) string { return strings.Repeat("[", n) + strings.Repeat("]", n) }

func TestReadJSONBodyNestingLimitIsGoDecodersOwn(t *testing.T) {
	// 10,000 段ちょうどの正しい JSON は読める
	b, e := ReadJSONBody(bodyReq(nested(10000), "application/json"))
	if e != nil || b.Kind != BodyJSON {
		t.Fatalf("10000 段: kind=%v err=%v", b.Kind, e)
	}
	// 1 段超えたら 422（JSON decode error）。位置は Go の位置（10001 個目の「[」。位置を探す読み取りは、上限を超えるので使われない）
	for _, n := range []int{10001, 50000, 500000} {
		_, e = ReadJSONBody(bodyReq(nested(n), "application/json"))
		if e == nil || e.Status != 422 || len(e.Details) != 1 || e.Details[0].Msg != "JSON decode error" ||
			len(e.Details[0].Loc) != 2 || e.Details[0].Loc[0] != "body" || e.Details[0].Loc[1] != "10000" {
			t.Errorf("%d 段: %+v", n, e)
		}
	}
}

// 100 万段の本文は、すぐ 422 になる。スタックを使い切って、プロセスごと落ちることがない（Recover では止められない致命的エラーになるため）。
func TestReadJSONBodyMillionLevelsIsRejectedQuicklyWithoutGrowingTheStack(t *testing.T) {
	for name, body := range map[string]string{
		"配列（閉じない）":     strings.Repeat("[", 1_000_000),
		"オブジェクト（閉じない）": strings.Repeat(`{"a":`, 200_000),
		"配列（閉じる）":      nested(500_000),
		"配列と数（途中に誤り）":  strings.Repeat("[", 1_000_000-3) + "1,,",
	} {
		runtime.GC()
		var before, after runtime.MemStats
		runtime.ReadMemStats(&before)
		start := time.Now()
		_, e := ReadJSONBody(bodyReq(body, "application/json"))
		took := time.Since(start)
		runtime.ReadMemStats(&after) // この goroutine がまだ生きているので、伸びたスタックが数えられる
		if e == nil || e.Status != 422 || len(e.Details) != 1 || e.Details[0].Msg != "JSON decode error" {
			t.Errorf("%s: %+v", name, e)
			continue
		}
		if took > time.Second {
			t.Errorf("%s: %v かかった（1 秒以内のはず）", name, took)
		}
		if grown := int64(after.StackInuse) - int64(before.StackInuse); grown > 24<<20 {
			t.Errorf("%s: スタックが %d MiB 増えた", name, grown>>20)
		}
		// 本文の大きさに比例する分（文字の配列 4 倍・文字列の写し）だけで、段ごとには確保しない
		if alloc := after.TotalAlloc - before.TotalAlloc; alloc > uint64(len(body))*16 {
			t.Errorf("%s: %d MiB を確保した（本文 %d MiB）", name, alloc>>20, len(body)>>20)
		}
	}
}

// 範囲外の浮動小数（1e999）。Python の json.loads は inf として読む（Python 3.13.18 で確かめた。pydantic の検証には、そのまま進む）。
// Go の encoding/json は読めず、422（JSON decode error）。位置は Go の位置になる（README の「Python との意図した違い」）。
func TestReadJSONBodyOutOfRangeFloatIsRejectedUnlikePython(t *testing.T) {
	for _, raw := range []string{`{"messages":[],"x":1e999}`, `[-1e999]`, `{"x":1E400}`} {
		_, e := ReadJSONBody(bodyReq(raw, "application/json"))
		if e == nil || e.Status != 422 || len(e.Details) != 1 || e.Details[0].Msg != "JSON decode error" {
			t.Errorf("%s: %+v", raw, e)
		}
	}
	// 範囲内の指数は読める
	if b, e := ReadJSONBody(bodyReq(`{"x":1e308,"y":-1e-320}`, "application/json")); e != nil || b.Kind != BodyJSON {
		t.Errorf("範囲内: %v %v", b, e)
	}
}

// 位置を探す読み取りが諦めても、応答の形は同じ（422・JSON decode error・本文の文字は出さない）。
func TestReadJSONBodyTooDeepResponseDoesNotEchoTheBody(t *testing.T) {
	_, e := ReadJSONBody(bodyReq(strings.Repeat("[", 20000)+`"secret-marker"`, "application/json"))
	if e == nil || e.Status != 422 || strings.Contains(string(e.Marshal()), "secret-marker") {
		t.Errorf("%+v", e)
	}
}
