# api/（Go の API）

TownScan の API を、Python（FastAPI。`backend/app`）から Go へ置き換える（[ADR 0005](../docs/decisions/0005-api-in-go.md)）。**いまあるのは、土台・読み取り API・認証・検出画像・チャット（模擬モデルだけ）**で、`compose.yaml` の api は、この Go の API（2026-11-25 に切り替えた。FastAPI 版は `compose.python-api.yaml`。Gemini が Go に入るまで残す）。

- 作ってある: `GET /api/health`・`/api/areas`・`/api/candidates`・`/api/candidates.geojson`・`/api/candidates/{id}`・`/api/metrics`・`POST /api/chat`（模擬モデル。下の「チャット」）
- 認証: `GET /api/me`（JWT を JWKS の公開鍵で検証。下の「認証」）
- 検出画像: `GET /api/candidates/{id}/image`（写真タイルの切り出しと輪郭の描画。`internal/imaging`。Python の Pillow と構造が同じで、画素は平均絶対差 1.07 ほど。`difftest/image.sh` が確かめる）
- あとの段（ルートを足すだけでよい形にしてある）: チャットの Gemini → Python の API を消す
- 作らない: `/api/docs`・OpenAPI（契約は `docs/spec-prototype.md` §4.4 と `contract/` が持つ）

振る舞いの正本は `backend/app/`・`backend/tests/`・`docs/spec-prototype.md`。JSON のキー・型・並び順・数の書式（Python の `100.0`・`1e-05`）・検証エラーの文言・307 の Location・405 の本文まで、Python の API と**バイト列が同じ**になるように作ってある（`difftest/` が確かめる）。

## 構成

| 場所 | 責務 |
|---|---|
| `cmd/api/main.go` | 設定 → DB とスキーマ → 待ち受け → 停止の合図（SIGINT・SIGTERM）で処理中の応答を終えてから止まる。`-healthcheck`（distroless 用） |
| `internal/config` | 環境変数（`backend/app/config.py` と同じ名前・既定・検証）。秘密は `Secret` 型で、どの書き方でも伏せ字 |
| `internal/apierr` | エラーの形（`{"error":{"code","message"}}`・422 の `details`） |
| `internal/httpx` | ルーター（Starlette と同じ 405・307・404）・クエリの読み方（`parse_qsl` と同じ）・Pydantic と同じ検証・本文（JSON）の読み方（壊れた JSON の誤りの位置も Python と同じ。`jsonpos.go`）・ミドルウェア（アクセスログ・panic の回復・nosniff・本文の上限） |
| `internal/pyjson` | Python の `json.dumps` と同じ書式（`float` の repr・jsonb の書き直し） |
| `internal/auth` | `GET /api/me` の JWT の検証: ES256 だけ・JWKS の取得と保持（600 秒）・iss / aud / exp / nbf / iat / sub の規則・`email` / `name` / `picture` の整形・`Authorization: Bearer` の読み方 |
| `internal/imaging` | 検出画像: 候補の外周の緯度経度 → 写真タイル（`TILES_DIR`）の切り出し・拡縮（CatmullRom）・輪郭（縁取りと実線・破線）の描画 → PNG。入力の上限（正方形・一辺 1024 以下・8 MB 以下・外周 1 万頂点以下）と、`os.Root` による置き場の閉じ込め、同時に作る画像は 8 枚まで |
| `internal/chat` | チャット（模擬モデルの規則・ツール・返答文・数字の検査 `GuardNumbers`・1 往復の `Service`）。`backend/app/chat/` と同じ応答。Python が作った期待値（golden）で照合する |
| `internal/store` | pgx の接続プール・問い合わせ・整形・スキーマの適用（`sql/` は `backend/db/` の写し。一致をテストで確かめる） |
| `internal/handlers` | 読み取りのハンドラーと `POST /api/chat`（DB は `Reader`、チャットは `Chatter` インターフェース。テストは偽の実装） |
| `internal/testdb` | DB のテストが、テストごとに新しいデータベースを作る |
| `difftest/` | Python の API との差分検査（標準ライブラリだけの Python。`run.sh` が JSON の差分、`image.sh` が検出画像の差分を、全部用意して流す） |

