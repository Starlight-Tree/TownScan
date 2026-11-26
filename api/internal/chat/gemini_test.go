package chat

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"townscan/api/internal/config"
	"townscan/api/internal/store"
)

// 実 LLM（Gemini）の窓口（gemini.go）と、往復（gemini_model.go）の検査。実 API は呼ばない: HTTP は、net/http/httptest の偽のサーバー
// （127.0.0.1 の空きポート。外へは出ない）か、偽の送信関数（sendFunc）に差し替える。キーは、テストの中の作り物。
// 期限・待ちは、短い値に差し替えるか、偽の時計（fakeClock）で確かめる（実際に 27 秒は待たない）。

const (
	testKey   = "AIzaSyTEST-SECRET-KEY_0123456789abcdef" // どの出力にも出てはいけない
	testModel = "gemini-test-model"
)

// ---- 偽の Gemini ----

type recordedRequest struct {
	Method, Path, RawQuery string
	Header                 http.Header
	Body                   map[string]any
	Raw                    string
}

// geminiStep は、1 回の呼び出しへの応答の台本。
type geminiStep func(w http.ResponseWriter, r *http.Request)

type fakeGemini struct {
	t        *testing.T
	srv      *httptest.Server
	mu       sync.Mutex
	script   []geminiStep
	repeat   geminiStep
	requests []recordedRequest
}

func newFakeGemini(t *testing.T, steps ...geminiStep) *fakeGemini {
	t.Helper()
	f := &fakeGemini{t: t, script: steps}
	f.srv = httptest.NewServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeGemini) handle(w http.ResponseWriter, r *http.Request) {
	raw, _ := io.ReadAll(io.LimitReader(r.Body, 16<<20))
	var body map[string]any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	_ = dec.Decode(&body)
	f.mu.Lock()
	f.requests = append(f.requests, recordedRequest{Method: r.Method, Path: r.URL.Path, RawQuery: r.URL.RawQuery, Header: r.Header.Clone(), Body: body, Raw: string(raw)})
	var step geminiStep
	switch {
	case f.repeat != nil:
		step = f.repeat
	case len(f.script) > 0:
		step, f.script = f.script[0], f.script[1:]
	}
	f.mu.Unlock()
	if step == nil {
		f.t.Errorf("台本より多く呼ばれた（%d 回目）", len(f.requests))
		http.Error(w, "台本が尽きた", 599)
		return
	}
	step(w, r)
}

func (f *fakeGemini) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.requests)
}

func (f *fakeGemini) reqs() []recordedRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]recordedRequest(nil), f.requests...)
}

func fcall(name string, args map[string]any, extra ...map[string]any) map[string]any {
	if args == nil {
		args = map[string]any{}
	}
	p := map[string]any{"functionCall": map[string]any{"name": name, "args": args}}
	for _, e := range extra { // id は functionCall の中、thoughtSignature は parts の中
		for k, v := range e {
			if k == "id" {
				p["functionCall"].(map[string]any)["id"] = v
			} else {
				p[k] = v
			}
		}
	}
	return p
}

func reply(parts ...map[string]any) map[string]any {
	ps := make([]any, len(parts))
	for i, p := range parts {
		ps[i] = p
	}
	return map[string]any{"candidates": []any{map[string]any{"content": map[string]any{"role": "model", "parts": ps}, "finishReason": "STOP"}}}
}

func textPart(s string) map[string]any { return map[string]any{"text": s} }

func jsonStep(status int, v any) geminiStep {
	return func(w http.ResponseWriter, _ *http.Request) {
		b, _ := json.Marshal(v)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write(b)
	}
}

func rawStep(status int, body string) geminiStep {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}
}

func okReplyStep(v any) geminiStep { return jsonStep(200, v) }
func say(text string) geminiStep   { return okReplyStep(reply(textPart(text))) }

// countTwice は、件数のツールを 2 回呼ぶ。件数だけ 1 件の回答は本文をコードで組み立てるので、LLM の文の検査は、結果を 2 件にして行う
// （許される数字の集合は、1 回のときと同じ）。
func countTwice(args map[string]any) geminiStep {
	return okReplyStep(reply(fcall("count_candidates", args), fcall("count_candidates", args)))
}
func call(name string, args map[string]any, extra ...map[string]any) geminiStep {
	return okReplyStep(reply(fcall(name, args, extra...)))
}

// googleError は、Google のエラーの形。message に、キーを入れておく（出さないことを確かめるため）。
func googleError(status int, googleStatus, reason string) geminiStep {
	err := map[string]any{"code": status, "message": "Quota exceeded for key " + testKey, "status": googleStatus}
	if reason != "" {
		err["details"] = []any{map[string]any{"@type": "type.googleapis.com/google.rpc.ErrorInfo", "reason": reason}}
	}
	return jsonStep(status, map[string]any{"error": err})
}

// hangStep は、応答を返さない（クライアントが切るまで待つ）。
func hangStep() geminiStep {
	return func(_ http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(10 * time.Second):
		}
	}
}

// dropStep は、応答を返さずに、接続を切る。
func dropStep() geminiStep {
	return func(w http.ResponseWriter, _ *http.Request) {
		conn, _, err := w.(http.Hijacker).Hijack()
		if err == nil {
			conn.Close()
		}
	}
}

// ---- サービスの組み立て ----

type testLogs struct {
	mu    sync.Mutex
	lines []string
}

func (l *testLogs) logf(format string, args ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lines = append(l.lines, fmt.Sprintf(format, args...))
}

func (l *testLogs) text() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return strings.Join(l.lines, "\n")
}

// geminiService は、偽の Gemini（f）へ向けたサービス。待ちは短い値にする（再試行の待ち 5 ms）。
func geminiService(t *testing.T, f *fakeGemini, data Data, mut ...func(*GeminiConfig)) (*Service, *testLogs) {
	t.Helper()
	cfg := GeminiConfig{
		APIKey: config.Secret(testKey), Model: testModel, BaseURL: f.srv.URL + "/v1beta/models",
		CallTimeout: 5 * time.Second, Deadline: 10 * time.Second, RetryDelay: 5 * time.Millisecond, MinAttempt: 100 * time.Millisecond,
	}
	for _, m := range mut {
		m(&cfg)
	}
	logs := &testLogs{}
	s, err := New(data, Config{Provider: "gemini", Gemini: cfg}, logs.logf)
	if err != nil {
		t.Fatal(err)
	}
	return s, logs
}

func ask(s *Service, text string, history ...Message) (Reply, error) {
	return s.Answer(context.Background(), append(append([]Message{}, history...), user(text)))
}

// mustAsk は、成功する質問。結果は、模擬モデルのときと同じ形（結果と tool_calls が同じ数）。
func mustAsk(t *testing.T, s *Service, text string, history ...Message) Reply {
	t.Helper()
	r, err := ask(s, text, history...)
	if err != nil {
		t.Fatalf("エラー: %v", err)
	}
	if r.Role != "assistant" || len(r.Results) != len(r.ToolCalls) || len(r.Results) < 1 {
		t.Fatalf("返答 = %s", jsonOf(t, r))
	}
	for _, res := range r.Results {
		checkResultShape(t, text, res)
	}
	return r
}

// llmErr は、エラーが *LLMError であること。
func llmErr(t *testing.T, err error) *LLMError {
	t.Helper()
	var le *LLMError
	if !errors.As(err, &le) {
		t.Fatalf("*LLMError のはずが: %T %v", err, err)
	}
	return le
}

// noSecrets は、キー・キーを含む URL の断片・偽のサーバーの URL が、どの出力にも無いこと。
func noSecrets(t *testing.T, f *fakeGemini, label string, outputs ...string) {
	t.Helper()
	for _, o := range outputs {
		for _, bad := range []string{testKey, "key=", "AIzaSy", f.srv.URL, strings.TrimPrefix(f.srv.URL, "http://")} {
			if strings.Contains(o, bad) {
				t.Errorf("%s: 出力に %q が含まれる: %s", label, bad, o)
			}
		}
	}
}

// ---- (a) 件数の質問: functionCall → 結果 → 文 ----

