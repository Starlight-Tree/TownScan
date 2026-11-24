package store

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"
)

// ErrUnavailable は、DB に届かない・接続を取れないときのエラー（errors.Is で調べる）。
// backend では psycopg.OperationalError と PoolTimeout にあたり、API は 503 db_unavailable にする。
var ErrUnavailable = errors.New("DB に接続できません")

// unavailableError は、ErrUnavailable に当たる、もとのエラーの包み。
// Error() は、もとの文を出さない（接続文字列の一部・ホスト名などを、ログ・メッセージへ運ばないため）。型の名前だけを持つ。
type unavailableError struct {
	kind  string
	cause error
}

func (e *unavailableError) Error() string { return "DB に接続できません（" + e.kind + "）" }
func (e *unavailableError) Is(target error) bool {
	return target == ErrUnavailable
}
func (e *unavailableError) Unwrap() error { return e.cause }

// Kind は、エラーの型の名前（PgError なら SQLSTATE も）。ログ・起動の失敗の文に出す。値・接続先は含まない。
func Kind(err error) string {
	var u *unavailableError
	if errors.As(err, &u) {
		return u.kind
	}
	return describe(err)
}

// 接続・資源・運用の状態によるエラー（SQLSTATE のクラス）。psycopg が OperationalError にするクラスと同じ:
// 08 接続の例外・40 トランザクションの巻き戻し・53 資源不足・54 制限超過・57 運用者の介入（停止など）・58 システムのエラー・F0 設定ファイル
var operationalClasses = []string{"08", "40", "53", "54", "57", "58", "F0"}

// classify は、pgx・ネットワークのエラーを、API が扱う形にする。DB に届かない類（Python の OperationalError・PoolTimeout）だけを
// ErrUnavailable に当たる包みにし、それ以外（SQL の誤り・値の型の不一致など）はそのまま返す。
func classify(err error) error {
	if err == nil {
		return nil
	}
	if unavailable(err) {
		return &unavailableError{kind: describe(err), cause: err}
	}
	return err
}

func unavailable(err error) bool {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		for _, c := range operationalClasses {
			if strings.HasPrefix(pgErr.Code, c) {
				return true
			}
		}
		return false
	}
	var connectErr *pgconn.ConnectError
	var netErr net.Error
	switch {
	case errors.As(err, &connectErr),
		errors.As(err, &netErr),
		errors.Is(err, io.EOF), errors.Is(err, io.ErrUnexpectedEOF),
		errors.Is(err, pgconn.ErrConnClosed),
		pgconn.SafeToRetry(err), pgconn.Timeout(err),
		errors.Is(err, context.DeadlineExceeded): // プールから接続を取れないまま、待ち時間（10 秒）が過ぎた（PoolTimeout）
		return true
	}
	// 閉じたプール（puddle の "closed pool"）。プールが閉じているのは、DB が使えないのと同じ扱い
	return strings.Contains(err.Error(), "closed pool")
}

// describe は、エラーの型の名前（PgError なら SQLSTATE も）。値・接続先は含めない。
func describe(err error) string {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return fmt.Sprintf("%T SQLSTATE=%s", pgErr, pgErr.Code)
	}
	return fmt.Sprintf("%T", err)
}
