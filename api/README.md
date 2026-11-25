# api/（Go の API）

TownScan の API（[ADR 0005](../docs/decisions/0005-api-in-go.md)）。土台・読み取り API・認証・検出画像・チャット（模擬モデルと Gemini）・会話の履歴があり、`compose.yaml` の api は、この Go の API。最初は Python（FastAPI）で作ったが、Go へ置き換え、Python の API は 2026-11-25 に消した（最後の版は、コミット `e9a6614` の `backend/`。コードのコメントの `backend/app/…` は、そこを指す）。

- 作ってある: `GET /api/health`・`/api/areas`・`/api/candidates`・`/api/candidates.geojson`・`/api/candidates/{id}`・`/api/metrics`・`POST /api/chat`（模擬モデルと Gemini。下の「チャット」）
- 認証: `GET /api/me`（JWT を JWKS の公開鍵で検証。下の「認証」）
- 検出画像: `GET /api/candidates/{id}/image`（写真タイルの切り出しと輪郭の描画。`internal/imaging`。消した Python の API の Pillow と構造が同じで、画素は平均絶対差 1.07 ほどだった）
- 会話の履歴（ログイン中だけ）: `GET /api/conversations`・`GET /api/conversations/{id}/messages`・`DELETE /api/conversations/{id}`（どれも `Authorization: Bearer`・`Cache-Control: no-store`）と、`POST /api/chat` の任意の `conversation_id`（付けたときだけ、回答と一緒に保存する）。表は `internal/store/sql/history.sql`（API の起動のたびに流れる）。仕様は `docs/spec-prototype.md` §2.3・ADR 0006。保存期間の掃除は `history-cleanup`（下）
- 作らない: `/api/docs`・OpenAPI（契約は `docs/spec-prototype.md` §4.4 と `contract/` が持つ）

振る舞いの正本は `docs/spec-prototype.md` と `contract/`（HTTP から見える振る舞い）。JSON のキー・型・並び順・数の書式（Python の `100.0`・`1e-05`）・検証エラーの文言・307 の Location・405 の本文は、置き換え前の Python の API と**バイト列が同じ**になるように作った（差分検査は、Python の API を消したので無い。形は `contract/` と Go のテストが守る）。

## 構成

| 場所 | 責務 |
|---|---|
| `cmd/history-cleanup` | 保存期間を過ぎた会話の履歴を消す運用者のコマンド。**既定は件数の表示だけ**で、`--apply` を付けたときだけ消す（件数以外は出さない。終了コード 0 / 1 = DB の失敗 / 2 = 使い方の誤り）。`docker compose run --rm --entrypoint /history-cleanup api --older-than-days 7 [--apply]` |
| `cmd/api/main.go` | 設定 → DB とスキーマ → 待ち受け → 停止の合図（SIGINT・SIGTERM）で処理中の応答を終えてから止まる。`-healthcheck`（distroless 用） |
| `internal/config` | 環境変数（名前・既定・検証は仕様 §2 と `compose.yaml`）。秘密は `Secret` 型で、どの書き方でも伏せ字 |
| `internal/apierr` | エラーの形（`{"error":{"code","message"}}`・422 の `details`） |
| `internal/httpx` | ルーター（Starlette と同じ 405・307・404）・クエリの読み方（`parse_qsl` と同じ）・Pydantic と同じ検証・本文（JSON）の読み方（壊れた JSON の誤りの位置も Python と同じ。`jsonpos.go`）・ミドルウェア（アクセスログ・panic の回復・nosniff・本文の上限・要求全体の期限 `Timeout`） |
| `internal/pyjson` | Python の `json.dumps` と同じ書式（`float` の repr・jsonb の書き直し） |
| `internal/auth` | `GET /api/me` の JWT の検証: ES256 だけ・JWKS の取得と保持（600 秒）・iss / aud / exp / nbf / iat / sub の規則・`email` / `name` / `picture` の整形・`Authorization: Bearer` の読み方 |
| `internal/imaging` | 検出画像: 候補の外周の緯度経度 → 写真タイル（`TILES_DIR`）の切り出し・拡縮（CatmullRom）・輪郭（縁取りと実線・破線）の描画 → PNG。入力の上限（正方形・一辺 1024 以下・8 MB 以下・外周 1 万頂点以下）と、`os.Root` による置き場の閉じ込め、同時に作る画像は 8 枚まで |
| `internal/chat` | チャット（模擬モデルの規則・ツール・返答文・数字の検査 `GuardNumbers`・1 往復の `Service`）と、実 LLM の Gemini（`gemini.go` = 窓口: HTTP・再試行・期限・失敗の分類、`gemini_model.go` = function calling の往復）。消した Python の API と同じ応答。Python が作った期待値（golden。`testdata/golden.json.gz`。凍結したデータで、作り直す元の Python は無い）で照合する |
| `internal/store` | pgx の接続プール・問い合わせ・整形・スキーマの適用（`sql/schema.sql`・`auth.sql` は `pipeline/sql/`（ローダーが使う）の写しで、一致をテストで確かめる。`history.sql` は Go だけの表）・会話の履歴の保存・一覧・削除（`history.go`）・DB の `statement_timeout`（`WithStatementTimeout`） |
| `internal/handlers` | 読み取りのハンドラー・`POST /api/chat`・会話の履歴の 3 本（`history.go`。DB は `Reader`・`HistoryStore`、チャットは `Chatter` インターフェース。テストは偽の実装） |
| `internal/testdb` | DB のテストが、テストごとに新しいデータベースを作る |