func TestCountQuestionRunsTheFunctionCallingLoop(t *testing.T) {
	f := newFakeGemini(t,
		call("count_candidates", map[string]any{"cls": "confirmed_new"}, map[string]any{"id": "call-1", "thoughtSignature": "SIG-ABC"}),
		say("新規出現の候補の件数は、下の結果のカードのとおりです。機械の判定で、確定ではありません。"))
	s, logs := geminiService(t, f, newFakeData())
	r := mustAsk(t, s, "新規出現の候補は何件ありますか？")
	// 返すもの: 結果は模擬と同じ形（DB から作った count）。件数だけの回答の本文は、LLM の文でなく、コードで組み立てた文
	if r.Results[0].(CountResult).Total != 4 {
		t.Errorf("結果 = %s", jsonOf(t, r.Results))
	}
	if got := jsonOf(t, r.ToolCalls); got != `[{"name":"count_candidates","args":{"cls":"confirmed_new"}}]` {
		t.Errorf("tool_calls = %s", got)
	}
	if want := renderCount(r.Results[0].(CountResult)); r.Content != want || strings.Contains(r.Content, "下の") {
		t.Errorf("content = %q（期待 %q）", r.Content, want)
	}
	reqs := f.reqs()
	if len(reqs) != 2 {
		t.Fatalf("呼び出し = %d 回", len(reqs))
	}
	// 送るもの: キーは URL に付けず、ヘッダーで送る
	for _, req := range reqs {
		if req.Method != "POST" || req.Path != "/v1beta/models/"+testModel+":generateContent" || req.RawQuery != "" {
			t.Errorf("要求 = %s %s ?%s", req.Method, req.Path, req.RawQuery)
		}
		if req.Header.Get("x-goog-api-key") != testKey || !strings.HasPrefix(req.Header.Get("Content-Type"), "application/json") {
			t.Errorf("ヘッダー = %v", req.Header)
		}
		if strings.Contains(req.Raw, testKey) {
			t.Error("キーが本文に入っている")
		}
	}
	first, second := reqs[0].Body, reqs[1].Body
	if got := jsonOf(t, first["contents"]); got != `[{"parts":[{"text":"新規出現の候補は何件ありますか？"}],"role":"user"}]` {
		t.Errorf("contents = %s", got)
	}
	decls := first["tools"].([]any)[0].(map[string]any)["functionDeclarations"].([]any)
	var names []string
	for _, d := range decls {
		names = append(names, d.(map[string]any)["name"].(string))
	}
	if got := strings.Join(names, " "); got != "count_candidates list_candidates compare_areas show_candidate get_accuracy focus_map show_help refuse" {
		t.Errorf("ツール = %s", got)
	}
	system := first["systemInstruction"].(map[string]any)["parts"].([]any)[0].(map[string]any)["text"].(string)
	for _, want := range []string{"合成町", "試験町", "仮想町", "中央区"} {
		if !strings.Contains(system, want) {
			t.Errorf("システムの指示に %s が無い", want)
		}
	}
	// 最初の往復は必ずツールを呼ばせ、結果を渡したあとは、モデルに任せる
	mode := func(b map[string]any) any {
		return b["toolConfig"].(map[string]any)["functionCallingConfig"].(map[string]any)["mode"]
	}
	if mode(first) != "ANY" || mode(second) != "AUTO" {
		t.Errorf("mode = %v・%v", mode(first), mode(second))
	}
	if first["generationConfig"].(map[string]any)["maxOutputTokens"].(json.Number).String() != "2048" {
		t.Errorf("generationConfig = %v", first["generationConfig"])
	}
	// 2 回目: モデルの functionCall を、返ってきたとおり（thoughtSignature・id を含む）戻し、結果を functionResponse で渡す
	contents := second["contents"].([]any)
	if len(contents) != 3 {
		t.Fatalf("2 回目の contents = %s", jsonOf(t, contents))
	}
	if got := jsonOf(t, contents[1]); got != `{"parts":[{"functionCall":{"args":{"cls":"confirmed_new"},"id":"call-1","name":"count_candidates"},"thoughtSignature":"SIG-ABC"}],"role":"model"}` {
		t.Errorf("モデルの発言 = %s", got)
	}
	resp := contents[2].(map[string]any)
	fr := resp["parts"].([]any)[0].(map[string]any)["functionResponse"].(map[string]any)
	result := fr["response"].(map[string]any)["result"].(map[string]any)
	if resp["role"] != "user" || fr["name"] != "count_candidates" || fr["id"] != "call-1" || result["total"].(json.Number).String() != "4" {
		t.Errorf("functionResponse = %s", jsonOf(t, resp))
	}
	for _, hidden := range []string{"provenance", "bbox", "candidate_ids", "images", "geometry", "suggestions"} {
		if _, ok := result[hidden]; ok {
			t.Errorf("LLM に %s を見せている", hidden)
		}
	}
	if logs.text() != "" {
		t.Errorf("成功した要求にログが出ている: %s", logs.text())
	}
}

func TestTwoParallelCallsAndAChainedCall(t *testing.T) {
	f := newFakeGemini(t,
		okReplyStep(reply(fcall("count_candidates", nil), fcall("compare_areas", map[string]any{"cls": "confirmed_new"}))),
		call("list_candidates", map[string]any{"limit": json.Number("2")}),
		say("件数と比較と一覧を、下のカードにまとめました。"))
	s, _ := geminiService(t, f, newFakeData())
	r := mustAsk(t, s, "件数と地区の比較と一覧を見せて")
	var names []string
	for _, c := range r.ToolCalls {
		names = append(names, c.Name)
	}
	if strings.Join(names, " ") != "count_candidates compare_areas list_candidates" {
		t.Errorf("tool_calls = %v", names)
	}
	if _, ok := r.Results[1].(CompareResult); !ok {
		t.Errorf("結果の型 = %T", r.Results[1])
	}
	if tbl, ok := r.Results[2].(TableResult); !ok || tbl.Shown != 2 {
		t.Errorf("一覧 = %s", jsonOf(t, r.Results[2]))
	}
	// 並列の functionCall には、functionResponse を 1 つの user の発言にまとめて返す
	replies := f.reqs()[1].Body["contents"].([]any)[2].(map[string]any)
	parts := replies["parts"].([]any)
	if replies["role"] != "user" || len(parts) != 2 ||
		parts[0].(map[string]any)["functionResponse"].(map[string]any)["name"] != "count_candidates" ||
		parts[1].(map[string]any)["functionResponse"].(map[string]any)["name"] != "compare_areas" {
		t.Errorf("並列の返し方 = %s", jsonOf(t, replies))
	}
}

func TestAreaNamesBecomeIDsAndUnknownArgumentsAreDropped(t *testing.T) {
	f := newFakeGemini(t,
		call("count_candidates", map[string]any{"area_ids": []any{"合成町"}, "cls": "confirmed_new", "evil": map[string]any{"x": json.Number("1")}}),
		say("合成町の件数です。結果のとおりです。"))
	s, _ := geminiService(t, f, newFakeData())
	r := mustAsk(t, s, "合成町の新規出現は？")
	if got := jsonOf(t, r.ToolCalls[0].Args); got != `{"area_ids":["`+a1+`"],"cls":"confirmed_new"}` {
		t.Errorf("args = %s", got)
	}
	if c := r.Results[0].(CountResult); c.Total != 1 || c.Filter.AreaID != a1 || c.Filter.Scope != "合成町" {
		t.Errorf("結果 = %s", jsonOf(t, c))
	}
}

func TestWardAndIDArgumentsWorkAndUnknownToolsAreRefused(t *testing.T) {
	f := newFakeGemini(t,
		okReplyStep(reply(fcall("count_candidates", map[string]any{"ward": "東区"}), fcall("count_candidates", map[string]any{"area_ids": []any{a2}}), fcall("rm_rf", map[string]any{"path": "/"}))),
		say("結果のとおりです。"))
	s, logs := geminiService(t, f, newFakeData())
	r := mustAsk(t, s, "いろいろ")
	if c := r.Results[0].(CountResult); c.Total != 3 || c.Filter.Scope != "東区" {
		t.Errorf("東区 = %s", jsonOf(t, c))
	}
	if c := r.Results[1].(CountResult); c.Total != 3 || c.Filter.AreaID != a2 {
		t.Errorf("ID = %s", jsonOf(t, c))
	}
	// 知らないツール・引数は、断りの結果になる。tool_calls に、引数は残らない
	if ref, ok := r.Results[2].(RefusalResult); !ok || ref.Reason != "out_of_scope" {
		t.Errorf("知らないツール = %s", jsonOf(t, r.Results[2]))
	}
	if got := jsonOf(t, r.ToolCalls[2]); got != `{"name":"rm_rf","args":{}}` {
		t.Errorf("tool_calls[2] = %s", got)
	}
	if strings.Contains(logs.text(), "rm_rf") {
		t.Errorf("LLM が書いたツール名がログに出ている: %s", logs.text())
	}
}

func TestWronglyTypedArgumentsBecomeARefusalNotAnError(t *testing.T) {
	f := newFakeGemini(t,
		okReplyStep(reply(
			fcall("count_candidates", map[string]any{"area_ids": []any{map[string]any{"a": json.Number("1")}}}),
			fcall("list_candidates", map[string]any{"limit": "5", "cls": []any{"x"}}),
			fcall("list_candidates", map[string]any{"limit": json.Number("5.0")}),
			fcall("list_candidates", map[string]any{"limit": true}),
			fcall("show_candidate", map[string]any{"candidate_id": json.Number("5")}),
			fcall("count_candidates", map[string]any{"wards": []any{json.Number("1")}}),
		)),
		say("結果のとおりです。"))
	s, logs := geminiService(t, f, newFakeData())
	r := mustAsk(t, s, "変な引数")
	kinds := []string{}
	for _, res := range r.Results {
		switch v := res.(type) {
		case RefusalResult:
			kinds = append(kinds, "refusal:"+v.Message)
		case TableResult:
			kinds = append(kinds, fmt.Sprintf("table:%d", v.Shown))
		default:
			kinds = append(kinds, fmt.Sprintf("%T", res))
		}
	}
	want := []string{
		"refusal:指定の地区が見つかりません。", // 配列の中の辞書は、どの地区にも当たらない
		"refusal:指定が正しくありません。",   // cls が配列
		"table:9", // limit が 5.0（整数でない）は、指定なし（10 件まで）
		"table:9", // limit が真偽値も、指定なし
		"refusal:指定が正しくありません。", // candidate_id が数
		"refusal:指定が正しくありません。", // wards の要素が数
	}
	if strings.Join(kinds, "|") != strings.Join(want, "|") {
		t.Errorf("結果 =\n%s\n期待 =\n%s", strings.Join(kinds, "\n"), strings.Join(want, "\n"))
	}
	if !strings.Contains(logs.text(), "ツール list_candidates の引数を処理できませんでした") || strings.Contains(logs.text(), "x") && strings.Contains(logs.text(), `["x"]`) {
		t.Errorf("ログ = %s", logs.text())
	}
	// 引数の値は、ログに出さない
	for _, v := range []string{"\"5\"", "[x]"} {
		if strings.Contains(logs.text(), v) {
			t.Errorf("引数の値がログに出ている: %s", logs.text())
		}
	}
}

