package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"townscan/api/internal/auth"
	"townscan/api/internal/chat"
	"townscan/api/internal/store"
)

// 会話の履歴（history.go と、chat.go の conversation_id）。偽の Authenticator・HistoryStore・Chatter で、
// 契約（contract/）から見えないことを確かめる: LLM を呼ぶ前に断ること・ログに ID・質問・題名を出さないこと・保存の失敗で回答を返さないこと。

const (
	secretID       = "sec-conv-id-0123456789"
	secretUser     = "sec_user_id_0042"
	secretQuestion = "秘密の質問の本文"
	secretAnswer   = "秘密の回答の本文"
)

type fakeHistory struct {
	// ConversationPrecheck の戻り
	exists      bool
	stored      int
	precheckErr error
	// SaveTurn・一覧・発言・削除の戻り
	saveErr error
	list    []store.ConversationSummary
	msgs    []store.StoredMessage
	found   bool
	deleted bool
	err     error // 一覧・発言・削除のエラー

	calls []string
	saved []store.Turn
	users []string
}

func (f *fakeHistory) ConversationPrecheck(_ context.Context, userID, _ string) (bool, int, error) {
	f.calls = append(f.calls, "precheck")
	f.users = append(f.users, userID)
	return f.exists, f.stored, f.precheckErr
}

func (f *fakeHistory) SaveTurn(_ context.Context, t store.Turn) error {
	f.calls = append(f.calls, "save")
	f.users = append(f.users, t.UserID)
	f.saved = append(f.saved, t)
	return f.saveErr
}

func (f *fakeHistory) ListConversations(_ context.Context, userID string) ([]store.ConversationSummary, error) {
	f.calls = append(f.calls, "list")
	f.users = append(f.users, userID)
	return f.list, f.err
}

func (f *fakeHistory) ConversationMessages(_ context.Context, userID, _ string) ([]store.StoredMessage, bool, error) {
	f.calls = append(f.calls, "messages")
	f.users = append(f.users, userID)
	return f.msgs, f.found, f.err
}

func (f *fakeHistory) DeleteConversation(_ context.Context, userID, _ string) (bool, error) {
	f.calls = append(f.calls, "delete")
	f.users = append(f.users, userID)
	return f.deleted, f.err
}

type historyRig struct {
	h    http.Handler
	fh   *fakeHistory
	fc   *fakeChat
	fa   *fakeAuth
	logs []string
}

// newHistoryRig は、ログイン済み（sub = secretUser）の構成。個々のテストが、fa・fh・fc を替える。
func newHistoryRig(t *testing.T) *historyRig {
	t.Helper()
	r := &historyRig{
		fh: &fakeHistory{exists: true, found: true, deleted: true},
		fc: &fakeChat{reply: okReply()},
		fa: &fakeAuth{identity: auth.Identity{Sub: secretUser}},
	}
	r.rebuild(r.fa)
	return r
}

func (r *historyRig) rebuild(a Authenticator) {
	d := Deps{Store: &fakeStore{}, LLMProvider: "mock", Chat: r.fc, History: r.fh,
		Logf: func(f string, args ...any) { r.logs = append(r.logs, fmt.Sprintf(f, args...)) }}
	if a != nil {
		d.Auth = a
	}
	r.h = New(d)
}

func (r *historyRig) do(method, path, body string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	r.h.ServeHTTP(rec, req)
	return rec
}

// chatBody は、質問 1 件と conversation_id の本文（JSON）。
func chatBody(content, convID string) string {
	return chatBodyOf([]chat.Message{{Role: "user", Content: content}}, &convID)
}

// chatBodyOf は、発言の並びと、conversation_id（nil なら付けない）の本文（JSON。NUL・改行も正しく逃がす）。
func chatBodyOf(msgs []chat.Message, convID *string) string {
	body := map[string]any{"messages": msgs}
	if convID != nil {
		body["conversation_id"] = *convID
	}
	b, err := json.Marshal(body)
	if err != nil {
		panic(err)
	}
	return string(b)
}

const validID = "5b0c9f0e-1111-2222-3333-444455556666"

func TestHistoryRoutesAreAbsentWithoutAHistoryStore(t *testing.T) {
	tt := newTester(t, &fakeStore{}) // History が nil
	rec := httptest.NewRecorder()
	tt.h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/conversations", nil))
	if rec.Code != 404 {
		t.Errorf("状態 = %d", rec.Code)
	}
}

