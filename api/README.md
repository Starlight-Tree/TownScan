# api/（Go の API）

TownScan の API を、Python（FastAPI。`backend/app`）から Go へ置き換える（[ADR 0005](../docs/decisions/0005-api-in-go.md)）。**いまあるのは第 1 段（土台と読み取り API）だけ**で、`compose.yaml` はまだ Python の API を指している。

- 作ってある: `GET /api/health`・`/api/areas`・`/api/candidates`・`/api/candidates.geojson`・`/api/candidates/{id}`・`/api/metrics`
- あとの段（ルートを足すだけでよい形にしてある）: 認証（`/api/me`）→ 検出画像（`/api/candidates/{id}/image`）→ チャット（`/api/chat`）→ 切り替え
- 作らない: `/api/docs`・OpenAPI（契約は `docs/spec-prototype.md` §4.4 と `contract/` が持つ）

振る舞いの正本は `backend/app/`・`backend/tests/`・`docs/spec-prototype.md`。JSON のキー・型・並び順・数の書式（Python の `100.0`・`1e-05`）・検証エラーの文言・307 の Location・405 の本文まで、Python の API と**バイト列が同じ**になるように作ってある（`difftest/` が確かめる）。

## 構成

| 場所 | 責務 |
|---|---|
| `cmd/api/main.go` | 設定 → DB とスキーマ → 待ち受け → 停止の合図（SIGINT・SIGTERM）で処理中の応答を終えてから止まる。`-healthcheck`（distroless 用） |
| `internal/config` | 環境変数（`backend/app/config.py` と同じ名前・既定・検証）。秘密は `Secret` 型で、どの書き方でも伏せ字 |
| `internal/apierr` | エラーの形（`{"error":{"code","message"}}`・422 の `details`） |
| `internal/httpx` | ルーター（Starlette と同じ 405・307・404）・クエリの読み方（`parse_qsl` と同じ）・Pydantic と同じ検証・ミドルウェア（アクセスログ・panic の回復・nosniff・本文の上限） |
| `internal/pyjson` | Python の `json.dumps` と同じ書式（`float` の repr・jsonb の書き直し） |
| `internal/store` | pgx の接続プール・問い合わせ・整形・スキーマの適用（`sql/` は `backend/db/` の写し。一致をテストで確かめる） |
| `internal/handlers` | 読み取りのハンドラー（DB は `Reader` インターフェース。テストは偽の実装） |
| `internal/testdb` | DB のテストが、テストごとに新しいデータベースを作る |
| `difftest/` | Python の API との差分検査（標準ライブラリだけの Python。`run.sh` が全部用意する） |

依存は標準ライブラリと `github.com/jackc/pgx/v5` だけ（推移的に pgpassfile・pgservicefile・puddle/v2・x/sync・x/text）。

## 検査

```bash
scripts/test-go.sh               # gofmt・go vet・go test -race（使い捨ての Postgres つき）。初回だけ scripts/test-go.sh --download
api/difftest/run.sh              # Python の API との差分検査（Go のバイナリを作り、両方を同じ DB に向けて、7 段階で比べる）
```

ホストに Go は要らない（ローカルの `docunavi-dev` イメージの Go 1.26.10 を、ホストのユーザーで流す）。

## 守ること

- 数字・件数・座標は DB の値のまま返す（丸めない・型を変えない）。
- DB のパスワード・Gemini のキーは、ログ・エラー・応答に出さない。ログに出すのは、エラーの型と SQLSTATE まで。
- アクセスログは、メソッド・パス・状態・大きさ・所要時間だけ（クエリ文字列・`Authorization`・本文は出さない）。
- Go の版は `go.mod`（1.26.10）に合わせる。`Dockerfile` の `golang:` も同じ版。