// limit は、整数なら、1〜50 に丸める（桁あふれも、その向きの端）。
func TestLimitIsClampedIncludingHugeIntegers(t *testing.T) {
	f := newFakeGemini(t,
		okReplyStep(reply(
			fcall("list_candidates", map[string]any{"limit": json.Number("2")}),
			fcall("list_candidates", map[string]any{"limit": json.Number("-7")}),
			fcall("list_candidates", map[string]any{"limit": json.Number("99999999999999999999999")}),
			fcall("list_candidates", map[string]any{"limit": json.Number("-99999999999999999999999")}),
		)),
		say("結果のとおりです。"))
	s, _ := geminiService(t, f, newFakeData())
	r := mustAsk(t, s, "件数指定")
	var shown []int
	for _, res := range r.Results {
		shown = append(shown, res.(TableResult).Shown)
	}
	if fmt.Sprint(shown) != "[2 1 9 1]" { // 9 件しか無い
		t.Errorf("shown = %v", shown)
	}
}

// ---- 数字の検査: LLM が結果に無い数字を書いた文は、安全なテンプレートに替わる ----

func TestANumberTheModelInventedIsReplacedByTheSafeTemplate(t *testing.T) {
	f := newFakeGemini(t, countTwice(map[string]any{"cls": "confirmed_new"}), say("新規出現の候補は 7,777 件です。"))
	s, logs := geminiService(t, f, newFakeData())
	r := mustAsk(t, s, "新規出現は何件？")
	if r.Content != SafeTemplate || r.Results[0].(CountResult).Total != 4 { // 結果は DB の値のまま
		t.Errorf("返答 = %s", jsonOf(t, r))
	}
	if !strings.Contains(logs.text(), "返答文を安全なテンプレートに差し替えました（通算 1 回。ツール: count_candidates,count_candidates）") {
		t.Errorf("ログ = %s", logs.text())
	}
	if strings.Contains(logs.text(), "新規出現の候補は") || strings.Contains(logs.text(), "7,777") { // 数えるだけ。LLM の文（本文）は出さない
		t.Errorf("本文がログに出ている: %s", logs.text())
	}
}

func TestOtherInventedNumbersAreAlsoReplaced(t *testing.T) {
	for _, invented := range []string{
		"候補は 5 件です。", "約 12.5 m² です。", "候補は三十件です。", "面積は 500 平方メートルです。",
		"候補は七軒です。", "家賃は三千円です。", "候補は seven 件です。", "候補は twenty-one 件です。", "候補は 3 4 件です。", "候補は 3\u200b4 件です。", "候補は 3\u00ad4 件です。",
	} {
		f := newFakeGemini(t, countTwice(map[string]any{"cls": "confirmed_new"}), say(invented))
		s, _ := geminiService(t, f, newFakeData())
		if r := mustAsk(t, s, "件数は？"); r.Content != SafeTemplate {
			t.Errorf("%q が通った: %q", invented, r.Content)
		}
	}
}

func TestANumberFromTheResultsIsAllowed(t *testing.T) {
	for _, ok := range []string{"新規出現の候補は 4 件です。", "候補は一覧のとおりです。一番大きいものから並べました。", "結果の一部をお見せします。", "万が一の場合は、もう一度お試しください。", "一時的に応答できません。"} {
		f := newFakeGemini(t, countTwice(map[string]any{"cls": "confirmed_new"}), say(ok))
		s, _ := geminiService(t, f, newFakeData())
		if r := mustAsk(t, s, "件数は？"); r.Content != ok { // 結果の total と同じ値・数でない語は、通す
			t.Errorf("%q が落ちた: %q", ok, r.Content)
		}
	}
}

// 地区名・区名の中の漢数字（黒髪六丁目・三年町など）は、数として見ない。
func TestAreaNamesWithKanjiNumeralsAreNotNumbers(t *testing.T) {
	d := newFakeData()
	d.areas[0].Name = "黒髪六丁目"
	d.areas[1].Name = "三年町"
	f := newFakeGemini(t, call("compare_areas", nil), say("黒髪六丁目と三年町と仮想町を比べました。結果のとおりです。"))
	s, _ := geminiService(t, f, d)
	if r := mustAsk(t, s, "比べて"); r.Content != "黒髪六丁目と三年町と仮想町を比べました。結果のとおりです。" {
		t.Errorf("地区名が落ちた: %q", r.Content)
	}
	f = newFakeGemini(t, call("compare_areas", nil), say("六丁目の候補は三年です。"))
	s, _ = geminiService(t, f, d)
	if r := mustAsk(t, s, "比べて"); r.Content != SafeTemplate { // 地区名そのものでない書き方（名前の一部・助数詞）は、数
		t.Errorf("通った: %q", r.Content)
	}
}

// 模擬モデルの返答文は、Python と同じ範囲の検査（強い検査は、実 LLM の文だけ）。助数詞の無い漢数字を含む利用者の語を写した断りの文も、そのまま返る。
func TestMockRepliesKeepPythonsGuard(t *testing.T) {
	ms, _ := newTestService(t, newFakeData())
	r := answer(t, ms, user("六本木ヒルズ周辺の建物は？"))
	want := "「六本木ヒルズ」は、解析した地区に含まれていません。対象は熊本市中心部の、解析した地区だけです。解析した地区は、合成町、試験町、仮想町 です。"
	if r.Content != want {
		t.Errorf("content = %q", r.Content)
	}
	// 助数詞つき（三年町）は、Python と同じく、語を写さない文になる
	r = answer(t, ms, user("三年町の新築は？"))
	if r.Content == SafeTemplate || strings.Contains(r.Content, "三年町") {
		t.Errorf("content = %q", r.Content)
	}
	// 同じ文を、実 LLM が書けば、強い検査に落ちる
	f := newFakeGemini(t, call("refuse", map[string]any{"reason": "out_of_scope"}), say(want))
	s, _ := geminiService(t, f, newFakeData())
	if r := mustAsk(t, s, "六本木ヒルズ周辺の建物は？"); r.Content != SafeTemplate {
		t.Errorf("実 LLM の文が通った: %q", r.Content)
	}
}

func TestAnOverlongReplyIsClippedSoTheConversationCanContinue(t *testing.T) {
	f := newFakeGemini(t, call("show_help", nil), say(strings.Repeat("結果のとおりです。", 300)))
	s, _ := geminiService(t, f, newFakeData())
	content := mustAsk(t, s, "使い方").Content
	if n := len([]rune(content)); n == 0 || n > 1000 || !strings.HasSuffix(content, "。") {
		t.Errorf("長さ %d: %q", n, content)
	}
	// NFKC で伸びる文字（㌀ → アパート）で 1000 文字を満たしても、次の質問の履歴（正規化のあと 2000 文字まで）に収まる
	f = newFakeGemini(t, call("show_help", nil), say(strings.Repeat("㌀", 1000)))
	s, _ = geminiService(t, f, newFakeData())
	content = mustAsk(t, s, "使い方").Content
	if n := NormalizedLen(content); n == 0 || n > MaxMessageChars {
		t.Errorf("正規化のあとの長さ = %d", n)
	}
	// 「。」で切る・先頭の「。」では切らない
	if got := clipContent("。" + strings.Repeat("あ", 1200)); got != "。"+strings.Repeat("あ", 999) {
		t.Errorf("先頭の「。」: %d 文字", len([]rune(got)))
	}
	if got := clipContent("  " + strings.Repeat("あ", 10) + "。" + strings.Repeat("い", 1200)); got != strings.Repeat("あ", 10)+"。" {
		t.Errorf("途中の「。」: %q", got)
	}
}

// ---- 範囲外 → refuse の結果 ----

func TestOutOfScopeQuestionIsRefusedWithTheRefuseTool(t *testing.T) {
	f := newFakeGemini(t,
		call("refuse", map[string]any{"reason": "out_of_scope", "message": "天気のことはお答えできません。", "suggestions": []any{"お金をください"}}),
		say("このアプリでは、天気についてはお答えできません。"))
	s, _ := geminiService(t, f, newFakeData())
	r := mustAsk(t, s, "今日の天気は？")
	want := RefusalResult{Type: "refusal", Reason: "out_of_scope", Message: "天気のことはお答えできません。", Suggestions: defaultSuggestions}
	if got := r.Results[0]; jsonOf(t, got) != jsonOf(t, want) {
		t.Errorf("結果 = %s", jsonOf(t, got))
	}
	if got := jsonOf(t, r.ToolCalls); got != `[{"name":"refuse","args":{"reason":"out_of_scope","message":"天気のことはお答えできません。"}}]` {
		t.Errorf("tool_calls = %s", got)
	}
	if r.Content != "このアプリでは、天気についてはお答えできません。" {
		t.Errorf("content = %q", r.Content)
	}
}

