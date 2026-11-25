package handlers

import (
	"context"
	"net/http"
	"strconv"
	"unicode/utf8"

	"townscan/api/internal/apierr"
	"townscan/api/internal/chat"
	"townscan/api/internal/httpx"
)

// POST /api/chat（backend/app/routes.py の chat）。会話（messages）を受け、ツールの結果つきの返答を返す。
// サーバーは会話を保存しない。文脈は、送られた messages の末尾 chat.ContextMessages 件だけから作る。
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
	maxChatContent  = 2000 // 1 件の本文の上限（文字数）
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
	if len(details) > 0 {
		httpx.WriteError(w, apierr.Validation(details))
		return
	}
	if last := messages[len(messages)-1]; last.Role != "user" || chat.IsBlank(last.Content) {
		httpx.WriteError(w, apierr.New(http.StatusUnprocessableEntity, "validation_error", chatLastMessageRule))
		return
	}
	reply, err := a.d.Chat.Answer(r.Context(), messages)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.writeJSON(w, httpx.ContentTypeJSON, struct {
		Message chat.Reply `json:"message"`
	}{reply})
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
			case utf8.RuneCountInString(s) > maxChatContent:
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
