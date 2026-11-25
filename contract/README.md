# contract/ — API の契約の検査

TownScan の API（`/api/*`）が、**HTTP から見える振る舞い**を満たしているかを確かめる pytest。起動中の API へ HTTP だけで叩く。API の実装の言語に依らず、アプリのコード（`backend/`・将来の `api/`）は import しない。
いまの Python（FastAPI）の API で全件合格することを確かめてから、Go の API（`docs/decisions/0005-api-in-go.md`）が同じ検査に合格することを、置き換えの条件にする（`docs/plan.md` の PG 段の出口条件①②）。
**契約は、いまの振る舞いを固定する。** Python の API の本物のバグは契約にしない（見つけたら直すか、報告する）。

## 流し方

```sh
scripts/test-contract.sh python          # 全部。使い捨ての Postgres と API を起動し、構成ごとに検査を流して、全部消す（Docker が要る）
scripts/test-contract.sh go              # Go の API。api/Dockerfile がまだ無いので「未対応」と出して終わる（終了コード 2）
scripts/verify.sh contract               # 同じもの（verify.sh の「contract」の段）
CONTRACT_PHASES=main scripts/test-contract.sh python -k chat -x   # 開発用: 構成を絞る・pytest の引数を渡す
```

`scripts/test-contract.sh` がやること（どの実装でも同じ）: ① 検査を流すイメージ（`contract/Dockerfile`。pytest・PyJWT・Pillow だけ）と、データの読み込みのイメージ（`backend/` の runtime。`python -m app.load` は API が Go になっても Python の仕事）と、対象の API のイメージを作る
→ ② 使い捨ての Postgres（`townscan-contract-db`・mem_limit 256m・データは tmpfs）を、外へ出られない専用ネットワーク（`--internal`）で起動 → ③ 合成データを書いて（`contract/prepare_data.py`）、`python -m app.load --run` で DB へ入れる
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
| `CONTRACT_JWKS_BIND`・`CONTRACT_JWKS_PORT` | 偽の JWKS サーバー（検査のプロセスの中）の待ち受け先（既定 `0.0.0.0:8901`）。API の `AUTH_JWKS_URL` がここを指す |
| `CONTRACT_AUTH_ISSUER` | 偽の画面のサーバーの発行元（既定 `https://auth.contract.test`）。API の `AUTH_ISSUER` と同じにする |
| `CONTRACT_TIMEOUT`・`CONTRACT_READY_TIMEOUT` | 1 回の要求の待ち（既定 20 秒）・API が応答するまでの待ち（既定 60 秒） |

## API の構成（variant）

API は、環境変数（`compose.yaml` の api と同じ名前）だけで構成される。構成ごとに API を起動し直して、その構成の検査だけを流す（`@pytest.mark.variant(...)`。付けなければ `main`）。

| 構成 | API の起動時の設定 | 確かめること | 検査 |
|---|---|---|---|
| `empty` | 表だけがある空の DB。ログインの設定なし | データを読む入口は 503 `no_data`（引数の検証 422 が先）。ヘルスは 200（run は null）。チャットは `no_data` の断り | `test_no_data.py` |
| `main` | 合成データ入りの DB。`AUTH_ISSUER`・`AUTH_JWKS_URL`（偽の JWKS サーバー）あり。`AUTH_AUDIENCE` は**設定しない**（既定 `townscan` の検査を兼ねる） | 本体。全エンドポイントの正常系・異常系、チャット、画像、`/api/me` の検証 | 上記以外のすべて |
| `noauth` | `main` と同じデータ。`AUTH_*` なし | `/api/me` は、JWT の有無・形を見る前に 503。ほかの入口は影響を受けない | `test_me_unconfigured.py`・`test_auth_independence.py` |
| `badauth` | `AUTH_ISSUER=localhost:3500`（http(s) の URL でない。`BETTER_AUTH_URL` の書き間違いを `compose.yaml` がそのまま渡した想定）、`AUTH_JWKS_URL` は正しい | 起動は止まらず、`noauth` と同じ動き（JWKS を取りに行かない） | 同上 |
| `jwksdown` | `AUTH_ISSUER` は正しい、`AUTH_JWKS_URL` は届かない URL（接続拒否） | 鍵を要する検証は 503（詳細を漏らさない）。鍵を使わずに断れるものは 401 のまま | 同上 |
| `dbdown` | `main` と同じ。起動して healthy を確かめたあとで、DB を止める | ヘルスは 503（`status`・`db` が error）、データを読む入口は 503 `db_unavailable`、DB を使わない `/api/me` は 200 | `test_no_data.py` |