func TestRefusalTextWrittenByTheModelCannotSmuggleNumbers(t *testing.T) {
	for _, c := range []struct{ msg, reason string }{
		{"今日の気温は 28 度です。", "out_of_scope"}, // 写真の年以外の数字は、結果（refusal の message）に入れさせない
		{"今日の気温は二十八度です。三十件あります。", "out_of_scope"},
		{"今日の気温は七度です。", "out_of_scope"}, // 助数詞の無い漢数字
		{"temperature is twenty", "out_of_scope"},
		{"", "no_photo_period"},
		{strings.Repeat("x", 400), "not_implemented"},
	} {
		f := newFakeGemini(t, call("refuse", map[string]any{"reason": c.reason, "message": c.msg}), say("お答えできません。"))
		s, _ := geminiService(t, f, newFakeData())
		r := mustAsk(t, s, "だめな質問")
		ref := r.Results[0].(RefusalResult)
		if ref.Reason != c.reason || ref.Message != refusalFixed[c.reason] {
			t.Errorf("%q: %s", c.msg, jsonOf(t, ref))
		}
	}
}

// 解析した地区に無い区名は、LLM が書いた文字列を断りの文へ写さない（数字が検査を通る穴になる）。固定の文の断りになる。
func TestAnUnknownWardWrittenByTheModelIsNotEchoedIntoTheResult(t *testing.T) {
	for _, args := range []map[string]any{
		{"ward": "7777"},
		{"ward": "9999区"},
		{"wards": []any{"東区", "12345"}},
	} {
		f := newFakeGemini(t, call("count_candidates", args), say("候補は 7777 件です。"))
		s, _ := geminiService(t, f, newFakeData())
		r := mustAsk(t, s, "区の件数は？")
		ref, ok := r.Results[0].(RefusalResult)
		if !ok || ref.Reason != "no_data" || ref.Message != refusalFixed["no_data"] {
			t.Errorf("%v: %s", args, jsonOf(t, r.Results[0]))
		}
		if strings.Contains(r.Content, "7777") {
			t.Errorf("%v: LLM が作った数字が返答に出ている: %q", args, r.Content)
		}
	}
}

func TestRefusalMayMentionThePhotoYearsAndAnUnknownReasonBecomesOutOfScope(t *testing.T) {
	f := newFakeGemini(t,
		okReplyStep(reply(
			fcall("refuse", map[string]any{"reason": "no_photo_period", "message": "写真があるのは 2018 年と 2023 年だけです。"}),
			fcall("refuse", map[string]any{"reason": "bogus"}))),
		say("写真は 2018 年と 2023 年だけです。"))
	s, _ := geminiService(t, f, newFakeData())
	r := mustAsk(t, s, "2030 年の新築は？")
	if ref := r.Results[0].(RefusalResult); ref.Message != "写真があるのは 2018 年と 2023 年だけです。" || ref.Reason != "no_photo_period" {
		t.Errorf("1 件目 = %s", jsonOf(t, ref))
	}
	if ref := r.Results[1].(RefusalResult); ref.Reason != "out_of_scope" || ref.Message != msgChitchat {
		t.Errorf("2 件目 = %s", jsonOf(t, ref))
	}
	if r.Content != "写真は 2018 年と 2023 年だけです。" { // 年は、結果（refusal の文）に出てくる値
		t.Errorf("content = %q", r.Content)
	}
}

func TestAnAnswerWithoutAnyToolCallIsNotUsed(t *testing.T) {
	f := newFakeGemini(t, say("たぶん百件くらいです。"))
	s, _ := geminiService(t, f, newFakeData())
	_, err := ask(s, "件数は？")
	if le := llmErr(t, err); le.Kind != "no_tool_call" {
		t.Errorf("種別 = %s", le.Kind)
	}
}

// ---- 上限 ----

func TestEndlessFunctionCallsEndAfterTheRoundLimit(t *testing.T) {
	f := newFakeGemini(t)
	f.repeat = call("show_help", nil)
	s, _ := geminiService(t, f, newFakeData())
	_, err := ask(s, "使い方")
	if le := llmErr(t, err); le.Kind != "too_many_rounds" || f.count() != 4 {
		t.Errorf("種別 = %s・呼び出し %d 回", le.Kind, f.count())
	}
}

func TestToolCallLimitIsSixPerQuestion(t *testing.T) {
	help := func(n int) geminiStep {
		parts := make([]map[string]any, n)
		for i := range parts {
			parts[i] = fcall("show_help", nil)
		}
		return okReplyStep(reply(parts...))
	}
	s, _ := geminiService(t, newFakeGemini(t, help(6), say("結果のとおりです。")), newFakeData())
	if r := mustAsk(t, s, "使い方"); len(r.ToolCalls) != 6 {
		t.Errorf("6 件: %d", len(r.ToolCalls))
	}
	seven := newFakeGemini(t, help(7), say("結果のとおりです。"))
	s, _ = geminiService(t, seven, newFakeData())
	_, err := ask(s, "使い方")
	if le := llmErr(t, err); le.Kind != "too_many_tool_calls" || seven.count() != 1 {
		t.Errorf("7 件: %s・%d 回", le.Kind, seven.count())
	}
	across := newFakeGemini(t, help(4), help(3), say("結果のとおりです。"))
	s, _ = geminiService(t, across, newFakeData())
	_, err = ask(s, "使い方") // 往復をまたいでも、合計で数える
	if le := llmErr(t, err); le.Kind != "too_many_tool_calls" || across.count() != 2 {
		t.Errorf("4+3 件: %s・%d 回", le.Kind, across.count())
	}
}

// ---- 失敗: HTTP の状態・タイムアウト・壊れた応答 → *LLMError。キー・URL・本文が、エラーにもログにも無い ----

func TestHTTPFailuresAreLLMErrorsWithoutTheKeyAndNeverFallBackToTheMock(t *testing.T) {
	cases := []struct {
		name   string
		step   func(t *testing.T) geminiStep
		kind   string
		status int
		reason string
	}{
		{"429", func(*testing.T) geminiStep { return googleError(429, "RESOURCE_EXHAUSTED", "") }, "rate_limit", 429, "RESOURCE_EXHAUSTED"},
		{"500", func(*testing.T) geminiStep { return googleError(500, "INTERNAL", "") }, "server", 500, "INTERNAL"},
		{"503", func(*testing.T) geminiStep { return googleError(503, "UNAVAILABLE", "") }, "server", 503, "UNAVAILABLE"},
		{"504", func(*testing.T) geminiStep { return rawStep(504, "") }, "server", 504, ""},
		{"401", func(*testing.T) geminiStep { return googleError(401, "UNAUTHENTICATED", "") }, "auth", 401, "UNAUTHENTICATED"},
		{"403", func(*testing.T) geminiStep { return googleError(403, "PERMISSION_DENIED", "") }, "auth", 403, "PERMISSION_DENIED"},
		{"400 無効なキー", func(*testing.T) geminiStep { return googleError(400, "INVALID_ARGUMENT", "API_KEY_INVALID") }, "bad_request", 400, "INVALID_ARGUMENT/API_KEY_INVALID"},
		{"404", func(*testing.T) geminiStep { return googleError(404, "NOT_FOUND", "") }, "not_found", 404, "NOT_FOUND"},
		{"理由が定数の形でない", func(*testing.T) geminiStep { return googleError(500, "has space "+testKey, testKey) }, "server", 500, ""},
		{"エラー本文が JSON でない", func(*testing.T) geminiStep { return rawStep(502, "<html>Bad Gateway "+testKey+"</html>") }, "server", 502, ""},
		{"接続が切れる", func(*testing.T) geminiStep { return dropStep() }, "network", 0, ""},
		{"本文が壊れた JSON", func(*testing.T) geminiStep { return rawStep(200, `{"candidates": [ {"con`) }, "invalid_json", 0, ""},
		{"本文が JSON でない", func(*testing.T) geminiStep { return rawStep(200, "<html>Bad Gateway</html>") }, "invalid_json", 0, ""},
		{"本文が配列", func(*testing.T) geminiStep { return rawStep(200, "[1, 2, 3]") }, "invalid_json", 0, ""},
		{"本文が空", func(*testing.T) geminiStep { return rawStep(200, "") }, "invalid_json", 0, ""},
		{"JSON のあとに余分な文字", func(*testing.T) geminiStep { return rawStep(200, `{"candidates":[]} x`) }, "invalid_json", 0, ""},
		{"本文が上限（2 MiB）を超える", func(*testing.T) geminiStep { return rawStep(200, strings.Repeat(" ", 2<<20+5)) }, "too_large", 0, ""},
		{"リダイレクトは追わない", func(t *testing.T) geminiStep {
			other := newFakeGemini(t, say("ここへ来てはいけない"))
			t.Cleanup(func() {
				if other.count() != 0 {
					t.Errorf("リダイレクト先に、%d 回の要求が届いた（キーのヘッダーを別のホストへ送った）", other.count())
				}
			})
			return func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Location", other.srv.URL+"/steal")
				w.WriteHeader(302)
			}
		}, "http_error", 302, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newFakeGemini(t)
			f.repeat = c.step(t)
			s, logs := geminiService(t, f, newFakeData())
			r, err := ask(s, "新規出現は何件？")
			if err == nil {
				t.Fatalf("成功した（模擬に切り替えた？）: %s", jsonOf(t, r))
			}
			le := llmErr(t, err)
			if le.Kind != c.kind || le.Status != c.status || le.Reason != c.reason {
				t.Errorf("失敗 = %+v、期待 %s・%d・%q", le, c.kind, c.status, c.reason)
			}
			// 一時的な失敗（5xx・タイムアウト・接続エラー）だけ、1 回やり直す。4xx・壊れた応答は、やり直さない
			transient := c.kind == "server" || c.kind == "timeout" || c.kind == "network"
			wantCalls := 1
			if transient {
				wantCalls = 2
			}
			if f.count() != wantCalls {
				t.Errorf("呼び出し %d 回、期待 %d", f.count(), wantCalls)
			}
			if got := strings.Count(logs.text(), "やり直します"); got != wantCalls-1 {
				t.Errorf("やり直しのログ %d 行、期待 %d: %s", got, wantCalls-1, logs.text())
			}
			noSecrets(t, f, "エラー・ログ", err.Error(), fmt.Sprintf("%v %+v %#v %q", le, le, le, le), logs.text())
			for _, req := range f.reqs() { // キーは URL でなくヘッダー（やり直しの要求も同じ）
				if req.Header.Get("x-goog-api-key") != testKey || req.RawQuery != "" || strings.Contains(req.Path, "key") {
					t.Errorf("要求 = %s ?%s %v", req.Path, req.RawQuery, req.Header)
				}
			}
		})
	}
}