依存は標準ライブラリと `github.com/jackc/pgx/v5`（推移的に pgpassfile・pgservicefile・puddle/v2・x/sync）と、JWT の検証の `github.com/golang-jwt/jwt/v5`（v5.3.1。ES256 の署名とクレームの検査だけに使う。鍵の取得・保持・JWK の読み取りは自前）と、検出画像の拡縮の `golang.org/x/image`（v0.46.0。`draw` の CatmullRom だけ）と、チャットの `golang.org/x/text`（v0.42.0。`unicode/norm` の NFKC だけ。文字の整えと数字の検査を、Python の `unicodedata.normalize` と同じ結果にするため。ユーザー承認 2026-11-25）。Gemini の窓口は、標準ライブラリ（`net/http`・`encoding/json`・`context`）だけで、依存を足していない。

## 認証（`GET /api/me`）

仕様は `docs/spec-prototype.md` §2.1・§4.4、契約は `contract/test_me.py`・`test_me_unconfigured.py`・`test_auth_independence.py`。検証の観点は、`internal/auth`・`internal/handlers/me_test.go` の Go のテストが持つ。

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

仕様は `docs/spec-prototype.md` §4.5、契約は `contract/test_chat_*.py`。模擬モデルの規則・ツール・返答文・数字の検査（結果に無い数字を返答に書かせない）は、Python と同じ応答になるよう移してある。照合の元は、`internal/chat/testdata/golden.json.gz` と `internal/httpx/testdata/jsonpos.json.gz`（どちらも Python が作った期待値。後者の作り方は `gen_jsonpos.py`）。

- **Gemini（`LLM_PROVIDER=gemini`）**: `GEMINI_API_KEY`（必須。`LLM_PROVIDER=gemini` のときだけ読む）・`GEMINI_MODEL`（既定 `gemini-3.5-flash-lite`）。キーが無い・形が不正なときは、黙って模擬に落とさず、`config.Validate` と `chat.New` が起動を止める（DB を待つ前。キーは文に入れない）。模擬が既定で、`mock` のときは Gemini の設定を読みもしない。
  - 役割は「どのツールを呼ぶか」と「結果の説明文」だけ（`gemini_model.go`）。数字・件数・座標は書かせない。結果（`results`）は、模擬と同じく `Registry` が DB から作り、返答文は `GuardNumbers` を通る。モデルへの往復は最大 4 回・ツール呼び出しは最大 6 件・返答文は 1000 文字まで。
  - 失敗（キーが無効・429・5xx・タイムアウト・壊れた応答・候補が無い／拒否・往復やツール呼び出しの上限超過）は、`*chat.LLMError` になり、`POST /api/chat` は **502** `{"error":{"code":"llm_unavailable","message":"いまは LLM が応答できません。少し待ってからもう一度お試しください"}}`（模擬には切り替えない。本文は Python と同じ）。**再試行は 1 回**（要求ごと。HTTP 5xx・タイムアウト・接続エラーだけを、1 秒待ってやり直す。4xx〔429 を含む〕・壊れた応答は、やり直さない。残りの期限が 5 秒を切るときも、やり直さない）。**1 回の呼び出しの待ちは 20 秒、チャット 1 回の要求の全体の期限は 27 秒**（`chat.RequestDeadline`）。frontend の Next.js が `/api/*` を転送するときの待ち（既定 30 秒）より前に、502 を返せる。
  - **キー・URL・質問や返答の本文・Google のエラー本文は、ログにも応答にも出さない。** ログと 502 に出すのは、失敗の種類（`rate_limit`・`server`・`timeout` など）・HTTP の状態・Google の理由の定数（`INVALID_ARGUMENT` など。定数の形のものだけ）まで。キーは URL に付けず、ヘッダー `x-goog-api-key` で送る（Python と同じ）。リダイレクト（3xx）は追わない（キーを別のホストへ送らないため。失敗 `http_error`）。`GeminiConfig`・`geminiClient` は、`%v`・`%+v`・`%#v`・JSON のどれで書いても、キーを出さない。
  - エンドポイント（`chat.GeminiConfig.BaseURL`）・待ち・期限は、テストが偽のサーバーへ向け、短い値に差し替えるための設定で、**環境変数では変えられない**（キーを別の宛先へ送る設定を、環境に持たせないため）。テストは `net/http/httptest` の偽サーバーだけを使い、実 Gemini には、つながない。