API の起動時の設定（対象に関わらず同じ）: `DATABASE_URL`・`TILES_DIR`・`LLM_PROVIDER=mock`・（構成により）`AUTH_ISSUER`・`AUTH_JWKS_URL`。API は、引数なしの起動（イメージの CMD）で、コンテナの 8000 番を待ち受ける。

## 保証すること

| エンドポイント | 検査 | 固定するもの |
|---|---|---|
| `GET /api/health` | `test_health.py`・`test_no_data.py` | キーの集合・`status`/`db`/`llm`（模擬）・現在の run（`created_at` は同じ時刻の ISO 8601）・件数。DB が止まれば 503。データ無しは 200 |
| `GET /api/areas` | `test_areas.py` | 並び（北→南・西→東）・キーと型・bbox・centroid・分類ごとの件数と合計 |
| `GET /api/candidates` | `test_candidates.py` | 並び（面積の降順、同じなら id の昇順。`area_asc` も）・total・キーと値・`cls`/`area_id` の絞り込み・`limit`（1〜500）/`offset`（0〜1,000,000）・不正な引数は 422（`query.<名前>`）。入力値は応答に出さない |
| `GET /api/candidates.geojson` | `test_candidates.py` | `application/geo+json`・FeatureCollection・並び・properties（`id`,`class`,`area_m2`,`area_id`）・外周の座標・絞り込み・422 |
| `GET /api/candidates/{id}` | `test_detail.py` | 9 候補すべての詳細（evidence・geometry・理由ごとの固定の説明文・画像の URL・provenance）・内部の値（tile_x/tile_y）を出さない・404 `not_found`・形が違う id は 422（`path.candidate_id`） |
| `GET /api/candidates/{id}/image` | `test_image.py` | PNG（`image/png`）・大きさ（64〜1024、既定 512、正方形）・年は 2018・2023 だけ・年ごとの写真・向きと範囲（候補が真ん中・余白は約 20 m・タイルの外へ出ず内側へずらす）・輪郭の色と線種（実線・破線・点線）・`Cache-Control: private`・422・404（候補なし）・404 `tile_not_found`（ファイルなし・壊れたファイル・`TILES_DIR` の外を指すリンク。パスを漏らさない） |
| `GET /api/metrics` | `test_detail.py` | 評価ファイルの内容そのもの + provenance（2018 年の写真・固定の注記） |
| `POST /api/chat` | `test_chat_answers.py`・`test_chat_behavior.py` | 代表的な質問 29 件の答え（`tool_calls`・`results`・`content` を全体で）。ツールの選び方・範囲外の断り（`out_of_scope`・`no_photo_period`・`not_implemented`）・文脈（末尾 20 件だけ）・履歴の上限（500 件まで・1 件 2000 文字）・不正な入力は 422・**返答文の数字は結果の値だけから出る**（`support/chat.py` の検査。`guard_numbers` の契約）・SQL インジェクションの文字列が検索を変えない |
| `GET /api/me` | `test_me.py`・`test_me_unconfigured.py` | JWT の検証（ES256 のみ・`iss`/`aud`/`exp`/`sub` 必須・完全一致・10 秒のずれまで・署名・kid・使えない鍵が混ざる JWKS）・`{sub,email,name,picture}` の整形（https の画像・254 文字のメール・100 文字の名前・印字できない文字を除く）・401（固定の文・`WWW-Authenticate: Bearer`・`no-store`）・503（未設定・JWKS 不達） |
| 全体 | `test_errors.py`・`test_auth_independence.py` | エラーはすべて JSON の `{error:{code,message}}`（422 は `details` も）・存在しない経路は 404 `not_found`・許されないメソッドは 405 `method_not_allowed`・ログインの有無・設定は、ほかの入口に影響しない（応答が同じ） |

ヘッダー: API が付けるのは、`/api/me` の `Cache-Control: no-store`（成功・401・503）・401 の `WWW-Authenticate: Bearer`・画像の `Cache-Control: private`・`Content-Type` だけ。**セキュリティヘッダー（CSP・HSTS など）は、API には無い**（画面の Next.js が付ける。`frontend/lib/security-headers.ts`）ので、契約に入れていない。

## 契約の決め方

