package handlers

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"townscan/api/internal/chat"
	"townscan/api/internal/store"
)

// POST /api/chat の本文の検証・応答の形・エラーの対応（chat.go）。チャット 1 往復そのものは chat のテストが見る。ここでは偽の Chatter を使う。

type fakeChat struct {
	got   []chat.Message
	calls int
	reply chat.Reply
	err   error
}

func (f *fakeChat) Answer(_ context.Context, msgs []chat.Message) (chat.Reply, error) {
	f.calls++
	f.got = msgs
	return f.reply, f.err
}

func chatTester(t *testing.T, fc *fakeChat) *tester {
	t.Helper()
	tt := newTester(t, &fakeStore{})
	tt.h = New(Deps{Store: tt.fake, LLMProvider: "mock", Chat: fc, Logf: func(f string, a ...any) { tt.logs = append(tt.logs, f) }})
	return tt
}

func (tt *tester) post(body, contentType string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/api/chat", strings.NewReader(body))
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	rec := httptest.NewRecorder()
	tt.h.ServeHTTP(rec, req)
	return rec
}

func okReply() chat.Reply {
	return chat.Reply{Role: "assistant", Content: "答えです。", Results: []chat.Result{}, ToolCalls: []chat.Call{{Name: "show_help", Args: chat.Args{}}}}
}

func TestChatRouteExistsOnlyWithAChatter(t *testing.T) {
	tt := newTester(t, &fakeStore{}) // Chat が nil
	tt.wantJSON(tt.post(`{"messages":[{"role":"user","content":"x"}]}`, jsonCT), 404, jsonCT, `{"error":{"code":"not_found","message":"見つかりません"}}`)
	fc := &fakeChat{reply: okReply()}
	tt = chatTester(t, fc)
	if rec := tt.post(`{"messages":[{"role":"user","content":"x"}]}`, jsonCT); rec.Code != 200 {
		t.Errorf("状態 = %d: %s", rec.Code, rec.Body)
	}
	// POST だけ（GET などは 405）
	for _, m := range []string{http.MethodGet, http.MethodPut, http.MethodDelete, http.MethodPatch} {
		rec := httptest.NewRecorder()
		tt.h.ServeHTTP(rec, httptest.NewRequest(m, "/api/chat", nil))
		if rec.Code != 405 || !strings.Contains(rec.Body.String(), `"method_not_allowed"`) {
			t.Errorf("%s: %d %s", m, rec.Code, rec.Body)
		}
	}
}

func TestChatReturnsTheReplyUnderMessage(t *testing.T) {
	fc := &fakeChat{reply: okReply()}
	tt := chatTester(t, fc)
	rec := tt.post(`{"messages":[{"role":"user","content":"使い方は？"}]}`, jsonCT)
	tt.wantJSON(rec, 200, jsonCT, `{"message":{"role":"assistant","content":"答えです。","results":[],"tool_calls":[{"name":"show_help","args":{}}]}}`)
	if len(fc.got) != 1 || fc.got[0] != (chat.Message{Role: "user", Content: "使い方は？"}) {
		t.Errorf("渡した会話 = %+v", fc.got)
	}
	// application/json の別の書き方・文字コードの指定・大文字小文字
	for _, ct := range []string{"application/json; charset=utf-8", "Application/JSON", "application/vnd.api+json"} {
		if rec := tt.post(`{"messages":[{"role":"user","content":"x"}]}`, ct); rec.Code != 200 {
			t.Errorf("%s: %d", ct, rec.Code)
		}
	}
	// クライアントが付ける余分な項目は、無視する（会話は role と content だけ）
	rec = tt.post(`{"messages":[{"role":"user","content":"候補は？","id":1},{"role":"assistant","content":"9 件","results":[{"type":"count"}],"tool_calls":[]},{"role":"user","content":"では"}],"x":1}`, jsonCT)
	if rec.Code != 200 || len(fc.got) != 3 || fc.got[1] != (chat.Message{Role: "assistant", Content: "9 件"}) {
		t.Errorf("余分な項目: %d %+v", rec.Code, fc.got)
	}
}

