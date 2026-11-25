package apierr

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestWriteShapeMatchesPython(t *testing.T) {
	cases := []struct {
		name   string
		err    *Error
		status int
		body   string
	}{
		{"404 パスなし", NotFound(), 404, `{"error":{"code":"not_found","message":"見つかりません"}}`},
		{"405", MethodNotAllowed(), 405, `{"error":{"code":"method_not_allowed","message":"このメソッドは使えません"}}`},
		{"候補なし", CandidateNotFound(), 404, `{"error":{"code":"not_found","message":"候補が見つかりません"}}`},
		{"評価なし", MetricsNotFound(), 404, `{"error":{"code":"not_found","message":"評価の結果がありません"}}`},
		{"データなし", NoData(), 503, `{"error":{"code":"no_data","message":"データが読み込まれていません。python -m pipeline.load で pipeline の出力を読み込んでください"}}`},
		{"DB 不通", DBUnavailable(), 503, `{"error":{"code":"db_unavailable","message":"データベースに接続できません。しばらくしてから再試行してください"}}`},
		{"LLM 不通", LLMUnavailable(), 502, `{"error":{"code":"llm_unavailable","message":"いまは LLM が応答できません。少し待ってからもう一度お試しください"}}`},
		{"内部", Internal(), 500, `{"error":{"code":"internal_error","message":"サーバー内部のエラーです"}}`},
		{
			"検証", Validation([]Detail{{Loc: []string{"query", "limit"}, Msg: "Input should be greater than or equal to 1"}}), 422,
			`{"error":{"code":"validation_error","message":"引数が不正です（query.limit）","details":[{"loc":["query","limit"],"msg":"Input should be greater than or equal to 1"}]}}`,
		},
		{
			"検証（複数。message は先頭の場所）",
			Validation([]Detail{
				{Loc: []string{"query", "area_id"}, Msg: "a"},
				{Loc: []string{"query", "cls"}, Msg: "b"},
			}), 422,
			`{"error":{"code":"validation_error","message":"引数が不正です（query.area_id）","details":[{"loc":["query","area_id"],"msg":"a"},{"loc":["query","cls"],"msg":"b"}]}}`,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			Write(rec, c.err)
			if rec.Code != c.status {
				t.Errorf("状態 = %d, 期待 %d", rec.Code, c.status)
			}
			if got := rec.Body.String(); got != c.body {
				t.Errorf("本文 = %s\n期待 = %s", got, c.body)
			}
			if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
				t.Errorf("Content-Type = %q", ct)
			}
			if cl := rec.Header().Get("Content-Length"); cl == "" {
				t.Error("Content-Length が無い")
			}
		})
	}
}

func TestValidationWithoutDetailsHasPlainMessage(t *testing.T) {
	if e := Validation(nil); e.Message != "引数が不正です" {
		t.Errorf("message = %q", e.Message)
	}
	if e := Validation([]Detail{{Loc: nil, Msg: "x"}}); e.Message != "引数が不正です" {
		t.Errorf("message = %q", e.Message)
	}
}

func TestForStatusFollowsPythonTables(t *testing.T) {
	cases := []struct {
		status        int
		detail        string
		code, message string
	}{
		{404, "Not Found", "not_found", "見つかりません"},
		{405, "Method Not Allowed", "method_not_allowed", "このメソッドは使えません"},
		{400, "bad", "bad_request", "bad"},
		{503, "x", "unavailable", "x"},
		{418, "teapot", "error", "teapot"},
	}
	for _, c := range cases {
		e := ForStatus(c.status, c.detail)
		if e.Status != c.status || e.Code != c.code || e.Message != c.message {
			t.Errorf("ForStatus(%d, %q) = %+v", c.status, c.detail, e)
		}
	}
}

func TestWriteAddsExtraHeaders(t *testing.T) {
	rec := httptest.NewRecorder()
	e := New(http.StatusUnauthorized, "unauthorized", "ログインしてください")
	e.Headers = map[string]string{"WWW-Authenticate": "Bearer", "Cache-Control": "no-store"}
	Write(rec, e)
	if rec.Header().Get("WWW-Authenticate") != "Bearer" || rec.Header().Get("Cache-Control") != "no-store" {
		t.Errorf("ヘッダー = %v", rec.Header())
	}
	if !strings.Contains(rec.Body.String(), `"code":"unauthorized"`) {
		t.Errorf("本文 = %s", rec.Body.String())
	}
}