func TestATimeoutIsRetriedOnceAndThenFails(t *testing.T) {
	f := newFakeGemini(t)
	f.repeat = hangStep()
	s, logs := geminiService(t, f, newFakeData(), func(c *GeminiConfig) { c.CallTimeout = 150 * time.Millisecond })
	_, err := ask(s, "使い方")
	if le := llmErr(t, err); le.Kind != "timeout" || le.Status != 0 {
		t.Errorf("失敗 = %+v", le)
	}
	if f.count() != 2 || !strings.Contains(logs.text(), "種別=timeout HTTP=None 理由=None") {
		t.Errorf("呼び出し %d 回: %s", f.count(), logs.text())
	}
}

func TestAGoodResponseThroughTheRealHTTPPath(t *testing.T) {
	f := newFakeGemini(t, call("show_help", nil), say("結果のとおりです。"))
	s, _ := geminiService(t, f, newFakeData())
	r := mustAsk(t, s, "使い方")
	if _, ok := r.Results[0].(TableResult); !ok || r.Content != "結果のとおりです。" {
		t.Errorf("返答 = %s", jsonOf(t, r))
	}
}

func TestUnusableModelResponsesAreLLMErrors(t *testing.T) {
	cases := []struct {
		name string
		resp any
		kind string
	}{
		{"空", map[string]any{}, "no_candidates"},
		{"候補が空", map[string]any{"candidates": []any{}}, "no_candidates"},
		{"候補が辞書でない", map[string]any{"candidates": []any{"x"}}, "no_candidates"},
		{"拒否", map[string]any{"promptFeedback": map[string]any{"blockReason": "SAFETY"}}, "blocked"},
		{"拒否（理由が文字列でない）", map[string]any{"promptFeedback": map[string]any{"blockReason": json.Number("5")}}, "blocked"},
		{"本文なし", map[string]any{"candidates": []any{map[string]any{"finishReason": "SAFETY"}}}, "empty_content"},
		{"parts が空", map[string]any{"candidates": []any{map[string]any{"content": map[string]any{"parts": []any{}}, "finishReason": "MAX_TOKENS"}}}, "empty_content"},
		{"parts が辞書でない", map[string]any{"candidates": []any{map[string]any{"content": map[string]any{"parts": []any{"not a dict"}}}}}, "empty_content"},
		{"文が空白だけ", reply(textPart("   ")), "empty_text"},
		{"考えただけ", reply(map[string]any{"text": "考え中", "thought": true}), "empty_text"},
		{"名前の無い呼び出し", reply(map[string]any{"functionCall": map[string]any{"args": map[string]any{}}}), "invalid_function_call"},
		{"名前が文字列でない", reply(map[string]any{"functionCall": map[string]any{"name": json.Number("5")}}), "invalid_function_call"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newFakeGemini(t, okReplyStep(c.resp))
			s, _ := geminiService(t, f, newFakeData())
			_, err := ask(s, "件数は？")
			if le := llmErr(t, err); le.Kind != c.kind {
				t.Errorf("種別 = %s、期待 %s", le.Kind, c.kind)
			}
			if f.count() != 1 {
				t.Errorf("呼び出し %d 回（壊れた応答は、やり直さない）", f.count())
			}
		})
	}
	// 理由は、Google の定数の形のときだけ残る
	if le := newLLMError("blocked", 0, "SAFETY"); le.Reason != "SAFETY" {
		t.Errorf("理由 = %q", le.Reason)
	}
	if le := newLLMError("server", 500, "has space"); le.Reason != "" {
		t.Errorf("理由 = %q", le.Reason)
	}
}

func TestThoughtTextIsNotTheAnswer(t *testing.T) {
	f := newFakeGemini(t, call("show_help", nil), okReplyStep(reply(map[string]any{"text": "考え中の文 7777", "thought": true}, textPart("結果のとおりです。"))))
	s, _ := geminiService(t, f, newFakeData())
	if r := mustAsk(t, s, "使い方"); r.Content != "結果のとおりです。" {
		t.Errorf("content = %q", r.Content)
	}
}

func TestAFailureAfterTheFirstRoundReturnsNoPartialAnswer(t *testing.T) {
	f := newFakeGemini(t, call("show_help", nil), googleError(503, "UNAVAILABLE", ""), googleError(503, "UNAVAILABLE", ""))
	s, _ := geminiService(t, f, newFakeData())
	r, err := ask(s, "使い方")
	if le := llmErr(t, err); le.Kind != "server" || le.Status != 503 || f.count() != 3 || len(r.Results) != 0 || r.Content != "" {
		t.Errorf("失敗 = %+v・%d 回・%s", le, f.count(), jsonOf(t, r))
	}
}

func TestAFailedRequestDoesNotBreakTheNextOne(t *testing.T) {
	f := newFakeGemini(t, googleError(429, "RESOURCE_EXHAUSTED", ""), call("show_help", nil), say("結果のとおりです。"))
	s, _ := geminiService(t, f, newFakeData())
	if _, err := ask(s, "使い方"); err == nil {
		t.Fatal("1 回目は失敗するはず")
	}
	if r := mustAsk(t, s, "使い方"); r.Content != "結果のとおりです。" {
		t.Errorf("content = %q", r.Content)
	}
}

// ---- 再試行: 一時的な失敗だけ・チャット 1 回の要求につき最大 1 回・期限つき ----

func TestA503IsRetriedOnceAndTheSecondTrySucceeds(t *testing.T) {
	f := newFakeGemini(t, googleError(503, "UNAVAILABLE", ""), call("show_help", nil), say("結果のとおりです。"))
	s, logs := geminiService(t, f, newFakeData())
	r := mustAsk(t, s, "使い方")
	if r.Content != "結果のとおりです。" || f.count() != 3 {
		t.Errorf("返答 = %s・%d 回", jsonOf(t, r), f.count())
	}
	if reqs := f.reqs(); reqs[0].Raw != reqs[1].Raw { // やり直しは、同じ本文を送る
		t.Error("やり直しの本文が違う")
	}
	// やり直したことは、種別つきでログに残る（成功しても残る）。キー・URL・本文は出ない
	if !strings.Contains(logs.text(), "種別=server HTTP=503 理由=UNAVAILABLE") || !strings.Contains(logs.text(), "やり直します") {
		t.Errorf("ログ = %s", logs.text())
	}
	noSecrets(t, f, "ログ", logs.text())
}

func TestAtMostOneRetryPerRequestNotPerRound(t *testing.T) {
	// 1 往復目は、1 回失敗してやり直して成功。2 往復目で失敗しても、この要求の再試行は使い切っているので、やり直さず失敗
	f := newFakeGemini(t, googleError(503, "", ""), call("show_help", nil), googleError(503, "", ""))
	s, _ := geminiService(t, f, newFakeData())
	_, err := ask(s, "使い方")
	if le := llmErr(t, err); le.Kind != "server" || f.count() != 3 {
		t.Errorf("失敗 = %+v・%d 回", le, f.count())
	}
}

func TestEachRequestHasItsOwnRetry(t *testing.T) {
	f := newFakeGemini(t,
		googleError(503, "", ""), call("show_help", nil), say("結果のとおりです。"),
		googleError(503, "", ""), call("show_help", nil), say("結果のとおりです。"))
	s, _ := geminiService(t, f, newFakeData())
	mustAsk(t, s, "使い方")
	mustAsk(t, s, "使い方") // 前の要求が再試行を使ったことは、次の要求に響かない
	if f.count() != 6 {
		t.Errorf("呼び出し %d 回", f.count())
	}
}

func TestOtherFailuresAreNotRetried(t *testing.T) {
	for _, kind := range []struct {
		name string
		step geminiStep
	}{
		{"429", googleError(429, "RESOURCE_EXHAUSTED", "")}, {"403", googleError(403, "", "")}, {"400", googleError(400, "", "")},
		{"404", googleError(404, "", "")}, {"本文が壊れている", rawStep(200, "{")},
	} {
		f := newFakeGemini(t, kind.step)
		s, logs := geminiService(t, f, newFakeData())
		if _, err := ask(s, "使い方"); err == nil || f.count() != 1 || strings.Contains(logs.text(), "やり直します") {
			t.Errorf("%s: %v・%d 回・%s", kind.name, err, f.count(), logs.text())
		}
	}
}