func validation(msg string, loc ...string) string {
	locs := `"` + strings.Join(loc, `","`) + `"`
	return `{"error":{"code":"validation_error","message":"引数が不正です（` + strings.Join(loc, ".") + `）","details":[{"loc":[` + locs + `],"msg":"` + msg + `"}]}}`
}

func TestChatBodyValidationMatchesPydantic(t *testing.T) {
	user := func(c string) string { return `{"role":"user","content":"` + c + `"}` }
	long := strings.Repeat("あ", 2001)
	cases := []struct {
		name, body, ct string
		want           string
	}{
		{"本文が無い", ``, jsonCT, validation("Field required", "body")},
		{"JSON でない Content-Type", `{"messages":[` + user("x") + `]}`, "text/plain", validation("Input should be a valid dictionary or object to extract fields from", "body")},
		{"Content-Type が無い", `{"messages":[` + user("x") + `]}`, "", validation("Input should be a valid dictionary or object to extract fields from", "body")},
		{"オブジェクトでない（配列）", `["x"]`, jsonCT, validation("Input should be a valid dictionary or object to extract fields from", "body")},
		{"オブジェクトでない（null）", `null`, jsonCT, validation("Input should be a valid dictionary or object to extract fields from", "body")},
		{"オブジェクトでない（文字列）", `"x"`, jsonCT, validation("Input should be a valid dictionary or object to extract fields from", "body")},
		{"messages が無い", `{}`, jsonCT, validation("Field required", "body", "messages")},
		{"messages が配列でない", `{"messages":"x"}`, jsonCT, validation("Input should be a valid list", "body", "messages")},
		{"messages が null", `{"messages":null}`, jsonCT, validation("Input should be a valid list", "body", "messages")},
		{"messages が空", `{"messages":[]}`, jsonCT, validation("List should have at least 1 item after validation, not 0", "body", "messages")},
		{"要素がオブジェクトでない", `{"messages":[null]}`, jsonCT, validation("Input should be a valid dictionary or object to extract fields from", "body", "messages", "0")},
		{"role が無い", `{"messages":[{"content":"x"}]}`, jsonCT, validation("Field required", "body", "messages", "0", "role")},
		{"role が違う", `{"messages":[{"role":"system","content":"x"}]}`, jsonCT, validation("Input should be 'user' or 'assistant'", "body", "messages", "0", "role")},
		{"role が文字列でない", `{"messages":[{"role":5,"content":"x"}]}`, jsonCT, validation("Input should be 'user' or 'assistant'", "body", "messages", "0", "role")},
		{"content が無い", `{"messages":[{"role":"user"}]}`, jsonCT, validation("Field required", "body", "messages", "0", "content")},
		{"content が文字列でない", `{"messages":[{"role":"user","content":5}]}`, jsonCT, validation("Input should be a valid string", "body", "messages", "0", "content")},
		{"content が null", `{"messages":[{"role":"user","content":null}]}`, jsonCT, validation("Input should be a valid string", "body", "messages", "0", "content")},
		{"content が 2001 文字", `{"messages":[` + user(long) + `]}`, jsonCT, validation("String should have at most 2000 characters", "body", "messages", "0", "content")},
		{"2 件目の誤り（位置は 1）", `{"messages":[` + user("x") + `,{"role":"user"}]}`, jsonCT, validation("Field required", "body", "messages", "1", "content")},
	}
	for _, c := range cases {
		fc := &fakeChat{reply: okReply()}
		tt := chatTester(t, fc)
		tt.wantJSON(tt.post(c.body, c.ct), 422, jsonCT, c.want)
		if fc.calls != 0 {
			t.Errorf("%s: 検証に落ちたのに、チャットを呼んだ", c.name)
		}
	}
}

// 壊れた JSON は 422（loc は ["body", 位置]・msg は "JSON decode error"）。位置は Python（json.loads）の値。入力の文字は応答に出さない。
func TestChatBrokenJSONIs422(t *testing.T) {
	for body, pos := range map[string]string{`not json`: "0", `{"messages":`: "12", `{"messages":[}`: "13", `{'messages': []}`: "1", `{"messages":[]}x`: "15"} {
		tt := chatTester(t, &fakeChat{reply: okReply()})
		tt.wantJSON(tt.post(body, jsonCT), 422, jsonCT, `{"error":{"code":"validation_error","message":"引数が不正です（body.`+pos+`）","details":[{"loc":["body","`+pos+`"],"msg":"JSON decode error"}]}}`)
	}
}

