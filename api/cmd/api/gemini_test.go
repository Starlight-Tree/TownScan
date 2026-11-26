package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"townscan/api/internal/chat"
	"townscan/api/internal/config"
	"townscan/api/internal/store"
	"townscan/api/internal/testdb"
)

// 実 LLM（Gemini）の、組み立てた全体（buildHandler）での通し: HTTP → ミドルウェア → ハンドラー → チャット → 本物の DB → 偽の Gemini（httptest。外へは出ない）。
// 実 Gemini は呼ばない。キーは、テストの中の作り物。

const e2eKey = "AIzaSyE2E-SECRET-KEY_0123456789abcdef"

// geminiScript は、偽の Gemini。台本の 1 歩ごとに、(状態, 本文) を返す。
type geminiScript struct {
	mu    sync.Mutex
	steps []func() (int, string)
	calls int
}

func (g *geminiScript) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	_, _ = io.Copy(io.Discard, r.Body)
	g.mu.Lock()
	g.calls++
	var step func() (int, string)
	if len(g.steps) > 0 {
		step, g.steps = g.steps[0], g.steps[1:]
	}
	g.mu.Unlock()
	if step == nil {
		http.Error(w, "台本が尽きた", 599)
		return
	}
	status, body := step()
	w.WriteHeader(status)
	_, _ = io.WriteString(w, body)
}

