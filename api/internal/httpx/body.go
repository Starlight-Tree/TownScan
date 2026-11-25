package httpx

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"townscan/api/internal/apierr"
)

// リクエスト本文（JSON）の読み方。FastAPI（Starlette）が、本文を 1 つの Pydantic モデルとして受けるときの決まりと同じ:
//   - 本文が空 → 「無い」（BodyMissing。検証エラー "Field required"）
//   - Content-Type が application/json か application/*+json（大文字小文字は問わない）→ JSON として読む。
//     UTF-8 でなければ 400 bad_request（"There was an error parsing the body"）、JSON として壊れていれば 422（loc は ["body", 位置]・"JSON decode error"）
//   - それ以外の Content-Type（無い・text/plain など）→ JSON として読まない（BodyOpaque。検証エラー）
//
// 合わせていない点: UTF-16・UTF-32 の JSON（Python の json.loads(bytes) は読む）・NaN/Infinity の書き方（Python は読む）・
// 4300 桁を超える整数（Python は 400）・対の無いサロゲートの逃がし（Python は検証エラー）・入れ子が約 1 万段を超える本文（Python は RecursionError で 500。
// Go は 1 万段まで読み、超えると 422）。どれも、frontend が送る本文には現れない。
// 壊れた JSON の「位置」は、Python と同じ読み方で探すので、同じになる（jsonpos.go。Python が受け入れる NaN などで見つからないときだけ、Go の位置）。

// BodyKind は、本文の読み方の結果。
type BodyKind int

const (
	BodyJSON    BodyKind = iota // JSON として読めた（Body.Value）
	BodyMissing                 // 本文が空
	BodyOpaque                  // JSON として読まない Content-Type（本文はバイト列のまま。モデルとしては不正）
)

// Body は、読んだ本文。Value は、JSON の値（map[string]any・[]any・string・float64・bool・nil）。
type Body struct {
	Kind  BodyKind
	Value any
}

const parseBodyMessage = "There was an error parsing the body"

// ReadJSONBody は、リクエスト本文を、上の決まりで読む。読めなければ、そのまま応答にするエラー（413・400・422）。
func ReadJSONBody(r *http.Request) (Body, *apierr.Error) {
	var raw []byte
	if r.Body != nil {
		var err error
		raw, err = io.ReadAll(r.Body)
		if err != nil {
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				return Body{}, apierr.PayloadTooLarge()
			}
			return Body{}, apierr.ForStatus(http.StatusBadRequest, parseBodyMessage) // 途中で切れた・読めなかった（Python も 400）
		}
	}
	if len(raw) == 0 {
		return Body{Kind: BodyMissing}, nil
	}
	if !isJSONContentType(r.Header.Get("Content-Type")) {
		return Body{Kind: BodyOpaque}, nil
	}
	raw = bytes.TrimPrefix(raw, []byte("\xef\xbb\xbf")) // UTF-8 の BOM（Python は読み飛ばす）
	if !utf8.Valid(raw) {
		return Body{}, apierr.ForStatus(http.StatusBadRequest, parseBodyMessage)
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return Body{}, jsonDecodeError(raw, err)
	}
	return Body{Kind: BodyJSON, Value: v}, nil
}

// jsonDecodeError は、壊れた JSON の 422。位置は、Python の JSONDecodeError.pos（文字数）。
// Python と同じ読み方で探す（jsonpos.go）。Python が受け入れる本文（NaN など）で見つからないときだけ、Go の位置で代える。
func jsonDecodeError(raw []byte, err error) *apierr.Error {
	if pos, ok := pyJSONErrorPos([]rune(string(raw))); ok {
		return apierr.Validation([]apierr.Detail{{Loc: []string{"body", strconv.Itoa(pos)}, Msg: "JSON decode error"}})
	}
	pos := 0
	var se *json.SyntaxError
	if errors.As(err, &se) {
		if strings.HasPrefix(se.Error(), "unexpected end") { // 途中で終わっている: 末尾
			pos = len(raw)
		} else {
			pos = int(se.Offset) - 1 // Offset は、読んだバイト数（問題の文字を含む）
		}
	}
	pos = min(max(pos, 0), len(raw))
	return apierr.Validation([]apierr.Detail{{Loc: []string{"body", strconv.Itoa(utf8.RuneCount(raw[:pos]))}, Msg: "JSON decode error"}})
}

// isJSONContentType は、Content-Type が application/json か application/*+json か（大文字小文字は問わない。読めない値は、JSON でない）。
func isJSONContentType(v string) bool {
	mt, _, err := mime.ParseMediaType(v)
	if err != nil && mt == "" {
		// パラメーターの書き方の誤りなどは、型の部分だけで見る（Python は型だけを見る）
		mt = strings.TrimSpace(strings.SplitN(v, ";", 2)[0])
	}
	maintype, subtype, ok := strings.Cut(strings.ToLower(mt), "/")
	return ok && maintype == "application" && (subtype == "json" || strings.HasSuffix(subtype, "+json"))
}