- `Deps.Chat` が nil なら、`/api/chat` のルートは作らない（404）。
- 本文の大きさの上限は 4 MiB（`cmd/api/main.go` の `maxBodyBytes`。超えると 413）。いちばん大きい正しい本文（500 件 × 2000 文字 × 3 バイト）が約 3.02 MB なので、それが収まる大きさ。本文は、そのまま UTF-8 で送る前提（frontend の `JSON.stringify` がそう。`\uXXXX` に逃がして送ると 1 文字 6 バイトで、最大の会話は収まらない）。
- **コンテナのメモリー上限は 1 GiB 以上にする（`compose.yaml` の api は `mem_limit: 1g`）。** JSON を復号すると、本文の約 50 倍のメモリーを使う（4 MiB の `[{},{},…]` で、確保が累計約 200 MB。`internal/httpx` で実測）ため。

Python との意図した違い:

- 返答文を安全なテンプレートに差し替えたとき、Go のログは差し替えた回数だけ（Python は、検査に落ちた数字の先頭 5 件も出す。数字・本文をログに出さないため）。
- 本文（JSON）: UTF-16・UTF-32・NaN/Infinity・4300 桁を超える整数・対の無いサロゲートの逃がしは、Python と違う（`httpx/body.go` の冒頭。frontend は送らない）。本文の大きさの上限（`maxBodyBytes`）は Go だけにある。
- 範囲外の浮動小数（`1e999` など）を含む本文は、Python は inf として受け入れ、Go は 422（JSON decode error）。
- 入れ子が深い本文: Python は 9992 段ほどを超えると RecursionError で 400（"There was an error parsing the body"。FastAPI 0.165 で実測）、Go は 10,000 段まで読み、超えると 422。壊れた JSON の誤りの位置を探す読み取りは、9990 段までだけ Python と同じ位置を返す（超えると Go の位置。スタックを使い切らせないため。`httpx/jsonpos.go`）。逆に、JSON としては正しいが検証に落ちる本文（例: 本文全体が入れ子の配列）が 971 段ほどを超えると、Python は 500（実測。エラーの応答を作るところで再帰の上限に当たる）、Go は 422。
- metrics の評価ファイルの形が壊れているとき（パイプラインは、そういう形を書かない。検査担当が見つけた差）: 形によって、Python は 500・Go は 200 になる。評価が JSON の `null` のとき、`GET /api/metrics` は Python が 404、Go は 500。
- Gemini: 1 回の呼び出しの待ち（20 秒）は、接続・応答・本文の読み込みの全体で数える（Python は、接続・受信の各段階ごと。少しずつ届く応答は、Python は切らない）。LLM の引数の型が合わないとき（文字列のところに数・配列など）は、ツールごとの文ではなく、常に「指定が正しくありません。」の断り（Python は、区の指定なら「区の指定が正しくありません。」など）。`tool_calls` に返す引数は、宣言した型に直したもの（空の `area_ids`・型の違う値は残らない。地区の指定に書かれた文字列でない値は、Python は `str()`、Go は JSON の表記で、どちらも、どの地区にも当たらず、断りになる）。ログに残すツール名は、登録したものだけ（LLM が書いた名前は出さない）。
- 要求全体の期限と DB の statement_timeout（下の「Gemini の窓口の前に直したこと」）。Python には、どちらも無い。
- 数字の検査（実 LLM の文と、LLM が書いた `refuse` の文だけ。模擬モデルの返答文は、Python と同じ範囲の検査のまま）: 助数詞の無い漢数字・英語の数詞・空白や不可視の文字で区切った数も落とす（下）。地区名・区名の中の漢数字（黒髪六丁目・三年町など）は、数として見ない（Python は、名前の中の「三年」のような助数詞つきの漢数字も落とす）。
- 会話の 1 件の本文は、NFKC のあとの文字数も 2000 以下（「ﷺ」は 18 文字になる）。超えると、同じ 422（`String should have at most 2000 characters`）。Gemini の返答文は、1000 文字までに加えて、NFKC のあとが 2000 文字を超えないように切る（frontend は返答を次の質問の履歴に入れて送り返すので、弾かれると、その会話が進まなくなる）。
- Go の `unicode` は Unicode 15.0、Python 3.13 は 15.1。語の文字の判定が、CJK 拡張 I の 622 字だけ違う（規則の語に隣り合うときだけ影響）。NFKC（`golang.org/x/text` v0.42.0 の `unicode/norm`）の表も Unicode 15.0 だが、補助面の全文字＋結合文字 9 種（約 940 万組）と、全コードポイントの単独の NFKC を Python 3.13（unicodedata 15.1.0）と比べて、違いは無かった。