// 誤りは、見つかった順にすべて返す（Pydantic と同じ）。
func TestChatReportsEveryInvalidMessage(t *testing.T) {
	tt := chatTester(t, &fakeChat{reply: okReply()})
	rec := tt.post(`{"messages":[{"role":"x","content":5},{"role":"user"},7]}`, jsonCT)
	want := `{"error":{"code":"validation_error","message":"引数が不正です（body.messages.0.role）","details":[` +
		`{"loc":["body","messages","0","role"],"msg":"Input should be 'user' or 'assistant'"},` +
		`{"loc":["body","messages","0","content"],"msg":"Input should be a valid string"},` +
		`{"loc":["body","messages","1","content"],"msg":"Field required"},` +
		`{"loc":["body","messages","2"],"msg":"Input should be a valid dictionary or object to extract fields from"}]}}`
	tt.wantJSON(rec, 422, jsonCT, want)
}

// 文字数の上限は、文字（コードポイント）で数える。バイト数ではない。件数は 500 まで。
func TestChatLimits(t *testing.T) {
	fc := &fakeChat{reply: okReply()}
	tt := chatTester(t, fc)
	msg := func(n int) string {
		return `{"messages":[{"role":"user","content":"` + strings.Repeat("あ", n) + `"}]}`
	}
	if rec := tt.post(msg(2000), jsonCT); rec.Code != 200 { // 2000 文字（6000 バイト）は通る
		t.Errorf("2000 文字: %d %s", rec.Code, rec.Body)
	}
	if rec := tt.post(msg(2001), jsonCT); rec.Code != 422 {
		t.Errorf("2001 文字: %d", rec.Code)
	}
	// 絵文字（1 文字 = 4 バイト、UTF-16 では 2 単位）も 1 文字
	if rec := tt.post(`{"messages":[{"role":"user","content":"`+strings.Repeat("😀", 2000)+`"}]}`, jsonCT); rec.Code != 200 {
		t.Errorf("絵文字 2000 文字: %d", rec.Code)
	}
	if rec := tt.post(`{"messages":[{"role":"user","content":"`+strings.Repeat("😀", 2001)+`"}]}`, jsonCT); rec.Code != 422 {
		t.Errorf("絵文字 2001 文字: %d", rec.Code)
	}
	many := func(n int) string {
		return `{"messages":[` + strings.TrimSuffix(strings.Repeat(`{"role":"user","content":"候補は何件？"},`, n), ",") + `]}`
	}
	if rec := tt.post(many(500), jsonCT); rec.Code != 200 || len(fc.got) != 500 {
		t.Errorf("500 件: %d（渡した件数 %d）", rec.Code, len(fc.got))
	}
	// 501 件: 件数のエラーだけ（最後の規則・個々の誤りは見ない）
	rec := tt.post(many(501), jsonCT)
	tt.wantJSON(rec, 422, jsonCT, validation("List should have at most 500 items after validation, not 501", "body", "messages"))
	tt.wantJSON(tt.post(`{"messages":[`+strings.TrimSuffix(strings.Repeat(`{"role":"bad"},`, 501), ",")+`]}`, jsonCT), 422, jsonCT,
		validation("List should have at most 500 items after validation, not 501", "body", "messages"))
}

