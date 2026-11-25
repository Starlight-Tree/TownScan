package store

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"townscan/api/internal/testdb"
)

// DB の statement_timeout（1 つの文の実行時間の上限）。接続ごとに設定する（WithStatementTimeout）。DB のテストなので、scripts/test-go.sh で流す。

func openWith(t *testing.T, url string, opts ...Option) *Store {
	t.Helper()
	s, err := Open(context.Background(), url, opts...)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	return s
}

func showTimeout(t *testing.T, s *Store) string {
	t.Helper()
	var got string
	if err := s.pool.QueryRow(context.Background(), "SHOW statement_timeout").Scan(&got); err != nil {
		t.Fatal(err)
	}
	return got
}

func TestStatementTimeoutIsSetOnEveryConnection(t *testing.T) {
	url := testdb.URL(t)
	s := openWith(t, url, WithStatementTimeout(27*time.Second))
	if got := showTimeout(t, s); got != "27s" {
		t.Errorf("statement_timeout = %q、期待 27s", got)
	}
	// 接続が複数に増えても、どの接続も同じ（プールは、最大 4 本）
	ctx := context.Background()
	conns := make([]interface{ Release() }, 0, 4)
	for i := 0; i < 4; i++ {
		c, err := s.pool.Acquire(ctx)
		if err != nil {
			t.Fatal(err)
		}
		conns = append(conns, c)
		var got string
		if err := c.QueryRow(ctx, "SHOW statement_timeout").Scan(&got); err != nil || got != "27s" {
			t.Errorf("%d 本目: %q %v", i+1, got, err)
		}
	}
	for _, c := range conns {
		c.Release()
	}
}

func TestNoStatementTimeoutUnlessAsked(t *testing.T) {
	url := testdb.URL(t)
	if got := showTimeout(t, openWith(t, url)); got != "0" {
		t.Errorf("既定 = %q、期待 0（無し）", got)
	}
	if got := showTimeout(t, openWith(t, url, WithStatementTimeout(0))); got != "0" {
		t.Errorf("0 = %q", got)
	}
	if got := showTimeout(t, openWith(t, url, WithStatementTimeout(-time.Second))); got != "0" {
		t.Errorf("負 = %q", got)
	}
}

// 接続文字列（DATABASE_URL）に statement_timeout があれば、そちらを優先する。
func TestStatementTimeoutInTheConnectionStringWins(t *testing.T) {
	url := testdb.URL(t)
	sep := "?"
	if strings.Contains(url, "?") {
		sep = "&"
	}
	s := openWith(t, url+sep+"statement_timeout=5000", WithStatementTimeout(27*time.Second))
	if got := showTimeout(t, s); got != "5s" {
		t.Errorf("statement_timeout = %q、期待 5s", got)
	}
}

// 期限を超えた文は、DB が取り消す。API からは、DB に届かないのと同じ扱い（503 db_unavailable）。プールは、そのあとも使える。
func TestStatementTimeoutCancelsALongStatement(t *testing.T) {
	s := openWith(t, testdb.URL(t), WithStatementTimeout(300*time.Millisecond))
	ctx := context.Background()
	start := time.Now()
	_, err := s.pool.Exec(ctx, "SELECT pg_sleep(10)")
	if err == nil {
		t.Fatal("取り消されなかった")
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Errorf("取り消しまで %v", elapsed)
	}
	if classified := classify(err); !errors.Is(classified, ErrUnavailable) {
		t.Errorf("classify(%v) = %v（ErrUnavailable のはず）", err, classified)
	}
	var one int
	if err := s.pool.QueryRow(ctx, "SELECT 1").Scan(&one); err != nil || one != 1 {
		t.Errorf("取り消しのあと: %v", err)
	}
	// 短い文は、影響を受けない
	if _, err := s.pool.Exec(ctx, "SELECT pg_sleep(0.05)"); err != nil {
		t.Errorf("短い文: %v", err)
	}
}

func TestOpenKeepsItsErrorsFreeOfTheConnectionString(t *testing.T) {
	_, err := Open(context.Background(), "postgresql://u:pw-secret-marker@h:notaport/x", WithStatementTimeout(time.Second))
	if err == nil || strings.Contains(err.Error(), "pw-secret-marker") {
		t.Errorf("err = %v", err)
	}
}
