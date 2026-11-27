# contract/ — API の契約の検査

TownScan の API（`/api/*`）が、**HTTP から見える振る舞い**を満たしているかを確かめる pytest。起動中の API へ HTTP だけで叩く。API の実装の言語に依らず、アプリのコード（`api/`）は import しない。
契約は、最初の Python（FastAPI）の API で全件合格することを確かめてから、Go の API（`docs/decisions/0005-api-in-go.md`）が同じ検査に合格することを、置き換えの条件にした（`docs/plan.md` の PG 段の出口条件①②。Python の API は 2026-11-25 に消した）。
**契約は、いまの振る舞いを固定する。** API の本物のバグは契約にしない（見つけたら直すか、報告する）。

## 流し方

```sh
scripts/test-contract.sh                                   # 全部。使い捨ての Postgres と Go の API を起動し、構成ごとに検査を流して、全部消す（Docker が要る。対象は `go` だけで、省略できる）
scripts/verify.sh contract                                 # 同じもの（verify.sh の「contract」の段）
CONTRACT_PHASES=main scripts/test-contract.sh -k chat -x   # 開発用: 構成を絞る・pytest の引数を渡す
CONTRACT_PHASES=history scripts/test-contract.sh -k h_l5   # 開発用: 履歴の構成だけ。同時に別の作業が流すときは CONTRACT_PREFIX も変える
```

`scripts/test-contract.sh` がやること（どの実装でも同じ）: ① 検査を流すイメージ（`contract/Dockerfile`。pytest・PyJWT・Pillow だけ）と、データの読み込みのイメージ（`pipeline/loader.Dockerfile` の runtime。`python -m pipeline.load` は、API が Go でも Python の仕事）と、対象の API のイメージを作る
→ ② 使い捨ての Postgres（`townscan-contract-db`・mem_limit 256m・データは tmpfs）を、外へ出られない専用ネットワーク（`--internal`）で起動 → ③ 合成データを書いて（`contract/prepare_data.py`）、`python -m pipeline.load --run` で DB へ入れ、**検査用の利用者 200 人を `auth_user` へ入れる**（構成 `history` が使う。下の「データの準備」）
→ ④ 構成ごとに、API を起動して検査を流して止める → ⑤ 結果の表を出し、`townscan-contract-*` を全部消す。ポートは公開しない（ホストの 8500・3500・5432 に触れない）。外への通信・実 API は無い（`LLM_PROVIDER=mock`）。
API のログは、失敗した構成のときだけ末尾を出す。所要は、イメージが作ってあれば約 1 分（うち、DB が止まったときの検査 `dbdown` が約 30 秒。接続の待ちが各 10 秒前後かかる）。

自分で起動した API に流すこともできる（データが合成データであること。下の「データの準備」）:

```sh
API_BASE_URL=http://127.0.0.1:8600 CONTRACT_VARIANT=main python -m pytest contract   # contract/ の依存（requirements.txt）が要る
```

| 環境変数 | 意味 |
|---|---|
| `API_BASE_URL` | 叩く API（既定 `http://127.0.0.1:8500`）。合成データの run（`synthetic-test`）が入っていなければ、検査を始めずに止まる（開発用の API に流して、大量の失敗を出さないため） |
| `CONTRACT_VARIANT` | API の構成（下の表。既定 `main`）。自分の構成の検査だけが流れる（ほかは `deselected`） |
| `CONTRACT_FEATURES` | この API が持つ機能（空白かカンマ区切り。いまは `history` だけ）。機能の印 `@pytest.mark.history` の付いた検査は、ここに `history` が無いと、構成が合っていても `deselected`（Python の API があったころの仕組み）。`scripts/test-contract.sh` は `history` を渡す。自分で起動した Go の API に流すときは、自分で付ける。構成 `history` を `CONTRACT_FEATURES` 無しで流すと、空振りさせずに止める |
| `CONTRACT_USER_POOL` | 履歴の検査用の利用者の人数（既定 200）。`auth_user` に入れた人数と同じにする（`scripts/test-contract.sh` は `CONTRACT_HISTORY_USERS`〔既定 200〕を、入れる側と検査の側の両方に渡す）。使い切ると、`fresh_user()` がはっきり失敗する |
| `CONTRACT_JWKS_BIND`・`CONTRACT_JWKS_PORT` | 偽の JWKS サーバー（検査のプロセスの中）の待ち受け先（既定 `0.0.0.0:8901`）。API の `AUTH_JWKS_URL` がここを指す |
| `CONTRACT_AUTH_ISSUER` | 偽の画面のサーバーの発行元（既定 `https://auth.contract.test`）。API の `AUTH_ISSUER` と同じにする |
| `CONTRACT_TIMEOUT`・`CONTRACT_READY_TIMEOUT` | 1 回の要求の待ち（既定 20 秒）・API が応答するまでの待ち（既定 60 秒） |

