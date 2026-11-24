# TownScan backend

FastAPI（Python 3.13）・Postgres 17（psycopg 3・SQL は自前でパラメータ化）。仕様の正本は [../docs/spec-prototype.md](../docs/spec-prototype.md)（§2・§4.3〜§4.5・§8 E3/E5）。

## 動かす・試す

```sh
scripts/dev-up.sh [--no-web]                      # ホストで。.env 作成 → ビルド → compose up → healthy 待ち → 実データがあれば読み込み
                                                  # .env が無いのに DB のボリュームが残っているときは、パスワードを作り直さず止まる（DB と合わなくなるため）
scripts/test-backend.sh [pytest の引数]            # ホストで。使い捨ての Postgres（townscan-test-db・256m）でテストを流し、終わったら片付ける
docker compose exec -T api python -m app.load --run /data/townscan/run1/out [--check]   # pipeline の出力を DB へ（冪等）
python tests/synthetic.py --out DIR [--tiles DIR]  # 合成データ（kind=synthetic）の書き出し。tests/fixtures/synthetic_run はその写し
```

- ローダーは、全ファイルを先に検査してから 1 トランザクションで `run_id` ごと置き換える。足りない・壊れたファイルは日本語のエラーで止まる（DB は変わらない）。`--check` は DB に触れない。
- 環境変数: `DATABASE_URL`（必須）、`TILES_DIR`（既定 `/data/townscan/tiles`）、`LLM_PROVIDER`（`mock`＝既定、`gemini`。ほかは起動時にエラー）、`GEMINI_API_KEY`（`gemini` のとき必須。`.env` に自分で書く）、`GEMINI_MODEL`（任意。既定 `gemini-3.5-flash-lite`。下の「実 LLM（Gemini）」）。ログインの `AUTH_ISSUER`・`AUTH_AUDIENCE`・`AUTH_JWKS_URL` は任意（下の「認証」）。
- 開発コンテナの Python（`~/.venvs/townscan-backend`）でも `pytest` は動くが、DB のテストは `TEST_DATABASE_URL` が無いと skip になる。全部流すには `scripts/test-backend.sh`。

## 仕様に形の指定が無い応答（backend が決めたもの。frontend の型と合わせ済み）

- `GET /api/areas` は配列。要素は `{id, name, ward, municipality, bbox, centroid, counts}`（`name` は無ければ id、`ward` は無ければ空文字）。並びは北から南、西から東。
- `CandidateSummary` = `{id, area_id, area_name, ward, class, area_m2, bbox, centroid, reason}`。
- `CandidateDetail` = Summary + `{evidence, geometry, explanation_key, explanation, images:[{year,url}], provenance}`。`explanation_key` は `reason` と同じ値、`explanation` はその平易な日本語。
- `GET /api/metrics` は `eval.json` の内容に `provenance` を足したもの。
- 地区 id は `z18-{x}-{y}`、候補 id は `c-{x}-{y}-{n}`。形が違う値は 422、形が合って存在しない候補は 404。`year` は文字列 `"2018"` か `"2023"` だけ。`size` は 64〜1024。
- `POST /api/chat` の `messages` は 500 件まで受け付ける（超えたら 422）。frontend は会話の全履歴を送るので、件数で弾くと、その会話は二度と進まない。**返答に使う文脈は末尾 20 件だけ**（`app/chat/service.py` の `CONTEXT_MESSAGES`）。それより前の「その地区」「さっきの候補」は引き継がない。
- 模擬モデルは、ID（`c-…`・`z18-…`）が日本語に直接つながっていても読む（前後の半角の英数字・ハイフン以外は区切り）。区が複数出たら、すべて使う: 1 つなら `ward`、2 つ以上なら `wards`（ツールの引数。その区の地区の和集合。表示名は「中央区・西区」）。年は西暦のほか、和暦（令和6年・R6年）と漢数字（二〇二四年）も読み、写真が無い年・「最近」「現在」などは `no_photo_period` で断る。取り壊し・減少（2018 年にあって 2023 年に無い建物）は `not_implemented` で断る。
- `focus_map` の件数は DB の実数。地図に渡す候補 ID は 5000 件で切り、切ったときだけ、タイトルに「N 件のうち、面積の大きい上位 M 件」と書く。

## チャットのツールを足す

`app/chat/tools.py` の `ToolRegistry`（登録表）に `Tool(name, description, JSON Schema, handler)` を `register` する。ハンドラは §4.5 の形の結果（辞書）を返し、`ToolError` で refusal にできる。
模擬モデルに規則を足すのは `app/chat/mock_model.py`（`plan`）、結果の文章化は `register_renderer(type, fn)`。返答文は必ず `guard_numbers`（`app/chat/guard.py`）を通る: 数字が結果の値から出ていなければ、返さず安全なテンプレートに落とす。

## 実 LLM（Gemini。任意）

