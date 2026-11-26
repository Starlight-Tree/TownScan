package main

import (
	"context"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"townscan/api/internal/testdb"
)

// チャット（POST /api/chat）の、起動から応答までの通しの検査。

// LLM_PROVIDER=gemini は、キーがあれば起動できる（/api/health が、llm と llm_model を返す。キーは出さない）。キーが無ければ、黙って模擬に落とさず、
// DB を待つ前に、設定の誤りで止まる（キー・接続文字列は出さない）。実 Gemini には、つながない（チャットを 1 回も呼ばない）。
func TestRunStartsWithGeminiWhenAKeyIsGiven(t *testing.T) {
	const keySecret = "AIza-key-secret-marker"
	url := testdb.URL(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var out syncBuffer
	addrc := make(chan net.Addr, 1)
	done := make(chan int, 1)
	env := map[string]string{"DATABASE_URL": url, "LLM_PROVIDER": "gemini", "GEMINI_API_KEY": keySecret, "GEMINI_MODEL": "gemini-test-model"}
	go func() {
		done <- run(ctx, []string{"-listen", "127.0.0.1:0"}, envOf(env), &out, func(a net.Addr) { addrc <- a })
	}()
	var base string
	select {
	case a := <-addrc:
		base = "http://" + a.String()
	case code := <-done:
		t.Fatalf("起動できなかった（終了コード %d）: %s", code, out.String())
	case <-time.After(20 * time.Second):
		t.Fatal("起動が終わらない")
	}
	resp, err := http.Get(base + "/api/health")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if body := string(b); !strings.Contains(body, `"llm":"gemini"`) || !strings.Contains(body, `"llm_model":"gemini-test-model"`) || strings.Contains(body, keySecret) {
		t.Errorf("health = %s", body)
	}
	cancel()
	select {
	case code := <-done:
		if code != 0 {
			t.Errorf("終了コード = %d: %s", code, out.String())
		}
	case <-time.After(15 * time.Second):
		t.Fatal("停止しない")
	}
	if logs := out.String(); !strings.Contains(logs, "LLM=gemini") || strings.Contains(logs, keySecret) || strings.Contains(logs, url) {
		t.Errorf("ログ = %s", logs)
	}
}

func TestRunStopsAtStartupWhenGeminiHasNoKey(t *testing.T) {
	const dbSecret = "pw-secret-marker"
	var out syncBuffer
	env := map[string]string{"DATABASE_URL": "postgresql://u:" + dbSecret + "@127.0.0.1:1/x", "LLM_PROVIDER": "gemini"}
	start := time.Now()
	code := run(context.Background(), nil, envOf(env), &out, nil)
	if code != 2 {
		t.Errorf("終了コード = %d, 期待 2（設定の誤り）", code)
	}
	if !strings.Contains(out.String(), "GEMINI_API_KEY が要ります") || strings.Contains(out.String(), dbSecret) {
		t.Errorf("出力 = %s", out.String())
	}
	if time.Since(start) > 5*time.Second {
		t.Errorf("DB を待ってから止まった（%v）", time.Since(start))
	}
}

func TestRunServesTheChatEndToEnd(t *testing.T) {
	url := testdb.URL(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var out syncBuffer
	addrc := make(chan net.Addr, 1)
	done := make(chan int, 1)
	go func() {
		done <- run(ctx, []string{"-listen", "127.0.0.1:0"}, envOf(map[string]string{"DATABASE_URL": url}), &out, func(a net.Addr) { addrc <- a })
	}()
	var base string
	select {
	case a := <-addrc:
		base = "http://" + a.String()
	case code := <-done:
		t.Fatalf("起動できなかった（終了コード %d）: %s", code, out.String())
	case <-time.After(20 * time.Second):
		t.Fatal("起動が終わらない")
	}

	post := func(body string) (int, string) {
		resp, err := http.Post(base+"/api/chat", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		if ct := resp.Header.Get("Content-Type"); ct != "application/json" {
			t.Errorf("Content-Type = %q", ct)
		}
		if resp.Header.Get("X-Content-Type-Options") != "nosniff" {
			t.Errorf("nosniff が無い: %v", resp.Header)
		}
		return resp.StatusCode, string(b)
	}

	// データが無い（run が 1 つも無い）: 200 で、no_data の断り
	status, body := post(`{"messages":[{"role":"user","content":"候補は何件？"}]}`)
	if status != 200 || !strings.HasPrefix(body, `{"message":{"role":"assistant","content":"データがまだ読み込まれていません。`) ||
		!strings.Contains(body, `"reason":"no_data"`) || !strings.Contains(body, `"tool_calls":[{"name":"refuse","args":{"reason":"no_data"}}]`) {
		t.Errorf("データ無し: %d %s", status, body)
	}

	seed(t, url) // 起動（スキーマの適用）のあとに、行を入れる
	status, body = post(`{"messages":[{"role":"user","content":"新規出現の候補は何件ありますか？"}]}`)
	want := `{"message":{"role":"assistant","content":"モデルが 2024 年の写真だけで見つけた候補は 1 件です（候補は全部で 2 件）。","results":[{"type":"count",` +
		`"title":"「2014 年は未検出」の件数（全地区）","total":1,"breakdown":[{"key":"confirmed_new","label":"2014 年は未検出","value":1}],"overall":{"total":2,"uncertain":1},"filter":{"cls":"confirmed_new","scope":"全地区"},`
	if status != 200 || !strings.HasPrefix(body, want) || !strings.HasSuffix(body, `"tool_calls":[{"name":"count_candidates","args":{"cls":"confirmed_new"}}]}}`) {
		t.Errorf("件数: %d\n%s", status, body)
	}
	// 一覧・地図・写真・精度・断り（本物の DB の問い合わせを通る）
	for q, wantIn := range map[string]string{
		"一覧で見せて":         `"type":"table"`,
		"試験町を地図で見せて":     `"type":"map_focus"`,
		"一番大きい新規出現の写真は？": `"type":"detection_image"`,
		"このアプリの精度は？":     `"type":"accuracy"`,
		"地区ごとに比べて":       `"type":"compare"`,
		"福岡の新築は？":        `"reason":"out_of_scope"`,
		"2030年の新築は？":     `"reason":"no_photo_period"`,
	} {
		status, body = post(`{"messages":[{"role":"user","content":"` + q + `"}]}`)
		if status != 200 || !strings.Contains(body, wantIn) {
			t.Errorf("%s: %d %s", q, status, body)
		}
	}
	// SQL の断片になりうる質問も、ただの文字列
	status, body = post(`{"messages":[{"role":"user","content":"試験町' OR '1'='1 の新規出現は何件？"}]}`)
	if status != 200 || !strings.Contains(body, `"total":1,`) || !strings.Contains(body, `"area_id":"z18-1-1"`) {
		t.Errorf("インジェクション: %d %s", status, body)
	}
	// 検証エラー・最後が user でない
	if status, body = post(`{"messages":[]}`); status != 422 || !strings.Contains(body, `"validation_error"`) {
		t.Errorf("422: %d %s", status, body)
	}
	if status, body = post(`{"messages":[{"role":"assistant","content":"x"}]}`); status != 422 || !strings.Contains(body, "最後のメッセージは、空でない user のメッセージである必要があります") {
		t.Errorf("最後が user でない: %d %s", status, body)
	}
	// 数字・質問の文は、ログに出ない
	cancel()
	select {
	case code := <-done:
		if code != 0 {
			t.Errorf("終了コード = %d: %s", code, out.String())
		}
	case <-time.After(15 * time.Second):
		t.Fatal("停止しない")
	}
	logs := out.String()
	if !strings.Contains(logs, `POST "/api/chat" -> 200`) || strings.Contains(logs, "福岡") || strings.Contains(logs, "試験町") || strings.Contains(logs, "OR '1'") || strings.Contains(logs, url) {
		t.Errorf("ログ = %s", logs)
	}
}
