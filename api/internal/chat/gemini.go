package chat

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"townscan/api/internal/config"
)

// 実 LLM（Gemini）の窓口: generateContent を呼ぶ HTTP のクライアント（再試行・期限・失敗の分類）。backend/app/chat/gemini_model.py の
// GeminiClient・post_json・RequestBudget と同じ振る舞い。往復（function calling）の本体は gemini_model.go。
//
// 失敗（キーが無効・429・5xx・タイムアウト・壊れた応答・往復やツール呼び出しの上限超過）は、模擬に黙って切り替えず、*LLMError にして返す
// （API としては 502）。エラー・ログ・応答には、失敗の種類・HTTP の状態・Google が返した理由の定数（INVALID_ARGUMENT など）だけを持たせる。
// キー・URL・質問や返答の本文・Google のエラー本文は、持たせない。キーは URL に付けず、ヘッダー（x-goog-api-key）で送る。
//
// 再試行は、一時的な失敗（HTTP 5xx・タイムアウト・接続エラー）だけを、チャット 1 回の要求につき最大 1 回（往復ごとではなく要求ごと）、
// RetryDelay 待ってやり直す。4xx（429 を含む）は、待っても直らないので、やり直さない。再試行を含めた 1 回の要求の総所要時間には、
// Deadline の期限がある（残りが MinAttempt より短ければ、新しい呼び出し・再試行を始めない）。

const (
	// DefaultGeminiBaseURL は、generateContent の URL の前半（モデル名と :generateContent が続く）。
	DefaultGeminiBaseURL = "https://generativelanguage.googleapis.com/v1beta/models"
	// DefaultCallTimeout は、1 回の呼び出し（接続から本文の読み終わりまで）を待つ上限。
	DefaultCallTimeout = 20 * time.Second
	// RequestDeadline は、チャット 1 回の要求（往復・ツールの実行・再試行の全部）の期限。frontend の Next.js が /api/* を転送するときの待ちの既定
	// （proxyTimeout 30 秒。next 16.4.6 の proxy-request.js が `proxyTimeout || 30000`）より短くして、転送が切れる前に、API が 502（llm_unavailable）を返せるようにする。
	// 各呼び出しの待ちは、残りの期限を超えない。cmd/api は、要求全体の期限（httpx.Timeout）と DB の statement_timeout にも、この値を使う。
	RequestDeadline = 27 * time.Second
	// DefaultRetryDelay は、やり直す前の待ち。
	DefaultRetryDelay = time.Second
	// DefaultMinAttempt は、残りの期限がこれより短いときは、新しい呼び出し・再試行を始めない（通常の応答は約 2 秒、遅くて 20 秒前後）。
	DefaultMinAttempt = 5 * time.Second

	maxRetries        = 1        // 1 回の要求あたりの再試行の上限（往復ごとではない）
	maxResponseBytes  = 2 << 20  // 応答の本文の上限
	maxErrorBodyBytes = 64 << 10 // エラーの本文は、理由の定数を取るために、これだけ読む
)

// 失敗の種類（LLMError.Kind）。Python の LlmUnavailable.kind と同じ語。
const (
	kindServer       = "server"       // HTTP 5xx
	kindTimeout      = "timeout"      // 待ちの上限・要求全体の期限
	kindNetwork      = "network"      // 接続できない・途中で切れた
	kindDeadline     = "deadline"     // 要求の期限を使い切った（新しい呼び出しを始めなかった）
	kindAuth         = "auth"         // 401・403（キーが無効・API が有効でない）
	kindRateLimit    = "rate_limit"   // 429
	kindNotFound     = "not_found"    // 404（モデル名の誤り）
	kindBadRequest   = "bad_request"  // 400（Google は、無効なキーにも 400 を返すことがある）
	kindHTTPError    = "http_error"   // そのほかの HTTP 状態（リダイレクトを含む）
	kindInvalidJSON  = "invalid_json" // 本文が JSON のオブジェクトでない
	kindTooLarge     = "too_large"    // 本文が上限（2 MiB）を超えた
	kindNoMessages   = "no_messages"
	kindBlocked      = "blocked"
	kindNoCandidates = "no_candidates"
	kindEmptyContent = "empty_content"
	kindEmptyText    = "empty_text"
	kindNoToolCall   = "no_tool_call"
	kindTooManyCalls = "too_many_tool_calls"
	kindTooManyRound = "too_many_rounds"
	kindBadFunction  = "invalid_function_call"
)

