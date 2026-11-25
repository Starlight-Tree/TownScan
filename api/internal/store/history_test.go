package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"
)

// 会話の履歴の保存・一覧・発言・削除・整理・掃除（history.go。仕様 §2.3）。DB を使う（scripts/test-go.sh。TEST_DATABASE_URL が無ければ skip）。

func seedUser(t *testing.T, s *Store, id string) {
	t.Helper()
	exec(t, s, `INSERT INTO auth_user (id, name, email, "emailVerified") VALUES ($1, 'name', $1 || '@example.test', false)`, id)
}

func turn(user, conv, question string) Turn {
	return Turn{
		UserID: user, ConversationID: conv, Title: question, Question: question, Answer: "答え: " + question,
		Results: json.RawMessage(`[{"type":"count","count":5.5}]`), ToolCalls: json.RawMessage(`[{"name":"count_candidates","args":{}}]`),
	}
}

func count(t *testing.T, s *Store, sql string, args ...any) int {
	t.Helper()
	var n int
	if err := s.pool.QueryRow(context.Background(), sql, args...).Scan(&n); err != nil {
		t.Fatalf("%s: %v", sql, err)
	}
	return n
}

func TestSaveTurnCreatesAConversationAndAppendsToIt(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	seedUser(t, s, "user-0001")
	run := time.Date(2026, 11, 24, 3, 0, 0, 0, time.UTC)
	first := turn("user-0001", "conv-a", "新規出現は何件？")
	first.RunCreatedAt = &run
	if err := s.SaveTurn(ctx, first); err != nil {
		t.Fatal(err)
	}
	second := turn("user-0001", "conv-a", "では地区ごとは？")
	second.Title = "題名は作るときだけ" // 既存の会話では、題名を変えない
	if err := s.SaveTurn(ctx, second); err != nil {
		t.Fatal(err)
	}
	list, err := s.ListConversations(ctx, "user-0001")
	if err != nil || len(list) != 1 || list[0].ID != "conv-a" || list[0].Title != "新規出現は何件？" {
		t.Fatalf("一覧 = %+v, %v", list, err)
	}
	if !list[0].UpdatedAt.After(list[0].CreatedAt) {
		t.Errorf("updated_at が進んでいない: %v %v", list[0].CreatedAt, list[0].UpdatedAt)
	}
	msgs, found, err := s.ConversationMessages(ctx, "user-0001", "conv-a")
	if err != nil || !found || len(msgs) != 4 {
		t.Fatalf("発言 = %d 件, found=%v, %v", len(msgs), found, err)
	}
	for i, want := range []struct{ role, content string }{
		{"user", "新規出現は何件？"}, {"assistant", "答え: 新規出現は何件？"}, {"user", "では地区ごとは？"}, {"assistant", "答え: では地区ごとは？"},
	} {
		if msgs[i].Role != want.role || msgs[i].Content != want.content {
			t.Errorf("発言 %d = %s %q", i, msgs[i].Role, msgs[i].Content)
		}
	}
	// 質問は results・tool_calls・run_created_at を持たず、回答は配列で持つ。run_created_at は、回答を作った run のもの
	if msgs[0].Results != nil || msgs[0].ToolCalls != nil || msgs[0].RunCreatedAt != nil {
		t.Errorf("質問に回答の項目がある: %+v", msgs[0])
	}
	var results []map[string]any
	if err := json.Unmarshal(msgs[1].Results, &results); err != nil || len(results) != 1 || results[0]["count"] != 5.5 {
		t.Errorf("results = %s, %v", msgs[1].Results, err)
	}
	if msgs[1].RunCreatedAt == nil || !msgs[1].RunCreatedAt.Equal(run) || msgs[3].RunCreatedAt != nil {
		t.Errorf("run_created_at = %v / %v", msgs[1].RunCreatedAt, msgs[3].RunCreatedAt)
	}
}