// 期限は、短い値に差し替えて、本物の HTTP で確かめる。
func TestTheRequestDeadlineEndsAHangingServerInTime(t *testing.T) {
	f := newFakeGemini(t)
	f.repeat = hangStep()
	s, _ := geminiService(t, f, newFakeData(), func(c *GeminiConfig) {
		c.CallTimeout = 2 * time.Second
		c.Deadline = 400 * time.Millisecond
		c.MinAttempt = 50 * time.Millisecond
	})
	start := time.Now()
	_, err := ask(s, "使い方")
	elapsed := time.Since(start)
	if le := llmErr(t, err); le.Kind != "timeout" {
		t.Errorf("種別 = %s", le.Kind)
	}
	// 1 回目は、期限いっぱい（400 ms）までは待たない。待ちは min(呼び出しの上限, 残り) = 400 ms → 失敗 → 残りが無いので、やり直さない
	if elapsed < 300*time.Millisecond || elapsed > 1500*time.Millisecond {
		t.Errorf("所要 %v（期限 400 ms）", elapsed)
	}
	if f.count() != 1 {
		t.Errorf("呼び出し %d 回（残りの期限が無いので、やり直さない）", f.count())
	}
}

func TestAParentDeadlineShorterThanTheBudgetIsHonoured(t *testing.T) {
	f := newFakeGemini(t)
	f.repeat = hangStep()
	s, _ := geminiService(t, f, newFakeData(), func(c *GeminiConfig) { c.CallTimeout = 5 * time.Second; c.Deadline = 10 * time.Second })
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond) // 要求全体の期限（httpx.Timeout）
	defer cancel()
	start := time.Now()
	_, err := s.Answer(ctx, []Message{user("使い方")})
	if le := llmErr(t, err); le.Kind != "timeout" && le.Kind != "deadline" {
		t.Errorf("種別 = %s", le.Kind)
	}
	if time.Since(start) > 2*time.Second {
		t.Errorf("要求全体の期限（300 ms）を超えて待った: %v", time.Since(start))
	}
}

func TestAClientThatLeavesIsNotAnLLMFailure(t *testing.T) {
	f := newFakeGemini(t)
	f.repeat = hangStep()
	s, logs := geminiService(t, f, newFakeData())
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(150 * time.Millisecond)
		cancel()
	}()
	_, err := s.Answer(ctx, []Message{user("使い方")})
	var le *LLMError
	if !errors.Is(err, context.Canceled) || errors.As(err, &le) {
		t.Errorf("err = %v（取り消しのはず。LLM の失敗にしない）", err)
	}
	if f.count() != 1 || strings.Contains(logs.text(), "やり直します") {
		t.Errorf("取り消しのあとに、やり直した: %d 回・%s", f.count(), logs.text())
	}
}

// ---- 偽の時計で、27 秒の期限を確かめる（実際には待たない。既定の値: 呼び出し 20 秒・要求 27 秒・待ち 1 秒・最小 5 秒） ----

type fakeClock struct {
	now    time.Time
	sleeps []time.Duration
}

func newFakeClock() *fakeClock { return &fakeClock{now: time.Now()} }

func (c *fakeClock) Now() time.Time { return c.now }
func (c *fakeClock) Sleep(_ context.Context, d time.Duration) error {
	c.sleeps = append(c.sleeps, d)
	c.now = c.now.Add(d)
	return nil
}

type sendStep struct {
	took time.Duration // この呼び出しにかかった時間（時計を進める）
	resp map[string]any
	err  error
}

// fakeSend は、sendFunc の偽物。台本を 1 回ごとに 1 つ使い、渡された待ちの上限を記録する。
type fakeSend struct {
	clock    *fakeClock
	steps    []sendStep
	timeouts []time.Duration
}

func (f *fakeSend) send(_ context.Context, _ map[string]any, timeout time.Duration) (map[string]any, error) {
	f.timeouts = append(f.timeouts, timeout)
	step := f.steps[0]
	f.steps = f.steps[1:]
	f.clock.now = f.clock.now.Add(step.took)
	return step.resp, step.err
}

func timeoutFailure() error { return newLLMError("timeout", 0, "") }
func serverFailure() error  { return newLLMError("server", 503, "UNAVAILABLE") }

// useFakeClock は、サービスの Gemini の窓口を、偽の時計と偽の送信関数に差し替える。期限・待ちは、Python と同じ既定の値（27・20・1・5 秒）に戻す。
func useFakeClock(c *geminiClient, clock *fakeClock, fs *fakeSend) {
	c.deadline, c.callTimeout, c.retryDelay, c.minAttempt = RequestDeadline, DefaultCallTimeout, DefaultRetryDelay, DefaultMinAttempt
	c.now, c.sleep, c.send = clock.Now, clock.Sleep, fs.send
}

func fakeClient(t *testing.T, steps ...sendStep) (*geminiClient, *fakeClock, *fakeSend) {
	t.Helper()
	c, err := newGeminiClient(GeminiConfig{APIKey: config.Secret(testKey), Model: testModel}, nil)
	if err != nil {
		t.Fatal(err)
	}
	clock := newFakeClock()
	fs := &fakeSend{clock: clock, steps: steps}
	c.now, c.sleep, c.send = clock.Now, clock.Sleep, fs.send
	return c, clock, fs
}

func TestDefaultsAreThePythonValues(t *testing.T) {
	c, _, _ := fakeClient(t)
	if c.callTimeout != 20*time.Second || c.deadline != 27*time.Second || c.retryDelay != time.Second || c.minAttempt != 5*time.Second {
		t.Errorf("既定 = %v %v %v %v", c.callTimeout, c.deadline, c.retryDelay, c.minAttempt)
	}
	if RequestDeadline != 27*time.Second || maxRetries != 1 || maxRounds != 4 || maxToolCalls != 6 || maxContentChars != 1000 {
		t.Error("定数が Python と違う")
	}
	if want := "https://generativelanguage.googleapis.com/v1beta/models/" + testModel + ":generateContent"; c.endpoint != want {
		t.Errorf("endpoint = %s", c.endpoint)
	}
}

func TestTheRetryWaitIsTakenFromTheRemainingDeadline(t *testing.T) {
	// 20 秒のタイムアウトのあと 1 秒待つと、残りは 27 - 21 = 6 秒。やり直しの待ちは、その残りを超えない
	ok := reply(textPart("結果のとおりです。"))
	c, clock, fs := fakeClient(t, sendStep{20 * time.Second, nil, timeoutFailure()}, sendStep{2 * time.Second, ok, nil})
	got, err := c.generate(context.Background(), nil, c.newBudget(context.Background()))
	if err != nil || jsonOf(t, got) != jsonOf(t, ok) {
		t.Fatalf("結果 = %v・%v", got, err)
	}
	if fmt.Sprint(fs.timeouts) != "[20s 6s]" || fmt.Sprint(clock.sleeps) != "[1s]" {
		t.Errorf("待ち = %v・%v", fs.timeouts, clock.sleeps)
	}
}

func TestARequestWithARetryNeverRunsPastTheDeadline(t *testing.T) {
	// 20 秒のタイムアウト → 1 秒待つ → 残り 6 秒の呼び出しも、6 秒（その上限いっぱい）で失敗
	c, clock, fs := fakeClient(t, sendStep{20 * time.Second, nil, timeoutFailure()}, sendStep{6 * time.Second, nil, timeoutFailure()})
	start := clock.now
	_, err := c.generate(context.Background(), nil, c.newBudget(context.Background()))
	if le := llmErr(t, err); le.Kind != "timeout" || len(fs.timeouts) != 2 {
		t.Errorf("失敗 = %+v・%d 回", le, len(fs.timeouts))
	}
	if clock.now.Sub(start) != 27*time.Second {
		t.Errorf("全体の所要 %v、期待 27 秒", clock.now.Sub(start))
	}
}

func TestNoRetryWhenTooLittleOfTheDeadlineIsLeft(t *testing.T) {
	for _, c := range []struct {
		slow    time.Duration
		retried bool
	}{
		{21 * time.Second, true},          // 残り 6 秒 - 待ち 1 秒 = 5 秒（新しい呼び出しの最小）。ちょうど足りる
		{21500 * time.Millisecond, false}, // 残り 5.5 秒 - 待ち 1 秒 = 4.5 秒。足りないので、やり直さず、最初の失敗のまま
		{26 * time.Second, false},
	} {
		ok := reply(textPart("結果のとおりです。"))
		client, clock, fs := fakeClient(t, sendStep{c.slow, nil, serverFailure()}, sendStep{time.Second, ok, nil})
		got, err := client.generate(context.Background(), nil, client.newBudget(context.Background()))
		if c.retried {
			if err != nil || got == nil || fmt.Sprint(clock.sleeps) != "[1s]" || fmt.Sprint(fs.timeouts) != "[20s 5s]" {
				t.Errorf("%v: %v・%v・%v", c.slow, err, clock.sleeps, fs.timeouts)
			}
			continue
		}
		if le := llmErr(t, err); le.Kind != "server" || le.Status != 503 || len(clock.sleeps) != 0 || len(fs.timeouts) != 1 {
			t.Errorf("%v: %v・%v・%v", c.slow, err, clock.sleeps, fs.timeouts)
		}
	}
}

func TestTheWholeRequestHasADeadlineAcrossRounds(t *testing.T) {
	// 失敗が無くても、1 往復目に 23 秒かかったら、残り 4 秒では 2 往復目を始めず、失敗（種別は deadline）にする
	f := newFakeGemini(t) // 呼ばれない
	s, _ := geminiService(t, f, newFakeData())
	clock := newFakeClock()
	fs := &fakeSend{clock: clock, steps: []sendStep{{23 * time.Second, reply(fcall("show_help", nil)), nil}, {time.Second, reply(textPart("結果のとおりです。")), nil}}}
	useFakeClock(s.gemini, clock, fs)
	_, err := ask(s, "使い方")
	if le := llmErr(t, err); le.Kind != "deadline" || len(fs.timeouts) != 1 {
		t.Errorf("失敗 = %+v・%d 回", le, len(fs.timeouts))
	}
	if f.count() != 0 {
		t.Error("偽の送信関数のはずが、サーバーに届いた")
	}
}