// 再試行する失敗の種類。4xx（429 を含む）・壊れた応答（invalid_json・too_large）は、やり直さない。
var retryableKinds = map[string]bool{kindServer: true, kindTimeout: true, kindNetwork: true}

// Google が返す理由の定数（INVALID_ARGUMENT・API_KEY_INVALID など。"/" でつなぐ）。この形の文字列だけ、ログに出す
var enumRE = regexp.MustCompile(`^[A-Z][A-Z0-9_]{2,60}(?:/[A-Z][A-Z0-9_]{2,60})*$`)
var enumOneRE = regexp.MustCompile(`^[A-Z][A-Z0-9_]{2,60}$`)

// LLMError は、実 LLM が使えないとき。失敗の種類（Kind）・HTTP の状態（Status。無ければ 0）・Google が返した理由の定数（Reason。無ければ ""）だけを持つ。
// 原因のエラー・URL・キー・応答の本文は、持たない（ログ・エラーの表示に混ざらないように）。API は 502（llm_unavailable）にする。
type LLMError struct {
	Kind   string
	Status int
	Reason string
}

func newLLMError(kind string, status int, reason string) *LLMError {
	if !enumRE.MatchString(reason) {
		reason = ""
	}
	return &LLMError{Kind: kind, Status: status, Reason: reason}
}

func (e *LLMError) Error() string { return "LLM が使えません（" + e.Kind + "）" }

// LogFields は、ログに出す 3 つの値（Python と同じ「種別=… HTTP=… 理由=…」。無いものは None）。
func (e *LLMError) LogFields() (kind, status, reason string) {
	status, reason = "None", "None"
	if e.Status != 0 {
		status = fmt.Sprint(e.Status)
	}
	if e.Reason != "" {
		reason = e.Reason
	}
	return e.Kind, status, reason
}

// GeminiConfig は、Gemini の窓口の設定。0 の値は、既定（上の定数）。時間の設定は、テストが短い値に差し替えるための口。
type GeminiConfig struct {
	APIKey  config.Secret // どの書き方（%v・JSON・ログ）でも伏せ字になる
	Model   string
	BaseURL string // 既定は DefaultGeminiBaseURL。テストが偽のサーバーへ向ける（環境変数では変えられない）

	CallTimeout time.Duration // 1 回の呼び出しの待ち（既定 20 秒）
	Deadline    time.Duration // 要求全体の期限（既定 RequestDeadline = 27 秒）
	RetryDelay  time.Duration // やり直す前の待ち（既定 1 秒）
	MinAttempt  time.Duration // 残りがこれより短ければ、新しい呼び出しを始めない（既定 5 秒）

	HTTPClient *http.Client // nil なら、既定のクライアント。どちらも、リダイレクトは追わない
}

// sendFunc は、generateContent を 1 回呼ぶ。失敗は *LLMError（呼び出し側が取り消したときは、その ctx のエラー）。テストは、これを偽物に差し替える。
type sendFunc func(ctx context.Context, body map[string]any, timeout time.Duration) (map[string]any, error)

// geminiClient は、generateContent を呼ぶ（一時的な失敗は、要求ごとに 1 回だけやり直す）。キーはここだけが持つ（String・GoString・ログ・エラーに出さない）。
type geminiClient struct {
	apiKey   string
	model    string
	endpoint string
	httpc    *http.Client

	callTimeout, deadline, retryDelay, minAttempt time.Duration

	logf  func(format string, args ...any)
	now   func() time.Time
	sleep func(ctx context.Context, d time.Duration) error
	send  sendFunc
}