## API の構成（variant）

API は、環境変数（`compose.yaml` の api と同じ名前）だけで構成される。構成ごとに API を起動し直して、その構成の検査だけを流す（`@pytest.mark.variant(...)`。付けなければ `main`）。
**機能の印 `@pytest.mark.history`**（構成の印とは別）は、会話の履歴の検査（H-系）に付ける。`CONTRACT_FEATURES` に `history` が無いときは、構成が合っていても外す。Python の API があったころの仕組み（この末尾の「新しい実装の足し方」）。

| 構成 | API の起動時の設定 | 確かめること | 検査 |
|---|---|---|---|
| `empty` | 表だけがある空の DB。ログインの設定なし | データを読む入口は 503 `no_data`（引数の検証 422 が先）。ヘルスは 200（run は null）。チャットは `no_data` の断り | `test_no_data.py` |
| `main` | 合成データ入りの DB。`AUTH_ISSUER`・`AUTH_JWKS_URL`（偽の JWKS サーバー）あり。`AUTH_AUDIENCE` は**設定しない**（既定 `townscan` の検査を兼ねる） | 本体。全エンドポイントの正常系・異常系、チャット、画像、`/api/me` の検証 | 上記以外のすべて |
| `noauth` | `main` と同じデータ。`AUTH_*` なし | `/api/me` は、JWT の有無・形を見る前に 503。ほかの入口は影響を受けない。**履歴の 3 本と `conversation_id` つきの chat も 503**（H-A5） | `test_me_unconfigured.py`・`test_auth_independence.py`・`test_history_unavailable.py`（履歴の印つき） |
| `badauth` | `AUTH_ISSUER=localhost:3500`（http(s) の URL でない。`BETTER_AUTH_URL` の書き間違いを `compose.yaml` がそのまま渡した想定）、`AUTH_JWKS_URL` は正しい | 起動は止まらず、`noauth` と同じ動き（JWKS を取りに行かない） | 同上 |
| `jwksdown` | `AUTH_ISSUER` は正しい、`AUTH_JWKS_URL` は届かない URL（接続拒否） | 鍵を要する検証は 503（詳細を漏らさない）。鍵を使わずに断れるものは 401 のまま（履歴の経路も同じ。H-A6） | 同上 |
| `dbdown` | `main` と同じ。起動して healthy を確かめたあとで、DB を止める | ヘルスは 503（`status`・`db` が error）、データを読む入口は 503 `db_unavailable`、DB を使わない `/api/me` は 200。履歴の 3 本と `conversation_id` つきの chat も 503 `db_unavailable`（H-A7） | `test_no_data.py`・`test_history_unavailable.py`（履歴の印つき） |
| `history` | `main` と同じ設定（合成データ・偽の JWKS）。`scripts/test-contract.sh` の既定の並びでは `main` の次。使い捨ての DB 専用 | 会話の履歴（仕様 §2.3・§4.4・§8 の E9。H-系 26 行）: 履歴の 3 本のログイン・一覧・発言の取得・削除・`conversation_id` つきの chat の保存と上限 | `test_history_*.py` |

API の起動時の設定（対象に関わらず同じ）: `DATABASE_URL`・`TILES_DIR`・`LLM_PROVIDER=mock`・（構成により）`AUTH_ISSUER`・`AUTH_JWKS_URL`。API は、引数なしの起動（イメージの CMD）で、コンテナの 8000 番を待ち受ける。