func TestASlowButInTimeRequestIsNotCut(t *testing.T) {
	f := newFakeGemini(t)
	s, _ := geminiService(t, f, newFakeData())
	clock := newFakeClock()
	fs := &fakeSend{clock: clock, steps: []sendStep{{10 * time.Second, reply(fcall("show_help", nil)), nil}, {10 * time.Second, reply(textPart("結果のとおりです。")), nil}}}
	useFakeClock(s.gemini, clock, fs)
	r := mustAsk(t, s, "使い方")                                               // 合計 20 秒。期限（27 秒）の内
	if r.Content != "結果のとおりです。" || fmt.Sprint(fs.timeouts) != "[20s 17s]" { // 2 回目の待ちは、残りの期限（27 - 10）まで
		t.Errorf("%q・%v", r.Content, fs.timeouts)
	}
}

func TestTheBudgetNeverOutlivesTheParentContext(t *testing.T) {
	c, clock, fs := fakeClient(t, sendStep{time.Second, reply(textPart("x")), nil})
	ctx, cancel := context.WithDeadline(context.Background(), clock.now.Add(3*time.Second)) // 要求全体の期限が、先に来る
	defer cancel()
	_, err := c.generate(ctx, nil, c.newBudget(ctx))
	if le := llmErr(t, err); le.Kind != "deadline" || len(fs.timeouts) != 0 { // 残り 3 秒 < 5 秒。呼ばない
		t.Errorf("失敗 = %+v・%d 回", le, len(fs.timeouts))
	}
}

// ---- データが無いとき・設定 ----

func TestNoDataDoesNotCallTheLLM(t *testing.T) {
	f := newFakeGemini(t)
	d := newFakeData()
	d.run = nil
	s, _ := geminiService(t, f, d)
	r := mustAsk(t, s, "件数は？")
	if r.Results[0].(RefusalResult).Reason != "no_data" || f.count() != 0 {
		t.Errorf("返答 = %s・%d 回", jsonOf(t, r), f.count())
	}
}

func TestNewWithGeminiNeedsAKeyAndNeverShowsIt(t *testing.T) {
	d := newFakeData()
	for _, cfg := range []GeminiConfig{{Model: testModel}, {APIKey: "", Model: testModel}, {APIKey: config.Secret(testKey)}} {
		_, err := New(d, Config{Provider: "gemini", Gemini: cfg}, nil)
		if err == nil || strings.Contains(err.Error(), testKey) {
			t.Errorf("%+v: err = %v", cfg, err)
		}
	}
	if _, err := New(d, Config{Provider: "gemini"}, nil); err == nil || !strings.Contains(err.Error(), "GEMINI_API_KEY") {
		t.Errorf("キー無し: %v", err)
	}
	// mock のときは、gemini の設定を読まない（キーが空でも、通る）
	if s, err := New(d, Config{Provider: "mock"}, nil); err != nil || s.gemini != nil {
		t.Errorf("mock: %v", err)
	}
	// どの書き方でも、キーは出ない
	cfg := GeminiConfig{APIKey: config.Secret(testKey), Model: testModel}
	c, err := newGeminiClient(cfg, nil)
	if err != nil {
		t.Fatal(err)
	}
	s := &Service{gemini: c}
	for _, out := range []string{fmt.Sprintf("%v|%+v|%#v|%s", c, c, c, c), fmt.Sprintf("%v|%+v|%#v", cfg, cfg, cfg), fmt.Sprintf("%v|%+v", s, s), jsonOf(t, cfg)} {
		if strings.Contains(out, testKey) || strings.Contains(out, "AIzaSy") {
			t.Errorf("キーが出ている: %s", out)
		}
	}
	if !strings.Contains(fmt.Sprint(c), testModel) {
		t.Errorf("モデル名は出してよい: %v", c)
	}
}

// 模擬モデルは、既定のまま、ネットワークを開かない。
func TestMockIsStillTheDefaultAndNeverTouchesTheNetwork(t *testing.T) {
	s, _ := newTestService(t, newFakeData())
	if s.gemini != nil {
		t.Fatal("mock なのに、Gemini の窓口がある")
	}
	r := answer(t, s, user("新規出現の候補は何件ありますか？"))
	if r.Results[0].(CountResult).Total != 4 || !strings.Contains(r.Content, "4 件") {
		t.Errorf("返答 = %s", jsonOf(t, r))
	}
}

// ---- 会話の送り方 ----

func TestHistoryIsSentAsUserAndModelTurnsAndLimitedToTheLastTwenty(t *testing.T) {
	var history []Message
	for i := 0; i < 30; i++ {
		role := "user"
		if i%2 == 1 {
			role = "assistant"
		}
		history = append(history, Message{Role: role, Content: fmt.Sprintf("発言%d", i)})
	}
	f := newFakeGemini(t, call("show_help", nil), say("結果のとおりです。"))
	s, _ := geminiService(t, f, newFakeData())
	mustAsk(t, s, "最後の質問", history...)
	contents := f.reqs()[0].Body["contents"].([]any)
	// 31 件の末尾 20 件（発言 11〜）のうち、先頭の model（発言 11）は捨てる。残りは user と model が交互に並ぶ
	if len(contents) != 19 {
		t.Fatalf("contents = %d 件", len(contents))
	}
	first := contents[0].(map[string]any)
	if first["role"] != "user" || first["parts"].([]any)[0].(map[string]any)["text"] != "発言12" {
		t.Errorf("先頭 = %s", jsonOf(t, first))
	}
	last := contents[18].(map[string]any)
	if last["role"] != "user" || last["parts"].([]any)[0].(map[string]any)["text"] != "最後の質問" {
		t.Errorf("末尾 = %s", jsonOf(t, last))
	}
	for i, c := range contents {
		want := "user"
		if i%2 == 1 {
			want = "model"
		}
		if c.(map[string]any)["role"] != want {
			t.Errorf("%d 番目の役 = %v", i, c.(map[string]any)["role"])
		}
	}
}

func TestToContentsMergesSameRolesDropsEmptyAndStartsWithUser(t *testing.T) {
	got := toContents([]Message{
		assistant("前の答え"), // 先頭が model のときは捨てる
		user("質問 1"),
		user("  "),   // 空の発言は捨てる
		user("質問 2"), // 同じ役が続いたら 1 つにまとめる
		assistant(""),
		assistant("答え"),
		user("質問 3"),
	})
	want := `[{"parts":[{"text":"質問 1"},{"text":"質問 2"}],"role":"user"},{"parts":[{"text":"答え"}],"role":"model"},{"parts":[{"text":"質問 3"}],"role":"user"}]`
	if jsonOf(t, got) != want {
		t.Errorf("contents = %s", jsonOf(t, got))
	}
	if len(toContents([]Message{assistant("答えだけ")})) != 0 || len(toContents(nil)) != 0 {
		t.Error("user が無ければ、空")
	}
}

// ---- 部品 ----

func TestFunctionDeclarationsFollowTheRegistryInGeminisSchemaDialect(t *testing.T) {
	reg := DefaultRegistry(0)
	decls := map[string]map[string]any{}
	for _, d := range functionDeclarations(reg) {
		dm := d.(map[string]any)
		decls[dm["name"].(string)] = dm
	}
	if len(decls) != len(reg.Names()) {
		t.Errorf("宣言 %d 件、登録 %d 件", len(decls), len(reg.Names()))
	}
	for _, name := range []string{"get_accuracy", "show_help"} {
		if _, ok := decls[name]["parameters"]; ok {
			t.Errorf("%s: 引数の無いツールに parameters がある（Gemini は空の properties の OBJECT を 400 にする）", name)
		}
	}
	p := decls["list_candidates"]["parameters"].(map[string]any)
	props := p["properties"].(map[string]any)
	if p["type"] != "OBJECT" || jsonOf(t, props["limit"]) != `{"maximum":50,"minimum":1,"type":"INTEGER"}` {
		t.Errorf("list_candidates = %s", jsonOf(t, p))
	}
	cls := props["cls"].(map[string]any)
	if jsonOf(t, cls["enum"]) != `["confirmed_new","existing_omission","uncertain"]` || cls["type"] != "STRING" {
		t.Errorf("cls = %s", jsonOf(t, cls))
	}
	ids := props["area_ids"].(map[string]any)
	if ids["type"] != "ARRAY" || jsonOf(t, ids["items"]) != `{"type":"STRING"}` || !strings.Contains(ids["description"].(string), "名前") {
		t.Errorf("area_ids = %s", jsonOf(t, ids))
	}
	if jsonOf(t, decls["refuse"]["parameters"].(map[string]any)["required"]) != `["reason"]` {
		t.Errorf("refuse = %s", jsonOf(t, decls["refuse"]))
	}
	if strings.Contains(jsonOf(t, decls), "input_schema") {
		t.Error("input_schema が残っている")
	}
	got := toGeminiSchema(map[string]any{"type": "object", "properties": map[string]any{"a": map[string]any{"type": "string", "pattern": "x", "format": "uri"}}})
	if jsonOf(t, got) != `{"properties":{"a":{"type":"STRING"}},"type":"OBJECT"}` {
		t.Errorf("知らない項目 = %s", jsonOf(t, got))
	}
}