func newGeminiClient(cfg GeminiConfig, logf func(string, ...any)) (*geminiClient, error) {
	key := cfg.APIKey.Reveal()
	if key == "" {
		return nil, errors.New("LLM_PROVIDER=gemini には GEMINI_API_KEY が要ります（黙って模擬モデルには切り替えません）")
	}
	if cfg.Model == "" {
		return nil, errors.New("LLM_PROVIDER=gemini には、モデル名（GEMINI_MODEL）が要ります")
	}
	base := cfg.BaseURL
	if base == "" {
		base = DefaultGeminiBaseURL
	}
	endpoint := strings.TrimRight(base, "/") + "/" + url.PathEscape(cfg.Model) + ":generateContent"
	c := &geminiClient{
		apiKey:      key,
		model:       cfg.Model,
		endpoint:    endpoint,
		httpc:       cfg.HTTPClient,
		callTimeout: orDuration(cfg.CallTimeout, DefaultCallTimeout),
		deadline:    orDuration(cfg.Deadline, RequestDeadline),
		retryDelay:  orDuration(cfg.RetryDelay, DefaultRetryDelay),
		minAttempt:  orDuration(cfg.MinAttempt, DefaultMinAttempt),
		logf:        logf,
		now:         time.Now,
		sleep:       sleepCtx,
	}
	if c.httpc == nil {
		c.httpc = newHTTPClient()
	} else { // 渡されたクライアントでも、リダイレクトは追わない（キーのヘッダーを別のホストへ送らない）
		cp := *c.httpc
		cp.CheckRedirect = noRedirect
		c.httpc = &cp
	}
	if c.logf == nil {
		c.logf = func(string, ...any) {}
	}
	c.send = c.postJSON
	return c, nil
}

func orDuration(d, def time.Duration) time.Duration {
	if d <= 0 {
		return def
	}
	return d
}

// newHTTPClient は、リダイレクトを追わない HTTP クライアント。追うと、キーのヘッダーを別のホストへ送ってしまう恐れがある
// （3xx は、そのまま「http_error」の失敗になる）。待ちの上限は、呼び出しごとの context で付ける。環境のプロキシ設定は、標準のとおり使う（Python の urllib と同じ）。
func newHTTPClient() *http.Client {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	return &http.Client{
		Transport:     tr,
		CheckRedirect: noRedirect,
	}
}

func noRedirect(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// String・GoString は、キーを含めない（%v・%+v・%#v・ログのどれで書いても、モデル名だけ）。
func (c *geminiClient) String() string   { return fmt.Sprintf("GeminiClient(model=%q)", c.model) }
func (c *geminiClient) GoString() string { return c.String() }

// budget は、チャット 1 回の要求が使える、再試行の残りと全体の期限。往復をまたいで 1 つを共有する
// （再試行は往復ごとではなく要求ごとに 1 回。期限は、往復・ツールの実行・待ちを全部含む）。
type budget struct {
	endsAt      time.Time
	retriesLeft int
}

// newBudget は、チャット 1 回の要求の始めに 1 つ作り、その要求の generate すべてに渡す。親の ctx に期限があれば、それを超えない。
func (c *geminiClient) newBudget(ctx context.Context) *budget {
	ends := c.now().Add(c.deadline)
	if d, ok := ctx.Deadline(); ok && d.Before(ends) {
		ends = d
	}
	return &budget{endsAt: ends, retriesLeft: maxRetries}
}

func (c *geminiClient) remaining(b *budget) time.Duration { return b.endsAt.Sub(c.now()) }

// generate は、generateContent を 1 回呼ぶ。一時的な失敗（retryableKinds）は、b に残りがあれば、RetryDelay 待ってやり直す。
// 失敗は *LLMError（やり直しても失敗したときは、最後の失敗）。クライアントが切った（ctx が取り消された）ときは、ctx のエラー。
func (c *geminiClient) generate(ctx context.Context, body map[string]any, b *budget) (map[string]any, error) {
	for {
		remaining := c.remaining(b)
		if remaining < c.minAttempt {
			return nil, newLLMError(kindDeadline, 0, "") // 往復・やり直しで、要求の期限を使い切った
		}
		resp, err := c.send(ctx, body, min(c.callTimeout, remaining))
		if err == nil {
			return resp, nil
		}
		var failure *LLMError
		if !errors.As(err, &failure) {
			return nil, err
		}
		if !c.mayRetry(failure, b) {
			return nil, failure
		}
		b.retriesLeft--
		// 失敗の種類だけを残す（キー・URL・本文は、LLMError に無い）。やり直しが成功しても、この行は残る
		kind, status, reason := failure.LogFields()
		c.logf("LLM の呼び出しに失敗したので、%.1f 秒待ってやり直します: 種別=%s HTTP=%s 理由=%s", c.retryDelay.Seconds(), kind, status, reason)
		if err := c.sleep(ctx, c.retryDelay); err != nil {
			return nil, ctxFailure(ctx, err)
		}
	}
}

// mayRetry は、一時的な失敗で、この要求の再試行が残っていて、待ったあとにも新しい呼び出しの分の期限が残るときだけ true。
func (c *geminiClient) mayRetry(failure *LLMError, b *budget) bool {
	return retryableKinds[failure.Kind] && b.retriesLeft > 0 && c.remaining(b)-c.retryDelay >= c.minAttempt
}

// ctxFailure は、親の ctx が終わったときの失敗。クライアントが切った（取り消し）なら、そのエラーをそのまま（応答を書く相手がいない）。
// 期限切れ（要求全体の期限）なら、timeout の失敗。
func ctxFailure(ctx context.Context, err error) error {
	if errors.Is(ctx.Err(), context.Canceled) {
		return context.Canceled
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return newLLMError(kindTimeout, 0, "")
	}
	return newLLMError(kindNetwork, 0, "")
}

// postJSON は、JSON を POST して、JSON のオブジェクトの応答を返す。失敗はすべて *LLMError（元のエラーは持ち越さない）。
func (c *geminiClient) postJSON(ctx context.Context, body map[string]any, timeout time.Duration) (map[string]any, error) {
	var payload bytes.Buffer
	enc := json.NewEncoder(&payload)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(body); err != nil {
		return nil, newLLMError(kindNetwork, 0, "") // 送れない形（本文は、こちらで作る。起きない）
	}
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(cctx, http.MethodPost, c.endpoint, &payload)
	if err != nil {
		return nil, newLLMError(kindNetwork, 0, "")
	}
	req.Header.Set("x-goog-api-key", c.apiKey) // キーは URL（?key=…）に付けない。URL は、エラー・ログ・プロキシの記録に残りやすい
	req.Header.Set("Content-Type", "application/json; charset=utf-8")
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpc.Do(req)
	if err != nil {
		return nil, transportFailure(ctx, err) // err には URL が入る。文は持ち越さない
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, maxErrorBodyBytes))
		return nil, httpFailure(resp.StatusCode, raw)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if err != nil {
		return nil, transportFailure(ctx, err)
	}
	if len(raw) > maxResponseBytes {
		return nil, newLLMError(kindTooLarge, 0, "")
	}
	parsed, ok := decodeObject(raw)
	if !ok {
		return nil, newLLMError(kindInvalidJSON, 0, "")
	}
	return parsed, nil
}