## 保証すること

| エンドポイント | 検査 | 固定するもの |
|---|---|---|
| `GET /api/health` | `test_health.py`・`test_no_data.py` | キーの集合・`status`/`db`/`llm`（模擬）・現在の run（`created_at` は同じ時刻の ISO 8601）・件数。DB が止まれば 503。データ無しは 200 |
| `GET /api/areas` | `test_areas.py` | 並び（北→南・西→東）・キーと型・bbox・centroid・分類ごとの件数と合計 |
| `GET /api/candidates` | `test_candidates.py` | 並び（面積の降順、同じなら id の昇順。`area_asc` も）・total・キーと値・`cls`/`area_id` の絞り込み・`limit`（1〜500）/`offset`（0〜1,000,000）・不正な引数は 422（`query.<名前>`）。入力値は応答に出さない |
| `GET /api/candidates.geojson` | `test_candidates.py` | `application/geo+json`・FeatureCollection・並び・properties（`id`,`class`,`area_m2`,`area_id`）・外周の座標・絞り込み・422 |
| `GET /api/candidates/{id}` | `test_detail.py` | 9 候補すべての詳細（evidence・geometry・理由ごとの固定の説明文・画像の URL・provenance）・内部の値（tile_x/tile_y）を出さない・404 `not_found`・形が違う id は 422（`path.candidate_id`） |
| `GET /api/candidates/{id}/image` | `test_image.py` | PNG（`image/png`）・大きさ（64〜1024、既定 512、正方形）・年は 2014・2024 だけ・年ごとの写真・向きと範囲（候補が真ん中・余白は約 20 m・タイルの外へ出ず内側へずらす）・輪郭の色と線種（実線・破線・点線）・`Cache-Control: private`・422・404（候補なし）・404 `tile_not_found`（ファイルなし・壊れたファイル・`TILES_DIR` の外を指すリンク。パスを漏らさない） |
| `GET /api/metrics` | `test_detail.py` | 評価ファイルの内容そのもの + provenance（2014 年の写真・固定の注記） |
| `POST /api/chat` | `test_chat_answers.py`・`test_chat_behavior.py` | 代表的な質問 29 件の答え（`tool_calls`・`results`・`content` を全体で）。ツールの選び方・範囲外の断り（`out_of_scope`・`no_photo_period`・`not_implemented`）・文脈（末尾 20 件だけ）・履歴の上限（500 件まで・1 件 2000 文字）・不正な入力は 422・**返答文の数字は結果の値だけから出る**（`support/chat.py` の検査。`guard_numbers` の契約）・SQL インジェクションの文字列が検索を変えない |
| `GET /api/me` | `test_me.py`・`test_me_unconfigured.py` | JWT の検証（ES256 のみ・`iss`/`aud`/`exp`/`sub` 必須・完全一致・10 秒のずれまで・署名・kid・使えない鍵が混ざる JWKS）・`{sub,email,name,picture}` の整形（https の画像・254 文字のメール・100 文字の名前・印字できない文字を除く）・401（固定の文・`WWW-Authenticate: Bearer`・`no-store`）・503（未設定・JWKS 不達） |
| `GET /api/conversations`・`GET /api/conversations/{id}/messages`・`DELETE /api/conversations/{id}`（履歴。構成 `history`） | `test_history_auth.py`・`test_history_list.py`・`test_history_messages.py`・`test_history_delete.py` | 未ログインは 3 経路とも同じ 401（ID の形の 422 より先）・本人の会話だけ（無い ID と他人の ID は、本文も同じ 404）・一覧は更新が新しい順で最大 50 件・題名の規則（40 文字・コードポイントで数える・空白を畳む）・発言は古い順で、回答は chat の `message` と JSON として等しい（＋`run_created_at`）・見るだけでは更新しない・形が違う ID は 422（`path.conversation_id`）・3 経路の全応答（200・204・401・404・422）が `Cache-Control: no-store`・削除は 204 で本当に消える（同じ ID で話しかけ直しても戻らない） |
| `POST /api/chat` ＋ `conversation_id`（履歴） | `test_history_auth.py`・`test_history_list.py`・`test_history_chat.py` | 本文の不正（空の発言・最後が assistant・形が違う ID・NUL）は、未ログインでも 422（本文が先）。そのあと未ログイン → 401（回答も保存もしない）・`auth_user` に行が無い → 401・保存は回答を変えない・追記・同じ ID を別の人が使っても別の会話・失敗した往復は保存しない・質問 2000 文字・1 会話 500 件（超えたら 422 `conversation_full`）・1 人 50 件（超えたら最も古い 1 件が消える）・全種類の結果の往復・`conversation_id: null` は「無し」 |
| 履歴が使えないとき（既存の構成で流す） | `test_history_unavailable.py` | `noauth`・`badauth`: 3 経路と chat＋`conversation_id` は、JWT を見る前に 503 `unavailable`（3 経路は `no-store`）。`jwksdown`: 無し・壊れた → 401、形の正しいトークン → 503。`dbdown`: 有効な JWT で 503 `db_unavailable`（chat は回答が無い・接続先を漏らさない）。どれも `conversation_id` なしの chat は 200 |
| 全体 | `test_errors.py`・`test_auth_independence.py` | エラーはすべて JSON の `{error:{code,message}}`（422 は `details` も）・存在しない経路は 404 `not_found`・許されないメソッドは 405 `method_not_allowed`・ログインの有無・設定は、ほかの入口に影響しない（応答が同じ） |

