package store

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"time"
)

// DB の定義。pipeline/sql/schema.sql・pipeline/sql/auth.sql（ローダーが使う）の写し。
// store_test.go の TestSchemaMatchesLoaderCopy が、同じ内容かを確かめる。どちらも何度流しても同じ（IF NOT EXISTS）。
// auth.sql は、画面のサーバー（Better Auth）が使う表で、api が作る約束（spec-prototype §2.1）。

//go:embed sql/schema.sql
var schemaSQL string

//go:embed sql/auth.sql
var authSQL string

// history.sql は、会話の履歴の表（Go の API だけが使う。pipeline/sql/ に写しは無い）。auth_user を参照するので、authSQL のあとに流す。
//
//go:embed sql/history.sql
var historySQL string

// 同時に流れても（api の起動とローダー）スキーマ適用が競合しないための鍵。pipeline/db.py の _SCHEMA_LOCK_KEY と同じ値
const schemaLockKey int64 = 704_218_001

// ApplySchema は、schema.sql・auth.sql・history.sql を、この順に 1 つのトランザクションで流す。どれも冪等（既存の表・行は変えない）なので、
// すでにあるボリュームにも、起動のたびに流してよい。SQL の誤りはエラーのまま返す（起動を止める）。
func (s *Store) ApplySchema(ctx context.Context) error {
	c, err := s.conn(ctx)
	if err != nil {
		return err
	}
	defer c.Release()
	tx, err := c.Begin(ctx)
	if err != nil {
		return classify(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", schemaLockKey); err != nil {
		return classify(err)
	}
	for _, sql := range []string{schemaSQL, authSQL, historySQL} {
		// 引数なしの Exec は単純プロトコルで送られ、複数の文を 1 度に流せる
		if _, err := tx.Exec(ctx, sql); err != nil {
			return classify(err)
		}
	}
	return classify(tx.Commit(ctx))
}

// WaitAndApplySchema は、DB がまだ起きていないときに備えて、数回やり直す（compose では healthy を待つが、念のため）。
// やり直すのは、接続できないとき（ErrUnavailable）だけ。SQL の誤りは、すぐ失敗させる。
func (s *Store) WaitAndApplySchema(ctx context.Context, attempts int, delay time.Duration, logf func(format string, args ...any)) error {
	var last error
	for i := 1; i <= attempts; i++ {
		err := s.ApplySchema(ctx)
		if err == nil {
			return nil
		}
		if !errors.Is(err, ErrUnavailable) {
			return err
		}
		last = err
		if logf != nil {
			logf("スキーマの適用に失敗（%d/%d）: %s", i, attempts, Kind(err))
		}
		if i == attempts {
			break
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(delay):
		}
	}
	return fmt.Errorf("DB に接続してスキーマを適用できませんでした: %s", Kind(last))
}