func jsonBody(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func toolCall(name string, args map[string]any) func() (int, string) {
	return func() (int, string) {
		return 200, jsonBody(map[string]any{"candidates": []any{map[string]any{"content": map[string]any{"role": "model", "parts": []any{
			map[string]any{"functionCall": map[string]any{"name": name, "args": args}}}}}}})
	}
}

func saying(text string) func() (int, string) {
	return func() (int, string) {
		return 200, jsonBody(map[string]any{"candidates": []any{map[string]any{"content": map[string]any{"role": "model", "parts": []any{map[string]any{"text": text}}}}}})
	}
}

func failing(status int, googleStatus string) func() (int, string) {
	return func() (int, string) {
		return status, jsonBody(map[string]any{"error": map[string]any{"code": status, "message": "Quota exceeded for key " + e2eKey, "status": googleStatus}})
	}
}

type e2eServer struct {
	api    *httptest.Server
	gemini *geminiScript
	logs   *syncBuffer
}

func newE2EServer(t *testing.T, steps ...func() (int, string)) *e2eServer {
	t.Helper()
	url := testdb.URL(t)
	ctx := context.Background()
	st, err := store.Open(ctx, url, store.WithStatementTimeout(requestDeadline))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	if err := st.ApplySchema(ctx); err != nil {
		t.Fatal(err)
	}
	seed(t, url)
	script := &geminiScript{steps: steps}
	fake := httptest.NewServer(script)
	t.Cleanup(fake.Close)
	logs := &syncBuffer{}
	logf := func(f string, a ...any) { _, _ = fmt.Fprintf(logs, f+"\n", a...) }
	svc, err := chat.New(st, chat.Config{Provider: "gemini", Gemini: chat.GeminiConfig{
		APIKey: config.Secret(e2eKey), Model: "gemini-e2e", BaseURL: fake.URL + "/v1beta/models", RetryDelay: 5 * time.Millisecond,
	}}, logf)
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Load(envOf(map[string]string{"DATABASE_URL": url, "LLM_PROVIDER": "gemini", "GEMINI_API_KEY": e2eKey}), nil)
	if err != nil {
		t.Fatal(err)
	}
	api := httptest.NewServer(buildHandler(cfg, st, svc, logf))
	t.Cleanup(api.Close)
	return &e2eServer{api: api, gemini: script, logs: logs}
}

func (s *e2eServer) chat(t *testing.T, question string) (int, string) {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"messages": []any{map[string]any{"role": "user", "content": question}}})
	resp, err := http.Post(s.api.URL+"/api/chat", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

func TestGeminiChatEndToEnd(t *testing.T) {
	s := newE2EServer(t,
		toolCall("count_candidates", map[string]any{"cls": "confirmed_new"}),
		saying("新規出現の候補の件数は、下のカードのとおりです。"))
	status, body := s.chat(t, "新規出現の候補は何件ありますか？")
	// 件数だけの回答の本文は、LLM の文でなく、結果から組み立てた文
	if status != 200 || !strings.HasPrefix(body, `{"message":{"role":"assistant","content":"モデルが 2023 年の写真だけで見つけた候補は 1 件です（候補は全部で 2 件）。`) || strings.Contains(body, "新規出現の候補の件数は") ||
		!strings.Contains(body, `"results":[{"type":"count",`) ||
		!strings.Contains(body, `"total":1,`) || !strings.HasSuffix(body, `"tool_calls":[{"name":"count_candidates","args":{"cls":"confirmed_new"}}]}}`) {
		t.Errorf("%d %s", status, body)
	}
	// 結果に無い数字を書いた文は、安全なテンプレートに替わる（結果は DB の値のまま）
	s = newE2EServer(t, toolCall("compare_areas", nil), saying("候補は 9999 件です。"))
	status, body = s.chat(t, "地区ごとに比べて")
	if status != 200 || !strings.Contains(body, `"content":"`+chat.SafeTemplate+`"`) || !strings.Contains(body, `"type":"compare"`) || strings.Contains(body, "9999") {
		t.Errorf("%d %s", status, body)
	}
	if logs := s.logs.String(); !strings.Contains(logs, "安全なテンプレートに差し替えました") || strings.Contains(logs, "9999") {
		t.Errorf("ログ = %s", logs)
	}
}

// 実 LLM が使えない: 502 と固定の本文。模擬に切り替えない。キー・URL・Google のエラー本文は、応答にもログにも出ない。
func TestGeminiFailureIsA502WithoutLeakingAnything(t *testing.T) {
	s := newE2EServer(t, failing(429, "RESOURCE_EXHAUSTED"))
	status, body := s.chat(t, "新規出現の候補は何件ありますか？秘密の質問")
	if status != 502 || body != `{"error":{"code":"llm_unavailable","message":"いまは LLM が応答できません。少し待ってからもう一度お試しください"}}` {
		t.Errorf("%d %s", status, body)
	}
	logs := s.logs.String()
	if !strings.Contains(logs, "LLM が応答できませんでした: 種別=rate_limit HTTP=429 理由=RESOURCE_EXHAUSTED") || !strings.Contains(logs, `POST "/api/chat" -> 502`) {
		t.Errorf("ログ = %s", logs)
	}
	for _, out := range []string{body, logs} {
		for _, bad := range []string{e2eKey, "key=", "AIzaSy", "秘密の質問", "Quota", s.gemini.url()} {
			if strings.Contains(out, bad) {
				t.Errorf("出力に %q が含まれる: %s", bad, out)
			}
		}
	}
	if s.gemini.calls != 1 { // 429 は、やり直さない
		t.Errorf("呼び出し %d 回", s.gemini.calls)
	}
	// 一時的な失敗（503）は、1 回やり直して、成功する。やり直したことは、種別つきでログに残る
	s = newE2EServer(t, failing(503, "UNAVAILABLE"), toolCall("show_help", nil), saying("結果のとおりです。"))
	status, body = s.chat(t, "使い方は？")
	if status != 200 || !strings.Contains(body, `"content":"結果のとおりです。"`) || s.gemini.calls != 3 {
		t.Errorf("%d %s（呼び出し %d 回）", status, body, s.gemini.calls)
	}
	if logs := s.logs.String(); !strings.Contains(logs, "やり直します: 種別=server HTTP=503 理由=UNAVAILABLE") || strings.Contains(logs, e2eKey) {
		t.Errorf("ログ = %s", logs)
	}
	// 503 が続けば、やり直しは 1 回だけで、502
	s = newE2EServer(t, failing(503, "UNAVAILABLE"), failing(503, "UNAVAILABLE"))
	if status, body = s.chat(t, "使い方は？"); status != 502 || s.gemini.calls != 2 {
		t.Errorf("%d %s（呼び出し %d 回）", status, body, s.gemini.calls)
	}
}

func (g *geminiScript) url() string { return "127.0.0.1" } // 偽のサーバーの住所の断片（出力に出てはいけない）

// 要求全体の期限（27 秒）と、DB の statement_timeout・チャットの Gemini の期限は、同じ値（frontend の転送の待ち 30 秒より前に、API が応答できる）。
func TestTheRequestDeadlineMatchesTheGeminiDeadline(t *testing.T) {
	rd, gd := requestDeadline, chat.RequestDeadline // 定数どうしの比較にしない（vet が、同じ定数の比較を怪しむため）
	if rd != 27*time.Second {
		t.Errorf("requestDeadline = %v（27 秒のはず）", rd)
	}
	if rd != gd {
		t.Errorf("requestDeadline = %v、chat.RequestDeadline = %v（同じ値のはず）", rd, gd)
	}
	if rd >= 30*time.Second {
		t.Error("frontend の Next.js の転送の待ち（既定 30 秒）より前に、応答できる値でなければならない")
	}
}

type deadlineChat struct {
	deadline time.Time
	ok       bool
}

func (d *deadlineChat) Answer(ctx context.Context, _ []chat.Message) (chat.Reply, error) {
	d.deadline, d.ok = ctx.Deadline()
	return chat.Reply{Role: "assistant", Content: "答えです。", Results: []chat.Result{}, ToolCalls: []chat.Call{}}, nil
}

// どの要求も、期限つきの context で処理される（DB の問い合わせ・Gemini への通信は、この期限で打ち切られる）。
func TestEveryRequestRunsUnderTheRequestDeadline(t *testing.T) {
	cfg, err := config.Load(envOf(map[string]string{"DATABASE_URL": "postgresql://u:pw@db/x"}), nil)
	if err != nil {
		t.Fatal(err)
	}
	d := &deadlineChat{}
	h := buildHandler(cfg, nil, d, func(string, ...any) {})
	start := time.Now()
	rec := postChat(h, `{"messages":[{"role":"user","content":"使い方は？"}]}`, false)
	if rec.Code != 200 || !d.ok {
		t.Fatalf("%d・期限あり=%v", rec.Code, d.ok)
	}
	if remaining := d.deadline.Sub(start); remaining < requestDeadline-2*time.Second || remaining > requestDeadline+time.Second {
		t.Errorf("期限まで %v、期待 約 %v", remaining, requestDeadline)
	}
}