**履歴で契約にしないもの**（Go のテスト `go test -race`・保守コマンドのテストが持つ。仕様 §8 の E9）: 同じ会話への同時の書き込みで `seq` が重複・欠落しない・`updated_at` が逆戻りしない・同時の `DELETE` が保存を 401 に取り違えさせない・同じ人の同時の保存で 1 人 50 件の整理がデッドロックしない・一覧の「同時刻は `id` の昇順」・題名の作り方の単体（U+001F の畳み込み・「（題名なし）」）・保存のトランザクションの巻き戻し・**LLM を呼ぶ前に** `auth_user`・NUL・発言数を断ること（偽の LLM の呼び出しが 0 回。契約からは、模擬モデルが決定的で呼び出しが数えられないので見えない）・保存の失敗の分類（接続系 503・それ以外 500・`conversations_user_fk` だけ 401）・ログに本文・題名・`results`・生の ID が出ない・保守コマンド（既定は削除しない・`--apply`・境界）。

ヘッダー: API が付けるのは、`/api/me` と履歴の 3 本の `Cache-Control: no-store`（成功・401・503。履歴の 3 本は 204・404・422 も）・401 の `WWW-Authenticate: Bearer`・画像の `Cache-Control: private`・`Content-Type` だけ。**セキュリティヘッダー（CSP・HSTS など）は、API には無い**（画面の Next.js が付ける。`frontend/lib/security-headers.ts`）ので、契約に入れていない。

## 契約の決め方

- **固定する**: 状態コード・JSON のキーの集合と型・並び順・件数・上限・エラーの `code`・固定の文（ユーザーに見える文）・`tool_calls` と `results` の全体・数字が結果から出ていること。
- **固定しない**: 画素の完全な一致（縮小の方法は実装ごとに違ってよい。大きさ・向き・範囲・輪郭の色と線種を固定する）・座標や面積の小数の末尾（1e-6 度の許容）・時刻の表記（同じ時刻であればよい）・エラーの `details[].msg` の文（形だけ）・`no_data` の文面（読み込み方の案内を含む。読み込みの入口は将来移る）・`Cache-Control: private` の `max-age`・OpenAPI の自動文書（`/api/docs`・`/api/openapi.json` は FastAPI の機能）・末尾のスラッシュ（`/api/areas/` は Python では 307）・`HEAD`/`OPTIONS`・同じ引数の重複・`01` や `+5` のような数の別表記。
- **数字・件数は決め打ち**: 合成データから導いた値で、結果から読まない。導き方は `support/expected.py` の冒頭（地区 3 x 候補 3、2014 年は未検出 4・2014 年も検出 3・未判定 2、面積は画素数 x 約 0.2519 m²/画素 など）。
- **並びの同点**: 面積が同じ 3 件（75.6 m²）は id の昇順。比較（`compare_areas`）の同数は地区名の昇順（文字コード順）。`filter.area_ids` は文字列の昇順。SQL の照合順序に依らない形になっている（この合成データでは、どの照合でも同じ）。

