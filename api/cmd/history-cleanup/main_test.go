package main

import (
	"bytes"
	"context"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"townscan/api/internal/store"
	"townscan/api/internal/testdb"
)

// 保存期間の掃除のコマンド（仕様 §2.3.8）。既定は件数の表示だけ・--apply で消す・件数以外（ID・題名）は出さない・終了コード 0/1/2。

func prepare(t *testing.T) (url string, exec func(sql string, args ...any)) {
	t.Helper()
	url = testdb.URL(t)
	ctx := context.Background()
	st, err := store.Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	if err := st.ApplySchema(ctx); err != nil {
		t.Fatal(err)
	}
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close(ctx) })
	exec = func(sql string, args ...any) {
		t.Helper()
		if _, err := conn.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}
	exec(`INSERT INTO auth_user (id, name, email, "emailVerified") VALUES ('secret-user-01', 'n', 'secret@example.test', false)`)
	for _, c := range []struct{ id, age string }{{"secret-conv-old", "10 days"}, {"secret-conv-edge", "6 days"}, {"secret-conv-new", "0 days"}} {
		exec("INSERT INTO conversations (user_id, id, title, updated_at) VALUES ('secret-user-01', $1, '秘密の題名', now() - $2::interval)", c.id, c.age)
		exec(`INSERT INTO conversation_messages (user_id, conversation_id, seq, role, content) VALUES ('secret-user-01', $1, 0, 'user', '秘密の質問')`, c.id)
	}
	return url, exec
}

func runCmd(t *testing.T, url string, args ...string) (code int, out, errOut string) {
	t.Helper()
	var so, se bytes.Buffer
	code = run(context.Background(), args, func(k string) string {
		if k == "DATABASE_URL" {
			return url
		}
		return ""
	}, &so, &se)
	return code, so.String(), se.String()
}

func countRows(t *testing.T, url string) int {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	var n int
	if err := conn.QueryRow(ctx, "SELECT count(*) FROM conversations").Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestDefaultOnlyCountsAndDeletesNothing(t *testing.T) {
	url, _ := prepare(t)
	code, out, errOut := runCmd(t, url, "--older-than-days", "7")
	if code != 0 || errOut != "" {
		t.Fatalf("code=%d err=%q", code, errOut)
	}
	if !strings.Contains(out, "会話 1 件・発言 1 件（最後の動きが 7 日より前）") || !strings.Contains(out, "何も消していません") {
		t.Errorf("出力 = %s", out)
	}
	if n := countRows(t, url); n != 3 {
		t.Errorf("数えただけで消えた: %d 件", n)
	}
	// 既定の日数は 7
	if _, out, _ := runCmd(t, url); !strings.Contains(out, "7 日より前") {
		t.Errorf("既定の日数 = %s", out)
	}
}

func TestApplyDeletesOnlyTheStaleConversations(t *testing.T) {
	url, _ := prepare(t)
	code, out, errOut := runCmd(t, url, "--older-than-days", "7", "--apply")
	if code != 0 || errOut != "" || !strings.Contains(out, "消しました: 会話 1 件") {
		t.Fatalf("code=%d out=%s err=%q", code, out, errOut)
	}
	if n := countRows(t, url); n != 2 {
		t.Errorf("残り = %d 件", n)
	}
	// 二度目は、対象が無い
	if _, out, _ := runCmd(t, url, "--older-than-days", "7", "--apply"); !strings.Contains(out, "消しました: 会話 0 件") {
		t.Errorf("二度目 = %s", out)
	}
}

func TestOutputHasCountsOnly(t *testing.T) {
	url, _ := prepare(t)
	_, out, errOut := runCmd(t, url, "--apply")
	for _, secret := range []string{"secret-user", "secret-conv", "秘密の", "secret@"} {
		if strings.Contains(out+errOut, secret) {
			t.Errorf("%q が出力に出ている: %s%s", secret, out, errOut)
		}
	}
}

func TestUsageErrorsExitWith2(t *testing.T) {
	url, _ := prepare(t)
	for _, args := range [][]string{{"--older-than-days", "0"}, {"--older-than-days", "-3"}, {"--older-than-days", "x"}, {"extra"}, {"--unknown"}} {
		if code, _, _ := runCmd(t, url, args...); code != 2 {
			t.Errorf("%v: code = %d", args, code)
		}
	}
	if n := countRows(t, url); n != 3 {
		t.Errorf("使い方の誤りで消えた: %d", n)
	}
	var so, se bytes.Buffer
	if code := run(context.Background(), nil, func(string) string { return "" }, &so, &se); code != 2 || !strings.Contains(se.String(), "DATABASE_URL") {
		t.Errorf("DATABASE_URL 未設定: code=%d %s", code, se.String())
	}
}

func TestDBFailureExitsWith1AndNamesOnlyTheKind(t *testing.T) {
	url := "postgresql://u:pw-SECRET@127.0.0.1:1/db?connect_timeout=1" // 届かない
	code, _, errOut := runCmd(t, url)
	if code != 1 || !strings.Contains(errOut, "DB の処理に失敗しました") {
		t.Errorf("code=%d %s", code, errOut)
	}
	for _, leaked := range []string{"pw-SECRET", "127.0.0.1", "postgresql://"} {
		if strings.Contains(errOut, leaked) {
			t.Errorf("%q がエラーに出ている: %s", leaked, errOut)
		}
	}
	// 表が無い DB（API がまだスキーマを適用していない）も、DB の失敗として 1
	empty := testdb.URL(t)
	if code, _, _ := runCmd(t, empty); code != 1 {
		t.Errorf("表が無い: code = %d", code)
	}
}