- **固定する**: 状態コード・JSON のキーの集合と型・並び順・件数・上限・エラーの `code`・固定の文（ユーザーに見える文）・`tool_calls` と `results` の全体・数字が結果から出ていること。
- **固定しない**: 画素の完全な一致（縮小の方法は実装ごとに違ってよい。大きさ・向き・範囲・輪郭の色と線種を固定する）・座標や面積の小数の末尾（1e-6 度の許容）・時刻の表記（同じ時刻であればよい）・エラーの `details[].msg` の文（形だけ）・`no_data` の文面（読み込み方の案内を含む。読み込みの入口は将来移る）・`Cache-Control: private` の `max-age`・OpenAPI の自動文書（`/api/docs`・`/api/openapi.json` は FastAPI の機能）・末尾のスラッシュ（`/api/areas/` は Python では 307）・`HEAD`/`OPTIONS`・同じ引数の重複・`01` や `+5` のような数の別表記。
- **数字・件数は決め打ち**: 合成データから導いた値で、結果から読まない。導き方は `support/expected.py` の冒頭（地区 3 x 候補 3、新規出現 4・描き漏れ 3・保留 2、面積は画素数 x 約 0.2519 m²/画素 など）。
- **並びの同点**: 面積が同じ 3 件（75.6 m²）は id の昇順。比較（`compare_areas`）の同数は地区名の昇順（文字コード順）。`filter.area_ids` は文字列の昇順。SQL の照合順序に依らない形になっている（この合成データでは、どの照合でも同じ）。

## データの準備

検査が読み戻すデータは、`backend/tests/synthetic.py` の合成データ（`kind=synthetic`、run_id `synthetic-test`）。`scripts/test-contract.sh` は、`contract/prepare_data.py` で書いて、`python -m app.load --run` で入れる。手で用意するなら:

```sh
python contract/prepare_data.py --synthetic backend/tests/synthetic.py --out DIR   # DIR/run（pipeline の出力）・DIR/tiles（写真）・DIR/outside.png。Pillow が要る
python -m app.load --run DIR/run                                                    # DATABASE_URL の DB へ（backend/ で）
# API は TILES_DIR=DIR/tiles で起動する
```

写真タイルには、画像の 404 を確かめるための**故障を 3 つ仕込む**（`support/expected.py` の `TILE_FAULTS`）: 試験町の 2018 年 = ファイルが無い／仮想町の 2018 年 = PNG ではないファイル／仮想町の 2023 年 = `TILES_DIR` の外を指すシンボリックリンク（行き先は正しい PNG なので、外を読んだら 200 になって分かる）。合成町（A1）の候補は両年とも読めるので、画像の検査は主にこれを使う。
タイルは、R=列・G=行（タイル内の画素の位置）・B=年（2018→50、2023→200）の傾斜画像。切り出した画像の画素から、元のタイルのどこを切ったか（位置・範囲・向き）と、どの年かが分かる。

## 新しい実装（Go の `api/`）の足し方

1. **`api/Dockerfile` に `runtime` ターゲット**を作る。コンテナの 8000 番で `/api/*` を待ち受け、引数なしの起動で動く。環境変数は `compose.yaml` の api と同じ名前: `DATABASE_URL`・`TILES_DIR`・`LLM_PROVIDER`（`mock`）・`AUTH_ISSUER`・`AUTH_JWKS_URL`・`AUTH_AUDIENCE`。イメージは非 root で動くこと（読み取り専用のルートファイルシステムと、書き込めない `/work` で起動する）。
2. `scripts/test-contract.sh` の「対象」の節（`case "$TARGET"`）は、`go` で `api/Dockerfile` があれば、`docker build --target runtime -t townscan-contract-api-go api` で作って流す形になっている（`TARGET_IMAGE`・`TARGET_PORT`・`target_build` の 3 つが差し込み口）。違う作り方・ポートなら、そこを直す。`api/` がまだ無いので、本物の Go のイメージでは確かめていない: `api/Dockerfile` が無いときの「未対応」（終了コード 2）と、一時的に置いた `FROM` が Python のイメージだけの `api/Dockerfile` で `go` の経路が最後まで流れることまで確かめた（その `api/` は消してある）。
3. 実装が先に `scripts/test-contract.sh go` で流れる（読み取り → 認証 → 検出画像 → チャットの順に実装するなら、`-k` と `CONTRACT_PHASES` で、できたところから流す。構成 `main` の検査には、すべてのエンドポイントが入っている）。
4. **スキーマの適用**: 構成 `empty` は、表を先に作ってから（`app.db.apply_schema`）API を起動する。Python の API は起動時にも `schema.sql`・`auth.sql` を適用する（`auth_` の表は画面のサーバーが使う）。Go の API が適用するか、別の経路（ローダー・起動の手順）が適用するかは、置き換えのときに決める（契約は HTTP だけなので、どちらでも通る。**決めないと、画面のログインが `auth_` の表を見つけられない**）。
5. `compose.yaml` の api を Go のイメージに替えたあと、`scripts/verify.sh`（`contract` の段を含む全段）と `scripts/dev-up.sh` の実機で、画面の操作が従来どおりであることを確かめる（ADR 0005 の「結果」6）。Python の API を消したら、`scripts/test-contract.sh` の `python` の対象と、下の「残す検査」を整理する。