既定は模擬モデル。`.env` に `LLM_PROVIDER=gemini` と `GEMINI_API_KEY=<Google AI Studio の無料キー。自分で書く>` を足して api を作り直すと（`compose.yaml` が `.env` から渡す）、チャットの「どのツールを呼ぶか」と「結果の説明文」を Gemini（function calling）が作る。決定の理由・データの扱いは [../docs/decisions/0003-llm-provider.md](../docs/decisions/0003-llm-provider.md)、契約は [../docs/spec-prototype.md](../docs/spec-prototype.md) の §2.2・§4.5。

- 実装は `app/chat/gemini_model.py`（HTTP は標準ライブラリの `urllib`。依存は増やさない）。`service.answer` が、`app.state.llm`（`gemini` のときだけ作る窓口）があれば Gemini、無ければ模擬を使う。結果（`results`・`tool_calls`）は、どちらも `ToolRegistry` が DB から作る。
- 数字・件数・座標は LLM に書かせない: 返答文は同じ `guard_numbers` を通り、結果に無い数字を含む文は安全なテンプレートに替わる。`refuse` の `message` も、年（2018・2023）以外の数字を含むと固定の文に替える。
- 上限: モデルへの往復は最大 4 回・ツール呼び出しは最大 6 件・1 回の呼び出しの待ちは 20 秒（接続・受信の段階ごと）。チャット 1 回の要求の全体には 27 秒の期限があり、各呼び出しの待ちは残りの期限を超えない（Next.js の転送の既定の待ち 30 秒より前に、API が 502 を返すため）。超える・キー無効・429・5xx・壊れた応答は、模擬に切り替えず **HTTP 502**（`error.code = llm_unavailable`）。ログに出るのは、失敗の種類・HTTP のステータス・Google の理由の定数だけ（キー・URL・本文は出ない）。
- 再試行: 一時的な失敗（HTTP 5xx・タイムアウト・接続エラー）だけ、チャット 1 回の要求につき最大 1 回（往復ごとではない）、1 秒待ってやり直す。4xx（429 を含む）・壊れた応答はやり直さない（無料枠の上限は、待っても直らない）。やり直したことも、種別つきでログに残る。残りの期限が短い（待ったあとに 5 秒未満）ときは、やり直さない。
- キーは、URL でなくヘッダー `x-goog-api-key` で送り、repr・ログ・例外・`/api/health` に出さない。`/api/health` の `llm` は `mock`／`gemini`、`gemini` のときだけ `llm_model` が付く。
- テスト（`tests/test_gemini.py`・`tests/test_config.py`）は、偽の HTTP（`GeminiClient` の `send`、`post_json` の下の `_OPENER`）だけを使う。**実 API は呼ばない。実 API での動作は未確認**（キーが入ったあとに、手で確かめる）。

## 認証（ログインは任意）

ログイン（Google との通信・セッション・JWT の発行）は、画面のサーバー（Next.js）の中の Better Auth（`frontend/`）の仕事で、この API は扱わない。API がやるのは、web のサーバーが `Authorization: Bearer <JWT>` で送ってくる JWT の**検証だけ**（`app/jwt_auth.py`・`app/auth.py`）。
JobNavi の `backend/app/jwt_auth.py` と同じ考え方。チャット・地図・候補・精度など、ほかの入口はログインを要求せず、`Authorization` ヘッダーも見ない。

| 環境変数（名前だけ。値は `.env` や compose で渡す） | 意味 |
|---|---|
| `AUTH_ISSUER` | JWT の発行元（`iss`）。web の `BETTER_AUTH_URL` と同じ値（開発では `http://localhost:3500`）。完全一致で比べる（末尾の `/` は設定の読み取りで外す） |
| `AUTH_JWKS_URL` | 公開鍵の URL。web が配る `/api/auth/jwks`（compose の中では `http://web:3000/api/auth/jwks`） |
| `AUTH_AUDIENCE` | 対象（`aud`）。省略時は `townscan`（web の `JWT_AUDIENCE` と同じ値にする） |

