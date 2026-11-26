// Package chat は、チャット 1 往復: messages → ツール呼び出し → 結果 → 返答文 → 数字の検査 → 返答（backend/app/chat/ に相当）。
//
// 構成（役割ごとに分けてある）:
//   - router.go・rules.go・years.go・normalize.go・pycompat.go: 模擬モデル（質問の文から、呼ぶツールを決める規則）
//   - tools.go・results.go: ツール（DB の結果を、仕様 §4.5 の結果の型にする）
//   - text.go: 結果から返答文を作る文面
//   - guard.go: 返答文の数字の検査（数字は結果の値だけから出る）
//   - gemini.go・gemini_model.go: 実 LLM（Gemini）の窓口と、function calling の往復
//   - service.go（このファイル）: 1 往復
//
// 数字は、ツールの結果の値だけから出る（返答文の数字は GuardNumbers が結果と照合する。座標・ID は書かせない。ADR 0009）。範囲外の質問は断る。
// LLM_PROVIDER=gemini（実 LLM）は、gemini.go（窓口）・gemini_model.go（function calling の往復）。模擬モデルと同じく、結果は Registry が DB から作り、
// 返答文は同じ GuardNumbers を通る。キーが無いのに gemini が選ばれたら、模擬に黙って落とさず、New が明確なエラーを返す。
package chat

import (
	"context"
	"fmt"
	"strings"
	"sync/atomic"
	"time"

	"townscan/api/internal/store"
)

// ContextMessages は、文脈に使う messages の数（末尾から）。会話の全履歴を送ってくる client でも受け付ける（上限は handlers 側の 500 件）。
const ContextMessages = 20

// Reply は、応答の message（role は常に assistant）。
type Reply struct {
	Role      string   `json:"role"`
	Content   string   `json:"content"`
	Results   []Result `json:"results"`
	ToolCalls []Call   `json:"tool_calls"`
	// RunCreatedAt は、この回答を作ったときに読んだ run の created_at（run が無かったら nil）。応答には出さない（json:"-"）。
	// 会話の履歴が、回答と一緒に保存する（開き直したとき、いまの解析結果に基づくかを見分ける。仕様 §2.3.2）。
	RunCreatedAt *time.Time `json:"-"`
}

// Service は、チャットの 1 往復を行う。
type Service struct {
	data     Data
	registry *Registry
	gemini   *geminiClient         // nil なら、模擬モデル
	compose  func([]Result) string // 結果から返答文を作る（既定は Compose。テストが、数字の検査に落ちる文を差し込むために持つ）
	logf     func(format string, args ...any)
	stripped atomic.Int64 // 返答文から、カードの位置の語を取り除いた回数（同じく回数だけ）
	replaced atomic.Int64 // 返答文を、安全なテンプレートに差し替えた回数（このプロセスの通算。回数だけ数える。本文は残さない）
}

// Config は、チャットの設定。
type Config struct {
	// Provider は、LLM_PROVIDER の値。使えるのは "mock"（模擬モデル）と "gemini"（実 LLM）。
	Provider string
	// Gemini は、Provider が "gemini" のときだけ使う（キーなどは、mock のときは読まれもしない）。
	Gemini GeminiConfig
}

// New は、チャットのサービス。未対応の provider と、キーの無い gemini は、エラー（黙って模擬モデルには落とさない）。エラーの文に、キーは入れない。
func New(data Data, cfg Config, logf func(format string, args ...any)) (*Service, error) {
	if logf == nil {
		logf = func(string, ...any) {}
	}
	s := &Service{data: data, registry: DefaultRegistry(0), compose: Compose, logf: logf}
	switch cfg.Provider {
	case "mock":
	case "gemini":
		c, err := newGeminiClient(cfg.Gemini, logf)
		if err != nil {
			return nil, err
		}
		s.gemini = c
	default:
		return nil, fmt.Errorf("LLM_PROVIDER=%s は未対応です。使えるのは mock・gemini です", cfg.Provider)
	}
	return s, nil
}

// Answer は、会話（最後が利用者の質問）に答える。DB に届かないなどは、エラー（handlers が 503・500 にする）。
// 実 LLM が使えないときは *LLMError（handlers が 502 にする。模擬には切り替えない）。
func (s *Service) Answer(ctx context.Context, messages []Message) (Reply, error) {
	if len(messages) > ContextMessages {
		messages = messages[len(messages)-ContextMessages:]
	}
	run, err := s.data.CurrentRun(ctx)
	if err != nil {
		return Reply{}, err
	}
	var calls []Call
	var results []Result
	var content string
	var areas []store.Area
	if run == nil {
		results = []Result{newRefusal("no_data", noDataMessage, []string{})}
		calls = []Call{{Name: "refuse", Args: Args{Reason: "no_data"}}}
		content = noDataMessage
	} else {
		var err error
		areas, err = s.data.ListAreas(ctx, run.RunID)
		if err != nil {
			return Reply{}, err
		}
		tc := &ToolContext{Data: s.data, Run: *run, Areas: areas}
		if s.gemini != nil {
			var err error
			calls, results, content, err = (&geminiModel{client: s.gemini, areas: areas}).run(ctx, tc, s.registry, messages)
			if err != nil {
				return Reply{}, err
			}
		} else {
			calls = NewMockModel(areas).Plan(messages)
			for _, c := range calls {
				r, err := s.registry.Call(ctx, tc, c.Name, c.Args)
				if err != nil {
					return Reply{}, err
				}
				results = append(results, r)
			}
			content = s.compose(results)
		}
	}
	// 返答文の数字は、結果の値だけから出ていること。満たさなければ返さず、安全なテンプレートにする。
	// 実 LLM の文は、強い検査（地区名の漢数字は数として見ない）。模擬モデルの文は、Python と同じ範囲の検査
	var guarded string
	var replaced bool
	if s.gemini != nil {
		guarded, replaced = GuardNumbers(content, results, placeNames(areas)...)
	} else {
		guarded, replaced = guardTemplateNumbers(content, results)
	}
	if !replaced && guarded != content {
		s.logf("返答文から、カードの位置の語（上の・下の など）を取り除きました（通算 %d 回）", s.stripped.Add(1)) // 回数だけ。本文は出さない
	}
	if replaced {
		names := make([]string, len(calls))
		for i, c := range calls {
			names[i] = c.Name
		}
		// 差し替えた回数と、どのツールの質問だったか（ツール名だけ。数字・本文はログに出さない）
		s.logf("返答文を安全なテンプレートに差し替えました（通算 %d 回。ツール: %s）", s.replaced.Add(1), strings.Join(names, ","))
	}
	reply := Reply{Role: "assistant", Content: guarded, Results: results, ToolCalls: calls}
	if run != nil {
		created := run.CreatedAt
		reply.RunCreatedAt = &created
	}
	return reply, nil
}
