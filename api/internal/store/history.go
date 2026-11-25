package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

// 会話の履歴（仕様 docs/spec-prototype.md §2.3。表は sql/history.sql）。ログイン中だけ。Go の API だけが使う。
//
// SQL は、store.go と同じく、値を必ずパラメータ（$1…）で渡す。質問・回答・題名・会話 ID・利用者 ID は、エラーの文にもログにも入れない
// （呼び出し側が出すのは Kind だけ）。利用者は、検証に通った JWT の sub だけから決まる（呼び出し側が渡す）。

const (
	// 一覧の件数と、1 人あたりの会話の数（保存時に、これを超えた分を古い順に消す。一覧の上限と同じ値にそろえる）
	MaxConversationsPerUser = 50
	// 1 会話の発言数の上限。1 往復で 2 件増える。保存済みがこの値の会話に、続きは送れない
	MaxStoredMessages = 500
)

// historyLockClass は、同じ人の保存を順に並べる助言ロックの前半（schemaLockKey の 704218001 とは別の値）。後半は hashtext(利用者 ID)。
const historyLockClass int32 = 704_218_002

var (
	// ErrConversationUserMissing は、保存の段で、利用者の行（auth_user）が無かったとき（外部キー conversations_user_fk の違反）。呼び出し側は 401。
	// LLM を呼ぶ前の存在の確認（ConversationPrecheck）のあとに、行が消えた競合だけで起きる。
	ErrConversationUserMissing = errors.New("会話の持ち主の行がありません")
	// ErrConversationFull は、1 会話の発言数の上限（MaxStoredMessages）に達していて、もう 1 往復は入らないとき。呼び出し側は 422 conversation_full。
	ErrConversationFull = errors.New("会話の発言数が上限です")
)

// ConversationSummary は、一覧の 1 件。
type ConversationSummary struct {
	ID        string
	Title     string
	CreatedAt time.Time
	UpdatedAt time.Time
}

// StoredMessage は、保存した発言 1 件。回答のときだけ Results・ToolCalls（JSON の配列）・RunCreatedAt が入る。
type StoredMessage struct {
	Role         string
	Content      string
	Results      json.RawMessage
	ToolCalls    json.RawMessage
	RunCreatedAt *time.Time
}

// Turn は、保存する 1 往復（質問 1 件と、その回答 1 件）。
type Turn struct {
	UserID         string
	ConversationID string
	// Title は、会話を作るときだけ使う（既存の会話では変えない）
	Title    string
	Question string
	Answer   string
	// Results・ToolCalls は、回答（chat の message）が持つ値を、JSON の配列にしたもの。サーバーが作った値だけ（画面から来た値は入れない）
	Results   json.RawMessage
	ToolCalls json.RawMessage
	// RunCreatedAt は、回答を作ったときに読んだ run の created_at（run が無かったら nil）
	RunCreatedAt *time.Time
}