- `AUTH_ISSUER` と `AUTH_JWKS_URL` の**両方**がそろったときだけ、検証が有効になる。**形が不正な URL**（http(s) 以外・ホストなし・読めない形。例: `BETTER_AUTH_URL` を `localhost:3500` と書くと、compose がそのまま `AUTH_ISSUER` へ渡す）は、**起動を止めない**: 変数名だけ（値は出さない）を警告として 1 行ログに出し、検証を無効にする（未設定と同じ。`/api/me` は 503）。ここで止めると、api が起動のたびに落ち、web も api の healthy を待つので、チャット・地図まで使えなくなる。`AUTH_AUDIENCE` は形の検査が無い文字列（空なら `townscan`）。`DATABASE_URL` が無い・`LLM_PROVIDER` が `mock` 以外のときは、これまでどおり起動時のエラー。
- **未設定（または形が不正）のときの動き**: `GET /api/me` だけが、トークンの有無を見る前に **503**（`unavailable`・「Google でのログインは、まだ設定されていません」）を返す（仕様 §4.4）。ほかの入口と起動は、何も変わらない。
- **署名の検証**: JWKS の公開鍵だけで行う。**alg は ES256 に固定**（`none`・HS256・RS256 などは、鍵を取りに行く前に断る）。鍵は EC の P-256 で `kid` があるものだけ。`exp`・`iss`・`aud`・`sub` は必須（時計のずれは 10 秒まで許す）。`sub` は Better Auth の利用者 ID（英数字と `_` `-`、8〜64 文字）。
- **JWKS の鍵の置き場**: メモリーに 10 分。未知の `kid` は、60 秒に 1 回まで取り直す（でたらめな `kid` で、web への問い合わせを増やさせない）。取得の待ちは 3 秒・本文は 1 MB まで。取れなかったときは、前の鍵で続ける。**鍵が 1 つも無いまま**取れなかったときは、その要求を **503**（`unavailable`）にし、次の 5 秒間は取りに行かず即 503（web が落ちていても、API のスレッドを待ちで埋めない）。ほかの入口には影響しない。使える鍵が 1 つも無い JWKS も、取得の失敗として扱う。
- 応答の本文は固定の文。例外の文字列・URL・パスは出さず、ログに残すのは失敗の種類（例外のクラス名）だけ。トークン・`Authorization` ヘッダーはログに出さない。

### `GET /api/me`

`Authorization: Bearer <JWT>` を検証して、ログイン中の人を返す。DB は使わない。応答のヘッダーは、成功・失敗とも `Cache-Control: no-store`。

| 状態 | 応答 |
|---|---|
| 検証に通った | 200 `{sub, email, name, picture}`（JWT の claim。無い・使えない値は `null`。`picture` は `https://` の 2048 文字までの URL だけ（claim `picture`、無ければ `image`）。`name` は印字できない文字（制御文字のほか、全角空白・ゼロ幅の文字も）を除いて 100 文字まで。`email` は `@` を含む 254 文字まで） |
| ヘッダーが無い・`Bearer` 以外・形が違う・期限切れ・署名が違う・`aud` / `iss` の不一致・`kid` が不明・`alg` が ES256 以外 | 401 `{"error": {"code": "unauthorized", "message": "ログインしてください"}}`（理由は分けない）+ `WWW-Authenticate: Bearer` |
| 認証が未設定（`AUTH_ISSUER`・`AUTH_JWKS_URL` のどちらかが無い、または URL の形が不正）。トークンの有無より先に返す | 503 `{"error": {"code": "unavailable", "message": "Google でのログインは、まだ設定されていません"}}` |
| 鍵（JWKS）を取れない | 503 `{"error": {"code": "unavailable", "message": "ログインを確認できませんでした。しばらくしてから、もう一度お試しください"}}` |

JWT の中身は web（Better Auth の `jwt` プラグイン）が決める: ES256・15 分・`sub` = 利用者 ID・`email`・`email_verified`（API は読まない）・`name`・`picture`。

### 利用者の表（`db/auth.sql`）

Better Auth の表 `auth_user`・`auth_session`・`auth_account`・`auth_verification`・`auth_jwks`（形は JobNavi の `0004_better_auth.sql` と同じ。列名は Better Auth が決めた camelCase）。web が同じ DB の同じ表を読み書きし、API は読まない（DB のユーザーは API と同じで、表ごとの権限分けはしない）。TownScan には、利用者のプロフィールの表は無い。

- 適用は `schema.sql` と同じ仕組み（`app/db.py` の `apply_schema`）: **API の起動時とローダーの実行時に、`schema.sql` → `auth.sql` の順に、1 つのトランザクション・アドバイザリロックの下で流す**。どちらも `IF NOT EXISTS` だけの冪等な SQL なので、すでにあるボリュームにも、起動のたびに流れて、足りない表だけが増える（既存の表・行は変えない。`DROP`・`TRUNCATE`・`ALTER` は無い）。
- SQL の誤りは、やり直さずにそのまま例外になり、API の起動が止まる（途中まで作った表も残らない）。DB がまだ起きていないときだけ、数回やり直す。
- web（Better Auth）は、API が healthy になってから起動する（compose の `depends_on`）ので、web が始まるときには表がある。web 側で表を作る処理は持たない。
- `BETTER_AUTH_SECRET` は決めたら変えない（`auth_jwks` の秘密鍵の暗号化に使う。変えると全員がログアウトに見え、直すには `auth_jwks` の行を消す）。

テスト: `tests/test_jwt_auth.py`（検証・鍵の置き場・本物の HTTP での取得。DB 不要）、`tests/test_me.py`（`/api/me`・ほかの入口がログインを要求しないこと）、`tests/test_auth_schema.py`（表の形・2 回流して同じ・既存のボリューム・失敗で止まる。使い捨ての DB を作る）、`tests/test_config.py`（環境変数）。
鍵・トークンはテストの中で作り（`tests/jwt_tokens.py`）、ファイルには書かない。Better Auth と Google は呼ばない（JWKS は差し替える）。
