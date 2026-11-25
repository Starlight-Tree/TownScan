package httpx

import (
	"compress/gzip"
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"testing"
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
