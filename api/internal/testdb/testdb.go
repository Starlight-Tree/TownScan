// Package testdb は、DB を使うテストが、テストごとに新しいデータベースを作るための部品（テストからだけ使う）。
//
// 環境変数 TEST_DATABASE_URL（使い捨ての Postgres への接続。scripts/test-go.sh が用意する）が無いときは、テストを skip する。
// テストごとに別のデータベースを作るので、パッケージを並べて流しても（go test ./...）、互いの行を消さない。
package testdb

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// URL は、新しい空のデータベースへの接続文字列を返す（テストの終わりに、そのデータベースを消す）。
func URL(t testing.TB) string {
	t.Helper()
	base := os.Getenv("TEST_DATABASE_URL")
	if base == "" {
		t.Skip("TEST_DATABASE_URL が未設定のため DB のテストを飛ばします（scripts/test-go.sh で実行してください）")
	}
	u, err := url.Parse(base)
	if err != nil {
		t.Fatalf("TEST_DATABASE_URL を読めません: %v", err)
	}
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatal(err)
	}
	name := "tsgo_" + hex.EncodeToString(b[:])

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	admin, err := pgx.Connect(ctx, base)
	if err != nil {
		t.Fatalf("テスト用の DB に接続できません: %v", err)
	}
	defer admin.Close(ctx)
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatalf("テスト用のデータベースを作れません: %v", err)
	}
	t.Cleanup(func() {
		cctx, ccancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer ccancel()
		c, err := pgx.Connect(cctx, base)
		if err != nil {
			t.Logf("後始末: 接続できません: %v", err)
			return
		}
		defer c.Close(cctx)
		if _, err := c.Exec(cctx, "DROP DATABASE IF EXISTS "+name+" WITH (FORCE)"); err != nil {
			t.Logf("後始末: %s を消せません: %v", name, err)
		}
	})
	u.Path = "/" + name
	return u.String()
}