// transportFailure は、通信のエラーを、失敗の種類にする。クライアントが切ったとき（親の ctx の取り消し）は、そのエラー。
func transportFailure(parent context.Context, err error) error {
	if errors.Is(parent.Err(), context.Canceled) {
		return context.Canceled
	}
	var ne net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &ne) && ne.Timeout()) {
		return newLLMError(kindTimeout, 0, "")
	}
	return newLLMError(kindNetwork, 0, "")
}

// httpFailure は、HTTP の失敗（2xx 以外）を、失敗の種類にする。本文は、Google の理由の定数（status と details の reason）だけを取る。
func httpFailure(status int, raw []byte) *LLMError {
	kind := kindHTTPError
	switch {
	case status == 401 || status == 403:
		kind = kindAuth
	case status == 429:
		kind = kindRateLimit
	case status == 404:
		kind = kindNotFound
	case status == 400:
		kind = kindBadRequest
	case status >= 500:
		kind = kindServer
	}
	return newLLMError(kind, status, errorReason(raw))
}

// errorReason は、Google のエラー本文から、理由の定数（status と details の reason）だけを取る。message は取らない。
func errorReason(raw []byte) string {
	obj, ok := decodeObject(raw)
	if !ok {
		return ""
	}
	errObj, ok := obj["error"].(map[string]any)
	if !ok {
		return ""
	}
	var found []any
	found = append(found, errObj["status"])
	if details, ok := errObj["details"].([]any); ok {
		for _, d := range details {
			if m, ok := d.(map[string]any); ok {
				found = append(found, m["reason"])
			}
		}
	}
	var names []string
	for _, f := range found {
		if s, ok := f.(string); ok && enumOneRE.MatchString(s) {
			dup := false
			for _, n := range names {
				dup = dup || n == s
			}
			if !dup {
				names = append(names, s)
			}
		}
	}
	return strings.Join(names, "/")
}

// decodeObject は、JSON のオブジェクト 1 つ（後ろに余分な文字が無い）を読む。数は json.Number のまま（書き戻しても、桁が変わらない）。
func decodeObject(raw []byte) (map[string]any, bool) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, false
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, false
	}
	obj, ok := v.(map[string]any)
	return obj, ok
}
