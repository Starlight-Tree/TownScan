-- 会話の履歴（ログイン中だけ）。auth.sql（auth_user）のあとに流す。仕様: docs/spec-prototype.md §2.3・§4.3、ADR 0006。
-- Go の API だけが使う表（pipeline/sql/ には置かない。TestSchemaMatchesLoaderCopy の対象にしない）。
-- 何度流しても同じになる形（IF NOT EXISTS）。DROP・TRUNCATE は書かない。
CREATE TABLE IF NOT EXISTS conversations (
    user_id     text        NOT NULL,
    id          text        NOT NULL CHECK (id ~ '^[A-Za-z0-9_-]{1,128}$'),
    title       text        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 40),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, id),
    -- 名前を付ける（外部キー違反が、どの制約かを、Go が名前で見分ける。§2.3.3）
    CONSTRAINT conversations_user_fk FOREIGN KEY (user_id) REFERENCES auth_user ("id") ON DELETE CASCADE
);
-- 一覧と、1 人 50 件の整理: 本人の会話を、更新が新しい順に（同時刻は id の昇順）。
CREATE INDEX IF NOT EXISTS conversations_user_updated_idx ON conversations (user_id, updated_at DESC, id);

CREATE TABLE IF NOT EXISTS conversation_messages (
    user_id          text        NOT NULL,
    conversation_id  text        NOT NULL,
    seq              integer     NOT NULL CHECK (seq >= 0),
    role             text        NOT NULL CHECK (role IN ('user', 'assistant')),
    content          text        NOT NULL,
    results          jsonb,
    tool_calls       jsonb,
    -- 回答を作ったときに読んだ run の runs.created_at（サーバーが付ける。§7.1.5。run が無かった回答は NULL）
    run_created_at   timestamptz,
    PRIMARY KEY (user_id, conversation_id, seq),
    CONSTRAINT conversation_messages_conversation_fk
        FOREIGN KEY (user_id, conversation_id) REFERENCES conversations (user_id, id) ON DELETE CASCADE,
    -- ユーザーの発言は results・tool_calls・run_created_at を持たない。回答は、results・tool_calls を配列で持つ（空でもよい）
    CHECK (role = 'assistant' OR (results IS NULL AND tool_calls IS NULL AND run_created_at IS NULL)),
    CHECK (role = 'user' OR (results IS NOT NULL AND jsonb_typeof(results) = 'array'
                              AND tool_calls IS NOT NULL AND jsonb_typeof(tool_calls) = 'array'))
);