## データの準備

検査が読み戻すデータは、`contract/synthetic.py` の合成データ（`kind=synthetic`、run_id `synthetic-test`）。`scripts/test-contract.sh` は、`contract/prepare_data.py` で書いて、`python -m pipeline.load --run` で入れる。手で用意するなら:

```sh
python contract/prepare_data.py --synthetic contract/synthetic.py --out DIR   # DIR/run（pipeline の出力）・DIR/tiles（写真）・DIR/outside.png。Pillow が要る
python -m pipeline.load --run DIR/run                                              # DATABASE_URL の DB へ（リポジトリの直下で）
# API は TILES_DIR=DIR/tiles で起動する
```

**利用者の行（構成 `history`）**: 偽の JWT の `sub` に対応する `auth_user` の行が要る（`conversation_id` つきの chat は、LLM を呼ぶ前に行の存在を確かめ、会話は `auth_user.id` への外部キーを持つ）。`scripts/test-contract.sh` は、データを読み込んだあと（`auth_user` の表ができたあと）に、使い捨ての DB へ**検査用の利用者 200 人**（`ct_user_000001`〜`ct_user_000200`。`sub` の規則 `[A-Za-z0-9_-]{8,64}` に合う）を入れる。検査は互いの状態に依存してはならない（「一覧が空」や件数は、同じ利用者を別の検査が使うと順序で壊れる）ので、**検査ごとに別の利用者**を使う（`support/fakes.py` の `fresh_user()`。同じ実行の中で重ならず、使い切ったらはっきり失敗する）。行の無い利用者（H-A4）は、プールの外の固定の `sub`（`ct_nouser_000001`）。契約の検査自身は DB に触れない。後始末はしない（DB は実行ごとの使い捨て）。
**`history` 構成は、使い捨ての DB 専用。** 同じ DB に 2 回流すと、前の実行の会話が残り、利用者が新しくならず、H-L1 などが落ちる。自分で用意した DB に流すときは、データを読み込んだあと、1 回だけ次の SQL を流す（人数は `CONTRACT_USER_POOL` と同じに）:

```sql
INSERT INTO auth_user (id, name, email, "emailVerified")
SELECT 'ct_user_' || lpad(n::text, 6, '0'), 'contract user ' || n, 'ct_user_' || lpad(n::text, 6, '0') || '@contract.test', false
FROM generate_series(1, 200) AS n;
```

写真タイルには、画像の 404 を確かめるための**故障を 3 つ仕込む**（`support/expected.py` の `TILE_FAULTS`）: 試験町の 2014 年 = ファイルが無い／仮想町の 2014 年 = PNG ではないファイル／仮想町の 2024 年 = `TILES_DIR` の外を指すシンボリックリンク（行き先は正しい PNG なので、外を読んだら 200 になって分かる）。合成町（A1）の候補は両年とも読めるので、画像の検査は主にこれを使う。
タイルは、R=列・G=行（タイル内の画素の位置）・B=年（2014→50、2024→200）の傾斜画像。切り出した画像の画素から、元のタイルのどこを切ったか（位置・範囲・向き）と、どの年かが分かる。

## 新しい実装の足し方

今の対象は `go` だけ。`scripts/test-contract.sh` の「対象」の節（`case "$TARGET"`）の 3 つ（`TARGET_IMAGE`・`TARGET_PORT`・`target_build`）が差し込み口。