### Gemini の窓口の前に直したこと（Python と同じ抜け道。Go は塞いだ）

模擬モデルは、返答の数字を結果からだけ作るので、抜け道は出ない。実モデル（Gemini）の返答は、数字の検査（`internal/chat/guard.go`）に頼るので、窓口を作る前に塞いだ。Python の API には、この 3 点が無かった（消した）。

1. **数字の検査（`guard.go`）**: 結果に無い数を、次の書き方で通していた。Go は、全部落とす。かけるのは、実 LLM の返答文（`GuardNumbers`）と、LLM が書いた `refuse` の文だけ。模擬モデルの返答文は、Python と同じ範囲の検査（`guardTemplateNumbers`）のまま（模擬モデルは、数字を結果からだけ作る。強い検査にすると、利用者の語を写した断り〔「六本木」など〕が落ちて、Python と応答が変わる）。
   - 助数詞の表に無い漢数字（「七軒」「三千円」「七つ」）。漢数字は、助数詞の有無に依らず、結果と照合せずに落とす（助数詞つきを落とす Python の規則を、広げた）。数を表さない語（一覧・一番・一部・十分・万が一・もう一度・唯一・九州など。`nonNumericWords`）と、地区名・区名の中の漢数字（`GuardNumbers` の `known`。service が、その要求の地区から渡す）は、数として見ない。**表に無い語は、落とす側（安全なテンプレート）に倒れる**（返答の見た目が変わるだけで、数は通らない）。
   - 英語の数詞（seven・twenty-one・hundred・dozen など。大文字・小文字・全角を問わない）。漢数字と同じく、結果と照合せずに落とす。
   - 空白・不可視の書式文字（ゼロ幅スペース U+200B・ソフトハイフン U+00AD・U+2060・BOM・ZWJ など）で区切った数。読み手に見えない文字は、先に取り除いてから数える（「3〈U+200B〉4」は 34。結果の側の文字列も同じ）。空白で区切った整数の並び（「3 4」「1 234」）は、1 つずつの数に加えて、つなげた数（34・1234）も、結果に無ければ落とす（小数のあと・数のあいだに文字がある並びは、つなげない。「1 234」は、1 と 234 が結果に無いと落ちる。慎重な側）。
   - Python との照合（`golden_test.go`）: 数字の連なりと漢数字+助数詞は、すべての入力で Python と完全に同じ。Python が見逃す書き方（上の 3 つ。`numberScan.extra`）を含む入力は、その分だけ Go が多く落とす。
   - 見ないもの（残りの穴）: ひらがなの数（ひとつ・ふたつ）・ローマ数字（Ⅶ・VII）・大字（壱・弐・参）・単位の無い言い回し（半ダース）。システムの指示で、数を書かせない。
2. **要求全体の期限（`httpx.Timeout`）と DB の `statement_timeout`（`store.WithStatementTimeout`）**: どちらも 27 秒（`chat.RequestDeadline`。`cmd/api` の `requestDeadline`）。DB の問い合わせと Gemini への通信は、期限で打ち切られる（DB は 503 `db_unavailable`、Gemini は 502 `llm_unavailable`）。期限は、context を見ない処理を止めはしない。`DATABASE_URL` に `statement_timeout` があれば、そちらを優先する。
3. **正規化したあとの長さの上限（`handlers/chat.go`）**: 2000 文字の上限を、NFKC のあとでも数える（正規化の前の数え方は残す）。

## 検査

```bash
scripts/test-go.sh               # gofmt・go vet・go test -race（使い捨ての Postgres つき）。初回だけ scripts/test-go.sh --download。同時に流すときは TSGO_TEST_PREFIX=<固有の名前>
scripts/test-contract.sh         # 契約の検査 contract/（使い捨ての Postgres と Go の API をコンテナで起動して、HTTP だけで叩く）
```

ホストに Go は要らない（ローカルの `docunavi-dev` イメージの Go 1.26.10 を、ホストのユーザーで流す）。

## 守ること

- 数字・件数・座標は DB の値のまま返す（丸めない・型を変えない）。
- DB のパスワード・Gemini のキーは、ログ・エラー・応答に出さない。ログに出すのは、エラーの型と SQLSTATE まで。
- アクセスログは、メソッド・ルートのテンプレート（`/api/candidates/{candidate_id}`。どのルートにも合わなければ `?`）・状態・大きさ・所要時間だけ（生のパス・クエリ文字列・`Authorization`・本文は出さない。ID がパスに入るため）。
- Go の版は `go.mod`（1.26.10）に合わせる。`Dockerfile` の `golang:` も同じ版。