func TestEachUserHasHisOwnConversationEvenWithTheSameID(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	seedUser(t, s, "user-0001")
	seedUser(t, s, "user-0002")
	if err := s.SaveTurn(ctx, turn("user-0001", "same-id", "A の質問")); err != nil {
		t.Fatal(err)
	}
	if err := s.SaveTurn(ctx, turn("user-0002", "same-id", "B の質問")); err != nil {
		t.Fatal(err)
	}
	for user, question := range map[string]string{"user-0001": "A の質問", "user-0002": "B の質問"} {
		msgs, found, err := s.ConversationMessages(ctx, user, "same-id")
		if err != nil || !found || len(msgs) != 2 || msgs[0].Content != question {
			t.Errorf("%s: %+v %v %v", user, msgs, found, err)
		}
	}
	// 他人は、削除も見ることもできない（無い会話と同じ）
	if _, found, _ := s.ConversationMessages(ctx, "user-0003", "same-id"); found {
		t.Error("他人の会話が見える")
	}
	if ok, err := s.DeleteConversation(ctx, "user-0003", "same-id"); ok || err != nil {
		t.Errorf("他人の会話を消せた: %v %v", ok, err)
	}
	if n := count(t, s, "SELECT count(*) FROM conversations"); n != 2 {
		t.Errorf("会話 = %d 件", n)
	}
}

func TestSaveTurnWithoutTheUserRowSavesNothingAndSaysSo(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	err := s.SaveTurn(ctx, turn("ghost-0001", "conv-a", "質問"))
	if !errors.Is(err, ErrConversationUserMissing) {
		t.Fatalf("err = %v", err)
	}
	if n := count(t, s, "SELECT count(*) FROM conversations") + count(t, s, "SELECT count(*) FROM conversation_messages"); n != 0 {
		t.Errorf("保存された行 = %d", n)
	}
	// LLM を呼ぶ前の確認は、利用者の行の有無を返す
	exists, stored, err := s.ConversationPrecheck(ctx, "ghost-0001", "conv-a")
	if err != nil || exists || stored != 0 {
		t.Errorf("precheck = %v %d %v", exists, stored, err)
	}
	seedUser(t, s, "user-0001")
	exists, _, err = s.ConversationPrecheck(ctx, "user-0001", "conv-a")
	if err != nil || !exists {
		t.Errorf("precheck = %v %v", exists, err)
	}
}

// 他の外部キー違反（conversations_user_fk 以外）を、利用者の行が無いこととは取り違えない。
func TestOtherConstraintFailuresAreNotReportedAsAMissingUser(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	seedUser(t, s, "user-0001")
	bad := turn("user-0001", "conv-a", "質問")
	bad.Results = json.RawMessage(`{}`) // 配列でない（CHECK 違反 23514）
	err := s.SaveTurn(ctx, bad)
	if err == nil || errors.Is(err, ErrConversationUserMissing) || errors.Is(err, ErrConversationFull) || errors.Is(err, ErrUnavailable) {
		t.Errorf("err = %v（コードの誤りとして、そのまま返す）", err)
	}
	if n := count(t, s, "SELECT count(*) FROM conversations"); n != 0 {
		t.Errorf("失敗した保存の会話の行が残った: %d", n)
	}
	// NUL は、text にも jsonb にも保存できない（だから API は LLM を呼ぶ前に 422 にする）
	nul := turn("user-0001", "conv-b", "候補は\x00何件")
	if err := s.SaveTurn(ctx, nul); err == nil || errors.Is(err, ErrUnavailable) {
		t.Errorf("NUL を保存できた・または DB の不調と見た: %v", err)
	}
}

func seedMessages(t *testing.T, s *Store, user, conv string, n int) {
	t.Helper()
	exec(t, s, "INSERT INTO conversations (user_id, id, title) VALUES ($1, $2, '題名')", user, conv)
	exec(t, s, `INSERT INTO conversation_messages (user_id, conversation_id, seq, role, content, results, tool_calls)
	            SELECT $1, $2, i, CASE WHEN i % 2 = 0 THEN 'user' ELSE 'assistant' END, 'x',
	                   CASE WHEN i % 2 = 1 THEN '[]'::jsonb END, CASE WHEN i % 2 = 1 THEN '[]'::jsonb END
	              FROM generate_series(0, $3 - 1) AS i`, user, conv, n)
}

