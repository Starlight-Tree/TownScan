package handlers

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"townscan/api/internal/chat"
)

// 実 LLM（Gemini）が使えないとき: 502（llm_unavailable）。模擬には切り替えない。応答にもログにも、失敗の種類・HTTP の状態・理由の定数だけ。

const llmUnavailableBody = `{"error":{"code":"llm_unavailable","message":"いまは LLM が応答できません。少し待ってからもう一度お試しください"}}`

// llmTester は、整形したあとのログを覚えるテスター（chatTester は、整形前の書式だけを覚える）。
func llmTester(t *testing.T, fc *fakeChat) (*tester, func() string) {
	t.Helper()
	tt := newTester(t, &fakeStore{})
	var logs []string
	tt.h = New(Deps{Store: tt.fake, LLMProvider: "gemini", GeminiModel: "gemini-test", Chat: fc, Logf: func(f string, a ...any) { logs = append(logs, fmt.Sprintf(f, a...)) }})
	return tt, func() string { return strings.Join(logs, "\n") }
}

func TestChatLLMFailureIsA502WithAFixedBody(t *testing.T) {
	for _, c := range []struct {
		name string
		err  error
		log  string
	}{
		{"429", &chat.LLMError{Kind: "rate_limit", Status: 429, Reason: "RESOURCE_EXHAUSTED"}, "種別=rate_limit HTTP=429 理由=RESOURCE_EXHAUSTED"},
		{"種別だけ", &chat.LLMError{Kind: "no_tool_call"}, "種別=no_tool_call HTTP=None 理由=None"},
		{"期限", &chat.LLMError{Kind: "deadline"}, "種別=deadline HTTP=None 理由=None"},
		{"包まれていても", fmt.Errorf("包み: %w", &chat.LLMError{Kind: "server", Status: 503, Reason: "UNAVAILABLE"}), "種別=server HTTP=503 理由=UNAVAILABLE"},
	} {
		t.Run(c.name, func(t *testing.T) {
			tt, logText := llmTester(t, &fakeChat{err: c.err})
			rec := tt.post(`{"messages":[{"role":"user","content":"新規出現は何件？秘密の質問"}]}`, jsonCT)
			tt.wantJSON(rec, 502, jsonCT, llmUnavailableBody)
			if !strings.Contains(logText(), "LLM が応答できませんでした: "+c.log) {
				t.Errorf("ログ = %s", logText())
			}
			// 質問の本文・エラーの文は、ログにも応答にも出ない
			for _, out := range []string{rec.Body.String(), logText()} {
				if strings.Contains(out, "秘密の質問") || strings.Contains(out, "包み") {
					t.Errorf("本文・エラーの文が出ている: %s", out)
				}
			}
		})
	}
}

// LLM の失敗でないエラー（DB など）は、これまでどおり 503・500。
func TestChatNonLLMErrorsAreNotA502(t *testing.T) {
	tt := chatTester(t, &fakeChat{err: errors.New("評価ファイルを読めません")})
	rec := tt.post(`{"messages":[{"role":"user","content":"x"}]}`, jsonCT)
	tt.wantJSON(rec, 500, jsonCT, `{"error":{"code":"internal_error","message":"サーバー内部のエラーです"}}`)
}

// 本文の長さの上限は、正規化（NFKC）の前と後の、両方で数える。NFKC は、1 文字を最大 18 文字に伸ばす（「ﷺ」）。
func TestChatContentLimitIsCountedAfterNormalizationToo(t *testing.T) {
	msg := func(s string) string { return `{"messages":[{"role":"user","content":"` + s + `"}]}` }
	over := validation("String should have at most 2000 characters", "body", "messages", "0", "content")
	for _, c := range []struct {
		name, content string
		ok            bool
	}{
		{"ﷺ 111 字（正規化で 1998 字）", strings.Repeat("ﷺ", 111), true},
		{"ﷺ 112 字（正規化で 2016 字）", strings.Repeat("ﷺ", 112), false},
		{"ﷺ 2000 字（正規化の前は上限ちょうど）", strings.Repeat("ﷺ", 2000), false},
		{"㌀ 500 字（正規化で 2000 字）", strings.Repeat("㌀", 500), true},
		{"㌀ 501 字（正規化で 2004 字）", strings.Repeat("㌀", 501), false},
		{"全角の数字 2000 字（正規化で同じ長さ）", strings.Repeat("１", 2000), true},
		{"正規化の前が 2001 字（これまでどおり）", strings.Repeat("a", 2001), false},
	} {
		fc := &fakeChat{reply: okReply()}
		tt := chatTester(t, fc)
		rec := tt.post(msg(c.content), jsonCT)
		if c.ok && (rec.Code != 200 || fc.calls != 1) {
			t.Errorf("%s: %d %s", c.name, rec.Code, rec.Body)
		}
		if !c.ok {
			tt.wantJSON(rec, 422, jsonCT, over)
			if fc.calls != 0 {
				t.Errorf("%s: 検証に落ちたのに、チャットを呼んだ", c.name)
			}
		}
	}
	// assistant の発言も同じ（frontend は、前の返答を、そのまま履歴に入れて送り返す）
	tt := chatTester(t, &fakeChat{reply: okReply()})
	body := `{"messages":[{"role":"user","content":"x"},{"role":"assistant","content":"` + strings.Repeat("ﷺ", 112) + `"},{"role":"user","content":"y"}]}`
	tt.wantJSON(tt.post(body, jsonCT), 422, jsonCT, validation("String should have at most 2000 characters", "body", "messages", "1", "content"))
}