func TestHistoryRoutesNeedALoginAndAlwaysSayNoStore(t *testing.T) {
	routes := []struct{ method, path string }{
		{"GET", "/api/conversations"},
		{"GET", "/api/conversations/" + validID + "/messages"},
		{"DELETE", "/api/conversations/" + validID},
	}
	cases := []struct {
		name   string
		header map[string]string
		fa     Authenticator
		status int
		code   string
	}{
		{"no header", nil, &fakeAuth{}, 401, "unauthorized"},
		{"not bearer", map[string]string{"Authorization": "Basic abc"}, &fakeAuth{}, 401, "unauthorized"},
		{"bad token", bearer("x"), &fakeAuth{err: auth.ErrInvalidToken}, 401, "unauthorized"},
		{"jwks down", bearer("x"), &fakeAuth{err: auth.ErrUnavailable}, 503, "unavailable"},
		{"not configured", bearer("x"), nil, 503, "unavailable"},
	}
	for _, route := range routes {
		for _, c := range cases {
			t.Run(route.method+" "+c.name, func(t *testing.T) {
				rig := newHistoryRig(t)
				rig.rebuild(c.fa)
				rec := rig.do(route.method, route.path, "", c.header)
				if rec.Code != c.status || !strings.Contains(rec.Body.String(), `"code":"`+c.code+`"`) {
					t.Errorf("%d %s", rec.Code, rec.Body)
				}
				if got := rec.Header().Get("Cache-Control"); got != "no-store" {
					t.Errorf("Cache-Control = %q", got)
				}
				if len(rig.fh.calls) != 0 {
					t.Errorf("ログインできないのに DB に触れた: %v", rig.fh.calls)
				}
			})
		}
	}
}

func TestHistoryLoginComesBeforeTheShapeOfTheID(t *testing.T) {
	rig := newHistoryRig(t)
	// 未ログインなら、形が不正な ID でも 401（形が正しいかも分からせない）
	rec := rig.do("GET", "/api/conversations/a:b/messages", "", nil)
	if rec.Code != 401 {
		t.Errorf("未ログイン: %d %s", rec.Code, rec.Body)
	}
	// ログイン中なら 422（path.conversation_id）。no-store つき。DB には触れない
	for _, c := range []struct{ method, path string }{
		{"GET", "/api/conversations/a:b/messages"},
		{"DELETE", "/api/conversations/" + strings.Repeat("a", 129)},
	} {
		rec := rig.do(c.method, c.path, "", bearer("t"))
		if rec.Code != 422 || !strings.Contains(rec.Body.String(), `"loc":["path","conversation_id"]`) {
			t.Errorf("%s %s: %d %s", c.method, c.path, rec.Code, rec.Body)
		}
		if rec.Header().Get("Cache-Control") != "no-store" {
			t.Errorf("422 に no-store が無い")
		}
		if strings.Contains(rec.Body.String(), "a:b") {
			t.Errorf("入力値が応答に出ている: %s", rec.Body)
		}
	}
	if len(rig.fh.calls) != 0 {
		t.Errorf("DB に触れた: %v", rig.fh.calls)
	}
}

func TestListConversations(t *testing.T) {
	rig := newHistoryRig(t)
	rec := rig.do("GET", "/api/conversations", "", bearer("t"))
	if rec.Code != 200 || rec.Body.String() != `{"conversations":[]}` {
		t.Errorf("空: %d %s", rec.Code, rec.Body)
	}
	created := time.Date(2026, 11, 25, 1, 2, 3, 0, time.UTC)
	updated := time.Date(2026, 11, 25, 1, 5, 9, 123456000, time.FixedZone("JST", 9*3600))
	rig.fh.list = []store.ConversationSummary{{ID: validID, Title: "題名", CreatedAt: created, UpdatedAt: updated}}
	rec = rig.do("GET", "/api/conversations", "", bearer("t"))
	want := `{"conversations":[{"id":"` + validID + `","title":"題名","created_at":"2026-11-25T01:02:03+00:00","updated_at":"2026-11-24T16:05:09.123456+00:00"}]}`
	if rec.Body.String() != want {
		t.Errorf("本文 = %s\n期待 = %s", rec.Body, want)
	}
	if rec.Header().Get("Cache-Control") != "no-store" || rec.Header().Get("Content-Type") != "application/json" {
		t.Errorf("ヘッダー = %v", rec.Header())
	}
	// 利用者は、JWT の sub だけから決まる
	if len(rig.fh.users) == 0 || rig.fh.users[len(rig.fh.users)-1] != secretUser {
		t.Errorf("利用者 = %v", rig.fh.users)
	}
}