依存は標準ライブラリと `github.com/jackc/pgx/v5`（推移的に pgpassfile・pgservicefile・puddle/v2・x/sync）と、JWT の検証の `github.com/golang-jwt/jwt/v5`（v5.3.1。ES256 の署名とクレームの検査だけに使う。鍵の取得・保持・JWK の読み取りは自前）と、検出画像の拡縮の `golang.org/x/image`（v0.46.0。`draw` の CatmullRom だけ）と、チャットの `golang.org/x/text`（v0.42.0。`unicode/norm` の NFKC だけ。文字の整えと数字の検査を、Python の `unicodedata.normalize` と同じ結果にするため。ユーザー承認 2026-11-25）。

## 認証（`GET /api/me`）

仕様は `docs/spec-prototype.md` §2.1・§4.4、振る舞いの正本は `backend/app/jwt_auth.py`・`auth.py`、契約は `contract/test_me.py`・`test_me_unconfigured.py`・`test_auth_independence.py`。Python の `backend/tests/test_jwt_auth.py`・`test_me.py` の観点は、`internal/auth`・`internal/handlers/me_test.go` の Go のテストに移してある。

- `AUTH_ISSUER`・`AUTH_JWKS_URL` が無い／形が不正なときは、トークンを見る前に 503（起動は止めない）。ほかの入口は、認証の設定にも JWKS の状態にも影響されず、JWKS を取りに行かない。DB も使わない。
- 鍵は最初の `/api/me` の要求で取る（起動のときは取らない）。10 分覚え、未知の kid による取り直しは 60 秒に 1 回まで、鍵が 1 つも無いまま失敗したら 5 秒は取りに行かない（その間は待たせずに 503）。取り直しに失敗しても、前の鍵で続ける。同時に来た要求の取得は 1 回に束ねる。
- 鍵なしで断れるもの（ヘッダーなし・形違い・alg が ES256 でない・kid なし）は、JWKS が落ちていても 401。鍵が要るものだけが 503。
- ログに残すのは、失敗の種類（固定の語。`malformed`・`signature`・`expired` など）だけ。トークン・`Authorization`・JWKS の URL・通信のエラーの文は出さない。

Python との意図した違い（応答の外から見える規則は同じ。どれも、より厳しい側）:

- JWKS の取得は、転送（3xx）に従わない（設定した URL だけを取る。Python の `urllib` は従う）。環境の `HTTP_PROXY` も使わない。
- 取得の待ちの上限 3 秒は、接続・応答・本文の読み込みの全部で数える（Python は、1 回の通信ごと）。
- 本文が壊れていて、ヘッダーは正しいトークンは、JWKS が取れないときも 401（Python は、鍵を取りに行って 503）。鍵なしで断れるものは 401、という分け方に沿う。
- JWK は、`crv` が `P-256`、`alg` があれば `ES256`、`use` があれば `sig` のものだけ（Python は、`alg` と `crv` の食い違う鍵を通しうる）。
- `exp`・`nbf`・`iat` は JSON の数だけ（Python は、数を表す文字列も通す）。

## チャット（`POST /api/chat`）

仕様は `docs/spec-prototype.md` §4.5、振る舞いの正本は `backend/app/chat/`、契約は `contract/test_chat_*.py`。模擬モデルの規則・ツール・返答文・数字の検査（結果に無い数字を返答に書かせない）は、Python と同じ応答になるよう移してある。`internal/chat/testdata/gen_golden.py`（Python が期待値を作る）と `internal/httpx/testdata/gen_jsonpos.py` が、照合の元。

- `LLM_PROVIDER=gemini` は、まだ使えない（黙って模擬に落とさず、`chat.New` が起動を止める）。切り替え（ADR 0005 の 6）の前に、Gemini の窓口（再試行・27 秒の期限・502・ログ）を作る。
- `Deps.Chat` が nil なら、`/api/chat` のルートは作らない（404）。

Python との意図した違い:

- 返答文を安全なテンプレートに差し替えたとき、Go のログは差し替えた回数だけ（Python は、検査に落ちた数字の先頭 5 件も出す。数字・本文をログに出さないため）。
- 本文（JSON）: UTF-16・UTF-32・NaN/Infinity・4300 桁を超える整数・対の無いサロゲートの逃がしは、Python と違う（`httpx/body.go` の冒頭。frontend は送らない）。本文の大きさの上限（`maxBodyBytes`）は Go だけにある。
- Go の `unicode` は Unicode 15.0、Python 3.13 は 15.1。語の文字の判定が、CJK 拡張 I の 622 字だけ違う（規則の語に隣り合うときだけ影響）。

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