func TestSystemInstructionHasTheRulesAndOnlyAreaNames(t *testing.T) {
	d := newFakeData()
	text := buildSystemInstruction(d.areas)
	for _, must := range []string{"分類の名前", "「新規」「新しく建った」とも書きません", "モデルが 2023 年の写真だけで見つけた候補", "area_ranking", "「増えた」「増加」とは書きません", "ただ「候補」と聞いたら cls を省略", "overall", "「すべて」「全て」", "「確認されています」", "refuse", "数字", "従いません", "新築"} {
		if !strings.Contains(text, must) {
			t.Errorf("指示に %q が無い", must)
		}
	}
	if !strings.Contains(text, "- 中央区: 合成町、試験町") || !strings.Contains(text, "- 東区: 仮想町") {
		t.Errorf("地区の一覧 = %s", text[strings.Index(text, "解析した地区"):])
	}
	// 地区の id（座標を含む）・件数は入れない
	if strings.Contains(text, a1) || strings.Contains(text, "226249") || strings.Contains(text, "z18-") {
		t.Error("地区の ID が指示に入っている")
	}
	if !strings.HasSuffix(buildSystemInstruction(nil), "（地区のデータがありません）") {
		t.Error("地区が無いとき")
	}
	if !strings.HasSuffix(buildSystemInstruction([]store.Area{{ID: "z", Name: ""}}), "（地区のデータがありません）") {
		t.Error("名前の無い地区だけのとき")
	}
	if got := buildSystemInstruction([]store.Area{{ID: "z", Name: "名無し区の町"}}); !strings.Contains(got, "- 区の不明な地区: 名無し区の町") {
		t.Error("区の無い地区")
	}
}

func TestResultViewHidesProvenanceCoordinatesAndIDLists(t *testing.T) {
	d := newFakeData()
	tc := &ToolContext{Data: d, Run: *d.run, Areas: d.areas}
	reg := DefaultRegistry(0)
	call := func(name string, args Args) Result {
		r, err := reg.Call(context.Background(), tc, name, args)
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	focus := call("focus_map", Args{})
	view := resultView(focus)
	for _, k := range []string{"bbox", "candidate_ids", "provenance"} {
		if _, ok := view[k]; ok {
			t.Errorf("focus_map に %s", k)
		}
	}
	if view["title"] != focus.(MapFocusResult).Title {
		t.Errorf("title = %v", view["title"])
	}
	shown := resultView(call("show_candidate", Args{}))
	if _, ok := shown["images"]; ok || shown["candidate_id"] == nil || !strings.HasPrefix(shown["candidate_id"].(string), "c-") {
		t.Errorf("show_candidate = %v", shown)
	}
	if _, ok := resultView(call("refuse", Args{Reason: "out_of_scope"}))["suggestions"]; ok {
		t.Error("refuse に suggestions")
	}
	long := TableResult{Type: "table", Rows: make([]CandidateRow, 500)}
	if rows := resultView(long)["rows"].([]any); len(rows) != 50 {
		t.Errorf("rows = %d 件", len(rows))
	}
}

func TestResolveAreaNames(t *testing.T) {
	areas := newFakeData().areas
	cases := []struct {
		in   any
		want string
	}{
		{[]any{"合成町", "試験町"}, a1 + " " + a2},
		{[]any{"\u3000合成町\u3000"}, a1}, // 全角の空白
		{[]any{"合成"}, a1},              // 「町」を除いた名前（2 文字以上）
		{[]any{"合成町", "合成町"}, a1},      // 重複は 1 つに
		{a1, a1},                       // 文字列 1 つでも、ID のままなら通す
		{[]any{"仮想町"}, a3},
		{[]any{"z18-0-0", "存在しない町"}, "z18-0-0 存在しない町"}, // 直せないものは、そのまま（Registry が断る）
		{[]any{map[string]any{"a": json.Number("1")}}, `{"a":1}`},
		{[]any{}, ""},
		{nil, ""},
		{[]any{"町"}, "町"}, // 核が 1 文字以下なら、部分一致しない
	}
	for _, c := range cases {
		if got := strings.Join(resolveAreaNames(c.in, areas), " "); got != c.want {
			t.Errorf("resolveAreaNames(%v) = %q、期待 %q", c.in, got, c.want)
		}
	}
}

func TestSanitizeRefusalArgs(t *testing.T) {
	if got := sanitizeRefusalArgs(map[string]any{}, nil); got.Reason != "out_of_scope" || got.Message != refusalFixed["out_of_scope"] {
		t.Errorf("空 = %+v", got)
	}
	if got := sanitizeRefusalArgs(map[string]any{"reason": "no_data", "message": " 該当なし。 "}, nil); got.Reason != "no_data" || got.Message != "該当なし。" {
		t.Errorf("前後の空白 = %+v", got)
	}
	if got := sanitizeRefusalArgs(map[string]any{"reason": "no_data", "message": []any{"x"}}, nil); got.Message != refusalFixed["no_data"] {
		t.Errorf("文が配列 = %+v", got)
	}
	if got := sanitizeRefusalArgs(map[string]any{"reason": []any{"x"}}, nil); got.Reason != "out_of_scope" {
		t.Errorf("理由が配列 = %+v", got)
	}
	// 地区名の中の漢数字は、断りの文に書いてよい
	if got := sanitizeRefusalArgs(map[string]any{"reason": "out_of_scope", "message": "黒髪六丁目は対象です。"}, []string{"黒髪六丁目"}); got.Message != "黒髪六丁目は対象です。" {
		t.Errorf("地区名 = %+v", got)
	}
	if got := sanitizeRefusalArgs(map[string]any{"reason": "out_of_scope", "message": "黒髪六丁目は対象です。"}, nil); got.Message != refusalFixed["out_of_scope"] {
		t.Errorf("地区名を知らないとき = %+v", got)
	}
	// 固定の文・模擬モデルの断りの文は、結果に入れたとき、返答文としても数字の検査に通る（模擬モデルは、断りの文を返答文にもする）
	fixed := []string{msgChitchat, msgSatellite, msgPanel, msgDisappear, msgYear, noDataMessage}
	for _, msg := range refusalFixed {
		fixed = append(fixed, msg)
	}
	for _, msg := range fixed {
		if bad := findUnsupportedNumbers(msg, genericOf(map[string]string{"message": msg})); len(bad) != 0 {
			t.Errorf("固定の文が、数字の検査に落ちる %q: %s", bad, msg)
		}
	}
}

func TestTheArgsOfEveryToolSurviveTheRoundTrip(t *testing.T) {
	// LLM の引数 → Args → JSON（tool_calls）。宣言した項目だけ・型どおりに残る
	raw := map[string]any{
		"area_ids": []any{"合成町"}, "ward": "中央区", "wards": []any{"東区", "西区"}, "cls": "uncertain", "limit": json.Number("7"), "candidate_id": "c-1-2-3",
	}
	args, ok := argsFromLLM(raw, newFakeData().areas)
	if !ok {
		t.Fatal("型が合わないと判定された")
	}
	want := `{"candidate_id":"c-1-2-3","area_ids":["` + a1 + `"],"ward":"中央区","wards":["東区","西区"],"cls":"uncertain","limit":7}`
	if got := jsonOf(t, args); got != want {
		t.Errorf("args = %s", got)
	}
}

// 偽の GeminiConfig の既定: キー以外が 0 でも、既定が入る。
func TestGeminiConfigDefaults(t *testing.T) {
	c, err := newGeminiClient(GeminiConfig{APIKey: config.Secret(testKey), Model: "gemini-3.5-flash-lite", BaseURL: "http://127.0.0.1:9/x/"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if c.endpoint != "http://127.0.0.1:9/x/gemini-3.5-flash-lite:generateContent" {
		t.Errorf("endpoint = %s", c.endpoint)
	}
}

func TestPositionWordsAboutCardsAreRemovedOrReplaced(t *testing.T) {
	// 方向の語だけ取り除く（文は残る）。「以上の」「以下の」は位置ではないので、そのまま
	for in, want := range map[string]string{
		"結果は下のカードのとおりです。":    "結果はカードのとおりです。",
		"一覧を上のカードに示しました。":    "一覧をカードに示しました。",
		"右のグラフと左の地図を見てください。": "グラフと地図を見てください。",
		"以上の表をご覧ください。":       "以上の表をご覧ください。",
		"以下の図は参考です。":         "以下の図は参考です。",
		"候補は全部で 4 件です。":      "候補は全部で 4 件です。",
		"判定保留は、目で確かめる候補です。":  "判定保留は、目で確かめる候補です。",
	} {
		f := newFakeGemini(t, countTwice(map[string]any{"cls": "confirmed_new"}), say(in))
		s, _ := geminiService(t, f, newFakeData())
		if r := mustAsk(t, s, "件数は？"); r.Content != want {
			t.Errorf("%q → %q（期待 %q）", in, r.Content, want)
		}
	}
	// 「上記」「下記」は、取り除くと文が崩れるので、安全なテンプレートに替える
	for _, in := range []string{"詳細は下記のとおりです。", "上記の件数を見てください。"} {
		f := newFakeGemini(t, countTwice(map[string]any{"cls": "confirmed_new"}), say(in))
		s, _ := geminiService(t, f, newFakeData())
		if r := mustAsk(t, s, "件数は？"); r.Content != SafeTemplate {
			t.Errorf("%q が通った: %q", in, r.Content)
		}
	}
}
