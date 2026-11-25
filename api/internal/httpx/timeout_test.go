package httpx

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// Timeout: 1 回の要求の全体に期限を付ける（r.Context() の期限）。

func TestTimeoutPutsADeadlineOnTheRequestContext(t *testing.T) {
	var deadline time.Time
	var has bool
	h := Chain(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		deadline, has = r.Context().Deadline()
		w.WriteHeader(http.StatusNoContent)
	}), Timeout(27*time.Second))
	start := time.Now()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusNoContent || !has {
		t.Fatalf("状態 %d・期限あり=%v", rec.Code, has)
	}
	if d := deadline.Sub(start); d < 26*time.Second || d > 27*time.Second+time.Second {
		t.Errorf("期限まで %v、期待 27 秒", d)
	}
}

func TestTimeoutCancelsSlowWorkAtTheDeadline(t *testing.T) {
	var cause error
	h := Chain(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
			cause = r.Context().Err()
		case <-time.After(5 * time.Second):
		}
		w.WriteHeader(http.StatusServiceUnavailable)
	}), Timeout(100*time.Millisecond))
	start := time.Now()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if !errors.Is(cause, context.DeadlineExceeded) || time.Since(start) > 2*time.Second || rec.Code != 503 {
		t.Errorf("取り消し = %v・%v・%d", cause, time.Since(start), rec.Code)
	}
}

// 親の期限が短ければ、それを延ばさない。ハンドラーが期限の前に返れば、何も起きない。
func TestTimeoutDoesNotExtendAShorterParentDeadline(t *testing.T) {
	var got time.Time
	h := Timeout(time.Hour)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { got, _ = r.Context().Deadline() }))
	parent, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	want, _ := parent.Deadline()
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", nil).WithContext(parent))
	if !got.Equal(want) {
		t.Errorf("期限 = %v、期待 %v（親の期限）", got, want)
	}
}
