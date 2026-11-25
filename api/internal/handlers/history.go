package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"townscan/api/internal/apierr"
	"townscan/api/internal/chat"
	"townscan/api/internal/httpx"
	"townscan/api/internal/pyjson"
	"townscan/api/internal/store"
)

// 会話の履歴（ログイン中だけ。仕様 docs/spec-prototype.md §2.3・§4.4、ADR 0006）。
//
//	GET    /api/conversations                              本人の会話の一覧（更新が新しい順・最大 50 件）
//	GET    /api/conversations/{conversation_id}/messages   会話の発言（古い順）
//	DELETE /api/conversations/{conversation_id}            会話を 1 件消す（204）
//
// 3 本とも Authorization: Bearer が要る。利用者は、検証に通った JWT の sub だけから決める（本文・クエリ・パスの値は使わない）。
// 検査の順: ログイン（401・503）→ conversation_id の形（422）→ 会話の有無（404。無い会話と他人の会話は同じ 404 で、本文も同じ）。
// どの応答にも（204・401・404・422・500・503 を含めて）Cache-Control: no-store を付ける（人ごとに違う内容）。
// 質問・回答・題名・会話 ID・利用者 ID は、ログにも応答のエラーにも出さない。
// POST /api/chat の conversation_id（保存）は chat.go。

// HistoryStore は、会話の履歴が DB に求めること。*store.Store が満たす。テストは偽の実装を差し込む。
// Deps.History が nil なら、履歴の 3 本は作らず、POST /api/chat は conversation_id を見ない（履歴を持たない構成。本番は、いつも渡す）。
type HistoryStore interface {
	ConversationPrecheck(ctx context.Context, userID, conversationID string) (userExists bool, stored int, err error)
	SaveTurn(ctx context.Context, t store.Turn) error
	ListConversations(ctx context.Context, userID string) ([]store.ConversationSummary, error)
	ConversationMessages(ctx context.Context, userID, conversationID string) ([]store.StoredMessage, bool, error)
	DeleteConversation(ctx context.Context, userID, conversationID string) (bool, error)
}

var _ HistoryStore = (*store.Store)(nil)

// conversationIDPattern は、会話 ID の形（128 文字まで。表の CHECK と同じ）。
var conversationIDPattern = httpx.NewPattern(`^[A-Za-z0-9_-]{1,128}$`)

func (a *api) addHistoryRoutes(rt *httpx.Router) {
	if a.d.History == nil {
		return
	}
	rt.Handle(http.MethodGet, "/api/conversations", a.historyRoute(a.listConversations))
	rt.Handle(http.MethodGet, "/api/conversations/{conversation_id}/messages", a.historyRoute(a.conversationMessages))
	rt.Handle(http.MethodDelete, "/api/conversations/{conversation_id}", a.historyRoute(a.deleteConversation))
}

// historyRoute は、3 本の共通の前処理: no-store を先に付け、ログインを確かめて、sub を渡す。
func (a *api) historyRoute(h func(w http.ResponseWriter, r *http.Request, p httpx.Params, userID string)) httpx.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request, p httpx.Params) {
		w.Header().Set("Cache-Control", "no-store")
		identity, e := a.identify(r)
		if e != nil {
			httpx.WriteError(w, e)
			return
		}
		h(w, r, p, identity.Sub)
	}
}

// conversationID は、パスの会話 ID を、形で検査する。合わなければ 422（["path","conversation_id"]）を書いて "" と false。
func conversationID(w http.ResponseWriter, p httpx.Params) (string, bool) {
	id := p["conversation_id"]
	if msg := conversationIDPattern.Check(id); msg != "" {
		var errs httpx.Errors
		errs.Add("path", "conversation_id", msg)
		httpx.WriteError(w, errs.Err())
		return "", false
	}
	return id, true
}

// ---- GET /api/conversations ----

type conversationItem struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

func (a *api) listConversations(w http.ResponseWriter, r *http.Request, _ httpx.Params, userID string) {
	list, err := a.d.History.ListConversations(r.Context(), userID)
	if err != nil {
		a.fail(w, err)
		return
	}
	items := make([]conversationItem, 0, len(list))
	for _, c := range list {
		items = append(items, conversationItem{ID: c.ID, Title: c.Title, CreatedAt: store.ISOTime(c.CreatedAt), UpdatedAt: store.ISOTime(c.UpdatedAt)})
	}
	a.writeJSON(w, httpx.ContentTypeJSON, struct {
		Conversations []conversationItem `json:"conversations"`
	}{items})
}

// ---- GET /api/conversations/{conversation_id}/messages ----

