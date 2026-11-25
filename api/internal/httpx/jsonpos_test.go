package httpx

import (
	"compress/gzip"
	"encoding/json"
	"os"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

// 壊れた JSON の誤りの位置（jsonpos.go）が、Python（json.loads。3.13）と同じであること。
// 期待値は、Python が作る（testdata/gen_jsonpos.py → jsonpos.json.gz）。手で選んだ壊れ方と、正しい JSON を壊した約 2000 件の本文。

type jsonPosRow struct {
	Raw string `json:"raw"`
	Pos *int   `json:"pos"` // null = Python が受け入れる
	Msg string `json:"msg"`
}

func loadJSONPosRows(t *testing.T) []jsonPosRow {
	t.Helper()
	f, err := os.Open("testdata/jsonpos.json.gz")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	zr, err := gzip.NewReader(f)
	if err != nil {
		t.Fatal(err)
	}
	var rows []jsonPosRow
	if err := json.NewDecoder(zr).Decode(&rows); err != nil {
		t.Fatal(err)
	}
	return rows
}

// 同じ本文を、Go が Python と同じ位置で断ること（Python が受け入れる本文は、Go も受け入れること）。
func TestJSONErrorPositionMatchesPython(t *testing.T) {
	rows := loadJSONPosRows(t)
	if len(rows) < 1500 {
		t.Fatalf("期待値が少なすぎる: %d 件（testdata を作り直したときに、壊れていないか）", len(rows))
	}
	kinds := map[string]int{}
	accepted, pyOnly := 0, 0
	for _, row := range rows {
		if row.Raw == "" {
			continue // 空の本文は、JSON の誤りではなく「本文が無い」（TestReadJSONBodyKinds）
		}
		_, e := ReadJSONBody(bodyReq(row.Raw, "application/json"))
		if row.Pos == nil {
			switch {
			case e == nil:
				accepted++
			case strings.Contains(row.Raw, "NaN") || strings.Contains(row.Raw, "Infinity"):
				pyOnly++ // Python は NaN・Infinity を読む。Go は読まない（body.go に書いた、合わせていない点）
			default:
				t.Errorf("Python は受け入れるが、Go は断る: %q → %+v", row.Raw, e)
			}
			continue
		}
		kinds[row.Msg]++
		want := strconv.Itoa(*row.Pos)
		if e == nil {
			t.Errorf("Python は断る（%s・位置 %s）が、Go は受け入れる: %q", row.Msg, want, row.Raw)
			continue
		}
		if e.Status != 422 || len(e.Details) != 1 || e.Details[0].Msg != "JSON decode error" ||
			len(e.Details[0].Loc) != 2 || e.Details[0].Loc[0] != "body" || e.Details[0].Loc[1] != want {
			t.Errorf("%s: 位置が違う %q: Go=%+v 期待=%s", row.Msg, row.Raw, e.Details, want)
		}
	}
	// 期待値の作り直しで、種類が偏っていないこと（どの種類の誤りも、複数件は見ている）
	for _, msg := range []string{
		"Expecting value", "Expecting ',' delimiter", "Expecting ':' delimiter", "Expecting property name enclosed in double quotes", "Extra data",
		"Unterminated string starting at", "Invalid control character at", "Invalid \\escape", "Invalid \\uXXXX escape",
		"Illegal trailing comma before end of object", "Illegal trailing comma before end of array",
	} {
		if kinds[msg] < 3 {
			t.Errorf("%q の本文が %d 件しかない", msg, kinds[msg])
		}
	}
	if accepted < 100 || pyOnly < 3 {
		t.Errorf("受け入れる本文が少ない: 両方が受け入れる %d 件・Python だけ %d 件", accepted, pyOnly)
	}
}

// 位置を直接確かめる（Python 3.13 で確かめた値。誤りの種類ごとに、Go の encoding/json の位置とは違う例を含む）。
func TestPyJSONErrorPos(t *testing.T) {
	for _, c := range []struct {
		raw  string
		want int // -1 = 誤りではない
	}{
		{`not json`, 0},         // Go は 1（「nu」まで読んでから誤り）
		{`[1,]`, 2},             // Go は 3。末尾のコンマは、コンマの位置
		{`{"a":1,}`, 6},         // 同上
		{`"abc`, 0},             // 閉じていない文字列は、始まりの「"」の位置（Go は末尾）
		{`"a\x"`, 2},            // 不正な逃がしは、逆スラッシュの位置（Go は次の文字）
		{`"\u12"`, 2},           // 「u」の位置
		{`1.`, 1},               // 数字の続きが無い: 数字の終わりで Extra data
		{`-`, 0},                // 整数部が無い: 「-」の位置
		{"\"\n\"", 1},           // 制御文字の位置
		{`"😀" x`, 4},            // 位置は文字数（バイト数ではない）
		{`[NaN, Infinity]`, -1}, // Python は読む
		{`{"a":1}`, -1},
	} {
		pos, ok := pyJSONErrorPos([]rune(c.raw))
		if c.want < 0 {
			if ok {
				t.Errorf("%q: 誤りではないはずが、位置 %d", c.raw, pos)
			}
			continue
		}
		if !ok || pos != c.want {
			t.Errorf("%q: %d (ok=%v)、期待 %d", c.raw, pos, ok, c.want)
		}
	}
}

// 入れ子の深さの上限（maxPyJSONDepth）。上限ちょうどまでは Python と同じ位置を探し、超えたら ok=false（呼び出し側が Go の位置に切り替える）。
// 上限ちょうどの位置の期待値は、Python が作った行（gen_jsonpos.py の DEEP）から引く。
func TestPyJSONErrorPosDepthLimit(t *testing.T) {
	rows := loadJSONPosRows(t)
	pythonPos := func(raw string) int {
		for _, row := range rows {
			if row.Raw == raw && row.Pos != nil {
				return *row.Pos
			}
		}
		t.Fatalf("Python の期待値が無い（%d 文字の本文）。testdata を作り直したときに、DEEP の行が消えていないか", len(raw))
		return 0
	}
	if maxPyJSONDepth != 9990 {
		t.Fatalf("maxPyJSONDepth = %d（Python の実測 9991 段までの下に丸めた 9990 のはず。変えるときは、gen_jsonpos.py の DEEP と README も）", maxPyJSONDepth)
	}
	for _, c := range []struct{ name, unit string }{{"配列", "["}, {"オブジェクト", `{"a":`}} {
		at := strings.Repeat(c.unit, maxPyJSONDepth)       // ちょうど上限の深さ
		over := strings.Repeat(c.unit, maxPyJSONDepth+1)   // 1 段だけ超える
		inside := strings.Repeat(c.unit, maxPyJSONDepth-1) // 1 段手前
		pos, ok := pyJSONErrorPos([]rune(at))
		if !ok || pos != pythonPos(at) {
			t.Errorf("%s・上限ちょうど: 位置 %d (ok=%v)、Python は %d", c.name, pos, ok, pythonPos(at))
		}
		if pos, ok := pyJSONErrorPos([]rune(inside)); !ok || pos != pythonPos(inside) {
			t.Errorf("%s・上限の 1 段手前: 位置 %d (ok=%v)、Python は %d", c.name, pos, ok, pythonPos(inside))
		}
		if pos, ok := pyJSONErrorPos([]rune(over)); ok {
			t.Errorf("%s・上限を 1 段超える: 位置 %d を返した（ok=false のはず）", c.name, pos)
		}
	}
	// 上限を超えても、その前に誤りがあれば、その位置（Python も、深いところに着く前の誤りで止まる）
	if pos, ok := pyJSONErrorPos([]rune("[," + strings.Repeat("[", maxPyJSONDepth+10))); !ok || pos != 1 {
		t.Errorf("深い入れ子の前の誤り: %d (ok=%v)、期待 1", pos, ok)
	}
	// 閉じた入れ子（正しい JSON）の深さも数える。上限ちょうどは、そのあとの誤り（Extra data）を見つける。超えたら探さない
	closed := func(n int) string { return strings.Repeat("[", n) + strings.Repeat("]", n) + "x" }
	if pos, ok := pyJSONErrorPos([]rune(closed(maxPyJSONDepth))); !ok || pos != 2*maxPyJSONDepth {
		t.Errorf("閉じた上限ちょうど + 余分な文字: %d (ok=%v)、期待 %d", pos, ok, 2*maxPyJSONDepth)
	}
	if pos, ok := pyJSONErrorPos([]rune(closed(maxPyJSONDepth + 1))); ok {
		t.Errorf("閉じた上限超え + 余分な文字: 位置 %d を返した（ok=false のはず）", pos)
	}
	// 深さは、兄弟では足されない（1 段の配列を何個並べても、深さは 1）
	flat := "[" + strings.Repeat("[1],", 3*maxPyJSONDepth) + "x"
	if pos, ok := pyJSONErrorPos([]rune(flat)); !ok || pos != len([]rune(flat))-1 {
		t.Errorf("浅い配列の列: %d (ok=%v)、期待 %d", pos, ok, len([]rune(flat))-1)
	}
}

// 100 万段の入れ子でも、すぐ終わり、スタックもメモリーも増えない（上限が無いと、1 段ごとの再帰でスタックが尽き、致命的エラーでプロセスごと落ちる）。
// 伸びたスタックは、その goroutine が生きているうちに測る（終わると返される）。
func TestPyJSONErrorPosDoesNotGrowTheStackOnMillionLevels(t *testing.T) {
	text := []rune(strings.Repeat("[", 1_000_000))
	runtime.GC()
	var before runtime.MemStats
	runtime.ReadMemStats(&before)
	type result struct {
		ok      bool
		took    time.Duration
		stack   uint64 // 測った時点の StackInuse
		mallocs uint64
	}
	done := make(chan result)
	go func() {
		start := time.Now()
		_, ok := pyJSONErrorPos(text)
		took := time.Since(start)
		var after runtime.MemStats
		runtime.ReadMemStats(&after)
		done <- result{ok, took, after.StackInuse, after.Mallocs - before.Mallocs}
	}()
	r := <-done
	if r.ok {
		t.Error("100 万段は、位置を探さずに ok=false のはず")
	}
	if r.took > time.Second {
		t.Errorf("100 万段に %v かかった", r.took)
	}
	// 上限の深さ（9990 段）の再帰で、数 MB。上限が無いと、100 万段で数百 MB になる
	if grown := int64(r.stack) - int64(before.StackInuse); grown > 24<<20 {
		t.Errorf("スタックが %d MiB 増えた（上限 24 MiB）", grown>>20)
	}
	// 段ごとに、メモリーを確保しない（確保があるのは、goroutine の起動と測定だけ）
	if r.mallocs > 1000 {
		t.Errorf("確保が %d 回（段ごとに確保していないか）", r.mallocs)
	}
}
