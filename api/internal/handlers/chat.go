package handlers

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"townscan/api/internal/apierr"
	"townscan/api/internal/chat"
	"townscan/api/internal/httpx"
)

// POST /api/chat（backend/app/routes.py の chat）。会話（messages）を受け、ツールの結果つきの返答を返す。
// 保存は、任意の conversation_id が付いた要求だけ（ログイン中の会話の履歴。history.go・仕様 §2.3）。付けなければ、保存せず Authorization も見ない。
// 文脈は、保存の有無に関わらず、送られた messages の末尾 chat.ContextMessages 件だけから作る（保存した発言から組み直さない）。
// 本文の検証（形・件数・文字数）は、Pydantic のモデルと同じ場所（loc）・同じ文言のエラー（422）にする。入力値は応答に出さない。

// Chatter は、チャット 1 往復を行うもの。*chat.Service が満たす。テストは偽の実装を差し込む。
type Chatter interface {
	Answer(ctx context.Context, messages []chat.Message) (chat.Reply, error)
}

var _ Chatter = (*chat.Service)(nil)

// 受け付ける件数の上限。frontend は会話の全履歴を送るので、往復が増えても弾かない（弾くと、その会話は二度と進まない）。
// 返答に使うのは末尾の chat.ContextMessages 件だけ
const (
	maxChatMessages = 500
	maxChatContent  = chat.MaxMessageChars // 1 件の本文の上限（文字数。正規化の前と後の、両方で数える）
)

// 最後のメッセージの規則（形は合っているが、規則に合わない）。detail は付かず、message はこの固定の文
const chatLastMessageRule = "最後のメッセージは、空でない user のメッセージである必要があります"

// Pydantic（pydantic-core）の文言
const (
	pdFieldRequired = "Field required"
	pdNotModel      = "Input should be a valid dictionary or object to extract fields from"
	pdNotList       = "Input should be a valid list"
	pdNotString     = "Input should be a valid string"
	pdBadRole       = "Input should be 'user' or 'assistant'"
	pdTooShort      = "List should have at least 1 item after validation, not 0"
	// conversation_id つきの要求で、NUL（U+0000）を含む発言を断る文（Pydantic に同じ検査は無い。TownScan 固有。仕様 §2.3.4）
	pdNul = "String should not contain NUL characters"
)

var (
	pdContentTooBig = "String should have at most " + strconv.Itoa(maxChatContent) + " characters"
)

func pdTooLong(n int) string {
	return "List should have at most " + strconv.Itoa(maxChatMessages) + " items after validation, not " + strconv.Itoa(n)
}

func (a *api) addChatRoute(rt *httpx.Router) {
	if a.d.Chat != nil {
		rt.Handle(http.MethodPost, "/api/chat", a.chat)
	}
}

func (a *api) chat(w http.ResponseWriter, r *http.Request, _ httpx.Params) {
	body, e := httpx.ReadJSONBody(r)
	if e != nil {
		httpx.WriteError(w, e)
		return
	}
	messages, details := parseChatRequest(body)
	convID, hasConv, convDetail := parseConversationID(body)
	if convDetail != nil {
		details = append(details, *convDetail)
	}
	if len(details) > 0 {
		httpx.WriteError(w, apierr.Validation(details))
		return
	}
	if last := messages[len(messages)-1]; last.Role != "user" || chat.IsBlank(last.Content) {
		httpx.WriteError(w, apierr.New(http.StatusUnprocessableEntity, "validation_error", chatLastMessageRule))
		return
	}
	// conversation_id つき（会話の履歴。history.go）: 検査の順は、本文（形・空でない最後の user・conversation_id の形・NUL）→ ログイン → 利用者の行 →
	// 発言数の上限 → 回答の作成 → 保存。回答の作成（LLM）の前に、すべて済ませる（拒否された要求で課金しない）。
	// conversation_id が無い（または null）要求は、今までと同じ（Authorization を見ない・保存しない）
	save := hasConv && a.d.History != nil
	var userID string
	if save {
		if details := nulDetails(messages); len(details) > 0 {
			httpx.WriteError(w, apierr.Validation(details))
			return
		}
		identity, e := a.identify(r)
		if e != nil {
			httpx.WriteError(w, e)
			return
		}
		userID = identity.Sub
		if !a.precheckConversation(w, r, userID, convID) {
			return
		}
	}
	reply, err := a.d.Chat.Answer(r.Context(), messages)
	if err != nil {
		var llm *chat.LLMError
		if errors.As(err, &llm) {
			// 実 LLM が使えないとき。模擬には切り替えない。ログと応答に出すのは、失敗の種類・HTTP の状態・Google の理由の定数だけ
			// （キー・URL・質問や返答の本文・Google のエラーの本文は入れない）。frontend は {error:{code,message}} の message を「送信できませんでした」に出して、再送を出す
			kind, status, reason := llm.LogFields()
			a.logf("LLM が応答できませんでした: 種別=%s HTTP=%s 理由=%s", kind, status, reason)
			httpx.WriteError(w, apierr.LLMUnavailable())
			return
		}
		a.fail(w, err)
		return
	}
	if save && !a.saveConversationTurn(w, r, userID, convID, messages[len(messages)-1].Content, reply) {
		return // 保存できなかったときは、回答を返さない（回答だけ見えて履歴に無い食い違いを作らない）
	}
	a.writeJSON(w, httpx.ContentTypeJSON, struct {
		Message chat.Reply `json:"message"`
	}{reply})
}

