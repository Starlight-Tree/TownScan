package chat

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"os"
	"slices"
	"sort"
	"strings"
	"testing"

	"townscan/api/internal/pyjson"
	"townscan/api/internal/store"
)

// Python の実装（backend/app/chat/）が出した期待値（testdata/golden.json.gz）と、Go の実装が、同じ入力で同じ出力になるかを確かめる。
// 契約の検査（contract/）が見ない、規則の境目・正規表現の書き換え・Unicode の扱いを、広い入力（数千の質問）で Python に合わせるための検査。
// 期待値の作り方・作り直し方は testdata/gen_golden.py。

type goldenArea struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Ward string `json:"ward"`
}

type goldenFile struct {
	Areas  map[string][]goldenArea `json:"areas"`
	Tokens map[string]string       `json:"tokens"` // 印 → 断りの文
	Cases  []struct {
		A string          `json:"a"`
		Q string          `json:"q"`
		H [][2]string     `json:"h"`
		P json.RawMessage `json:"p"`
	} `json:"cases"`
	Normalize [][2]string `json:"normalize"`
	Years     []struct {
		T     string `json:"t"`
		Years []int  `json:"years"`
		Strip string `json:"strip"`
	} `json:"years"`
	Kanji [][2]json.RawMessage `json:"kanji"`
	Guard []struct {
		C   string          `json:"c"`
		R   json.RawMessage `json:"r"`
		Bad []string        `json:"bad"`
	} `json:"guard"`
	SafeTemplate string  `json:"safe_template"`
	Rules        [][]any `json:"rules"` // [規則名, 文, 当たるか]
	Pick         struct {
		Areas []goldenArea `json:"areas"`
		Cands [][]any      `json:"cands"` // [id, 地区 id, 分類, 面積]
		Cases []struct {
			Args Args `json:"args"`
			Res  struct {
				ID  string `json:"id"`
				Err string `json:"err"`
				Msg string `json:"msg"`
			} `json:"res"`
		} `json:"cases"`
	} `json:"pick"`
}

func loadGolden(t *testing.T) *goldenFile {
	t.Helper()
	f, err := os.Open("testdata/golden.json.gz")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	z, err := gzip.NewReader(f)
	if err != nil {
		t.Fatal(err)
	}
	var g goldenFile
	if err := json.NewDecoder(z).Decode(&g); err != nil {
		t.Fatal(err)
	}
	return &g
}

func goldenAreas(g *goldenFile, key string) []store.Area {
	var out []store.Area
	for _, a := range g.Areas[key] {
		out = append(out, store.Area{ID: a.ID, Name: a.Name, Ward: a.Ward})
	}
	return out
}

// 質問の文から、呼ぶツール（と引数）を決める規則が、Python と同じ（JSON のバイト列まで同じ）。
func TestGoldenPlanMatchesPython(t *testing.T) {
	g := loadGolden(t)
	if len(g.Cases) < 3000 {
		t.Fatalf("期待値が少ない: %d", len(g.Cases))
	}
	models := map[string]*MockModel{}
	for key := range g.Areas {
		models[key] = NewMockModel(goldenAreas(g, key))
	}
	// 断りの文の印を、文に戻す（JSON の文字列として）
	quoted := map[string]string{}
	for token, msg := range g.Tokens {
		b, _ := pyjson.Marshal(msg)
		quoted[`"`+token+`"`] = string(b)
	}
	failures := 0
	for i, c := range g.Cases {
		var msgs []Message
		for _, h := range c.H {
			msgs = append(msgs, Message{Role: h[0], Content: h[1]})
		}
		msgs = append(msgs, Message{Role: "user", Content: c.Q})
		if len(msgs) > ContextMessages {
			msgs = msgs[len(msgs)-ContextMessages:]
		}
		got, err := pyjson.Marshal(models[c.A].Plan(msgs))
		if err != nil {
			t.Fatal(err)
		}
		want := string(c.P)
		for tok, q := range quoted {
			want = strings.ReplaceAll(want, tok, q)
		}
		if string(got) != want {
			failures++
			if failures <= 15 {
				t.Errorf("#%d [%s] %q（履歴 %d 件）\n  Go     = %s\n  Python = %s", i, c.A, c.Q, len(c.H), got, want)
			}
		}
	}
	if failures > 0 {
		t.Errorf("Python と違う質問: %d / %d 件", failures, len(g.Cases))
	}
}

// 文字の整え方（NFKC・空白・小文字）が、Python と同じ。
func TestGoldenNormalizeMatchesPython(t *testing.T) {
	g := loadGolden(t)
	failures := 0
	for _, c := range g.Normalize {
		if got := normalize(c[0]); got != c[1] {
			failures++
			if failures <= 15 {
				t.Errorf("normalize(%+q) = %+q, Python は %+q", c[0], got, c[1])
			}
		}
	}
	if failures > 0 {
		t.Errorf("Python と違う入力: %d / %d 件", failures, len(g.Normalize))
	}
}

// 文に出る年（西暦・漢数字・和暦）の読み取りと、年の言い回しの除去が、Python と同じ。
func TestGoldenYearsMatchPython(t *testing.T) {
	g := loadGolden(t)
	for _, c := range g.Years {
		var got []int
		for y := range mentionedYears(c.T) {
			got = append(got, y)
		}
		sort.Ints(got)
		if !slices.Equal(got, c.Years) && !(len(got) == 0 && len(c.Years) == 0) {
			t.Errorf("mentionedYears(%q) = %v, Python は %v", c.T, got, c.Years)
		}
		if s := stripYears(c.T); s != c.Strip {
			t.Errorf("stripYears(%q) = %q, Python は %q", c.T, s, c.Strip)
		}
	}
}

func TestGoldenKanjiMatchesPython(t *testing.T) {
	g := loadGolden(t)
	for _, c := range g.Kanji {
		var text string
		if err := json.Unmarshal(c[0], &text); err != nil {
			t.Fatal(err)
		}
		got, ok := kanjiToInt(text)
		want := string(c[1])
		if want == "null" {
			if ok {
				t.Errorf("kanjiToInt(%q) = %d, Python は読めない", text, got)
			}
			continue
		}
		if len(want) > 12 { // 桁が多い値は、上限（1<<40）で止める（年・件数の判定には、大きいことだけが要る）
			if !ok || got < 1<<40 {
				t.Errorf("kanjiToInt(%q) = %d (%v), Python は %s（上限以上のはず）", text, got, ok, want)
			}
			continue
		}
		if !ok || fmt.Sprint(got) != want {
			t.Errorf("kanjiToInt(%q) = %d (%v), Python は %s", text, got, ok, want)
		}
	}
}

// 数字の検査（結果から出せない数字・漢数字+助数詞）が、Python と同じ。
func TestGoldenGuardMatchesPython(t *testing.T) {
	g := loadGolden(t)
	failures := 0
	for i, c := range g.Guard {
		dec := json.NewDecoder(bytes.NewReader(c.R))
		dec.UseNumber()
		var results any
		if err := dec.Decode(&results); err != nil {
			t.Fatal(err)
		}
		got := findUnsupportedNumbers(c.C, results)
		if !slices.Equal(got, c.Bad) && !(len(got) == 0 && len(c.Bad) == 0) {
			failures++
			if failures <= 15 {
				t.Errorf("#%d findUnsupportedNumbers(%+q, %s) = %q, Python は %q", i, c.C, c.R, got, c.Bad)
			}
		}
	}
	if failures > 0 {
		t.Errorf("Python と違う入力: %d / %d 件", failures, len(g.Guard))
	}
}