- `go` の作り方: `GO_IMAGE_BUILD=local`（既定）は、ローカルの `docunavi-dev` でバイナリを作って alpine に載せる（取得なし）。`dockerfile` は、`api/Dockerfile` の `runtime` ターゲットを使う。
- API は、環境変数（`compose.yaml` の api と同じ名前: `DATABASE_URL`・`TILES_DIR`・`LLM_PROVIDER`〔`mock`〕・`AUTH_ISSUER`・`AUTH_JWKS_URL`・`AUTH_AUDIENCE`）だけで構成され、引数なしの起動で 8000 番の `/api/*` を待ち受ける。非 root で、読み取り専用のルートファイルシステムと、書き込めない `/work` でも起動すること。
- **スキーマの適用**: 構成 `empty` は、表を先に作ってから（`pipeline.db.apply_schema`）API を起動する。Go の API は起動時にも `schema.sql`・`auth.sql`・`history.sql` を適用する（`auth_` の表は画面のサーバーが使う）。

偽の JWKS サーバー（`support/fakes.py`）は検査のプロセスの中で動き、API はコンテナの名前（`townscan-contract-runner`）で取りに来る。鍵は実行ごとに作る（EC P-256 を 2 つ。使えない鍵: EdDSA・RSA・P-384・kid 無し・暗号化用）。**同じ API に続けて流すと、API が前の実行の鍵を覚えているので（10 分。未知の鍵 ID の取り直しは 60 秒に 1 回まで）、`/api/me` の検査が落ちることがある**（API を起動し直す。`scripts/test-contract.sh` は毎回起動し直す）。

履歴（構成 `history`）は、Go の API が実装した（仕様 §8 の E9。履歴の表 `api/internal/store/sql/history.sql` は起動時に適用される）。Python の API を消したので、機能の印の仕組み（`CONTRACT_FEATURES`・`@pytest.mark.history`）は外してよい（履歴を常に流す）。外すかは未決。

## 実装の内部の検査

HTTP から見えない・実装の言語に依存する検査（例外の変換・ツールの登録表・JWKS の保持・設定の読み取り・Gemini の窓口の再試行と期限）は、契約に足さず、Go のテスト（`api/`。`go test -race`）が持つ。Gemini の検査は `api/internal/chat/gemini_test.go`・`api/cmd/api/gemini_test.go`（偽の Gemini は `net/http/httptest`）。契約は、実 API を呼ばない・`LLM_PROVIDER=mock` だけ。ローダー・スキーマ・スクリプトの検査は `pipeline/dbtests/`・`scripts/tests/`（`scripts/test-loader.sh`）。

## ファイル

| パス | 役割 |
|---|---|
| `conftest.py` | `API_BASE_URL`・構成の選別（と、機能の印 `history` の選別）・API の準備待ちとデータの確認・偽の JWKS サーバーの fixture・履歴の利用者の fixture（`fresh_user`・`member`・`nouser`） |
| `support/client.py` | 標準ライブラリ（`http.client`）の HTTP クライアント（URL を正規化しない） |
| `support/expected.py` | 期待する合成データ（導き方つき） |
| `support/fakes.py` | 偽の JWKS サーバー・鍵・JWT の作り方・履歴の検査用の利用者（`fresh_user()`・`NOUSER_SUB`） |
| `support/history.py` | 履歴（H-系）の検査の道具: 経路・固定の文・利用者ごとの呼び出し（`Member`）・JSON として等しいかの確かめ方 |
| `test_history_auth.py`・`test_history_unavailable.py`・`test_history_list.py`・`test_history_messages.py`・`test_history_delete.py`・`test_history_chat.py` | 履歴の検査（H-A1・A2・A4／H-A5〜A7／H-L1〜L8／H-M1〜M5／H-D1〜D3／H-C1〜C7）。すべて機能の印 `history` つき |
| `support/chat.py` | チャットの結果の形・数字の検査 |
| `support/checks.py` | エラーの形などの共通の確かめ方 |
| `prepare_data.py` | 合成データと写真タイル（故障つき）を書く |
| `wait_ready.py` | `GET /api/health` が 200 になるまで待つ |
| `Dockerfile`・`requirements.txt`・`pytest.ini` | 検査を流すイメージ（固定版）・設定 |