func TestConversationMessages(t *testing.T) {
	rig := newHistoryRig(t)
	run := time.Date(2026, 11, 24, 3, 0, 0, 0, time.UTC)
	rig.fh.msgs = []store.StoredMessage{
		{Role: "user", Content: "質問"},
		{Role: "assistant", Content: "答え", Results: []byte(`[{"type":"count",  "n": 5.0}]`), ToolCalls: []byte(`[]`), RunCreatedAt: &run},
		{Role: "user", Content: "続き"},
		{Role: "assistant", Content: "答え 2", Results: []byte(`[]`), ToolCalls: []byte(`[]`)},
	}
	rec := rig.do("GET", "/api/conversations/"+validID+"/messages", "", bearer("t"))
	want := `{"messages":[{"role":"user","content":"質問"},` +
		`{"role":"assistant","content":"答え","results":[{"type":"count","n":5.0}],"tool_calls":[],"run_created_at":"2026-11-24T03:00:00+00:00"},` +
		`{"role":"user","content":"続き"},` +
		`{"role":"assistant","content":"答え 2","results":[],"tool_calls":[],"run_created_at":null}]}`
	if rec.Code != 200 || rec.Body.String() != want {
		t.Errorf("%d\n本文 = %s\n期待 = %s", rec.Code, rec.Body, want)
	}
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Error("no-store が無い")
	}
}

func TestMissingAndOthersConversationsAre404WithTheSameBody(t *testing.T) {
	rig := newHistoryRig(t)
	rig.fh.found, rig.fh.deleted = false, false
	var bodies []string
	for _, c := range []struct{ method, path string }{
		{"GET", "/api/conversations/" + validID + "/messages"},
		{"DELETE", "/api/conversations/" + validID},
	} {
		rec := rig.do(c.method, c.path, "", bearer("t"))
		if rec.Code != 404 || rec.Header().Get("Cache-Control") != "no-store" {
			t.Errorf("%s: %d %v", c.method, rec.Code, rec.Header())
		}
		bodies = append(bodies, rec.Body.String())
	}
	want := `{"error":{"code":"not_found","message":"会話が見つかりません"}}`
	if bodies[0] != want || bodies[1] != want {
		t.Errorf("本文 = %v", bodies)
	}
}

func TestDeleteConversationIs204WithoutABody(t *testing.T) {
	rig := newHistoryRig(t)
	rec := rig.do("DELETE", "/api/conversations/"+validID, "", bearer("t"))
	if rec.Code != 204 || rec.Body.Len() != 0 || rec.Header().Get("Cache-Control") != "no-store" {
		t.Errorf("%d %q %v", rec.Code, rec.Body, rec.Header())
	}
}

func TestHistoryDBFailuresAre503Or500WithoutDetails(t *testing.T) {
	for _, c := range []struct {
		err    error
		status int
		code   string
	}{
		{fmt.Errorf("dial tcp 10.0.0.9:5432: %w", store.ErrUnavailable), 503, "db_unavailable"},
		{errors.New("relation \"conversations\" does not exist"), 500, "internal_error"},
	} {
		rig := newHistoryRig(t)
		rig.fh.err = c.err
		for _, route := range []struct{ method, path string }{
			{"GET", "/api/conversations"}, {"GET", "/api/conversations/" + validID + "/messages"}, {"DELETE", "/api/conversations/" + validID},
		} {
			rec := rig.do(route.method, route.path, "", bearer("t"))
			if rec.Code != c.status || !strings.Contains(rec.Body.String(), `"code":"`+c.code+`"`) || rec.Header().Get("Cache-Control") != "no-store" {
				t.Errorf("%s %s: %d %s", route.method, route.path, rec.Code, rec.Body)
			}
			for _, leaked := range []string{"10.0.0.9", "conversations", "dial tcp"} {
				if strings.Contains(rec.Body.String(), leaked) {
					t.Errorf("%q が応答に出ている: %s", leaked, rec.Body)
				}
			}
		}
	}
}

// ---- POST /api/chat の conversation_id ----

func TestChatWithoutAConversationIDDoesNotLookAtTheLoginOrTheHistory(t *testing.T) {
	for _, body := range []string{
		`{"messages":[{"role":"user","content":"質問"}]}`,
		`{"messages":[{"role":"user","content":"質問"}],"conversation_id":null}`,
	} {
		rig := newHistoryRig(t)
		rig.fa.err = auth.ErrInvalidToken // ログインが壊れていても、無関係
		rec := rig.do("POST", "/api/chat", body, map[string]string{"Authorization": "Bearer broken"})
		if rec.Code != 200 || rig.fc.calls != 1 {
			t.Errorf("%s: %d 回答 %d 回", body, rec.Code, rig.fc.calls)
		}
		if len(rig.fa.tokens) != 0 || len(rig.fh.calls) != 0 {
			t.Errorf("ログイン・履歴に触れた: %v %v", rig.fa.tokens, rig.fh.calls)
		}
		if rec.Header().Get("Cache-Control") != "" {
			t.Errorf("chat に Cache-Control を付けない: %q", rec.Header().Get("Cache-Control"))
		}
	}
}