func TestAConversationTakesAtMost500Messages(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	seedUser(t, s, "user-0001")
	seedMessages(t, s, "user-0001", "conv-a", 498)
	exists, stored, err := s.ConversationPrecheck(ctx, "user-0001", "conv-a")
	if err != nil || !exists || stored != 498 {
		t.Fatalf("precheck = %v %d %v", exists, stored, err)
	}
	if err := s.SaveTurn(ctx, turn("user-0001", "conv-a", "最後の往復")); err != nil { // 498 + 2 = 500
		t.Fatal(err)
	}
	before := count(t, s, "SELECT count(*) FROM conversation_messages")
	var updated time.Time
	if err := s.pool.QueryRow(ctx, "SELECT updated_at FROM conversations WHERE id = 'conv-a'").Scan(&updated); err != nil {
		t.Fatal(err)
	}
	if err := s.SaveTurn(ctx, turn("user-0001", "conv-a", "もう入らない")); !errors.Is(err, ErrConversationFull) {
		t.Fatalf("err = %v", err)
	}
	var after time.Time
	if err := s.pool.QueryRow(ctx, "SELECT updated_at FROM conversations WHERE id = 'conv-a'").Scan(&after); err != nil {
		t.Fatal(err)
	}
	if n := count(t, s, "SELECT count(*) FROM conversation_messages"); n != before || n != 500 || !after.Equal(updated) {
		t.Errorf("上限の拒否で変わった: 発言 %d→%d, updated_at %v→%v", before, n, updated, after)
	}
	// seq は 0〜499 が連続している
	var minSeq, maxSeq int
	if err := s.pool.QueryRow(ctx, "SELECT min(seq), max(seq) FROM conversation_messages WHERE conversation_id = 'conv-a'").Scan(&minSeq, &maxSeq); err != nil || minSeq != 0 || maxSeq != 499 {
		t.Errorf("seq = %d〜%d, %v", minSeq, maxSeq, err)
	}
}

