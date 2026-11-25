// history-cleanup は、保存期間を過ぎた会話の履歴を消す、運用者のコマンド（仕様 docs/spec-prototype.md §2.3.8。DocuNavi の app.history_admin と同じ形）。
//
// 最後の動き（conversations.updated_at）が、いまから N 日より前の会話を、発言ごと物理的に消す。
// **既定は、件数の表示だけで、何も消さない。`--apply` を付けたときだけ消す。** 表示するのは件数だけで、利用者 ID・会話 ID・題名は出さない。
// 期限を過ぎた会話は、このコマンドを流すまで残る（API は、期限を理由に隠さない。定期実行の仕組みは、公開の前に決める）。
//
// 使い方:
//
//	history-cleanup [--older-than-days N] [--apply]      N は 1 以上（既定 7）。DB は環境変数 DATABASE_URL
//
// 終了コード: 0 = 完了、1 = DB の失敗、2 = 使い方の誤り・DATABASE_URL が未設定。
// 表は API の起動が作る（このコマンドは作らない。表が無ければ、DB の失敗として 1 で終わる）。
// Docker では、API のイメージに入っている: docker compose run --rm --entrypoint /history-cleanup api --older-than-days 7
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"townscan/api/internal/store"
)

const (
	defaultDays = 7
	// 1 つの文の実行時間の上限（API と同じ値ではなく、保守コマンドなので余裕を持たせる）
	statementTimeout = 5 * time.Minute
)

func main() {
	ctx := context.Background()
	os.Exit(run(ctx, os.Args[1:], os.Getenv, os.Stdout, os.Stderr))
}

// run は main の本体。終了コードを返す。
func run(ctx context.Context, args []string, getenv func(string) string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("history-cleanup", flag.ContinueOnError)
	fs.SetOutput(stderr)
	days := fs.Int("older-than-days", defaultDays, "最後の動きがこの日数より前の会話が対象（1 以上）")
	apply := fs.Bool("apply", false, "実際に消す（付けなければ、件数の表示だけ）")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() > 0 {
		_, _ = fmt.Fprintf(stderr, "使い方の誤り: 余分な引数があります\n")
		return 2
	}
	if *days < 1 {
		_, _ = fmt.Fprintf(stderr, "使い方の誤り: --older-than-days は 1 以上です（実際: %d）\n", *days)
		return 2
	}
	dsn := strings.TrimSpace(getenv("DATABASE_URL"))
	if dsn == "" {
		_, _ = fmt.Fprintln(stderr, "環境変数 DATABASE_URL が未設定です")
		return 2
	}
	st, err := store.Open(ctx, dsn, store.WithStatementTimeout(statementTimeout))
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "起動できません: %v\n", err) // Open のエラーの文には、接続文字列を入れない
		return 2
	}
	defer st.Close()

	conversations, messages, err := st.StaleConversations(ctx, *days)
	if err != nil {
		return failed(stderr, err)
	}
	_, _ = fmt.Fprintf(stdout, "対象: 会話 %d 件・発言 %d 件（最後の動きが %d 日より前）\n", conversations, messages, *days)
	if !*apply {
		_, _ = fmt.Fprintln(stdout, "何も消していません。消すときは --apply を付けてください")
		return 0
	}
	deleted, err := st.DeleteStaleConversations(ctx, *days)
	if err != nil {
		return failed(stderr, err)
	}
	_, _ = fmt.Fprintf(stdout, "消しました: 会話 %d 件（発言も一緒に）\n", deleted)
	return 0
}

// failed は、DB の失敗を、種類だけで書く（エラーの文には、接続先・値が入りうる）。
func failed(stderr io.Writer, err error) int {
	if errors.Is(err, context.Canceled) {
		_, _ = fmt.Fprintln(stderr, "中断しました")
		return 1
	}
	_, _ = fmt.Fprintf(stderr, "DB の処理に失敗しました: %s\n", store.Kind(err))
	return 1
}