func TestChatRefusesBeforeCallingTheLLM(t *testing.T) {
	cases := []struct {
		name    string
		body    string
		setup   func(r *historyRig)
		header  map[string]string
		status  int
		contain string
	}{
		{"malformed id", chatBody("質問", "a:b"), nil, bearer("t"), 422, `"loc":["body","conversation_id"]`},
		{"empty id", chatBody("質問", ""), nil, bearer("t"), 422, `"loc":["body","conversation_id"]`},
		{"numeric id", `{"messages":[{"role":"user","content":"質問"}],"conversation_id":5}`, nil, bearer("t"), 422, `"loc":["body","conversation_id"]`},
		{"NUL", chatBody("候補は\u0000何件", validID), nil, bearer("t"), 422, `"loc":["body","messages","0","content"]`},
		{"NUL even when logged out", chatBody("候補は\u0000何件", validID), nil, nil, 422, `"loc":["body","messages","0","content"]`},
		{"logged out", chatBody("質問", validID), nil, nil, 401, `"code":"unauthorized"`},
		{"user row missing", chatBody("質問", validID), func(r *historyRig) { r.fh.exists = false }, bearer("t"), 401, `"code":"unauthorized"`},
		{"conversation full", chatBody("質問", validID), func(r *historyRig) { r.fh.stored = 499 }, bearer("t"), 422, `"code":"conversation_full"`},
		{"db down at the precheck", chatBody("質問", validID), func(r *historyRig) { r.fh.precheckErr = store.ErrUnavailable }, bearer("t"), 503, `"code":"db_unavailable"`},
		{"unexpected db error at the precheck", chatBody("質問", validID), func(r *historyRig) { r.fh.precheckErr = errors.New("boom") }, bearer("t"), 500, `"code":"internal_error"`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rig := newHistoryRig(t)
			if c.setup != nil {
				c.setup(rig)
			}
			rec := rig.do("POST", "/api/chat", c.body, c.header)
			if rec.Code != c.status || !strings.Contains(rec.Body.String(), c.contain) {
				t.Errorf("%d %s", rec.Code, rec.Body)
			}
			if strings.Contains(rec.Body.String(), `"message":{`) {
				t.Errorf("回答が返っている: %s", rec.Body)
			}
			if rig.fc.calls != 0 {
				t.Errorf("LLM（Chatter）を %d 回呼んだ。断る検査は、呼ぶ前に済ませる", rig.fc.calls)
			}
			for _, call := range rig.fh.calls {
				if call == "save" {
					t.Errorf("保存した: %v", rig.fh.calls)
				}
			}
		})
	}
}

func TestChatSavesTheRoundTripAndKeepsTheAnswerTheSame(t *testing.T) {
	run := time.Date(2026, 11, 24, 3, 0, 0, 0, time.UTC)
	rig := newHistoryRig(t)
	rig.fc.reply = chat.Reply{Role: "assistant", Content: "答えです。", Results: []chat.Result{}, ToolCalls: []chat.Call{{Name: "show_help", Args: chat.Args{}}}, RunCreatedAt: &run}
	body := `{"messages":[{"role":"user","content":"前の質問"},{"role":"assistant","content":"前の答え"},{"role":"user","content":"  新しい\n　質問  "}],"conversation_id":"` + validID + `"}`
	rec := rig.do("POST", "/api/chat", body, bearer("t"))
	plain := rig.do("POST", "/api/chat", strings.Replace(body, `,"conversation_id":"`+validID+`"`, "", 1), nil)
	if rec.Code != 200 || rec.Body.String() != plain.Body.String() {
		t.Errorf("conversation_id の有無で応答が変わる:\n%s\n%s", rec.Body, plain.Body)
	}
	if len(rig.fh.saved) != 1 {
		t.Fatalf("保存 %d 回", len(rig.fh.saved))
	}
	got := rig.fh.saved[0]
	if got.UserID != secretUser || got.ConversationID != validID {
		t.Errorf("持ち主・ID = %q %q", got.UserID, got.ConversationID)
	}
	// 保存するのは、この 1 往復だけ。質問は送った文字列のまま、題名は空白をまとめたもの
	if got.Question != "  新しい\n　質問  " || got.Title != "新しい 質問" || got.Answer != "答えです。" {
		t.Errorf("保存 = %+v", got)
	}
	if string(got.Results) != `[]` || string(got.ToolCalls) != `[{"name":"show_help","args":{}}]` {
		t.Errorf("results = %s, tool_calls = %s", got.Results, got.ToolCalls)
	}
	if got.RunCreatedAt == nil || !got.RunCreatedAt.Equal(run) {
		t.Errorf("run_created_at = %v", got.RunCreatedAt)
	}
	// 文脈は、要求の messages から（保存した発言から組み直さない）
	if len(rig.fc.got) != 3 {
		t.Errorf("Chatter に渡した発言 = %d 件", len(rig.fc.got))
	}
}