// ConversationPrecheck は、LLM を呼ぶ前の確認（読み取りだけ。ロックを持たない）: 利用者の行（auth_user）があるか、
// この会話に保存済みの発言が何件あるか。1 つの SELECT（副問い合わせ 2 つ）。
func (s *Store) ConversationPrecheck(ctx context.Context, userID, conversationID string) (userExists bool, stored int, err error) {
	c, err := s.conn(ctx)
	if err != nil {
		return false, 0, err
	}
	defer c.Release()
	err = c.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM auth_user WHERE id = $1),
		        (SELECT count(*) FROM conversation_messages WHERE user_id = $1 AND conversation_id = $2)`,
		userID, conversationID).Scan(&userExists, &stored)
	if err != nil {
		return false, 0, classify(err)
	}
	return userExists, stored, nil
}

// SaveTurn は、1 往復を、本人の会話に追記する（無ければ作る）。1 つのトランザクション（LLM を待つあいだは、ロックを持たない）。
// 手順は、仕様 §2.3.3 のとおり: 同じ人の保存を順に並べる → 会話の行を原子的に作る・更新する → 次の seq を決める → 2 行を入れる →
// 1 人 50 件を超えた分を古い順に消す → コミット。
// 利用者の行が無ければ ErrConversationUserMissing、上限なら ErrConversationFull（どちらも何も保存しない）。ほかは classify したエラー。
func (s *Store) SaveTurn(ctx context.Context, t Turn) error {
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

	// 1. 同じ人の保存を順に並べる（1 人 50 件の整理が、同じ人の別の保存と鍵を取り合って、デッドロックにならないように）
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1, hashtext($2))", historyLockClass, t.UserID); err != nil {
		return classify(err)
	}
	// 2. 行の作成と、既存の行のロックと更新を、1 文で原子的に行う。title は作るときだけ入り、既存の行では変えない。
	//    clock_timestamp() で書く（now() はトランザクションの開始時刻で、同じ会話への同時の書き込みが後から来ると、時刻が逆戻りしうる）
	if _, err := tx.Exec(ctx,
		`INSERT INTO conversations (user_id, id, title, created_at, updated_at)
		 VALUES ($1, $2, $3, clock_timestamp(), clock_timestamp())
		 ON CONFLICT (user_id, id) DO UPDATE SET updated_at = clock_timestamp()`,
		t.UserID, t.ConversationID, t.Title); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23503" && pgErr.ConstraintName == "conversations_user_fk" {
			return ErrConversationUserMissing
		}
		return classify(err)
	}
	// 3. 次の seq。行がロック済みなので、同時の書き込みと重ならない。上限は、LLM を呼ぶ前の確認をすり抜けた競合のための数え直し
	var count, next int
	if err := tx.QueryRow(ctx,
		"SELECT count(*), coalesce(max(seq), -1) + 1 FROM conversation_messages WHERE user_id = $1 AND conversation_id = $2",
		t.UserID, t.ConversationID).Scan(&count, &next); err != nil {
		return classify(err)
	}
	if count+2 > MaxStoredMessages {
		return ErrConversationFull // 巻き戻す（defer の Rollback。会話の行の作成・更新も取り消される）
	}
	// 4. 質問と回答の 2 行
	if _, err := tx.Exec(ctx,
		"INSERT INTO conversation_messages (user_id, conversation_id, seq, role, content) VALUES ($1, $2, $3, 'user', $4)",
		t.UserID, t.ConversationID, next, t.Question); err != nil {
		return classify(err)
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO conversation_messages (user_id, conversation_id, seq, role, content, results, tool_calls, run_created_at)
		 VALUES ($1, $2, $3, 'assistant', $4, $5, $6, $7)`,
		t.UserID, t.ConversationID, next+1, t.Answer, []byte(t.Results), []byte(t.ToolCalls), t.RunCreatedAt); err != nil {
		return classify(err)
	}
	// 5. 1 人 50 件の整理。いま保存した会話は先頭で、id <> $2 でも守る
	if _, err := tx.Exec(ctx,
		`DELETE FROM conversations
		  WHERE user_id = $1 AND id <> $2
		    AND id IN (SELECT id FROM conversations WHERE user_id = $1 ORDER BY updated_at DESC, id ASC OFFSET $3)`,
		t.UserID, t.ConversationID, MaxConversationsPerUser); err != nil {
		return classify(err)
	}
	return classify(tx.Commit(ctx))
}

// ListConversations は、本人の会話を、更新が新しい順（同時刻は id の昇順）に、MaxConversationsPerUser 件まで。無ければ空。
func (s *Store) ListConversations(ctx context.Context, userID string) ([]ConversationSummary, error) {
	c, err := s.conn(ctx)
	if err != nil {
		return nil, err
	}
	defer c.Release()
	rows, err := c.Query(ctx,
		"SELECT id, title, created_at, updated_at FROM conversations WHERE user_id = $1 ORDER BY updated_at DESC, id ASC LIMIT $2",
		userID, MaxConversationsPerUser)
	if err != nil {
		return nil, classify(err)
	}
	defer rows.Close()
	out := []ConversationSummary{}
	for rows.Next() {
		var v ConversationSummary
		if err := rows.Scan(&v.ID, &v.Title, &v.CreatedAt, &v.UpdatedAt); err != nil {
			return nil, classify(err)
		}
		out = append(out, v)
	}
	return out, classify(rows.Err())
}

