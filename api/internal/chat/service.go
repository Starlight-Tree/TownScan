// Package chat は、チャット 1 往復: messages → ツール呼び出し → 結果 → 返答文 → 数字の検査 → 返答（backend/app/chat/ に相当）。
//
// 構成（役割ごとに分けてある）:
//   - router.go・rules.go・years.go・normalize.go・pycompat.go: 模擬モデル（質問の文から、呼ぶツールを決める規則）
//   - tools.go・results.go: ツール（DB の結果を、仕様 §4.5 の結果の型にする）
//   - text.go: 結果から返答文を作る文面
//   - guard.go: 返答文の数字の検査（数字は結果の値だけから出る）
//   - service.go（このファイル）: 1 往復
//
// 数字・件数・座標は LLM に書かせない。ツールの結果をそのまま描く。範囲外の質問は断る。
// LLM_PROVIDER=gemini（実 LLM）は、まだ無い。設定されたら、模擬に黙って落とさず、New が明確なエラーを返す。
package chat

import (
	"context"
	"fmt"
	"sync/atomic"
)

// ContextMessages は、文脈に使う messages の数（末尾から）。会話の全履歴を送ってくる client でも受け付ける（上限は handlers 側の 500 件）。
const ContextMessages = 20

// Reply は、応答の message（role は常に assistant）。
type Reply struct {
	Role      string   `json:"role"`
	Content   string   `json:"content"`
	Results   []Result `json:"results"`
	ToolCalls []Call   `json:"tool_calls"`
}

// Service は、チャットの 1 往復を行う。
type Service struct {
	data     Data
	registry *Registry
	compose  func([]Result) string // 結果から返答文を作る（既定は Compose。テストが、数字の検査に落ちる文を差し込むために持つ）
	logf     func(format string, args ...any)
	replaced atomic.Int64 // 返答文を、安全なテンプレートに差し替えた回数（このプロセスの通算。回数だけ数える。本文は残さない）
}

// New は、チャットのサービス。provider は、LLM_PROVIDER の値。使えるのは "mock"（模擬モデル）だけで、"gemini" などは、エラー。
func New(data Data, provider string, logf func(format string, args ...any)) (*Service, error) {
	if provider != "mock" {
		return nil, fmt.Errorf("LLM_PROVIDER=%s は、この版の API ではまだ使えません（実 LLM の窓口は次の段で作ります）。mock にするか、LLM_PROVIDER を外してください", provider)
	}
	if logf == nil {
		logf = func(string, ...any) {}
	}
	return &Service{data: data, registry: DefaultRegistry(0), compose: Compose, logf: logf}, nil
}

// Answer は、会話（最後が利用者の質問）に答える。DB に届かないなどは、エラー（handlers が 503・500 にする）。
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
	if run == nil {
		results = []Result{newRefusal("no_data", noDataMessage, []string{})}
		calls = []Call{{Name: "refuse", Args: Args{Reason: "no_data"}}}
		content = noDataMessage
	} else {
		areas, err := s.data.ListAreas(ctx, run.RunID)
		if err != nil {
			return Reply{}, err
		}
		tc := &ToolContext{Data: s.data, Run: *run, Areas: areas}
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
	// 返答文の数字は、結果の値だけから出ていること。満たさなければ返さず、安全なテンプレートにする
	guarded, replaced := GuardNumbers(content, results)
	if replaced {
		s.logf("返答文を安全なテンプレートに差し替えました（通算 %d 回）", s.replaced.Add(1))
	}
	return Reply{Role: "assistant", Content: guarded, Results: results, ToolCalls: calls}, nil
}
