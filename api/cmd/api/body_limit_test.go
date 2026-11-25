package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"townscan/api/internal/chat"
	"townscan/api/internal/config"
)

// リクエスト本文の上限（maxBodyBytes）: 4 MiB。組み立てた全体（buildHandler）で、POST /api/chat に送って確かめる。
//
// 根拠: いちばん大きい正しい本文は、500 件 × 2000 文字 × 3 バイト（日本語は UTF-8 で 1 文字 3 バイト）= 3,000,000 バイトに JSON の枠を足した約 3.02 MB。
// 上限を大きくしないのは、JSON を復号するとメモリーが本文の約 50 倍になるため（8 MiB の [{},{},…] は約 400 MB）。

const bodyLimit = 4 * 1024 * 1024 // 値を直接書く（maxBodyBytes を参照すると、定数を変えても通ってしまう）

type countingChat struct{ got []chat.Message }

func (c *countingChat) Answer(_ context.Context, msgs []chat.Message) (chat.Reply, error) {
	c.got = msgs
	return chat.Reply{Role: "assistant", Content: "答えです。", Results: []chat.Result{}, ToolCalls: []chat.Call{}}, nil
}

func chatHandler(t *testing.T) (http.Handler, *countingChat) {
	t.Helper()
	cfg, err := config.Load(envOf(map[string]string{"DATABASE_URL": "postgresql://u:pw@db/x"}), nil)
	if err != nil {
		t.Fatal(err)
	}
	c := &countingChat{}
	return buildHandler(cfg, nil, c, func(string, ...any) {}), c
}

// postChat は、本文を POST /api/chat に送る。chunked が true なら、長さを申告しない（読み進めて上限に当たる経路）。
func postChat(h http.Handler, body string, chunked bool) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/api/chat", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if chunked {
		req.ContentLength = -1
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// padded は、有効なチャットの本文（余分なキーは無視される）を、ちょうど size バイトにして返す。
func padded(size int) string {
	const head, tail = `{"messages":[{"role":"user","content":"使い方は？"}],"pad":"`, `"}`
	return head + strings.Repeat("a", size-len(head)-len(tail)) + tail
}

func TestRequestBodyLimitIsFourMiB(t *testing.T) {
	if maxBodyBytes != bodyLimit {
		t.Fatalf("maxBodyBytes = %d、期待 %d（4 MiB。変えるときは、README・コメント・このテストの根拠も）", maxBodyBytes, bodyLimit)
	}
	h, c := chatHandler(t)
	for _, chunked := range []bool{false, true} {
		how := map[bool]string{false: "長さを申告", true: "申告なし"}[chunked]
		// ちょうど 4 MiB は通る
		body := padded(bodyLimit)
		if len(body) != bodyLimit {
			t.Fatalf("テストの本文が %d バイト", len(body))
		}
		c.got = nil
		if rec := postChat(h, body, chunked); rec.Code != 200 || len(c.got) != 1 {
			t.Errorf("%s・ちょうど 4 MiB: %d（渡した件数 %d）%.200s", how, rec.Code, len(c.got), rec.Body)
		}
		// 1 バイト超えたら 413（Go だけの上限。Python には無い）
		c.got = nil
		rec := postChat(h, padded(bodyLimit+1), chunked)
		if rec.Code != 413 || !strings.Contains(rec.Body.String(), `"code":"payload_too_large"`) || c.got != nil {
			t.Errorf("%s・4 MiB + 1: %d %.200s", how, rec.Code, rec.Body)
		}
	}
}

// 正しい本文のうち最大のもの（500 件 × 2000 文字。1 文字 3 バイト）は通る。上限（4 MiB）に収まり、約 3 MB。
func TestLargestLegitimateChatBodyIsAccepted(t *testing.T) {
	h, c := chatHandler(t)
	one := `{"role":"user","content":"` + strings.Repeat("あ", 2000) + `"}`
	body := `{"messages":[` + strings.TrimSuffix(strings.Repeat(one+",", 500), ",") + `]}`
	if len(body) < 3_000_000 || len(body) > 3_100_000 {
		t.Fatalf("最大の正しい本文が %d バイト（約 3.02 MB のはず）", len(body))
	}
	for _, chunked := range []bool{false, true} {
		c.got = nil
		rec := postChat(h, body, chunked)
		if rec.Code != 200 || len(c.got) != 500 || len([]rune(c.got[499].Content)) != 2000 {
			t.Errorf("chunked=%v: %d（渡した件数 %d）%.200s", chunked, rec.Code, len(c.got), rec.Body)
		}
	}
	// 501 件は、上限ではなく件数の検査で 422（Python と同じ）
	rec := postChat(h, `{"messages":[`+strings.TrimSuffix(strings.Repeat(`{"role":"user","content":"x"},`, 501), ",")+`]}`, false)
	if rec.Code != 422 {
		t.Errorf("501 件: %d", rec.Code)
	}
}

// 上限を超える本文は、読まずに断る（長さの申告があるとき）。復号のメモリーを使わせない。
func TestOversizedBodyIsRefusedWithoutReadingIt(t *testing.T) {
	h, c := chatHandler(t)
	req := httptest.NewRequest(http.MethodPost, "/api/chat", &neverRead{t: t})
	req.Header.Set("Content-Type", "application/json")
	req.ContentLength = 8 << 20 // 申告だけで、中身は読ませない
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 413 || c.got != nil {
		t.Errorf("%d %.200s", rec.Code, rec.Body)
	}
}

type neverRead struct{ t *testing.T }

func (n *neverRead) Read([]byte) (int, error) {
	n.t.Error("上限を超える申告なのに、本文を読んだ")
	return 0, nil
}