func TestChatDoesNotReturnTheAnswerWhenSavingFails(t *testing.T) {
	for _, c := range []struct {
		name    string
		err     error
		status  int
		contain string
	}{
		{"db down", fmt.Errorf("x: %w", store.ErrUnavailable), 503, `"code":"db_unavailable"`},
		{"unexpected", errors.New("check violation"), 500, `"code":"internal_error"`},
		{"user vanished", store.ErrConversationUserMissing, 401, `"code":"unauthorized"`},
		{"full", store.ErrConversationFull, 422, `"code":"conversation_full"`},
	} {
		t.Run(c.name, func(t *testing.T) {
			rig := newHistoryRig(t)
			rig.fh.saveErr = c.err
			rec := rig.do("POST", "/api/chat", chatBody(secretQuestion, validID), bearer("t"))
			if rec.Code != c.status || !strings.Contains(rec.Body.String(), c.contain) {
				t.Errorf("%d %s", rec.Code, rec.Body)
			}
			if strings.Contains(rec.Body.String(), "答えです") || strings.Contains(rec.Body.String(), `"message":{`) {
				t.Errorf("保存に失敗したのに、回答が返っている: %s", rec.Body)
			}
		})
	}
}

func TestChatSkipsTheHistoryWhenTheLLMFails(t *testing.T) {
	rig := newHistoryRig(t)
	rig.fc.err = &chat.LLMError{}
	rec := rig.do("POST", "/api/chat", chatBody("質問", validID), bearer("t"))
	if rec.Code != 502 {
		t.Errorf("%d %s", rec.Code, rec.Body)
	}
	for _, call := range rig.fh.calls {
		if call == "save" {
			t.Error("失敗した往復を保存した")
		}
	}
}

// 質問・回答・題名・会話 ID・利用者 ID は、ログに出さない（失敗の種類だけを出す）。
func TestHistoryNeverWritesSecretsToTheLog(t *testing.T) {
	scenarios := []func(r *historyRig) *httptest.ResponseRecorder{
		func(r *historyRig) *httptest.ResponseRecorder { // 成功
			return r.do("POST", "/api/chat", chatBody(secretQuestion, secretID), bearer("t"))
		},
		func(r *historyRig) *httptest.ResponseRecorder { // 保存の失敗（DB に届かない）
			r.fh.saveErr = fmt.Errorf("%s %s: %w", secretID, secretQuestion, store.ErrUnavailable)
			return r.do("POST", "/api/chat", chatBody(secretQuestion, secretID), bearer("t"))
		},
		func(r *historyRig) *httptest.ResponseRecorder { // 想定外のエラー
			r.fh.saveErr = errors.New(secretID + " " + secretAnswer + " " + secretUser)
			return r.do("POST", "/api/chat", chatBody(secretQuestion, secretID), bearer("t"))
		},
		func(r *historyRig) *httptest.ResponseRecorder { // 3 本の読み書きの失敗
			r.fh.err = errors.New(secretID + " " + secretUser)
			r.do("GET", "/api/conversations", "", bearer("t"))
			r.do("DELETE", "/api/conversations/"+secretID, "", bearer("t"))
			return r.do("GET", "/api/conversations/"+secretID+"/messages", "", bearer("t"))
		},
		func(r *historyRig) *httptest.ResponseRecorder { // ログインの失敗
			r.fa.err = auth.ErrInvalidToken
			return r.do("GET", "/api/conversations/"+secretID+"/messages", "", bearer(secretUser))
		},
	}
	for i, run := range scenarios {
		rig := newHistoryRig(t)
		rec := run(rig)
		all := strings.Join(rig.logs, "\n") + "\n" + rec.Body.String()
		for _, s := range []string{secretID, secretUser, secretQuestion, secretAnswer} {
			if strings.Contains(all, s) {
				t.Errorf("場面 %d: %q がログか応答に出ている:\n%s", i, s, all)
			}
		}
	}
}