// parseConversationID は、本文の conversation_id（任意。会話の履歴を保存するときだけ付ける）を読む。
// 無い・null は「無し」（present=false）。文字列で、形（^[A-Za-z0-9_-]{1,128}$）に合えば、その値。合わなければ 422 の項目（["body","conversation_id"]）。
// 空文字は「無し」にしない（形に合わないので 422。DocuNavi の古い呼び出しとの互換は、TownScan には無い）。本文が JSON の object でなければ、何も返さない
// （それは parseChatRequest が 422 にする）。
func parseConversationID(b httpx.Body) (id string, present bool, d *apierr.Detail) {
	if b.Kind == httpx.BodyMissing || b.Kind == httpx.BodyOpaque {
		return "", false, nil
	}
	obj, ok := b.Value.(map[string]any)
	if !ok {
		return "", false, nil
	}
	raw, ok := obj["conversation_id"]
	if !ok || raw == nil {
		return "", false, nil
	}
	s, isStr := raw.(string)
	if !isStr {
		x := detail(pdNotString, "conversation_id")
		return "", false, &x
	}
	if msg := conversationIDPattern.Check(s); msg != "" {
		x := detail(msg, "conversation_id")
		return "", false, &x
	}
	return s, true, nil
}

// nulDetails は、NUL（U+0000）を含む発言の 422 の項目（["body","messages","<番号>","content"]。番号は文字列）。
// 保存（text は SQLSTATE 22021、jsonb は 22P05）に失敗して 500 になり、LLM の費用だけが掛かるのを避けるため、LLM を呼ぶ前に断る。取り除いて保存はしない。
func nulDetails(messages []chat.Message) []apierr.Detail {
	var out []apierr.Detail
	for i, m := range messages {
		if strings.ContainsRune(m.Content, 0) {
			out = append(out, detail(pdNul, "messages", strconv.Itoa(i), "content"))
		}
	}
	return out
}

func detail(msg string, loc ...string) apierr.Detail {
	return apierr.Detail{Loc: append([]string{"body"}, loc...), Msg: msg}
}

// parseChatRequest は、本文を ChatRequest（{"messages": [{"role": "user"|"assistant", "content": 2000 文字まで}, …]（1〜500 件）}）として検証する。
// 余分なキーは無視する。エラーは、見つかった順にすべて返す（Pydantic と同じ。件数が多すぎるときは、件数のエラーだけ）。
func parseChatRequest(b httpx.Body) ([]chat.Message, []apierr.Detail) {
	switch b.Kind {
	case httpx.BodyMissing:
		return nil, []apierr.Detail{detail(pdFieldRequired)}
	case httpx.BodyOpaque:
		return nil, []apierr.Detail{detail(pdNotModel)}
	}
	obj, ok := b.Value.(map[string]any)
	if !ok {
		return nil, []apierr.Detail{detail(pdNotModel)}
	}
	raw, present := obj["messages"]
	if !present {
		return nil, []apierr.Detail{detail(pdFieldRequired, "messages")}
	}
	list, ok := raw.([]any)
	if !ok {
		return nil, []apierr.Detail{detail(pdNotList, "messages")}
	}
	if len(list) > maxChatMessages {
		return nil, []apierr.Detail{detail(pdTooLong(len(list)), "messages")}
	}
	var details []apierr.Detail
	messages := make([]chat.Message, 0, len(list))
	for i, item := range list {
		idx := strconv.Itoa(i)
		m, ok := item.(map[string]any)
		if !ok {
			details = append(details, detail(pdNotModel, "messages", idx))
			continue
		}
		var msg chat.Message
		switch v, present := m["role"]; {
		case !present:
			details = append(details, detail(pdFieldRequired, "messages", idx, "role"))
		case v == "user" || v == "assistant":
			msg.Role = v.(string)
		default:
			details = append(details, detail(pdBadRole, "messages", idx, "role"))
		}
		switch v, present := m["content"]; {
		case !present:
			details = append(details, detail(pdFieldRequired, "messages", idx, "content"))
		default:
			s, isStr := v.(string)
			switch {
			case !isStr:
				details = append(details, detail(pdNotString, "messages", idx, "content"))
			case utf8.RuneCountInString(s) > maxChatContent, chat.NormalizedLen(s) > maxChatContent:
				// 正規化（NFKC）の前に数えるだけでは足りない: NFKC は 1 文字を最大 18 文字に伸ばす（「ﷺ」）。伸びたあとの長さも、同じ上限で数える
				// （Python は、正規化の前だけ。Go だけが落とす意図した違い）。メッセージは、同じ
				details = append(details, detail(pdContentTooBig, "messages", idx, "content"))
			default:
				msg.Content = s
			}
		}
		messages = append(messages, msg)
	}
	if len(list) == 0 {
		details = append(details, detail(pdTooShort, "messages"))
	}
	return messages, details
}
