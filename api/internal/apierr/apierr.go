// Package apierr は、エラー応答の形（{"error":{"code","message"}}）。backend/app/errors.py と同じ JSON・状態コード・文言。
//
// 入力値そのもの（クエリの値など）は応答に載せない。載せるのは、場所（loc）と理由（msg）だけ。
package apierr

import (
	"net/http"
	"strconv"

	"townscan/api/internal/pyjson"
)

// Error は、応答にできるエラー。Headers は応答に足すヘッダー（401 の WWW-Authenticate など）。
type Error struct {
	Status  int
	Code    string
	Message string
	Headers map[string]string
	// 検証エラー（422）のときだけ。どの入力のどこが悪いか
	Details []Detail
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

// Detail は、検証エラーの 1 件。Loc は ["query","limit"]・["path","candidate_id"] の形。
type Detail struct {
	Loc []string `json:"loc"`
	Msg string   `json:"msg"`
}

type body struct {
	Error errorBody `json:"error"`
}

type errorBody struct {
	Code    string   `json:"code"`
	Message string   `json:"message"`
	Details []Detail `json:"details,omitempty"`
}

// 状態コードに対応する code。errors.py の _STATUS_CODES と同じ（表に無い状態は "error"）
var statusCodes = map[int]string{
	http.StatusBadRequest:          "bad_request",
	http.StatusNotFound:            "not_found",
	http.StatusMethodNotAllowed:    "method_not_allowed",
	http.StatusUnprocessableEntity: "validation_error",
	http.StatusServiceUnavailable:  "unavailable",
}

// 状態コードに対応する固定の文。errors.py の _STATUS_MESSAGES と同じ
var statusMessages = map[int]string{
	http.StatusNotFound:         "見つかりません",
	http.StatusMethodNotAllowed: "このメソッドは使えません",
}

// New は、状態・code・文言を指定したエラー。
func New(status int, code, message string) *Error {
	return &Error{Status: status, Code: code, Message: message}
}

// ForStatus は、状態コードだけから作るエラー（FastAPI の HTTPException の扱いと同じ。404・405 は固定の文、ほかは detail をそのまま使う）。
func ForStatus(status int, detail string) *Error {
	code, ok := statusCodes[status]
	if !ok {
		code = "error"
	}
	msg := statusMessages[status]
	if msg == "" {
		msg = detail
	}
	return New(status, code, msg)
}

// NotFound は、存在しないパス（ルートが無い）の 404。
func NotFound() *Error { return ForStatus(http.StatusNotFound, "") }

// MethodNotAllowed は、パスはあるがメソッドが違うときの 405。
func MethodNotAllowed() *Error { return ForStatus(http.StatusMethodNotAllowed, "") }

// CandidateNotFound は、候補の id が無いときの 404。
func CandidateNotFound() *Error {
	return New(http.StatusNotFound, "not_found", "候補が見つかりません")
}

// MetricsNotFound は、現在の run に評価の結果が無いときの 404。
func MetricsNotFound() *Error {
	return New(http.StatusNotFound, "not_found", "評価の結果がありません")
}

// NoData は、DB に run が 1 つも無いときの 503。
func NoData() *Error {
	return New(http.StatusServiceUnavailable, "no_data", "データが読み込まれていません。python -m app.load で pipeline の出力を読み込んでください")
}

// DBUnavailable は、DB に接続できないときの 503。
func DBUnavailable() *Error {
	return New(http.StatusServiceUnavailable, "db_unavailable", "データベースに接続できません。しばらくしてから再試行してください")
}

// LLMUnavailable は、実 LLM（Gemini）が使えないときの 502（キーが無効・429・5xx・タイムアウト・壊れた応答・往復の上限超過。模擬には切り替えない）。
// メッセージは固定で、失敗の詳細（種類・HTTP の状態・URL・キー）は載せない。
func LLMUnavailable() *Error {
	return New(http.StatusBadGateway, "llm_unavailable", "いまは LLM が応答できません。少し待ってからもう一度お試しください")
}

// Internal は、想定外のエラーの 500。原因は載せない。
func Internal() *Error {
	return New(http.StatusInternalServerError, "internal_error", "サーバー内部のエラーです")
}

// PayloadTooLarge は、リクエスト本文が上限を超えたときの 413。Python の API には無い（Go 側だけの上限。httpx.LimitBody）。
func PayloadTooLarge() *Error {
	return New(http.StatusRequestEntityTooLarge, "payload_too_large", "送れる大きさを超えています。短くして、もう一度お試しください")
}

// Validation は、引数が不正なときの 422。message は先頭の loc を "." でつないだもの（errors.py の _validation_error と同じ）。
func Validation(details []Detail) *Error {
	msg := "引数が不正です"
	if len(details) > 0 {
		where := ""
		for i, l := range details[0].Loc {
			if i > 0 {
				where += "."
			}
			where += l
		}
		if where != "" {
			msg = "引数が不正です（" + where + "）"
		}
	}
	e := New(http.StatusUnprocessableEntity, "validation_error", msg)
	e.Details = details
	return e
}

// Marshal は、応答の本文（JSON）。
func (e *Error) Marshal() []byte {
	b, err := pyjson.Marshal(body{Error: errorBody{Code: e.Code, Message: e.Message, Details: e.Details}})
	if err != nil { // 文字列と整数だけなので起きない
		return []byte(`{"error":{"code":"internal_error","message":"サーバー内部のエラーです"}}`)
	}
	return b
}

// Write は、エラーを JSON で書く。
func Write(w http.ResponseWriter, e *Error) {
	b := e.Marshal()
	h := w.Header()
	for k, v := range e.Headers {
		h.Set(k, v)
	}
	h.Set("Content-Type", "application/json")
	h.Set("Content-Length", strconv.Itoa(len(b)))
	w.WriteHeader(e.Status)
	_, _ = w.Write(b)
}