func TestSavingKeepsAtMostFiftyConversationsPerUserAndDropsTheOldest(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	seedUser(t, s, "user-0001")
	seedUser(t, s, "user-0002")
	for i := 0; i < 55; i++ {
		if err := s.SaveTurn(ctx, turn("user-0001", fmt.Sprintf("conv-%02d", i), fmt.Sprintf("質問 %d", i))); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.SaveTurn(ctx, turn("user-0002", "other", "別の人")); err != nil {
		t.Fatal(err)
	}
	list, err := s.ListConversations(ctx, "user-0001")
	if err != nil || len(list) != MaxConversationsPerUser {
		t.Fatalf("一覧 = %d 件, %v", len(list), err)
	}
	if list[0].ID != "conv-54" || list[len(list)-1].ID != "conv-05" { // 新しい順。古い 5 件（00〜04）が消えた
		t.Errorf("先頭 %s・末尾 %s", list[0].ID, list[len(list)-1].ID)
	}
	if n := count(t, s, "SELECT count(*) FROM conversation_messages WHERE user_id = 'user-0001'"); n != 100 {
		t.Errorf("発言 = %d 件（消えた会話の発言も CASCADE で消える。残りは 50 会話 × 2）", n)
	}
	// 別の人は影響を受けない。いま保存した会話は、いつも残る
	if other, _ := s.ListConversations(ctx, "user-0002"); len(other) != 1 {
		t.Errorf("別の人の会話 = %d 件", len(other))
	}
	// 古い会話に追記すると、その会話は先頭になり、代わりに別の古い会話が消える
	if err := s.SaveTurn(ctx, turn("user-0001", "conv-05", "また話す")); err != nil {
		t.Fatal(err)
	}
	list, _ = s.ListConversations(ctx, "user-0001")
	if list[0].ID != "conv-05" || len(list) != 50 {
		t.Errorf("先頭 %s・%d 件", list[0].ID, len(list))
	}
}

func TestListIsNewestFirstWithTiesByID(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	seedUser(t, s, "user-0001")
	for _, id := range []string{"b", "c", "a"} {
		exec(t, s, "INSERT INTO conversations (user_id, id, title, updated_at) VALUES ('user-0001', $1, 't', '2026-11-20T00:00:00Z')", id)
	}
	exec(t, s, "INSERT INTO conversations (user_id, id, title, updated_at) VALUES ('user-0001', 'z-newest', 't', '2026-11-21T00:00:00Z')")
	list, err := s.ListConversations(ctx, "user-0001")
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, c := range list {
		ids = append(ids, c.ID)
	}
	if fmt.Sprint(ids) != "[z-newest a b c]" {
		t.Errorf("順 = %v", ids)
	}
	if empty, err := s.ListConversations(ctx, "nobody-01"); err != nil || empty == nil || len(empty) != 0 {
		t.Errorf("会話の無い人 = %v, %v（空の配列）", empty, err)
	}
}

func TestDeleteRemovesTheConversationAndItsMessages(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	seedUser(t, s, "user-0001")
	if err := s.SaveTurn(ctx, turn("user-0001", "conv-a", "質問")); err != nil {
		t.Fatal(err)
	}
	ok, err := s.DeleteConversation(ctx, "user-0001", "conv-a")
	if !ok || err != nil {
		t.Fatalf("削除 = %v %v", ok, err)
	}
	if again, _ := s.DeleteConversation(ctx, "user-0001", "conv-a"); again {
		t.Error("二度目も消せた（404 になるはず）")
	}
	if n := count(t, s, "SELECT count(*) FROM conversation_messages"); n != 0 {
		t.Errorf("発言が残っている: %d", n)
	}
	// 同じ ID でもう一度話しかけても、前の発言は戻らない
	if err := s.SaveTurn(ctx, turn("user-0001", "conv-a", "新しく")); err != nil {
		t.Fatal(err)
	}
	if msgs, _, _ := s.ConversationMessages(ctx, "user-0001", "conv-a"); len(msgs) != 2 {
		t.Errorf("発言 = %d 件", len(msgs))
	}
}

func TestDeletingTheUserRemovesTheirConversations(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	seedUser(t, s, "user-0001")
	seedUser(t, s, "user-0002")
	for _, u := range []string{"user-0001", "user-0002"} {
		if err := s.SaveTurn(ctx, turn(u, "conv-a", "質問")); err != nil {
			t.Fatal(err)
		}
	}
	exec(t, s, "DELETE FROM auth_user WHERE id = 'user-0001'")
	if n := count(t, s, "SELECT count(*) FROM conversations WHERE user_id = 'user-0001'") + count(t, s, "SELECT count(*) FROM conversation_messages WHERE user_id = 'user-0001'"); n != 0 {
		t.Errorf("消した利用者の行が残っている: %d", n)
	}
	if n := count(t, s, "SELECT count(*) FROM conversations WHERE user_id = 'user-0002'"); n != 1 {
		t.Errorf("別の人の会話 = %d", n)
	}
}

// 同じ人の同時の保存（会話が 50 件を超える整理つき）が、デッドロックにも欠けた往復にもならない。
func TestConcurrentSavesOfOneUserNeitherDeadlockNorLoseRows(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	seedUser(t, s, "user-0001")
	var wg sync.WaitGroup
	errs := make(chan error, 200)
	for w := 0; w < 8; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < 10; i++ { // 8 × 10 = 80 会話 > 50（整理が同時に走る）
				if err := s.SaveTurn(ctx, turn("user-0001", fmt.Sprintf("conv-%d-%d", w, i), "質問")); err != nil {
					errs <- err
				}
			}
		}(w)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Errorf("同時の保存が失敗: %v（%s）", err, Kind(err))
	}
	if n := count(t, s, "SELECT count(*) FROM conversations"); n != MaxConversationsPerUser {
		t.Errorf("会話 = %d 件", n)
	}
	// どの会話も、質問と回答が対（発言は 2 件）
	if n := count(t, s, "SELECT count(*) FROM (SELECT 1 FROM conversation_messages GROUP BY user_id, conversation_id HAVING count(*) <> 2) x"); n != 0 {
		t.Errorf("対になっていない会話が %d 件", n)
	}
}