偽の JWKS サーバー（`support/fakes.py`）は検査のプロセスの中で動き、API はコンテナの名前（`townscan-contract-runner`）で取りに来る。鍵は実行ごとに作る（EC P-256 を 2 つ。使えない鍵: EdDSA・RSA・P-384・kid 無し・暗号化用）。**同じ API に続けて流すと、API が前の実行の鍵を覚えているので（10 分。未知の鍵 ID の取り直しは 60 秒に 1 回まで）、`/api/me` の検査が落ちることがある**（API を起動し直す。`scripts/test-contract.sh` は毎回起動し直す）。

## 実装の内部の検査として残すもの（`backend/tests/`。契約にしない）

HTTP から見えない・実装の言語に依存する検査は、`backend/tests/` に残す。Go の `api/` は、同じ観点を Go のテスト（`go test -race`）で持つ。

| ファイル | 残すもの | 理由 |
|---|---|---|
| `test_api.py` | 想定外の例外が 500 `internal_error`（詳細を漏らさない）・DB の例外の変換・OpenAPI が `/api` 配下にあること | 例外を起こす差し込み（monkeypatch）が要る・FastAPI の機能。DB 停止の 503 は契約（`dbdown`） |
| `test_chat.py` | ツールの登録表（`ToolRegistry`）・ツールの引数の検証・`limit` の丸め・`refuse` の reason の正規化・`guard_numbers` に落ちる偽の返答・`focus_map` の地図用 ID の上限（5000 件。切ったときだけ、タイトルに「N 件のうち上位 M 件」） | Python のクラスに依存・内部の関数を直接呼ぶ・5000 件のデータが要る。数字の検査は、模擬モデルの全返答で契約が確かめる |
| `test_image.py` | `tile_file`・`crop_box`・`_dashed` の単体 | Python の内部の関数。結果（位置・範囲・線種）は契約が画素で確かめる |
| `test_me.py` | OpenAPI に載ること・ログに URL・例外の文字列・トークンが出ないこと | FastAPI の機能・ログは HTTP から見えない |
| `test_jwt_auth.py` | `JwtVerifier` の単体: JWKS の保持（10 分）・未知の kid の取り直し（60 秒に 1 回）・失敗後の 5 秒の間隔・前の鍵で続ける・本文の上限（1 MB）・取得の待ち（3 秒）・JWKS が JSON でない／空 | 時間に依存する・内部の状態 |
| `test_auth_schema.py` | `auth.sql` の列・型・冪等・既存の行を消さないこと | DB の表の検査（HTTP から見えない） |
| `test_config.py`・`test_gemini.py`・`test_mock_model.py`・`test_guard.py`・`test_loader.py`・`test_dev_up.py`・`test_login_secrets.py` | 設定の読み取り・Gemini の窓口（再試行・27 秒の期限・502）・模擬モデルの規則の単体・数字の検査の単体・ローダー・スクリプト | 内部の関数・偽の外部サーバーが要る・Python（解析側）に残る |

Go の `api/` に Gemini の窓口ができた（2026-11-25）。その検査（再試行・期限・502・キーが出ない）は、契約に足さず、Go のテストに持つ（`api/internal/chat/gemini_test.go`・`api/cmd/api/gemini_test.go`。偽の Gemini は `net/http/httptest`）。契約は、実 API を呼ばない・`LLM_PROVIDER=mock` だけのまま。

## ファイル

| パス | 役割 |
|---|---|
| `conftest.py` | `API_BASE_URL`・構成の選別・API の準備待ちとデータの確認・偽の JWKS サーバーの fixture |
| `support/client.py` | 標準ライブラリ（`http.client`）の HTTP クライアント（URL を正規化しない） |
| `support/expected.py` | 期待する合成データ（導き方つき） |
| `support/fakes.py` | 偽の JWKS サーバー・鍵・JWT の作り方 |
| `support/chat.py` | チャットの結果の形・数字の検査 |
| `support/checks.py` | エラーの形などの共通の確かめ方 |
| `prepare_data.py` | 合成データと写真タイル（故障つき）を書く |
| `wait_ready.py` | `GET /api/health` が 200 になるまで待つ |
| `Dockerfile`・`requirements.txt`・`pytest.ini` | 検査を流すイメージ（固定版）・設定 |