// assistantMessage は、保存した回答 1 件の応答。その回答を返した POST /api/chat の message と JSON として等しい content・results・tool_calls に、
// 履歴だけの run_created_at（その回答を作ったときの run の created_at。run が無かった回答は null。null でも必ず出す）。ユーザーの発言は role・content だけ。
type assistantMessage struct {
	Role         string          `json:"role"`
	Content      string          `json:"content"`
	Results      json.RawMessage `json:"results"`
	ToolCalls    json.RawMessage `json:"tool_calls"`
	RunCreatedAt *string         `json:"run_created_at"`
}

func (a *api) conversationMessages(w http.ResponseWriter, r *http.Request, p httpx.Params, userID string) {
	id, ok := conversationID(w, p)
	if !ok {
		return
	}
	msgs, found, err := a.d.History.ConversationMessages(r.Context(), userID, id)
	if err != nil {
		a.fail(w, err)
		return
	}
	if !found {
		httpx.WriteError(w, apierr.ConversationNotFound())
		return
	}
	out := make([]any, 0, len(msgs))
	for _, m := range msgs {
		if m.Role != "assistant" {
			out = append(out, struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			}{m.Role, m.Content})
			continue
		}
		// jsonb が正規化した値を、Python の API と同じ書き方（pyjson）にして返す
		results, rerr := pyjson.Normalize(m.Results)
		calls, cerr := pyjson.Normalize(m.ToolCalls)
		if err := errors.Join(rerr, cerr); err != nil {
			a.fail(w, err)
			return
		}
		am := assistantMessage{Role: m.Role, Content: m.Content, Results: results, ToolCalls: calls}
		if m.RunCreatedAt != nil {
			s := store.ISOTime(*m.RunCreatedAt)
			am.RunCreatedAt = &s
		}
		out = append(out, am)
	}
	a.writeJSON(w, httpx.ContentTypeJSON, struct {
		Messages []any `json:"messages"`
	}{out})
}

// ---- DELETE /api/conversations/{conversation_id} ----

func (a *api) deleteConversation(w http.ResponseWriter, r *http.Request, p httpx.Params, userID string) {
	id, ok := conversationID(w, p)
	if !ok {
		return
	}
	deleted, err := a.d.History.DeleteConversation(r.Context(), userID, id)
	if err != nil {
		a.fail(w, err)
		return
	}
	if !deleted {
		httpx.WriteError(w, apierr.ConversationNotFound())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---- POST /api/chat の保存（chat.go が呼ぶ） ----

// precheckConversation は、conversation_id つきの chat の、LLM を呼ぶ前の確認（読み取りだけ）: 利用者の行が無ければ 401、
// 保存済みの発言が上限に近ければ（もう 1 往復を足すと 500 件を超える）422 conversation_full。DB の失敗は 503・500。
// 通れば true。通らなければ、応答を書いて false。
func (a *api) precheckConversation(w http.ResponseWriter, r *http.Request, userID, conversationID string) bool {
	exists, stored, err := a.d.History.ConversationPrecheck(r.Context(), userID, conversationID)
	switch {
	case err != nil:
		a.fail(w, err)
		return false
	case !exists:
		httpx.WriteError(w, apierr.NotLoggedIn())
		return false
	case stored+2 > store.MaxStoredMessages:
		httpx.WriteError(w, apierr.ConversationFull())
		return false
	}
	return true
}

// saveConversationTurn は、回答を作り終えたあとに、質問と回答を本人の会話に追記する。保存できなかったときは、応答（回答は返さない）を書いて false。
// 利用者の行が無いのは 401（確認の直後に行が消えた競合だけ）、上限は 422、DB に届かなければ 503、それ以外は 500。
func (a *api) saveConversationTurn(w http.ResponseWriter, r *http.Request, userID, conversationID, question string, reply chat.Reply) bool {
	results, rerr := marshalArray(reply.Results)
	calls, cerr := marshalArray(reply.ToolCalls)
	if err := errors.Join(rerr, cerr); err != nil {
		a.fail(w, err)
		return false
	}
	err := a.d.History.SaveTurn(r.Context(), store.Turn{
		UserID:         userID,
		ConversationID: conversationID,
		Title:          chat.HistoryTitle(question),
		Question:       question,
		Answer:         reply.Content,
		Results:        results,
		ToolCalls:      calls,
		RunCreatedAt:   reply.RunCreatedAt,
	})
	switch {
	case err == nil:
		return true
	case errors.Is(err, store.ErrConversationUserMissing):
		httpx.WriteError(w, apierr.NotLoggedIn())
	case errors.Is(err, store.ErrConversationFull):
		httpx.WriteError(w, apierr.ConversationFull())
	default:
		a.fail(w, err)
	}
	return false
}

// marshalArray は、回答の results・tool_calls を、応答と同じ書き方（pyjson）の JSON の配列にする（nil は []。表の CHECK が配列を求める）。
func marshalArray[T any](v []T) (json.RawMessage, error) {
	if v == nil {
		return json.RawMessage("[]"), nil
	}
	b, err := pyjson.Marshal(v)
	return json.RawMessage(b), err
}