// 同じ会話への同時の追記は、seq が重ならず、連続する。
func TestConcurrentSavesToOneConversationKeepSeqContiguous(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	seedUser(t, s, "user-0001")
	var wg sync.WaitGroup
	errs := make(chan error, 20)
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if err := s.SaveTurn(ctx, turn("user-0001", "conv-a", fmt.Sprintf("質問 %d", i))); err != nil {
				errs <- err
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Errorf("同時の追記が失敗: %v", err)
	}
	var minSeq, maxSeq, n int
	if err := s.pool.QueryRow(ctx, "SELECT min(seq), max(seq), count(*) FROM conversation_messages WHERE conversation_id = 'conv-a'").Scan(&minSeq, &maxSeq, &n); err != nil {
		t.Fatal(err)
	}
	if minSeq != 0 || maxSeq != 39 || n != 40 {
		t.Errorf("seq = %d〜%d・%d 件", minSeq, maxSeq, n)
	}
	// 質問（偶数の seq）と回答（奇数）が、交互に並んでいる
	if n := count(t, s, "SELECT count(*) FROM conversation_messages WHERE (seq % 2 = 0) <> (role = 'user')"); n != 0 {
		t.Errorf("質問と回答の並びが崩れた: %d 件", n)
	}
}

func TestStaleConversationsAreCountedAndDeletedByLastActivity(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	seedUser(t, s, "user-0001")
	for _, id := range []string{"old-1", "old-2", "fresh"} {
		if err := s.SaveTurn(ctx, turn("user-0001", id, "質問")); err != nil {
			t.Fatal(err)
		}
	}
	exec(t, s, "UPDATE conversations SET updated_at = now() - interval '8 days' WHERE id IN ('old-1', 'old-2')")
	conversations, messages, err := s.StaleConversations(ctx, 7)
	if err != nil || conversations != 2 || messages != 4 {
		t.Fatalf("対象 = %d 会話・%d 発言, %v", conversations, messages, err)
	}
	if n, _ := func() (int64, error) { c, m, err := s.StaleConversations(ctx, 9); return c + m, err }(); n != 0 {
		t.Errorf("9 日より古いものは無い: %d", n)
	}
	// 数えるだけでは消えない
	if n := count(t, s, "SELECT count(*) FROM conversations"); n != 3 {
		t.Errorf("数えただけで消えた: %d", n)
	}
	deleted, err := s.DeleteStaleConversations(ctx, 7)
	if err != nil || deleted != 2 {
		t.Fatalf("削除 = %d, %v", deleted, err)
	}
	if n := count(t, s, "SELECT count(*) FROM conversations") + count(t, s, "SELECT count(*) FROM conversation_messages"); n != 3 {
		t.Errorf("残り = %d（fresh の会話 1 件と発言 2 件）", n)
	}
}

func TestApplySchemaCreatesTheHistoryTablesAndIsIdempotent(t *testing.T) {
	s := testStore(t) // 1 回目
	if err := s.ApplySchema(context.Background()); err != nil {
		t.Fatalf("2 回目: %v", err)
	}
	for _, table := range []string{"conversations", "conversation_messages"} {
		if n := count(t, s, "SELECT count(*) FROM information_schema.tables WHERE table_name = $1", table); n != 1 {
			t.Errorf("表 %s が無い", table)
		}
	}
	// 表の名前を付けた制約（Go が名前で見分ける）
	for _, name := range []string{"conversations_user_fk", "conversation_messages_conversation_fk"} {
		if n := count(t, s, "SELECT count(*) FROM pg_constraint WHERE conname = $1", name); n != 1 {
			t.Errorf("制約 %s が無い", name)
		}
	}
}