// 形は合っているが、最後のメッセージが規則に合わない: detail は付かず、message は固定の文。
func TestChatLastMessageMustBeANonEmptyUserMessage(t *testing.T) {
	const want = `{"error":{"code":"validation_error","message":"最後のメッセージは、空でない user のメッセージである必要があります"}}`
	for _, body := range []string{
		`{"messages":[{"role":"assistant","content":"x"}]}`,
		`{"messages":[{"role":"user","content":"候補は？"},{"role":"assistant","content":"9 件です"}]}`,
		`{"messages":[{"role":"user","content":"   "}]}`,
		`{"messages":[{"role":"user","content":""}]}`,
		`{"messages":[{"role":"user","content":"　\n\t"}]}`,
		`{"messages":[{"role":"user","content":"\u001c\u0085  "}]}`, // Python の strip() が空白と見る文字
	} {
		fc := &fakeChat{reply: okReply()}
		tt := chatTester(t, fc)
		tt.wantJSON(tt.post(body, jsonCT), 422, jsonCT, want)
		if fc.calls != 0 {
			t.Errorf("%s: チャットを呼んだ", body)
		}
	}
	// 空白だけでない最後の user は通る・途中が空でも通る
	for _, body := range []string{
		`{"messages":[{"role":"user","content":" x "}]}`,
		`{"messages":[{"role":"user","content":""},{"role":"assistant","content":""},{"role":"user","content":"x"}]}`,
		`{"messages":[{"role":"user","content":"​"}]}`, // ゼロ幅の空白は、Python の strip() では空白でない
	} {
		tt := chatTester(t, &fakeChat{reply: okReply()})
		if rec := tt.post(body, jsonCT); rec.Code != 200 {
			t.Errorf("%s: %d %s", body, rec.Code, rec.Body)
		}
	}
}

// 本文の検証は、DB より先（Python も、本文の検証は、DB を使う処理の前）。DB に触らない。
func TestChatValidationDoesNotTouchTheDatabase(t *testing.T) {
	tt := chatTester(t, &fakeChat{reply: okReply()})
	tt.post(`{"messages":[]}`, jsonCT)
	tt.post(`not json`, jsonCT)
	if len(tt.fake.calls) != 0 {
		t.Errorf("DB への問い合わせ: %v", tt.fake.calls)
	}
}

// チャットの失敗は、DB に届かなければ 503（db_unavailable）、それ以外は 500（原因は載せない）。クライアントが切ったときは、何も書かない。
func TestChatErrorsMapToStatusCodes(t *testing.T) {
	post := func(err error) (*tester, *httptest.ResponseRecorder) {
		tt := chatTester(t, &fakeChat{err: err})
		return tt, tt.post(`{"messages":[{"role":"user","content":"x"}]}`, jsonCT)
	}
	tt, rec := post(errors.Join(store.ErrUnavailable))
	tt.wantJSON(rec, 503, jsonCT, `{"error":{"code":"db_unavailable","message":"データベースに接続できません。しばらくしてから再試行してください"}}`)

	secret := "pw-secret-marker"
	tt, rec = post(errors.New("評価ファイルを読めません: " + secret))
	tt.wantJSON(rec, 500, jsonCT, `{"error":{"code":"internal_error","message":"サーバー内部のエラーです"}}`)
	if strings.Contains(rec.Body.String(), secret) || strings.Contains(tt.logText(), secret) {
		t.Errorf("エラーの文が、応答かログに出ている: %s / %s", rec.Body, tt.logText())
	}

	_, rec = post(context.Canceled)
	if rec.Body.Len() != 0 {
		t.Errorf("クライアントが切ったときは書かない: %s", rec.Body)
	}
}

// 結果が空でも null にしない（Results・ToolCalls は常に配列）。応答に、本文・結果を超えるものを載せない。
func TestChatReplyKeepsTheKeyOrder(t *testing.T) {
	fc := &fakeChat{reply: chat.Reply{Role: "assistant", Content: "あ", Results: []chat.Result{chat.RefusalResult{Type: "refusal", Reason: "no_data", Message: "m", Suggestions: []string{}}},
		ToolCalls: []chat.Call{{Name: "refuse", Args: chat.Args{Reason: "no_data"}}}}}
	tt := chatTester(t, fc)
	tt.wantJSON(tt.post(`{"messages":[{"role":"user","content":"x"}]}`, jsonCT), 200, jsonCT,
		`{"message":{"role":"assistant","content":"あ","results":[{"type":"refusal","reason":"no_data","message":"m","suggestions":[]}],"tool_calls":[{"name":"refuse","args":{"reason":"no_data"}}]}}`)
}