// ConversationMessages は、本人の会話の発言を、古い順（seq の昇順）に返す。会話が無い（他人の会話を含む）ときは found=false。
// 見るだけで、updated_at は更新しない。
func (s *Store) ConversationMessages(ctx context.Context, userID, conversationID string) (msgs []StoredMessage, found bool, err error) {
	c, err := s.conn(ctx)
	if err != nil {
		return nil, false, err
	}
	defer c.Release()
	if err := c.QueryRow(ctx,
		"SELECT EXISTS (SELECT 1 FROM conversations WHERE user_id = $1 AND id = $2)", userID, conversationID).Scan(&found); err != nil {
		return nil, false, classify(err)
	}
	if !found {
		return nil, false, nil
	}
	rows, err := c.Query(ctx,
		`SELECT role, content, results, tool_calls, run_created_at
		   FROM conversation_messages WHERE user_id = $1 AND conversation_id = $2 ORDER BY seq ASC`,
		userID, conversationID)
	if err != nil {
		return nil, false, classify(err)
	}
	defer rows.Close()
	msgs = []StoredMessage{}
	for rows.Next() {
		var m StoredMessage
		var results, calls []byte
		if err := rows.Scan(&m.Role, &m.Content, &results, &calls, &m.RunCreatedAt); err != nil {
			return nil, false, classify(err)
		}
		m.Results, m.ToolCalls = results, calls
		msgs = append(msgs, m)
	}
	return msgs, true, classify(rows.Err())
}

// DeleteConversation は、本人の会話を 1 件、物理的に消す（発言は CASCADE）。消したら true、無い（他人の会話を含む）なら false。
func (s *Store) DeleteConversation(ctx context.Context, userID, conversationID string) (bool, error) {
	c, err := s.conn(ctx)
	if err != nil {
		return false, err
	}
	defer c.Release()
	tag, err := c.Exec(ctx, "DELETE FROM conversations WHERE user_id = $1 AND id = $2", userID, conversationID)
	if err != nil {
		return false, classify(err)
	}
	return tag.RowsAffected() > 0, nil
}

// StaleConversations は、保存期間の掃除の対象の数（最後の動き updated_at が、いまから days 日より前の会話と、その発言）。
func (s *Store) StaleConversations(ctx context.Context, days int) (conversations, messages int64, err error) {
	c, err := s.conn(ctx)
	if err != nil {
		return 0, 0, err
	}
	defer c.Release()
	err = c.QueryRow(ctx,
		`SELECT (SELECT count(*) FROM conversations WHERE updated_at < now() - make_interval(days => $1)),
		        (SELECT count(*) FROM conversation_messages m JOIN conversations c ON c.user_id = m.user_id AND c.id = m.conversation_id
		          WHERE c.updated_at < now() - make_interval(days => $1))`,
		days).Scan(&conversations, &messages)
	if err != nil {
		return 0, 0, classify(err)
	}
	return conversations, messages, nil
}

// DeleteStaleConversations は、保存期間を過ぎた会話を物理的に消す（発言は CASCADE）。消した会話の数を返す。
func (s *Store) DeleteStaleConversations(ctx context.Context, days int) (int64, error) {
	c, err := s.conn(ctx)
	if err != nil {
		return 0, err
	}
	defer c.Release()
	tag, err := c.Exec(ctx, "DELETE FROM conversations WHERE updated_at < now() - make_interval(days => $1)", days)
	if err != nil {
		return 0, classify(err)
	}
	return tag.RowsAffected(), nil
}
