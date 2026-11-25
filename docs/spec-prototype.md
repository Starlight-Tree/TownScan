# たたき台の仕様（ローカルで動き、UI で操作できる縦切り）

状態: 2026-11-24 起草（ユーザー依頼「アプリをローカル環境で動かして UI で操作できるたたき台になるところまで」）。**この文書が契約**。実装はここに従い、変えるときは先にここを直す。
改訂 2026-11-25: §4.2（`reason` から `small` を外す）と §6（縁の除外を左右対称に・追加の診断・参照の時期の注記）を、実装と監査の指摘に合わせて直した。
改訂 2026-11-25（2）: **任意のログイン**（Google だけ。ユーザー依頼「サイドバーも統一感を出して。そこのメニューも同様に」「プロフィールアイコンとかアカウントのロジックも同じにしておいて」。JobNavi・DocuNavi にそろえる）を足した。§2.1（認証）・§4.4（`GET /api/me`）・§7（サイドバー・アカウントのメニュー・`/login`）。既存の機能（チャット・地図・詳細・精度・このアプリについて）の契約は変えない。
改訂 2026-11-25（3）: 独立検証の指摘に合わせ、§2.1・§4.4（形が不正な `AUTH_ISSUER`・`AUTH_JWKS_URL` は起動を止めず、警告を出して検証を無効にする。JWT の `email_verified`。`email`・`name`・`picture` の整形の規則）と §7（ログインしていないときの印は「≡」）を、実装に合わせて直した。
改訂 2026-11-25（4）: `/` の画面（§7）を、右に「結果領域」（地図・グラフ・写真の比較のタブ）を置く設計に書き換えた（旧: 右に地図、候補の詳細は重なって開くドロワー）。回答の型から画面への自動の切り替え、手で選んだタブを保つこと、回答の条件（地区が 1 つ・複数・全地区、分類）を地図・グラフ・集計の帯へ同じに反映し、候補の一覧へは、地区が 1 つのときだけ地区で絞って反映すること（API が地区を 1 つしか受けないため。複数の地区のときは、一覧の本体を出さず、案内を出す）、印を押したときは地図に留まり「写真を比べる」で切り替わること、回答カードのボタンでその回答の条件を復元すること、「拡大」、縦に積む幅のスクロールを定めた。§4.5 は、backend がすでに返している `filter` の形（`area_ids`・`scope`、表と比較にも付く）に合わせて直した。API の振る舞いは変えない。
改訂 2026-11-25（5）: **任意の実 LLM（Gemini）**を足した（ユーザー承認 2026-11-25「いいよ　さっさとつないで試してよ」→ Gemini の無料キー）。§1・§2.2（環境変数。新設）・§3・§4.4（`/api/health` の `llm`・`llm_model`、`POST /api/chat` の 502）・§4.5（Gemini を選んだときの役割・安全・失敗）を、実装に合わせて直した。既定は模擬のまま。決定の理由・データの扱いは [ADR 0003](decisions/0003-llm-provider.md)。**実 API での動作は未確認**（キーが入ったあとに確かめる）。
改訂 2026-11-25（6）: `/` の画面（§7）を、実装に合わせて直した。分類の凡例を地図の上から外して集計の帯のチェックボックスへ移し、地図についての通知を地図の下の 1 行の帯へ移した。選択中の候補は、地図に重なるカード（地図の大きさは変わらない）にし、読み上げを足した。「拡大」の列幅を 340px から 280px にした。チャットは、開いた直後に説明の見出しから読み始められるようにした。詳細（写真の比較）は、「写真の比較」が見えるまでマウントも通信もしない。詳細を閉じたあとのフォーカスが body に落ちないようにした。回答の「対象・条件」は、右の絞り込みと同じ「最後の `count` か `compare`」から作る。API の振る舞いは変えない。**実画面（ブラウザー）では未確認**（コードと jsdom のテストで確かめた。幅の見積もりは CSS からの計算）。
改訂 2026-11-25（7）: `/` の最初の画面（§7）を、**チャットだけ**に変えた（旧: 会話の前から右に地図の結果領域が開いていた）。結果領域は、結果つきの回答か「地図で見る」などの操作で開き、「新しい会話」で閉じる。知らせの live region を結果領域の外へ出した。
改訂 2026-11-25（8）: `/` の画面（§7）を、**チャットだけの 1 列と「拡大ビュー」**に変えた（ユーザー決定 2026-11-25「そもそも　チャットウィンドウの中に回答全部出して　最大化ボタンみたいなのでキャンバスにした方がいい？」→ 案 D・既定案どおり）。常設の右の結果領域をなくし、結果は回答カードの中に出す。カードのボタン（「グラフで見る」「地図で見る」「詳細」など）を押すと、その回答の地図・グラフ・写真の比較が、大きなダイアログ（狭い幅では全面のシート）で開く。回答が届いても、画面は自動で開かない・替わらない。回答の条件の反映・詳細・地図の中身は、拡大ビューの中で今までと同じ。比較のカードは上位 5 地区までにした。API の振る舞いは変えない。
改訂 2026-11-25（9）: **`compose.yaml` の api を Go に切り替えた**（ユーザー承認 2026-11-25「y」）。api は `api/` の Go（mem_limit 1g・`GOMEMLIMIT`・`/api -healthcheck`）。FastAPI 版は `compose.python-api.yaml`（`scripts/dev-up.sh --api python`）として、Gemini の窓口が Go に入るまで残す。データの読み込み（`app.load`）は、常駐しない `loader`（Python）で行う（`docker compose run --rm loader python -m app.load …`）。Go の API は `LLM_PROVIDER=gemini` で起動を止める（黙って模擬に落とさない）。API の契約（§4）は変えない。
改訂 2026-11-25（10）: **会話の履歴**（ログイン中だけ・サーバーに保存・一覧・開き直し・2 段階の削除。ユーザー依頼「履歴は DocuNavi と同じ型」）を、**仕様として**足した。§1（対象外の認証の注記）・§2.1（ログインの有無で変えない範囲の例外と、`auth_user.id` の存在だけを api が読むこと）・§2.3（新設）・§4.3（表 2 つ。DDL は仕様の案で、実行しない）・§4.4（`/api/conversations` 3 本、`POST /api/chat` の任意の `conversation_id`、履歴のエラーと `Cache-Control`、空白の集合、題名の規則）・§7・§7.1（新設。サイドパネルの会話の履歴・開き直し・解析結果が変わった回答の扱い）・§8（E9）。ログインしていない間と、`conversation_id` を付けない要求は、今までと同じ。**この改訂は仕様だけで、実装は Go への切り替え（[ADR 0005](decisions/0005-api-in-go.md)）のあと**（Go の API にだけ入れる。Python の API には入れない。コードも DDL も、まだ無い。実装したら、この注を消す）。決定・理由・選ばなかった案・未確認は [ADR 0006](decisions/0006-conversation-history.md)。
改訂 2026-11-25（11）: **回答の中に、グラフと地図そのものを出す**（ユーザー依頼 2026-11-25「回答の中にグラフや地図を出す。小さくなくてよい。その方がいいならやって」。ユーザーが最初に言った「チャットウィンドウの中に回答全部出して、最大化ボタンでキャンバスにする」に沿う）。件数・比較・地図の表示の回答の、結果カードの並びの下に、「図」を出す（件数＝地図とグラフ、比較＝グラフ、地図の表示＝地図。写真の比較は図に入れない）。各図の「拡大」（「地図を拡大」「グラフを拡大」）を押すと、その回答の拡大ビューを、その図の画面で開く（拡大ビューは残す。自動では開かない）。図と拡大ビューは、回答ごとの同じ状態（絞り込み・強調・選んだ候補・寄せ先）を読み書きする（図で変えたことは拡大ビューに引き継がれ、逆も同じ）。件数・比較のカードの「グラフで見る」「地図で見る」は、図が代わるので外した（地図の表示のカードの「地図で見る」は残す）。§7（回答の中に出すもの・回答の中の図〔新設〕・拡大ビューを開く・拡大の単位・「新しい会話」・回答カードのボタン・幅）・§7.1.4・§7.1.5・§8 の E8 を直した。API の振る舞いは変えない。**実画面（Chrome）・スクリーンリーダーでは未確認**（コードと jsdom のテストで確かめた。図の読み上げの抑え方は、`aria-live="off"` の入れ子で、読み上げソフトでの挙動は未確認）。
位置づけ: [plan.md](plan.md) の P2（建物抽出と評価）・P3（差分・API・DB）・P4（チャット）を、薄く一通り通す。GEE 層（P5）・パネル（P6）・公開（P7）は対象外。

## 1. 何ができれば「たたき台」か

1. 熊本の 12 地区（z18 タイル 12 枚。2018・2023 年の写真が両方ある）で、事前学習モデルの建物抽出 → 2 時点の差分 → 「新規出現候補」3 分類が、**実データで**出る（Colab の T4 で推論）。
2. `docker compose up` で db・api・web が立ち上がり、ブラウザ（`http://127.0.0.1:3500`）で、チャットで質問でき、地図に候補が出て、1 棟ずつ 2018 / 2023 の写真を見比べられる。
3. 「このアプリの精度」の画面に、**実測した数字**（基盤地図情報 2018-10 版を参照にした建物抽出の指標）が出る。新築の再現率は手ラベルが無いので「未測定」と明示する。
4. 数字・件数・座標は、ツールの結果だけから出る（LLM に書かせない。模擬モデルが既定で、任意で Gemini を選べる。LLM の役割はツールの選択と説明文だけ。§2.2・§4.5）。範囲外は断る。
5. 合成データ（テスト用）と実データを取り違えない（§4 の `run.kind`、UI のバナー）。

対象外（やらない・やったと書かない）: GEE 層、パネル、確認モード（人の確定）、認証（ただし、**任意のログインだけ** §2.1 に足した。機能の制限・権限の分けには使わない。ログインの有無で変わるのは、**会話の履歴の保存と、その検査・開き直しだけ**: §2.3。仕様のみで、実装は Go への切り替えのあと）、公開、地区の行政区画の厳密な境界、PostGIS。実 LLM は、**任意で選べる Gemini だけ**を §2.2・§4.5 に足した（既定は模擬。ほかの LLM は対象外）。

## 2. 構成

```
host ブラウザ ──> web (Next.js, 127.0.0.1:3500) ──/api/* を転送──> api (Go, 127.0.0.1:8500) ──> db (Postgres 17, 公開しない)
                                                                  └─ ./data/townscan を読み取り専用でマウント（写真タイル）
```

- 起動はホストの Docker Compose（`compose.yaml`）。ポートは `127.0.0.1` だけに公開（既存の jobnavi 3200/8200・shoporder 3400/8400・docunavi 5433 と重ねない）。db は公開しない。
- Docker VM は 8 GB で、他プロジェクトが約 5.3 GB を使っている。**本番ビルド（`next build` + standalone 実行）**にし、compose の `mem_limit` を db 256m・api 1g（Go の JSON の読み込みが本文の数十倍のメモリーを使うため。FastAPI 版は 512m）・web 512m とする。実測の使用量を報告する。
- **メモリーの制約（2026-11-24 夜に実測）:** Docker VM の空きは約 0.5 GB（`free -m` の available 519 MB。jobnavi-frontend 1.9 GB・shoporder-frontend 3.3 GB が常駐）。ここで `next build`・`tsc`・`vitest` のような重い処理を流すと、OOM キラーが他プロジェクトのコンテナを落とす恐れがある。**他プロジェクトのコンテナは止めない・触らない。** よって **frontend の重い処理（`npm ci`・型検査・テスト・`next build`）はホストの Node 24 で行う**（理由: VM の空きメモリー。ホストの RAM は 17 GB。Node 24 は `npx -y -p node@24 -- <コマンド>` で得られる。実測で node v24.22.3）。Python の処理（pipeline・backend の単体テスト）は軽いので開発コンテナで行う。
- web のイメージは 2 つの target を持つ: `runtime`（イメージの中で `npm ci` と `next build` まで行う。メモリーに余裕のある環境・CI 用）と `prebuilt`（ホストで作った `.next/standalone` を載せるだけ。この VM ではこちらを使う）。`scripts/dev-up.sh` は `WEB_BUILD=host`（既定）／`docker` で選ぶ。
- コード・テストの実行は、可能なものは開発コンテナ（`devcontainer exec --workspace-folder /Users/Home/Projects/TownScan bash -lc '…'`、venv は `~/.venvs/townscan`）で行う。compose・DB を使うものはホストの Docker。
- 秘密: DB のパスワードは `scripts/dev-up.sh` が初回に乱数で `.env`（gitignore 済み）へ書く。ログイン（§2.1）を足したあとは、`BETTER_AUTH_SECRET`（同じく dev-up.sh が、無いときだけ 1 回足す）と、`GOOGLE_CLIENT_ID`・`GOOGLE_CLIENT_SECRET`（利用者が自分で `.env` に書く。無くても動く）が加わる。それ以外の秘密は無い。`.env` は読まない・表示しない。
- ログイン（任意）を足したあとの経路: web（Next.js）の中で Better Auth が動き、`/api/auth/*` は web 自身が受ける（`/api/*` の転送より先。api へは行かない）。web は db（`backend-net`）に届き、`auth_` の表だけを読み書きする。api は、web の JWKS（`http://web:3000/api/auth/jwks`）を取りに行って JWT を検証するだけ。ポート・公開範囲（127.0.0.1 のみ・db は非公開）は変えない。

### 2.1 認証（任意のログイン）

位置づけ: **ログインは任意**。チャット・地図・詳細・精度は、ログインなしで今まどおり使える。ログインすると、サイドバーの下のアカウントに、プロフィール画像（または人型アイコン）・メール・ログアウトが出る（§7）。**それ以外の機能の制限は足さない**（ログインの有無で、API の応答・件数・機能を変えない。**ただし、会話の履歴の保存と、その検査（`conversation_id` つきの `POST /api/chat`・履歴の 3 本）を除く**。§2.3。仕様のみで、実装は Go への切り替えのあと）。

- **方式**: Better Auth **1.7.18**（`frontend/package.json` に固定。JobNavi と同じ版）、**Google だけ**（メール・パスワードは使わない）。web（Next.js）のサーバーの中で動く。pg の接続プールで、TownScan の Postgres（`townscan`）の `auth_` の表に入れる。セッションは JobNavi と同じ（14 日・延長しない）。api はログインの通信も秘密も持たない。
- **Cookie の接頭辞は `townscan`**（`townscan.session_token` など。https では先頭に `__Secure-` が付く）。Better Auth の既定（`better-auth`）のままだと、同じ `localhost` で動く JobNavi（接頭辞 `jobnavi`）・DocuNavi と Cookie を上書きし合う（Cookie はポートで分かれない）。
- **JWT**: ES256・有効 15 分（`exp`）。`aud` = `townscan`（環境変数 `JWT_AUDIENCE`。既定 `townscan`）、`iss` = `BETTER_AUTH_URL`（開発では `http://localhost:3500`。末尾の `/` は付けない）、`sub` = `auth_user.id`。ほかの項目は `email`・`email_verified`・`name`・`picture`（Google の `image`）だけ。`email`・`name`・`picture` は、web が空でない文字列のときだけ入れ、それ以外は `null`。`email_verified` は真偽（`auth_user.emailVerified` が真のときだけ `true`）で、**api は読まず、`/api/me` の応答にも出さない**。JWKS は web の `/api/auth/jwks`（Better Auth の jwt プラグイン）。**api は、`Authorization: Bearer` の JWT を、JWKS の公開鍵で検証するだけ**: `alg` は ES256 に固定（`none`・HS256 などは受けない）、`aud`・`iss`・`exp`・`sub` を検査する。JWKS を取りに行けず、前に取れた鍵も無いときは、検証できない（503）。
- **環境変数**（名前だけ。値はこの文書にもコードにも書かない。`NEXT_PUBLIC_` は付けない）:

| 対象 | 名前 | 値の出どころ・意味 |
|---|---|---|
| web | `BETTER_AUTH_URL` | ブラウザーから見た web の URL（`compose.yaml` の既定 `http://localhost:3500`）。JWT の `iss`・Google のリダイレクト URI の元 |
| web | `BETTER_AUTH_SECRET` | 32 文字以上の乱数。`scripts/dev-up.sh` が `.env` に、無いときだけ 1 回作る |
| web | `GOOGLE_CLIENT_ID`・`GOOGLE_CLIENT_SECRET` | Google の OAuth クライアント（ウェブ アプリケーション）。利用者が Google Cloud Console で作り、`.env` に自分で書く。リダイレクト URI は `http://localhost:3500/api/auth/callback/google` |
| web | `DATABASE_URL` | db への接続（`compose.yaml` が `POSTGRES_PASSWORD` から組む。api と同じ資格情報で、表ごとの権限分けは無い。auth_ の表だけを使うのは、コードの上の約束） |
| web・api | `JWT_AUDIENCE`（api では `AUTH_AUDIENCE`） | JWT の `aud`。既定 `townscan`。`compose.yaml` が両方に同じ値を渡す |
| api | `AUTH_ISSUER` | JWT の `iss`。`compose.yaml` が web の `BETTER_AUTH_URL` と同じ値を渡す |
| api | `AUTH_JWKS_URL` | api のコンテナから届く web の JWKS（compose の中では `http://web:3000/api/auth/jwks`。`iss` とは別の URL） |

- **DB**: Better Auth の表は `auth_` 付きの 5 つ（`auth_user`・`auth_session`・`auth_account`・`auth_verification`・`auth_jwks`）。列名・型・外部キーは、JobNavi の `backend/app/migrations/0004_better_auth.sql`（Better Auth 1.7.18 が決めた camelCase の列名。引用符つき）の 5 つの表と同じ。`users` への列追加は TownScan には無い（アプリ側にプロフィールの表を持たない）。`auth_user.lastName`・`firstName` は JobNavi のプロフィール用の追加列で、TownScan のコードは読み書きしない（あっても無くてもよい。NULL 可）。置き場は `backend/db/auth.sql`（冪等: `CREATE TABLE IF NOT EXISTS`・`CREATE INDEX IF NOT EXISTS`。`DROP`・`TRUNCATE` は書かない）。すでにあるボリュームにも入る形で適用する（適用の方法は、`schema.sql` の適用の仕組みに合わせる。実装の側が決め、そこに書く）。`auth_` の表を読み書きするのは web だけで、api は読まない（JWT を検証して `sub`・`email`・`name`・`picture` を使うだけ）。**ただし、会話の履歴のために、api は `auth_user.id` の存在だけを読む**（外部キーと、LLM を呼ぶ前の存在の確認。`SELECT EXISTS … WHERE id = $1`。ほかの列は読まない。§2.3・§4.3。仕様のみで、実装は Go への切り替えのあと）。
- **`BETTER_AUTH_SECRET` は、決めたら変えない。** DB の `auth_jwks` の署名鍵（暗号化して入れる）と、Google のトークン（`auth_account`）の暗号化に使う。変えると、保存済みの鍵が読めなくなり、全員がログアウトに見える（web のログに `Failed to decrypt private key`）。直すには `auth_jwks` の行を消す必要があり、承認が要る。`scripts/dev-up.sh` は、`.env` にあれば触らず、空の行があるときは重複を作らずに止まる。`GOOGLE_CLIENT_ID`・`GOOGLE_CLIENT_SECRET` は、作らない・読まない・表示しない。
- **未設定のときの動き**: `BETTER_AUTH_SECRET`・`BETTER_AUTH_URL`・`GOOGLE_CLIENT_ID`・`GOOGLE_CLIENT_SECRET`・`DATABASE_URL` のどれかが空（または `BETTER_AUTH_SECRET` が 32 文字未満・URL の形が違う）なら、`/login` は「まだ設定されていません」と出し（ボタンは出さない）、`/api/auth/*` は 503。api は `AUTH_ISSUER`・`AUTH_JWKS_URL` のどちらかが無ければ `/api/me` が 503。**形が不正なとき**（http(s) の URL でない・ホストが無い・読めない形。例: `BETTER_AUTH_URL` を `localhost:3500` と書いた。`compose.yaml` はその値をそのまま `AUTH_ISSUER` へ渡す）も同じ扱い: api は**起動を止めず**、変数名だけ（値は入れない）を警告として 1 行ログに出し、検証を無効にして（`/api/me` は 503）、ほかの入口は動く（api が起動のたびに落ち続けると、web が api の healthy を待つため、チャット・地図まで使えなくなる）。`AUTH_AUDIENCE` は形の検査が無い文字列で、空なら `townscan`。**どの場合も、いまの機能（チャット・地図・詳細・精度・このアプリについて）は壊れない**（`compose.yaml` は、`GOOGLE_*` が空でも起動できる）。
- **実際の Google ログイン**は、利用者が OAuth クライアントを作って `.env` に書いたあとに、手で確かめる（自動テストは Better Auth と Google をモックする。本物の Google との往復はテストしない）。

### 2.2 チャットの LLM（任意の実モデル）

位置づけ: **既定は模擬モデル**（環境変数が無くても、いままでどおり動く）。`LLM_PROVIDER=gemini` にすると、チャットの「どのツールを呼ぶか」と「結果の説明文」を Gemini が作る（§4.5）。ツールの結果（件数・表・地図・写真・精度）は、どちらでも DB から同じ形で作る。決定の理由・データの扱いは [ADR 0003](decisions/0003-llm-provider.md)。

| 対象 | 名前 | 意味 |
|---|---|---|
| api | `LLM_PROVIDER` | `mock`（既定。空でも `mock`）か `gemini`。ほかの値は、起動時に止める（ConfigError） |
| api | `GEMINI_API_KEY` | Google AI Studio の無料キー。**利用者が `.env` に自分で書く**（値は、この文書・コード・`compose.yaml`・`.env.example` に書かない）。`gemini` なのに空、または形が不正（空白・改行・全角文字を含む）なら、起動時に止める。メッセージにキーの値は入れない。DocuNavi と同じ名前 |
| api | `GEMINI_MODEL` | 任意。空なら `gemini-3.5-flash-lite`（2026-11-25 の実測で、DocuNavi の既定だった `gemini-3.1-flash-lite` は 503・タイムアウトで失敗が続いたため、これに変えた。[ADR 0003](decisions/0003-llm-provider.md)）。英数字・`.`・`-`・`_` だけ（URL の path に入るため） |

- キーは、repr・ログ・例外・応答（`/api/health` を含む）に出さない。Google へは、URL でなくヘッダー `x-goog-api-key` で送る（URL は、例外・ログ・記録に残りやすい）。リダイレクトは追わない。
- `compose.yaml` は、`${GEMINI_API_KEY:-}`・`${GEMINI_MODEL:-}` で、ホストの `.env` の値を api へ渡すだけ。`scripts/dev-up.sh` は Gemini のキーを作らず、`.env` に書かない。
- 追加の依存は無い（HTTP は標準ライブラリの `urllib`）。

### 2.3 会話の履歴（ログイン中だけ）

位置づけ: **仕様のみ。実装は Go への切り替え（[ADR 0005](decisions/0005-api-in-go.md)）のあと、Go の API にだけ入れる**（Python の API には入れない。同じ業務ロジックを 2 つの言語に置かない）。コードも DDL も、まだ無い。決定の理由・選ばなかった案・未確認は [ADR 0006](decisions/0006-conversation-history.md)。表 2 つの追加は承認済み（ユーザー、2026-11-25）だが、**§4.3 の DDL は仕様の案で、実行しない**。土台のユーザー決定は「履歴は DocuNavi と同じ型（ログイン中だけ・サーバーに保存・サイドバーに一覧・削除は 2 段階）。ログインは任意で、ログインしていないときは今までどおり画面の中だけの会話」。画面は §7.1、API の形は §4.4、表は §4.3。本文の〔J1〕〜〔J7〕の印は、**ユーザー決定ではなく、起草者の判断**（異議があれば直す。一覧は ADR 0006）。印の無い項目のうち、ユーザーが決めたものは ADR 0006 の U1〜U10 に載る。

#### 2.3.1 目的と範囲

**目的:** ログイン中の人が、過去の会話を開き直して続きを聞け、不要な会話を自分で消せる。

**変えないこと（決定済み）:**

- ログインは任意。ログインしていないときは今までどおり、会話は画面の中だけで、開き直すと消える。**`conversation_id` を付けない要求は、ログインの有無に関わらず、今までと同じ**（API の応答・件数・機能。`Authorization` も見ない）。履歴を足して変わるのは、`conversation_id` つきの要求で保存するかどうかと、保存に伴う検査（ログイン・`auth_user` の存在・NUL・発言数の上限）だけ。
- ログイン前に画面の中でした会話は、ログインしても引き継がない（Google への往復で画面が作り直されるため。保存もしない）。
- 保存した会話を見られるのは、本人だけ。

**やること:** 保存・一覧・開き直し（続きを送れる）・本人による削除・1 人 50 件を超えた分の自動削除・保存期間を過ぎた会話の削除（運用者のコマンド）。

**やらないこと**（DocuNavi に無いので足さない）:

- 共有・公開の URL・検索・ピン留め・題名の編集・並べ替え・フォルダー・エクスポート・全部消すボタン・発言 1 件ずつの編集や削除。
- 一覧のページ分け（DocuNavi も最大 50 件の 1 ページ。TownScan は保存を 50 件に収めるので、一覧に出ない会話は無い）。
- LLM による題名づくり。
- 未ログインの会話の保存（サーバーにも、ブラウザーの `localStorage` にも置かない）。
- 複数の端末・タブへの即時の反映（別のタブで消した会話は、画面を読み直すまで一覧に残る）。
- 1023px 以下（重ねて開くサイドパネル）の履歴の入口（初版。保存は続く。§7.1.1）。

**TownScan 固有でやらないこと:** 拡大ビュー（§7。地図・グラフ・写真の比較）の回答ごとの「画面の状態」（選んだタブ・絞り込み・選んだ候補・強調・寄せ先）の保存。会話の中身（回答の `results`）から導けるものだけ、開き直したあと、その回答の拡大ビューをはじめて開くときに決める（§7.1.5）。

**用語:** DocuNavi の `thread` は、LangGraph の用語（`thread_id`）に由来する。TownScan は LangGraph を使わず、画面・仕様書が「会話」なので、API・表は **`conversation`** と呼ぶ。対応は `thread_id` ↔ `conversation_id`、`/threads` ↔ `/api/conversations`。

**数字・件数・座標:** 保存する `results` は、サーバーが作った値だけ（画面から送らせない。§2.3.4）。開き直すとき、画面は値を作り直さず、保存された値を描く。画面に出す固定の文（案内・注意書き）は、LLM が書くものではない。

#### 2.3.2 表の設計

DDL は §4.3（仕様の案。実行しない）。置き場は `api/internal/store/sql/history.sql`（新設の予定。Go だけが使う表。`backend/db/` には置かない。`TestSchemaMatchesBackend` の対象にしない）。

- **主キーは `(user_id, id)`。** `id` は画面が作る（§2.3.4）ので、別の人が同じ `id` を使っても、別の会話になる（衝突も、他人の会話の存在の確認もできない）。DocuNavi の `<利用者 ID>:<thread_id>` と同じ効果を、連結した文字列ではなく列で持つ。
- **外部キーは `auth_user.id`（制約名 `conversations_user_fk`。`ON DELETE CASCADE`）。** 利用者の行が消えれば、会話も発言も消える（§2.3.7）。`auth_` の表は、これまでどおり web だけが書く。API は、履歴のために **`auth_user.id` の存在だけ**を読む（`SELECT EXISTS … WHERE id = $1`。ほかの列は読まない。§2.1）。JWT は有効でも `auth_user` に行が無いとき（消された直後の 15 分間など）の**書き込み**（`conversation_id` つきの chat）は、**LLM を呼ぶ前**の存在の確認で **401** にする（§2.3.3・§2.3.4）。保存の段で外部キー違反（SQLSTATE 23503）になるのは、その確認の直後に行が消える競合だけで、**制約名が `conversations_user_fk` のときだけ 401**。読み取り（一覧・発言の取得・削除）は、行を確かめず、空・404 のままでよい（`auth_user` を余計に読まない）。
- **`title` は作るとき 1 回だけ書く**（作るときの要求の最後のユーザー発言から。ふつうは最初の質問。§2.3.4）。DocuNavi は表に列が無く、一覧のたびに最新のチェックポイントを読み出して題名を作る。TownScan は自前の表なので、発言を読まずに一覧を引ける。規則は §4.4 の「履歴の題名」（空白をまとめ、40 文字まで、超えたら 39 文字＋「…」）。`CHECK` の 1〜40 は、その結果。**題名が空になったら**（§4.4 の空白の集合をそろえれば起きない。防御として）「（題名なし）」にする（DocuNavi と同じ）。
- **`results`・`tool_calls` は jsonb で、回答が作ったものをそのまま持つ。** TownScan の回答の本体は `results`（件数・表・地図・写真）で、画面はこれを描く。DocuNavi のように本文から再構成せず、保存する。数字・件数・座標は、サーバーが作った `results` の値だけが残る（画面から送らせない。§2.3.4）。jsonb は、キーの順・空白・数値の書き方を正規化するので、読み戻した値は「JSON として等しい」（値は同じで、キーの順は保証しない）。
- **`run_created_at` は、回答を作るときに読んだ run の `runs.created_at`**〔J4〕（回答を作った run をそのまま写す。保存の直前に読み直さない）。開き直した会話で、「その回答が、いまの解析結果に基づくか」を見分けるために使う（§7.1.5）。`results` の `provenance.run_id` だけでは、同じ `run_id` を後処理し直して読み込み直したとき（ローダーは同じ `run_id` の行を消して入れ直す）に見分けられない。
- **索引は `conversations_user_updated_idx` だけ**（一覧と、1 人 50 件の整理の用）。発言は主キーで足りる。保存期間の掃除（`updated_at` の古い順）には索引を足さない（件数が小さい間は不要。大きくなったら足す）。
- **`content` の長さに `CHECK` は付けない。** ユーザーの発言は API が 2000 文字までに検査する。回答の文は、LLM を使うと 1000 文字までに切る（§4.5）が、模擬モデルの文の最大は確かめていない。
- **NUL（U+0000）は保存できない**（`text` は SQLSTATE 22021、`jsonb` は 22P05 で失敗する。一般知識。この環境で DB を触って確かめてはいない）。`conversation_id` つきの chat は、NUL を含む `content` を **LLM を呼ぶ前に 422** で断る（§2.3.4）。
- 時刻の更新（`updated_at`）は `clock_timestamp()` で書く（`now()` はトランザクションの開始時刻で、同じ会話への同時の書き込みが後から来ると、時刻が逆戻りしうるため）。

#### 2.3.3 書き込み・掃除の SQL の形（実装の目安）

**LLM を呼ぶ前**（読み取りだけ。ロックを持たない）: 1 つの `SELECT`（副問い合わせ 2 つ）で、`EXISTS (SELECT 1 FROM auth_user WHERE id = $1)` と `count(*)`（`conversation_messages` の `user_id = $1 AND conversation_id = $2`）を読む。行が無ければ 401、保存済みが 499 件以上（もう 1 往復＝2 件を足すと 500 件を超える）なら 422 `conversation_full`（§2.3.4）。

**保存**（回答を作り終えてから、**1 つのトランザクション**。LLM を待つあいだ、ロックを持たない）:

1. `SELECT pg_advisory_xact_lock(704218002, hashtext($1))`〔J3〕（`$1` は `user_id`。同じ人の保存を順に並べる。1 人 50 件の整理が、同じ人の別の保存と鍵を取り合って、行のロックの待ち合い（デッドロック）にならないようにする。`schemaLockKey`（704218001。`api/internal/store/schema.go`）とは別の値）。
2. `INSERT INTO conversations (user_id, id, title, created_at, updated_at) VALUES ($1, $2, $3, clock_timestamp(), clock_timestamp()) ON CONFLICT (user_id, id) DO UPDATE SET updated_at = clock_timestamp()`（**行の作成と、既存の行のロックと更新を、1 文で原子的に行う**。`title` は、作るときだけ入り、既存の行では変えない。新しい行も `clock_timestamp()` で書くので、`created_at` ≤ `updated_at` が常に成り立つ）。「無ければ作る（`DO NOTHING`）→ 別の文でロック」にしない: その間に別の `DELETE` が入ると、次の発言の挿入が `conversation_messages_conversation_fk` の外部キー違反（同じ SQLSTATE 23503）になり、「利用者の行が無い」と取り違えて 401 にしてしまう。
3. 次の `seq` を決める（`SELECT count(*), coalesce(max(seq), -1) + 1 …`。行がロック済みなので、同時の書き込みと重ならない）。件数が 499 以上なら、ここで巻き戻して 422 `conversation_full`（LLM を呼ぶ前の確認をすり抜けた競合。発言は 2 件ずつ入るので、ふつうの件数は偶数で、上限は 500）。
4. ユーザーの発言と回答の 2 行を入れる（`seq` は 0 から。2 行で `n`・`n+1`。回答に `run_created_at`）。
5. **1 人 50 件の整理:** `DELETE FROM conversations WHERE user_id = $1 AND id <> $2 AND id IN (SELECT id FROM conversations WHERE user_id = $1 ORDER BY updated_at DESC, id ASC OFFSET 50)`（発言は `CASCADE`。いま保存した会話は先頭で、`id <> $2` でも守るので、消えない。50 は一覧の上限と同じ定数）。
6. コミット。

**エラーの分け方**〔J1〕（Go の `store.classify`。`api/internal/store/errors.go` に合わせる）: DB に届かない類（SQLSTATE のクラス 08・40・53・54・57・58・F0、接続・タイムアウト）は 503 `db_unavailable`。それ以外（表が無い 42P01・`CHECK` 違反 23514・値の不正 22xxx・上で言う `conversations_user_fk` 以外の 23503 など）は、コードか環境の誤りなので **500 `internal_error`**（`handlers` の `fail` と同じ。原因は載せない）。401 にするのは、`PgError` の `Code == "23503"` かつ `ConstraintName == "conversations_user_fk"` のときだけ（決定）。

**保存期間の掃除:** `DELETE FROM conversations WHERE updated_at < now() - make_interval(days => $1)`（発言は `CASCADE`）。先に同じ条件で件数だけ数える（既定）。値はすべて、パラメータで渡す（文字列を連結して SQL を作らない）。

#### 2.3.4 保存の動き（`POST /api/chat` の `conversation_id`）と、検査の順

**決定: DocuNavi と同じく、サーバーが回答と一緒に保存する。** 要求に、任意の `conversation_id`（`^[A-Za-z0-9_-]{1,128}$`）を足す。

```json
{"messages": [{"role": "user", "content": "…"}], "conversation_id": "5b0c…"}
```

| 要求 | 動き |
|---|---|
| `conversation_id` が無い（または `null`） | **今までと同じ。** `Authorization` を見ない。保存しない。応答も同じ（既存の契約・`contract/test_auth_independence.py` は変わらない） |
| `conversation_id` がある | 下の順に検査する（本文・NUL → ログイン → `auth_user` の存在 → 発言数の上限）。通れば、今までと同じ回答を作り、**その回答と、要求の最後のユーザー発言（`messages` の末尾）を、本人の会話 `conversation_id` に追記する**（無ければ作る。題名は、作るときの最後のユーザー発言から。**保存するのは、この 1 往復だけ**で、`messages` の前の発言は保存しない）。応答の形は変えない（`{message}` のまま） |
| `conversation_id` が `""`・形が違う | 422（`["body","conversation_id"]`）。DocuNavi は空文字を「無し」と読むが、それは古い呼び出しとの互換のためで、TownScan には無い |

**検査の順:**

- 一覧・発言の取得・削除: ログイン（401・503）→ `conversation_id` の形（422）→ 会話の有無（404）。ログインしていない人には、形が正しいかも分からせない。
- `POST /api/chat`（`conversation_id` つき）: **本文**（形・空でない最後の user・`conversation_id` の形・NUL。422）→ **ログイン**（401・503）→ **`auth_user` の存在**（401）→ **発言数の上限**（422）→ 回答の作成 → 保存。**これらはすべて LLM を呼ぶ前に済ませる**（拒否された要求で課金しない）。本文が先なので、本文が不正なら、未ログインでも 422。
- `POST /api/chat`（`conversation_id` なし）: 今までと同じ（本文の 422 → 回答）。
- 順序が、3 経路（ログインが先）と chat（本文が先）で逆なのは、chat が既存の契約（本文の 422 は、ログインの有無に依らない）を保つため。

**そのほかの動き:**

- 回答の中身は、`conversation_id` の有無で変わらない（同じ質問・同じ模擬モデルなら、同じ `message`）。**例外は、保存できない入力の NUL だけ**（`conversation_id` つきは 422、無しは今までどおり通る）。
- **NUL:** `conversation_id` つきの chat は、`messages` のどの `content` にも NUL（U+0000）を許さず、LLM を呼ぶ前に 422 にする（保存が SQLSTATE 22021・22P05 で失敗して 500 になり、LLM の費用だけが掛かるのを避ける）。取り除いて保存する案は採らない（保存する値を作り替えない）。回答の側（LLM の出力）の NUL は ADR 0006 の未確認。
- **文脈は、これまでどおり要求の `messages`（末尾 20 件だけ使う）から作る。** 保存した発言から文脈を組み直さない（未ログイン〔`messages` から作る〕とログイン中〔保存から作る〕で、文脈の作り方が 2 つになるのを避ける。保存は副作用だけにする）。画面が全履歴を送る現行の作りは、そのまま（画面側の上限は 40 件で、API は 500 件まで受ける）。
- **保存しないとき:** 回答が失敗した往復（LLM の 502・検証の 422・認証の 401/503）は、何も保存しない。画面も、失敗した発言を次の質問の履歴に含めない（`frontend/components/chat/history.ts`）ので、そろう。
- **保存に失敗したとき**（DB の書き込みの失敗）は、**回答を返さず**、DB に届かない類は `503 db_unavailable`、それ以外の想定外は `500 internal_error`（§2.3.3）〔J1〕。回答だけ見えて履歴に無い食い違いを作らない。TownScan の `POST /api/chat` は、もともと DB から結果を作るので、DB が使えなければ同じく 503 になる。決定（ユーザー）は「DocuNavi と同じく、回答を返さず 503」。DocuNavi は保存先の例外をすべて 503 にする。すべて 503 にそろえたいなら、保存の段で包む規則 1 つに直す。
- **保存を飛ばした会話の整合（画面の規則。§7.1.7）:** 401・503（ログインの確認）で、`conversation_id` を外して送り直した往復は、保存されない。その会話で、次の質問に `conversation_id` を付け直すと、保存済みの会話に**欠けた往復**ができ、開き直すと画面で見た会話と食い違う。そこで、**保存を 1 度でも飛ばした会話では、それ以降の送信にも `conversation_id` を付けない**（決定。API の側で件数を比べる案は採らない: 画面の履歴は、失敗した発言・40 件の切り詰めで、保存済みの件数とずれるため）。
- **同じ発言が 2 回並びうる:** 通信が切れて画面が失敗と見たが、サーバーは保存していた場合、「もう一度送る」で同じ質問が 2 回保存される。重複を弾く仕組み（冪等キー）は足さない（DocuNavi にも無い。未確認: DocuNavi が同じ場面でどうなるか）。
- **`conversation_id` を画面が作る:** 保存するかを `conversation_id` の有無で決めるため、サーバーが「無ければ作って返す」（DocuNavi の方式）にすると、ログイン中の要求の既定が変わり、「`Authorization` を見ない」既存の契約と衝突する。画面が、ログイン中の新しい会話の最初の送信で `crypto.randomUUID()`（小文字 36 文字。上の規則に合う）を作る。他人の ID を知っても何もできない（主キーが `(user_id, id)`）ので、画面が決めてよい。

#### 2.3.5 上限

| 項目 | 値 | 備考 |
|---|---|---|
| 一覧の件数 | 50 | DocuNavi の値（`MAX_THREADS`）と同じ |
| 題名 | 40 文字まで・超えたら 39 文字＋「…」（コードポイントで数える） | DocuNavi と同じ（`MAX_TITLE_LENGTH`） |
| 質問 1 件 | 2000 文字 | 既存（`backend/app/routes.py` の `ChatMessage`）。DocuNavi も同じ |
| 会話 ID | 128 文字・`^[A-Za-z0-9_-]+$` | DocuNavi と同じ（表の `CHECK` にも入れる） |
| 要求に含める発言の数 | API は 500 件まで（`MAX_CHAT_MESSAGES`。既存）。画面は 40 件（`MAX_MESSAGES`。既存）。文脈に使うのは末尾 20 件（`CONTEXT_MESSAGES`。既存） | 既存のまま |
| 1 会話の発言数 | **500 件（決定）。** 超えたら 422 `conversation_full`（LLM を呼ぶ前に数え、保存のトランザクションの中でも数え直す）。1 往復で 2 件増えるので、保存済みが 500 件の会話に、続きは送れない | **根拠は、既存の `MAX_CHAT_MESSAGES`（1 要求の入力の上限）の流用で、保存の大きさ・読み出しの大きさからは導いていない。** DocuNavi には上限が無いが足す。TownScan は `results` を丸ごと持つ。1 回の `map_focus` だけで候補 ID を最大 5000 件（`MAX_FOCUS_IDS`）含みうる。ID 1 件を約 20 バイトと見積もると、1 回で約 100 KB、回答 250 件がすべてそうだと 1 会話で約 25 MB（`GET …/messages` の応答の大きさ）になりうる（実測ではなく見積もり）。実データは候補が少なく（ADR 0005 の実測は 18 候補）、この大きさにはならない見込み。バイト数や `results` の上限は、初版では足さない（実測のあとに決める） |
| 1 人あたりの会話の数 | **50 件（決定）。** 保存時に、50 件を超えた分を古い順（更新が古い順）に消す（§2.3.8） | 一覧の上限（50）と、保存の上限をそろえる。一覧に出ない会話を、本人が消せないまま溜めない。DocuNavi には上限が無い |
| 保存期間 | 最後の動きから 7 日（決定） | §2.3.8 |

#### 2.3.6 JWT をブラウザーからどう渡すか

TownScan のブラウザーは、同じオリジンの `/api/*` を呼び、`frontend/proxy.ts` が API へ転送する（`/api/auth/*` だけ web 自身が受ける）。いま画面は、API へ JWT を渡していない（`frontend/lib/session.ts` の冒頭のコメント）。履歴の API は、`Authorization: Bearer` が要る。

**決定: DocuNavi と同じく、ブラウザーが `GET /api/auth/token`（Better Auth の jwt プラグインの経路。Cookie のセッションがあれば `{token}` を返す）で JWT を取り、`Authorization: Bearer` で送る。**

- 新しい依存は無い（`better-auth` は入っている。`fetch('/api/auth/token')` で足りる。DocuNavi は `better-auth/client` の `$fetch('/token')` を使う）。経路の追加も無い（`frontend/app/api/auth/[...all]/route.ts` がすべて Better Auth に渡す。`disabledPaths` は `/update-user` だけ）。
- トークンは**メモリにだけ**置く（`localStorage`・`sessionStorage`・URL・ログに出さない）。期限（JWT は 15 分）の **60 秒前**になったら取り直す（DocuNavi の `REFRESH_MARGIN_SECONDS`）。同時に何本の要求があっても、取りに行くのは 1 回。
- API が 401 を返したら、**1 回だけ**取り直して送り直す（DocuNavi の `createAuthedFetch`）。それでも 401 なら、ログインが切れたと見る（§7.1.7）。トークンを取れなかったのが通信の失敗・5xx のときは、ログアウトとは見ない（再試行を促す）。**chat の 401 も同じ。** 401 は LLM を呼ぶ前に返る（§2.3.4・§4.4。保存の段の 401 は、存在の確認の直後に行が消える競合だけ）ので、この再送で LLM が余分に呼ばれることは、ふつうは無い（§7.1.7）。
- ログインの有無は、サーバーの layout が `currentUser()` で 1 回だけ決める（`frontend/app/(site)/layout.tsx`）。その真偽値を、画面のコンテキストへ渡す。ログインしていなければ、`/api/auth/token`・`/api/conversations` を**一度も呼ばない**。

#### 2.3.7 認可と個人情報

**本人だけ:**

- 利用者は、**検証に通った JWT の `sub` だけ**から決める。`sub` は `[A-Za-z0-9_-]{8,64}`（`backend/app/jwt_auth.py` の `_USER_ID`）。要求の本文・クエリ・パスの値は使わない。
- すべての問い合わせの条件に `user_id = $sub` を入れる。会話は `(user_id, id)` で引くので、他人の `id` を知っていても、別の（存在しない）会話として扱われる。**無い会話と他人の会話は、同じ 404 で、本文も同じ**（存在を確かめさせない。DocuNavi と同じ）。
- 他人と同じ `conversation_id` で `POST /api/chat` しても、他人の会話には届かない（自分の会話が新しくできる）。
- SQL は、パラメータで渡す。応答・ログに、例外の文字列・接続先・SQL を出さない。
- 履歴の API は、Cookie を見ない（`Authorization: Bearer` だけ）。Cookie を使う認可ではないので、別のサイトからの要求で動かされる心配（CSRF）は無い。
- 本人が消せる範囲と、保存される範囲は、一致する（保存は 1 人 50 件で、一覧もその全部。§2.3.8）。

**ログ:**

- **質問の本文・回答の本文・題名・`results` を、ログに出さない**（TownScan は、すでに Gemini の失敗でも、種類・ステータス・理由の定数だけを出す。§4.5）。履歴の処理の失敗は、種類（`store.Kind`。例外の型と SQLSTATE）だけを出す。
- **生の利用者 ID・会話 ID を、ログに出さない**〔J2〕（緩める案は、会話 ID は秘密ではないので `AccessLog` を直さず、利用者 ID・ハッシュを会話 ID と同じ行に出さない、という規則にする）。Go の API には、すでにアクセスログ（`api/internal/httpx/middleware.go` の `AccessLog`）があり、**`r.URL.Path` を `%q` で生のまま記録する**。このままだと、`/api/conversations/{会話 ID}` の経路で会話 ID がそのままログに出る。**履歴の経路を足すときに、`AccessLog` を直す:** ルーターが合わせたルートのテンプレート（`/api/conversations/{conversation_id}`・`/api/candidates/{candidate_id}` など）で記録し、どのルートにも合わなかった要求は `?` にする（DocuNavi の `[計測] DB` ログが `scope["route"].path` か `?` を出すのと同じ）。ルーターが、合ったパターンを、`AccessLog` が読める所（外側のミドルウェアが `recorder` と同じように持つ入れ物）へ書く仕組みが要る。実装は、既存の `httpx` の検査（`api/internal/httpx/httpx_test.go`）と一緒に直す。
  - 利用者を区別する必要があれば、ハッシュ（DocuNavi は `sha256("docunavi:" + ID)` の先頭 16 桁。TownScan は接頭辞を `townscan:` にする）。
  - **DocuNavi との違い:** DocuNavi の `[計測] DB` ログは、ルートのテンプレートで ID を載せないが、チャットの計測ログ（`session_id`）と失敗・切断のログは、生の `thread_id` を出す（`thread_id` は検証済みの文字列で、秘密ではない扱い）。TownScan は、会話 ID が `(user_id, id)` の主キーの一部で、他人の ID を知っても何もできない（秘密ではない）が、本人の会話を特定する識別子なので、念のため、ログには出さない（DocuNavi より厳しい）。
- **アクセスログ以外**に、会話 ID を出さない（履歴の失敗のログにも含めない）。Go のテストで、ログを捕まえて確かめる（§8 の E9）。

**削除で本当に消える:**

- 本人の削除は `DELETE`（物理削除）。会話・発言が、DB の現行のデータから消える。「消した印」だけを付ける作りにしない。保存時の 50 件の整理と、保存期間の掃除も、同じ物理削除。
- 利用者の行（`auth_user`）が消えれば、`CASCADE` で会話・発言も消える。TownScan に、利用者を消す画面は無い（`/update-user` も閉じている）。運用者が消すときは、`auth_user` の行を消せば足りる。
- 同じ ID でもう一度話しかけても、前の発言は戻らない（新しい会話として始まる）。
- **残りうるもの（確かめていない）:** Postgres は、消した行の領域を、自動の掃除（autovacuum）が回収するまで、ディスク上に残しうる（一般知識。今回の調査ではない）。DB のバックアップ・ダンプからは消えない。TownScan の docs・scripts・`backend/app` には、DB のバックアップの手順が見当たらない（`git grep`。CLAUDE.md の `backups/` の中身は読んでいない）。バックアップを作るようになったら、保存期間と合わせて決める。
- ログアウトしても、保存した会話は消えない。「全部消す」操作は作らない（上限と保存期間が消す）。

#### 2.3.8 保存期間と件数の上限

- **保存期間（決定）: 最後の動きから 7 日**（`updated_at` で決める。開いて見るだけでは更新しない。DocuNavi の方針と同じ値・同じ決め方）。
- **掃除は、Go の保守コマンド**（新しい実行物。`api/cmd/history-cleanup`・新設の予定。DocuNavi の `app.history_admin` と同じ形）。`--older-than-days N`（N は 1 以上。既定 7）。**既定は件数の表示だけで、何も消さない。`--apply` を付けたときだけ消す。** 表示は件数だけで、利用者 ID・会話 ID は出さない。終了コードは 0（完了）・1（DB の失敗）・2（使い方の誤り・接続先が未設定）。Python ではなく Go にする理由: 履歴の表を読み書きするのは API の仕事で、同じ業務ロジック（表の定義・削除の規則）を 2 つの言語に置かない（ADR 0005）。新しい言語・依存・サービスは足さない（Go の標準ライブラリと、API が使う `pgx` と `internal/store` を使う）。
- **件数の上限（決定）: 保存時に、1 人あたり 50 件を超えた分を古い順に消す**（§2.3.3 の 5。一覧の上限 50 と同じ定数）。
  - **理由:** 一覧は新しい 50 件だけで、51 件目以降は画面に出ない。本人は、画面から ID を得る手段が無く、それらを消せない。掃除は手で流す（下）ので、「本人が消せる」「保存期間 7 日」だけでは保証にならない。保存を 50 件に収めれば、一覧に出る会話が保存の全部で、本人が消せる範囲と一致し、画面に出ない会話が溜まらない。
  - **効き方:** 保存のたびに効く（定期実行に依らない）。いま保存した会話は先頭なので、消えない。別のタブで開いている古い会話は、次の保存で消えうる（開き直しの 404。§7.1.4 の 5）。
- **保証できるのは、件数（50 件）のほう。** 7 日は目安: DocuNavi は Cloud Scheduler＋Cloud Run Job（週 1 回）だが、TownScan はローカルだけで、定期実行の仕組みが無い。当面は手で流す。**期限を過ぎた会話は、コマンドを流すまで残る**（API は、期限を理由に隠さない。DocuNavi も同じ）。公開（P7）の前に、実行の仕組みを決める（ADR 0006 の未確認）。
- DocuNavi の保守コマンドにある `--thread-id`（1 件を運用者が消す）は、足さない（本人の削除は API で、利用者ごと消すなら `auth_user` の行を消す）。

**承認の関門**（それぞれ別に承認を得る。前の承認は次に及ばない）: この仕様の main へのコミットと push・DDL の実行（`history.sql` を `go:embed` へ足すコミットを main へ入れると、次の API の起動で、すでにあるボリュームの DB に表が入る。マージの前に、適用先の DB と影響を示す）・`api/cmd/history-cleanup` を実際に `--apply` で流すこと・本番への配備。Python のローダー（`python -m app.load`）の `apply_schema` は、この表を作らない（使わない）。

## 3. ディレクトリと担当

| 場所 | 内容 |
|---|---|
| `pipeline/` | 後処理（ベクトル化・基盤地図情報の読み込み・評価・差分と 3 分類・地区名）。出力は §4.1 |
| `pipeline/colab/` | Colab 側の推論スクリプト（**メインのセッションが担当。触らない**） |
| `backend/` | FastAPI・DB スキーマ・ローダー・ツール・チャット（模擬モデル。任意で Gemini）・画像切り出し |
| `frontend/` | Next.js（App Router・TypeScript）。`frontend/Dockerfile` を含む |
| `compose.yaml`・`.env.example`・`scripts/dev-up.sh` | backend の担当 |
| `scripts/verify.sh`・`.github/` | 最後に統合役が配線（それまで触らない） |
| `data/townscan/` | 実行時データ（gitignore 済み。Git に入れない） |

## 4. データの契約

### 4.1 ディスク（`data/townscan/`）

```
data/townscan/
  tiles/{year}/{x}_{y}.png            写真タイル 256×256 RGB（z18。地理院 nendophoto{year}。Colab が取得したものを持ち帰る）
  run1/colab/                         Colab の出力（メインが置く）
    meta.json                         モデル・版・正規化・タイル一覧・取得結果
    prob_{year}_{x}_{y}_s{100|150|200}.npy   建物の確率 float16 (H,W)。H=W=256×倍率（1.0/1.5/2.0 倍に双三次で拡大して推論）
  run1/out/                           後処理の出力（pipeline が作る。backend のローダーが読む）
    run.json                          {run_id, kind:"real"|"synthetic", created, model, params, tiles:[...], notes}
    areas.json                        [{id, z, x, y, bbox:[w,s,e,n], centroid:[lon,lat], name, ward, municipality, name_source}]
    buildings_2018.geojson / buildings_2023.geojson   建物ポリゴン（lon/lat）。properties: area_id, area_m2, prob_mean
    candidates.geojson                新規出現候補（§5）
    eval.json                         評価（§6）
```

- 地区 = z18 タイル 1 枚。`id` = `z18-{x}-{y}`。範囲は Web メルカトルのタイル境界を lon/lat にしたもの。
- 地区名 = 地理院の逆ジオコーダ（`https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=&lon=`）の `muniCd`・`lv01Nm`。`name` は「町丁目名」、`ward` は 43101 中央区・43102 東区・43103 西区・43104 南区・43105 北区。**pipeline のコードは外部へ通信しない**（`geocode.py` は、取得済みの応答を受けて名前を作る関数と、メインが実行する取得用の関数に分ける。取得は承認済みの範囲外なのでメインが行う）。
- 面積 `area_m2` は EPSG:6670（JGD2011 / 平面直角座標系 II 系）で計算。

### 4.2 `candidates.geojson`

FeatureCollection。Feature の `id` は `c-{x}-{y}-{n}`（n は地区内の連番、面積の大きい順）。geometry は Polygon（lon/lat）。`properties`:

```
area_id, class ("confirmed_new"|"existing_omission"|"uncertain"), area_m2,
bbox [w,s,e,n], centroid [lon,lat],
evidence: { prob_2023_mean, ov_2018, prob_2018_p90, ov_kiban, edge_touch },
reason: "new_absent_2018" | "present_2018" | "ambiguous" | "edge"
```

`reason` は上の 4 つだけ。面積 20 m² 未満の塊は §5 で**捨てる**ので、`candidates.geojson` に出ず、`"small"` は**出力しない**（pipeline の `diff` は、捨てる理由として内部でだけ使う）。backend のローダーは `"small"` も受理するが、これは余分に許しているだけで、pipeline は出さない。

### 4.3 DB（Postgres 17。拡張なし）

`runs(run_id pk, kind, created_at, model, params jsonb, notes)`・`areas(id pk, run_id, z, x, y, west, south, east, north, centroid_lon, centroid_lat, name, ward, municipality, name_source)`・`buildings(id bigserial pk, run_id, area_id, year, area_m2, prob_mean, geom jsonb)`・`candidates(id text pk, run_id, area_id, class, area_m2, west, south, east, north, centroid_lon, centroid_lat, geom jsonb, evidence jsonb, reason)`・`metrics(run_id pk, body jsonb)`。`class` は CHECK 制約。ローダーは冪等（同じ run_id を入れ直すと置き換える。トランザクション）。表示する現在の run は「最新の created_at」。

**会話の履歴の表 2 つ**（§2.3。**仕様の案で、実行しない。** 表 2 つの追加は承認済み〔ユーザー、2026-11-25〕。実装は Go への切り替えのあと、Go の API にだけ入れる）: `conversations(user_id, id, title, created_at, updated_at)`（主キー `(user_id, id)`。`user_id` は `auth_user.id` への外部キー `conversations_user_fk`・`ON DELETE CASCADE`）と、`conversation_messages(user_id, conversation_id, seq, role, content, results jsonb, tool_calls jsonb, run_created_at)`（主キー `(user_id, conversation_id, seq)`。`conversations` への外部キーで `CASCADE`）。置き場は **`api/internal/store/sql/history.sql`**（新設の予定。Go だけが使う表。`backend/db/` には置かない。`TestSchemaMatchesBackend` の対象にしない）。Go の API はすでに `schema.sql`・`auth.sql` を `go:embed` し、起動のたびに `ApplySchema` で、1 つのトランザクション・1 つの鍵で適用する（`api/internal/store/schema.go`。冪等）。履歴は、その SQL の並びの `authSQL` のあとに `historySQL` を足す（`auth_user` を参照するため、順序が要る）。何度流しても同じになる形（`IF NOT EXISTS`）で、`DROP`・`TRUNCATE` は書かない。設計の説明・書き込みの SQL の形は §2.3.2・§2.3.3。

**承認の関門:** `historySQL` を `go:embed` へ足すコミットを main へ入れると、次の API の起動で、**すでにあるボリュームの DB に表が入る**。表の追加の承認は、この関門を通る承認として扱う（マージの前に、適用先の DB と影響を示す）。Python のローダー（`python -m app.load`）の `apply_schema` は、この表を作らない（使わない）。

```sql
-- 会話の履歴（ログイン中だけ）。auth.sql（auth_user）のあとに流す。仕様: spec-prototype §2.3（案）。
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
```

### 4.4 API（JSON。接頭辞 `/api`）

| メソッド・パス | 内容 |
|---|---|
| GET `/api/health` | `{status, db, llm:"mock"\|"gemini", llm_model?, run:{run_id, kind, created_at}, counts:{areas, candidates, buildings}}`。`llm` は使っているプロバイダー名。`llm_model`（モデル名）は `gemini` のときだけ付く。キーは出さない |
| GET `/api/areas` | 地区の一覧（`id,name,ward,bbox,centroid,counts:{confirmed_new,existing_omission,uncertain,total}`） |
| GET `/api/candidates?area_id=&cls=&sort=area_desc&limit=&offset=` | `{total, items:[CandidateSummary]}` |
| GET `/api/candidates.geojson?area_id=&cls=` | 地図用 FeatureCollection（properties に `id,class,area_m2,area_id`） |
| GET `/api/candidates/{id}` | `CandidateDetail`（summary + evidence + 説明文のキー + 画像 URL + provenance） |
| GET `/api/candidates/{id}/image?year=2018\|2023&size=512` | PNG。候補の外接矩形に余白（約 20 m）を足した切り出しをタイルから作り、輪郭を描く。タイルの外へは出ない |
| GET `/api/metrics` | `eval.json` の内容 + provenance |
| POST `/api/chat` | 入力 `{messages:[{role,content}], conversation_id?}`（`conversation_id` は任意。会話の履歴〔§2.3。仕様のみ〕を保存するときだけ付ける）、出力 `{message:{role:"assistant", content, results:ToolResult[], tool_calls:[{name,args}]}}`（`conversation_id` の有無で変わらない） |
| GET `/api/me` | 任意のログイン（§2.1）の受け口。`Authorization: Bearer <JWT>` を検証し、`{sub, email, name, picture}` を返す |
| GET `/api/conversations` | 会話の履歴（§2.3。**仕様のみ。実装は Go への切り替えのあと**）: 本人の会話の一覧。`Authorization: Bearer` が要る |
| GET `/api/conversations/{conversation_id}/messages` | 同上: 会話の発言（古い順） |
| DELETE `/api/conversations/{conversation_id}` | 同上: 会話を 1 件消す |

エラーは `{error:{code,message}}` と適切な HTTP ステータス。存在しない id は 404、不正な引数は 422。`POST /api/chat` で実 LLM（§2.2）が使えないときは **502** `{error:{code:"llm_unavailable", message:"いまは LLM が応答できません。少し待ってからもう一度お試しください"}}`（模擬には切り替えない。§4.5）。

`GET /api/me`（§2.1 の JWT。ほかの入口は `Authorization` を見ない・ログインを要さない〔**例外: `conversation_id` つきの `POST /api/chat` と、履歴の 3 本。§2.3・下の「会話の履歴の API」**。`conversation_id` を付けない `POST /api/chat` は、今までどおり `Authorization` を見ない〕。**いまの機能は、ログインなしで今まどおり使える**）:

- 成功 200: `{sub, email, name, picture}`。`sub` は JWT の `sub`（必須）。`email`・`name`・`picture` は、JWT に無い・空・文字列でない・下の整形の規則に合わないときは `null`。応答に `Cache-Control: no-store`。
  - 整形の規則（実装は `backend/app/jwt_auth.py` の `_identity`。`email`・`picture` は前後の空白を除いてから見る）: `picture` は、claim `picture`（無ければ `image`）が `https://` で始まる 2048 文字までのときだけ（それ以外は `null`）。`email` は、`@` を含む 254 文字までのときだけ（含まない・254 文字を超えるときは `null`）。`name` は、印字できない文字（制御文字のほか、全角空白・ゼロ幅の文字も）を除いて、100 文字までに切る（空になれば `null`）。JWT の `email_verified` は読まない。JWT の中身・`Authorization` の値は、ログにも応答にも出さない（ログに残すのは失敗の種類だけ）。
- **401** `{error:{code:"unauthorized", message}}`（固定の文。理由は返さない。`WWW-Authenticate: Bearer` を付ける）: `Authorization` が無い・`Bearer` でない・JWT が壊れている・署名が合わない・`alg` が ES256 でない・`aud`／`iss`／`exp`／`sub` が合わない（期限切れを含む）。
- **503** `{error:{code:"unavailable", message}}`: `AUTH_ISSUER`・`AUTH_JWKS_URL` のどちらかが無い、または URL の形が不正（ログインの設定が無い扱い。起動は止まらない。§2.1。JWT の有無を見る前に返す）、または JWKS を取りに行けず前に取れた鍵も無い。ほかの入口には影響しない。
- 使うのはアカウントのロジック（ログインの確認・JWT と JWKS の疎通の確かめ）だけ。チャット・地図・詳細・精度などの入口は、これを呼ばず、これに依存しない。

**会話の履歴の API**（§2.3。**仕様のみ。実装は Go への切り替えのあと。Python の API には入れない**。保存の動き・検査の順・上限は §2.3.4・§2.3.5）:

- **共通**: ログインは `Authorization: Bearer <JWT>`（§2.1。ES256・`iss`・`aud`・`exp`・`sub` を検査。`GET /api/me` と同じ検証）。**利用者は、検証に通った JWT の `sub` だけから決める**（本文・クエリ・ヘッダーの別の値は使わない）。エラーは既存の形 `{error:{code,message}}`。422 は `details`（`loc`・`msg`）も付く。`details[].loc` は**文字列の配列**（例 `["path","conversation_id"]`・`["body","conversation_id"]`）で、`message` の側が先頭の `loc` を `.` でつないだ形（例「引数が不正です（path.conversation_id）」。`backend/app/errors.py`・`api/internal/apierr`）。入力値は応答に出さない。履歴の保存先が使えないときの文に、例外の内容・接続先・SQL を含めない。
- **`Cache-Control: no-store`**: 3 本の API は、成功・失敗のどの応答にも（204・401・404・422・500・503 を含めて）付ける（人ごとに違う内容。`/api/me` と同じ）。ルーターが 3 経路に合わせたあとの応答だけが対象（経路もメソッドも合わない 404・405 は含めない）。`POST /api/chat` には付けない（既存のまま）。
- **`GET /api/conversations`**: 200 `{"conversations": [{"id": "5b0c…", "title": "新規出現の候補は何件ありますか？", "created_at": "2026-11-25T01:02:03+00:00", "updated_at": "2026-11-25T01:05:09+00:00"}]}`。本人の会話だけ。**更新が新しい順、同時刻は `id` の昇順。最大 50 件。ページ分けは無い。** 保存を 1 人 50 件に収める（§2.3.8）ので、一覧に出ない会話は無い（上限は念のため）。`created_at`・`updated_at` は常に入る。表記（`+00:00` か `Z`）は固定しない（同じ時刻であればよい）。クエリは受けない。会話が 1 件も無ければ `{"conversations": []}`。
- **`GET /api/conversations/{conversation_id}/messages`**: 200 `{"messages": [{"role": "user", "content": "新規出現の候補は何件ありますか？"}, {"role": "assistant", "content": "…", "results": [ … ], "tool_calls": [ … ], "run_created_at": "2026-11-24T03:00:00+00:00"}]}`。`seq` の昇順（古い順）。ユーザーの発言は `{role, content}` だけ。回答は、**その回答を返した `POST /api/chat` の `message` と、JSON として等しい値**（`content`・`results`・`tool_calls`。§4.5 の判別可能ユニオン。jsonb はキーの順・空白・数値の書き方を正規化するので、キーの順は保証しない）。保存のときに、値を作り替えない。**回答には、`run_created_at`（その回答を作ったときの run の `created_at`。run が無かった回答は null）が付く**（chat の `message` には無い、履歴だけの項目。§7.1.5）。DocuNavi の `sent_at`（質問の時刻）は足さない（TownScan の画面は、発言の時刻を出さない）。発言の数は、§2.3.5 の上限（500 件）まで。ページ分けは無い。開いて見る（`GET`）だけでは、`updated_at` を更新しない。
- **`DELETE /api/conversations/{conversation_id}`**: 204（本文なし）。会話と、その発言を物理的に消す（`DELETE`。印を付けるだけの削除ではない）。無い・他人は 404。二度目は 404。画面は、削除の 404 を成功として扱う（DocuNavi の `deleteThread` と同じ。すでに目的の状態になっている）。
- **履歴まわりのエラー**（上の共通の形）:

| 状態 | `code` | いつ | 文 |
|---|---|---|---|
| 401 | `unauthorized` | `Authorization` が無い・`Bearer` でない・JWT が不正・期限切れ・`aud`/`iss` が違う。**加えて、`conversation_id` つきの chat だけ:** JWT は有効でも、`sub` の行が `auth_user` に無いとき（LLM を呼ぶ前の存在の確認。保存の段で `conversations_user_fk` の違反になった競合も同じ。回答も保存も無い） | 「ログインしてください」（`/api/me` と同じ固定の文。`WWW-Authenticate: Bearer`） |
| 503 | `unavailable` | ログインの設定が無い・形が不正（検証より先に返す）。JWKS を取りに行けず、前に取れた鍵も無い | `/api/me` と同じ固定の文 |
| 503 | `db_unavailable` | DB に届かない（既存の変換。SQLSTATE のクラス 08・40・53・54・57・58・F0 と接続系。保存の途中の失敗も含む） | 既存の固定の文 |
| 500 | `internal_error` | 上以外の、想定外の DB のエラー（表が無い・`CHECK` 違反・`conversations_user_fk` 以外の外部キー違反など。§2.3.3）〔J1〕 | 既存の固定の文（原因は載せない） |
| 404 | `not_found` | 会話が無い、または**他人の会話**（区別しない。本文も同じ） | 「会話が見つかりません」（TownScan の既存の文「候補が見つかりません」の書き方に合わせた） |
| 422 | `validation_error` | `conversation_id` の形（`^[A-Za-z0-9_-]{1,128}$`）が違う。`conversation_id` つきの chat で、`messages` のどれかの `content` に NUL（U+0000）がある（`loc` は `["body","messages","<番号>","content"]`） | 既存の「引数が不正です（…）」 |
| 422 | `conversation_full` | 1 会話の発言数の上限（§2.3.5）。回答の作成の前に断る | 「この会話は長くなりすぎました。新しい会話を始めてください」 |

- **`POST /api/chat` の「空でない発言」の判定に使う空白の集合**（既存の 422。Go でも同じにする）: Python の `str.strip()`（`str.isspace()` と同じ集合）。この集合は、Go の `unicode.IsSpace` に、**U+001C〜U+001F を足したもの**（Python は真・Go は偽。両方の集合を全コードポイントで数えて確かめた: Python は 29 個、Go は 25 個で、差はちょうど U+001C〜U+001F の 4 個。Go は、ローカルの `docunavi-dev` イメージの Go 1.26.10 で、ネットワークなし・読み取り専用のマウントで流した）。Go の正規表現の `\s` は ASCII だけなので使わず、この関数で畳む。集合が食い違うと、「空でない」と判定された発言の題名が空になり、`CHECK` で DB のエラー（500）になる。
- **履歴の題名の規則**: 題名は、会話を作るとき 1 回だけ、作るときの要求の最後のユーザー発言から作る（§2.3.2）。上の空白の集合の連続（空白・タブ・改行・全角空白〔U+3000〕・NBSP〔U+00A0〕を含む）を半角空白 1 つにまとめ、前後は除く。40 文字（コードポイントで数える）までで、超えたら先頭 39 文字＋「…」。**空になったら**（上の集合をそろえれば起きない。防御として）「（題名なし）」にする。

### 4.5 チャットのツール結果（判別可能ユニオン。`type` で分ける）

```
Provenance = { source, photo_years:number[], model, metric?, run_id, run_kind, note? }
ToolResult =
 | { type:"count",   title, total, breakdown:[{key,label,value}], filter:{area_id?,area_ids?,cls?,scope}, provenance }
 | { type:"table",   title, columns:[{key,label}], rows:[{id?, ...}], total, shown, filter:{area_id?,area_ids?,cls?,scope}, provenance }
 | { type:"compare", title, items:[{area_id,name,counts:{...}}], filter:{area_id?,area_ids?,cls?,scope}, provenance }
 | { type:"map_focus", title, bbox:[w,s,e,n], candidate_ids:string[], provenance }
 | { type:"detection_image", title, candidate_id, class, images:[{year,url}], caption, provenance }
 | { type:"accuracy", title, metrics:[{key,label,value|null,note}], provenance }
 | { type:"refusal", reason:"out_of_scope"|"no_photo_period"|"not_implemented"|"no_data", message, suggestions:string[] }
```

- **`filter`（回答の条件）**: 地区が 1 つなら `area_id`、2 つ以上（区の指定など）なら `area_ids`、全地区なら両方とも無い。`cls` は、指定があるときだけ（`compare` では並べ替えの分類）。`scope` は表示用の名前（例「中央区」「全地区」）で、常に付く（実装は `backend/app/chat/tools.py` の `_filter_info`）。
- **数字は結果からだけ**: 返答文 `content` に出る数字は、`results` に含まれる値だけ。API 側に検査（`guard_numbers`）を置き、満たさない返答は返さない（テストで確かめる）。文はテンプレートで作る。
- 模擬モデルは、日本語の規則で意図を決める（件数・一覧・比較・詳細／写真・精度・使い方・範囲外）。地区名は DB の `areas.name`・`ward` との部分一致。意図は `tool_calls` に出す。
- 範囲外の例: 天気・雑談、2024 年以降の棟の確認（写真が無い → `no_photo_period`）、衛星の「変化の当たり」（`not_implemented`: 未実装と言う）、対象地区の外。
- LLM の切り替え: 環境変数 `LLM_PROVIDER`（`mock`＝既定、`gemini`。§2.2）。道具の登録口は、後から GEE の道具を足せる形にする（登録表）。
- **Gemini を選んだとき**（`LLM_PROVIDER=gemini`。実装は `backend/app/chat/gemini_model.py`）:
  - **役割**: 「どのツールを呼ぶか」と「結果の説明文」だけ。数字・件数・座標・面積・ID は書かせない（システムの指示で言い、文は `guard_numbers` が検査する）。結果（`results`）・`tool_calls` の形は、模擬のときと同じ。変わるのは、`message.content` と、どのツールを呼ぶか。
  - **呼び方**: `generateContent` に、登録表のツールを `functionDeclarations` として渡す（引数のスキーマは登録表の定義から作る）。最初の往復は `toolConfig` の `ANY`（必ずツールを呼ぶ。範囲外も `refuse` を呼ばせる）、結果（`functionResponse`）を渡したあとは `AUTO`。**モデルへの往復は最大 4 回、ツール呼び出しは最大 6 件、1 回の呼び出しの待ちは 20 秒（接続・受信の段階ごと）。チャット 1 回の要求の全体（往復・ツール・再試行）には 27 秒の期限があり、各呼び出しの待ちは残りの期限を超えない**（各呼び出しが渡した待ちの内に終わる場合、frontend の Next.js の転送の既定の待ち 30 秒より前に、API が 502 を返す。少しずつ届く応答は、呼び出しの途中では切らない）。ツールを 1 つも呼ばずに返った文は、根拠が無いので使わない。モデルが返した `functionCall` の発言は、`thoughtSignature` を含め、返ってきたとおりに戻す。
  - **送るもの（Google へ出ていくもの）**: 会話の末尾 20 件（`CONTEXT_MESSAGES`。質問の文面を含む）、システムの指示（規則と、地区の**名前と区だけ**。座標・件数・ID は入れない）、ツールの結果（出どころ・座標・画像の URL・候補 ID の一覧は除き、配列は 50 件まで）。地区は名前で指定でき、API が ID に直す。
  - **安全**: ① 返答文は必ず `guard_numbers` を通す。LLM が結果に無い数字を書いた文は、安全なテンプレートに替わる（替えた回数だけをログに出す。文は出さない）。② `refuse` の `message` は、結果にそのまま入る（＝結果の数字として guard が認める）ので、写真の年（2018・2023）以外の数字を含む・空・300 文字を超える文は、理由ごとの固定の文に替える。`suggestions` は捨てる（既定の候補が付く）。③ 返答文は 1000 文字までに切る（frontend が会話の全履歴を送り返し、1 件 2000 文字の上限があるため）。④ 宣言していない引数は、`tool_calls` に残さない。知らないツール名は、断りの結果にする。⑤ ユーザーの発言の中の指示には従わない、とシステムの指示で言うが、守られる保証は無い。実際の防ぎは、数字の検査・ツールの境界（結果は DB からだけ）・`refuse` の文の検査。
  - **失敗**: キーが無効（401・403。Google は無効なキーに 400 を返すこともある）・429・5xx・タイムアウト・壊れた応答・候補が無い／拒否・往復やツール呼び出しの上限超過は、**模擬に切り替えず**、HTTP **502**（`code:"llm_unavailable"`、メッセージは固定）。**再試行**は、一時的な失敗（HTTP 5xx・タイムアウト・接続エラー）だけを、チャット 1 回の要求につき最大 1 回（往復ごとではない）、1 秒待ってやり直す。4xx（429 を含む）・壊れた応答はやり直さない。待ったあとの残りの期限が 5 秒未満なら、やり直さない。期限を使い切ったときの失敗の種類は `deadline`。やり直したことも、種別つきでログに残す。ログと応答に出すのは、失敗の種類・HTTP のステータス・Google の理由の定数（`INVALID_ARGUMENT` など）だけで、キー・URL・応答の本文は出さない。frontend は、既存の失敗の表示（「送信できませんでした」＋「もう一度送る」）でそのまま扱える。
  - **未確認**: 実 API での動作（`functionDeclarations` の受理・`ANY` と `AUTO` の挙動・`gemini-3.5-flash-lite` での関数呼び出し・日本語の質・待ち時間・無料枠の制限と利用条件）。キーが入ったあとに、手で確かめる。

## 5. 差分と 3 分類（`pipeline/diff.py`）

入口 = 2023 年の建物の塊 `c` のうち、**基盤地図情報（2018-10 版）に載っていないもの**（`ov_kiban < 0.25`。`ov_kiban` = c の面積のうち建物データが覆う割合）。面積が 20 m² 未満は捨てる（`small`）。次に旧写真（2018 年）で確かめる:

- `existing_omission`: `ov_2018 ≥ 0.5`（2018 の抽出が c の半分以上を覆う。旧写真に既にある → 建物データの描き漏れ。**モデルが両年とも同じ誤検出をしている場合も、ここに入る**）。
- `confirmed_new`: `ov_2018 ≤ 0.10` かつ `prob_2018_p90 < 0.20`（2018 のモデルが c の範囲に何も見ていない）。
- `uncertain`: 上のどちらでもない、またはタイルの縁に接する（`edge_touch`。`reason: "edge"`）。

閾値は `run.json.params` に入れる。**この閾値は未検証の初期値**（手ラベルが無い）と、UI の「このアプリの精度」に書く。名前に「確定」を使わない UI 文言は「新規出現（旧写真に無い）」「既存の描き漏れ（旧写真に既にある）」「判定保留」。

## 6. 評価（`pipeline/evaluate.py` → `eval.json`）

- 参照: `data/kiban/kmm_20181001`（基盤地図情報 BldA 2018-10 版。解析の読み方は `scripts/spike/kiban/loader_only.py`）。対象は 2018 年の写真 12 枚。
- 指標: 画素 IoU・適合率・再現率・F1、物体単位 F1（IoU ≥ 0.5 の 1 対 1 対応）。
- **縁の除外は、参照と予測で対称にする。**
  1. タイルの縁に接する物体は、参照・予測の両方から外す（切れた建物の不利を避けるため。参照 = 建物のポリゴンがタイルの縁の線と交わる、予測 = 連結成分が配列の縁に接する）。
  2. 1 で外した物体と、**自分の面積の半分以上が重なる反対側の物体も外す**（縁の手前で止まった予測の相手の参照、縁まで届いて隣と合体した予測の中の参照が、片側だけ残らないように。重なりは、相手側の外した物体の和との重なり。半分ちょうどを含む）。1 で外した物体を起点にした 1 段だけで、2 で外した物体からさらに外すことはしない（実データ 12 地区で 2 段目まで広げて数えたところ、増える物体は 0 だった）。
  3. 画素の指標では、外した物体の画素を、その物体の側の配列から除く（棟と画素は同じ決定で扱う）。
  4. 外した数を出す（`excluded_edge_objects` = 縁に接する数 + 重なりで外した数。内訳は `excluded_edge_detail`）。
- 分割: 12 枚を、`tiles` の並び順の前半 6 枚（調整用）と後半 6 枚（評価用）に分ける。倍率（1.0/1.5/2.0）と閾値（0.3〜0.7）は**調整用だけ**で選び、評価用と全体を別に報告する。選んだ値は `run.json.params`。
- `eval.json`: `{reference, split:{tune:[area_id], holdout:[area_id]}, sweep:[{scale,threshold,tune_object_f1,...}], chosen:{scale,threshold,selected_by}, holdout:{pixel:{...}, object:{...}}, tune:{...}, overall:{...}, per_area:[...], excluded_edge_objects:{reference,prediction}, excluded_edge_by_split:{...}, reference_detail:{...}, protocol:{year,...}, new_building_recall:null, notes:[...]}`。`overall` は 12 地区の合計の指標（`tune`・`holdout` と同じ形）、`excluded_edge_by_split` は縁の除外の数を調整用・評価用・全体に分けたもの、`protocol` は評価の取り決め（評価に使った写真の年 `year`、縁の除外の下限 `edge_overlap_min` など）、`reference_detail` は参照の素性。`new_building_recall` は手ラベルが無いので **null**（UI は「未測定」と表示）。
- **任意項目**（追加のみ。既存の項目の形は変えない。読む側は、知らない項目を無視する）:
  - `excluded_edge_detail`: `{overall|tune|holdout: {reference:{touching_edge, overlapping_excluded_prediction}, prediction:{touching_edge, overlapping_excluded_reference}}}`。`excluded_edge_objects`・`excluded_edge_by_split` の内訳（足すと一致する）。
  - `year_compare`: 同じ参照・同じ設定（調整用で選んだ倍率・閾値）で、もう一方の年の写真の抽出を測った指標。`{selected_on_year:2018, compare_year:2023, setting:{scale,threshold}, by_year:{"2018":{tune,holdout,overall}, "2023":{tune,holdout,overall}}}`（各 `tune`・`holdout`・`overall` は `{pixel:{...}, object:{...}}`）。選択には使わない。評価の年 `protocol.year` は 2018 のまま、比べる年を `protocol.compare_year` に書く。
  - `existing_absent_in_2018`: 基盤地図情報にある既存の建物（面積 20 m² 以上・縁に接しない）のうち、2018 年の抽出が「何も見ていない」（§5 の `confirmed_new` の 2018 側の条件。`diff` の関数と `DiffParams` をそのまま使う）棟数と割合 `absent`・`absent_share`、`ov_2018 ≥ 0.5` の棟数と割合 `present`・`present_share`。`{setting, params, overall|tune|holdout:{n_buildings, absent, absent_share, present, present_share}}`。**手ラベルの代わりにはならない**（absent には、モデルの見逃しと、写真の時点で取り壊し済みの参照の建物が混ざり、分けられない）。
  - `reference_detail.vintage`: 読み込んだ建物の属性の集計 `{gml_id_prefix, lf_span_from, dev_date: {値: 棟数}}`。`protocol.edge_overlap_min`: 縁の除外の重なりの下限（0.5）。
- `notes` には、**参照の時期**を、事実と推定を分けて書く。
  - 事実（読み込んだデータの集計。`reference_detail.vintage` から作る）: 読み込んだ建物は全棟が gml:id 接頭辞 K17・lfSpanFr 2018-10-01・devDate 2018-10-02 で、「2018-10」は配布の版の日付にすぎず、建物ごとの日付の違いは無い。
  - 推定（独立の確認はしていない）: [ADR 0001](decisions/0001-data-candidates.md) は、この地域の建物データは 2017-10 の更新のあと実質凍結、2018 年の熊本の写真は 2018 年 12 月の簡易空中写真と記す。これが正しければ、参照は写真より古い。写真にあって参照に無い建物は予測の FP に、参照に残る取り壊し済みの建物は FN に入る。**物体単位の適合率は、モデルの適合率ではなく、モデルの精度と参照の完全性が混ざった値**である。

## 7. UI（`frontend/`）

デザインの参考: 以前の UI モックのソース `/private/tmp/claude-501/-Users-Home-Projects/1150cdf2-1c45-42c2-85c0-d568636ced2a/scratchpad/ts-mock/project/*.dc.html`（Main＝会話と地図・Welcome＝初回の説明・Detail＝建物の詳細・Quality＝精度）。レイアウト・文言・色を踏襲してよい（写真は模式図で、数値はダミーだった。今回は実データ）。

- **全体の枠（サイドバー）**: JobNavi・DocuNavi と同じ作り・見た目・規則。本文（以下の各ページ）は、その右（1023px 以下では、上の帯の下）に置く。
  - **幅 1024px 以上: 左のサイドパネル。** 開いた表示（上にロゴと名前・閉じるボタン、続いて**「新しい会話」**（DocuNavi と同じ位置のボタン。細い帯では「＋」のアイコン）、下にアカウント（アバター＋名前）。ページへの入口の欄〔行き先〕は無い）と、アイコンだけの**細い帯**を、ボタンで切り替える。はじめは開いた状態で、保存はしない。細い帯では、ロゴの位置が「サイドパネルを開く」ボタンになり（ホバー・フォーカスでロゴが開閉の絵に変わる）、帯の空き部分をクリックしても開く。名前は、ホバーとキーボードのフォーカスで、アイコンの右に出る。開閉したら、フォーカスを、いま押せる側のボタンへ移す。
  - **「新しい会話」**（サイドパネル。`frontend/components/NewConversation.tsx`・`AppSidebar.tsx`）: ホーム（`/`）が開いていれば、チャット列の「新しい会話」と同じ処理（返答待ちの通信を止め、発言を 0 件に戻し、入力欄へフォーカスを移す。指で触る端末では移さない）を呼ぶ。ほかのページ（精度）では、ホームへ移る（移ればチャットは新しく始まる）。拡大ビュー（地図・グラフ・写真の比較）は、チャット列のボタンと同じく、閉じて、回答ごとの状態も捨てる（下の「「新しい会話」」）。1023px 以下は、サイドパネルが無いので、チャット列のボタンだけ。会話の履歴（一覧・保存・開き直し）は、**ログイン中だけ**の機能として、§7.1 に仕様を書いた（**仕様のみ。実装は Go への切り替えのあと**。いまは無く、会話は画面の状態だけで、開き直すと消える）。ログインしていないときは、今までどおり。
  - **幅 1023px 以下: サイドパネルを、必要なときだけ重ねて開く**（2026-11-25、ユーザー決定。上の横帯は無い）。はじめは閉じている（出さない）。本文の上に、細い 1 行（44px）があり、そこの「サイドパネルを開く」ボタンで、本文の上に重ねて開く（固定・窓の高さいっぱい・幅は最大 18rem。後ろに暗い背景〔scrim〕）。開いたときは、いつも**開いた表示**（細い帯にはならない）。閉じるのは、閉じるボタン・背景・Esc・ロゴ・「新しい会話」・ページの移動（アカウントのメニューの Esc は、メニューだけを閉じる）。開くとフォーカスは閉じるボタンへ、閉じると開くボタンへ戻る。細い帯の開閉は PC 幅だけで、幅の判定は `useWideScreen`（`(min-width: 1024px)`。サーバーの描画では PC 幅として扱い、見えるかどうかは CSS が決める）。DocuNavi も、狭い幅でサイドバーを開閉できる。
  - **状態の印（「模擬モデルで応答しています」・「モデル: 名前」）は出さない**（2026-11-25、ユーザー決定。サイドパネルにも、ほかのどこにも置かない）。合成データ・API 不通のバナーは、本文の上に出す（`AppBanners`）。
  - **ページへの入口の欄は無い**（2026-11-25 に、ユーザー決定で外した。ホームはロゴ、精度は下の「アカウントのメニュー」の中。サイドパネルにも横帯にも、ページの入口は置かない）。ページは 2 つ（`/`・`/accuracy`）。「このアプリについて」のページは、同日にやめた。さわればわかる作りにし、限界・出典と規約は精度ページへ移した。合成データのバナーと API 不通のバナーは、どちらの幅でも本文の上に出す（内容・文言は変えない）。
- **アカウントのメニュー**（サイドバー下のアバターのボタン。1023px 以下は上の帯の右端）: 押すとメニューが開く（細い帯では右へ、開いたパネルでは上へ）。パネルを開いているときは、ボタンにアバターと名前が並ぶ。
  - ログイン中: メールアドレス（先頭）・テーマ（ライト / ダーク / システム。選ぶと localStorage に保存し、以後は OS より優先する。「システム」で OS に従う状態へ戻す）・**「このアプリの精度」**（`/accuracy` へのリンク。押すとメニューを閉じる。開いているページでは `aria-current="page"`。ログインの有無に関わらず出る）・**「表示名を変更」**（DocuNavi と同じ。ログイン中だけ。押すとメニューを閉じて、標準の `<dialog>` を開く。1 欄・前後の空白を除いた 1〜30 文字・制御文字なし。保存は、サーバーアクション（`updateNameAction`）が、検査し直してから、Better Auth の `updateUser` で**名前だけ**を書き換える。HTTP の `/api/auth/update-user` は閉じたまま。保存したら、サイドパネルの名前がすぐ変わる。この名前は、自分にだけ表示される）・ログアウト。アバターは**プロフィール画像**（Google の `image`。`https://` のときだけ表示し、無い・読めないときは人型アイコン）。ログアウトはサーバーアクションでセッションを消し、`/` へ戻る。
  - ログインしていない: 「≡」（メニューの印。JobNavi と同じ。人型アイコンはログイン中の画像が無いときだけ）、テーマ、「このアプリの精度」、ログイン（`/login`）の入口。
  - 開いたら先頭の項目にフォーカスを置く。↑↓ で移動、Esc で閉じてボタンへ戻る、メニューの外を押しても閉じる。
- `/login`: **ログインは Google だけ**（見出し・1 行の案内・「Google でログイン」ボタン。はじめての人は、ログインするとそのまま登録される）。ログイン済みなら `/` へ。失敗は固定の文で出す（理由・秘密を含めない）。設定が足りないときは「まだ設定されていません」（§2.1）。**ログインは任意**: しなくても、全ページ・全機能を今まどおり使える。
- `/`: **チャットの 1 列**（枠・背景は無く、ページの地の上に、幅 46rem（736px）の列を中央に置く。DocuNavi と同じ）。常設の結果領域は無い。チャットは結果カードを §4.5 の型ごとに描く（`switch` を網羅的にし、`never` で漏れを検出）。グラフ・地図は、回答の中の**図**として出る（下の「回答の中の図」）。図の「拡大」、カードのボタン（「詳細」「詳細を開く」、地図の表示の「地図で見る」）、最初の画面の「解析した地区を地図で見る」は、**拡大ビュー**（地図・グラフ・写真の比較）を開く。サジェストのチップ。送信中・エラーの状態。「模擬モデルで応答しています」の表示（`/api/health` の `llm`）。`run.kind = synthetic` のとき、目立つバナー「合成データ（テスト用）」。
  - **回答の中に出すもの**（`frontend/components/chat/cards.tsx`。ユーザー決定 2026-11-25。読んで終わる数字は会話の中に出し、大きく見たいときだけ広げる形が、データを答える AI チャットの主流: Databricks Genie・Hex Threads など。出どころは一般の知識で、今回は調べていない）: 結果は、会話の中で読み切れる大きさで出す。数字・件数・座標・名前は、結果の値のまま（丸めない・LLM の文章で作らない）。グラフ・地図そのものは、カードの下の図に出す（下の「回答の中の図」）。
    - `count`: 件数・内訳の棒・条件を、今のまま出す。ボタンは無い（グラフ・地図は、下の図に出る）。
    - `compare`: 地区の表を、API の並びの先頭から**上位 5 地区まで**出す。地区が 5 を超えるときは、表の下に「全 N 地区中 5 地区を表示」と言い（表の「全 N 件中 M 件を表示」と同じ書き方）、全地区は、下のグラフの図（「表で見る」で表も）で読める。5 以下なら全部を出し、注記は出さない。ボタンは無い（グラフは、下の図に出る）。
    - `table`: API が返した行を、今のまま出す。候補の行の「詳細」。
    - `map_focus`: 1 文（「地図で、候補 N 件を目立たせて表示します」。候補が 0 件なら「地図で、この範囲を表示します」）と、ボタン「地図で見る」（押すと、拡大ビューを地図で開き、その候補を目立たせて範囲へ寄せる。下の地図の図は、はじめから、その候補を目立たせて、その範囲を見せている）。
    - `detection_image`: 2018・2023 の写真 2 枚と、分類・説明を、今のまま出す。ボタン「詳細を開く」。
    - `accuracy`・`refusal`・未知の型・壊れた結果: 今のまま。拡大ビューは開かない。
    - 「拡大」のボタンは、図にだけ置く（カードには足さない）。カードに残るボタンは、拡大ビューの写真の比較・地図を開く動作そのもの（「詳細」「詳細を開く」「地図で見る」〔地図の表示〕）だけ。
  - **回答の中の図**（`frontend/components/AnswerFigure.tsx`・`frontend/lib/answer-view.ts` の `figureKinds`。ユーザー依頼 2026-11-25。読んで終わる数字だけでなく、グラフ・地図も会話の中で見られるようにし、大きく見たいときだけ拡大ビューへ広げる）:
    - **出る条件**（結果カードにあった「グラフで見る」「地図で見る」の出し方を、そのまま写す。純粋な関数 `figureKinds`）: `count`＝地図とグラフ。`compare`＝グラフ（比べる地区が 1 つ以上のときだけ）。`map_focus`＝地図（範囲と候補の並びが読めるときだけ）。`table`・`detection_image`・`accuracy`・`refusal`・知らない型・壊れた結果（`filter` の無い `count` を含む。拡大ビューの絞り込みと同じ前処理）＝出さない。**写真の比較（詳細）は図に入れない**（「詳細」「詳細を開く」で、拡大ビューが写真の比較で開く）。1 つの回答に複数の結果があっても、種類ごとに 1 つだけ。
    - **位置・見た目**: 回答の、結果カードの並びの下。並びは、地図・グラフ（拡大ビューのタブと同じ）。幅は結果カードと同じ列（`--chat-w`）。枠・背景は結果カードの流儀（`.result-card` を重ねて使う。既存のトークンだけ。ライト・ダークとも読める）。頭の行は、図の名前（「地図」「グラフ」）と、右端の「拡大」ボタン。地図は `MapPanel`（ツールバー・集計の帯・現在表示の帯・「候補を一覧で見る」を含む）をそのまま使い、**地図の枠（`.map-stage`）は固定の高さ**（`clamp(360px, 55vw, 420px)`。狭い幅でも 360px）。グラフは `AreaChartView` をそのまま（高さは中身のまま）。
    - **状態は、その回答の拡大ビューと共有する**: 回答ごとの状態（タブ・絞り込み・強調・選んだ候補・寄せ先。`HomeClient` が持つ）を、図が読み、操作は同じ関数で、回答の鍵（`answerKey`）を渡して当てる（拡大ビューを開いているのが別の回答でも、その回答の図の操作は、その回答の状態にだけ当たる）。図で変えた絞り込み・強調・選択は、その回答の拡大ビューに引き継がれ、拡大ビューで変えたことは図に写る。地図の図とグラフの図も、同じ回答なら、互いに写る。状態が無い回答は、**はじめて図を出すとき**に、回答の結果から作る（絞り込みは「回答の条件」、強調・選択は `map_focus`・検出画像の候補。拡大ビューをはじめて開くときと同じ規則）。作るのは、地区の一覧と候補データが届いて（失敗も含む）から（それまでは、図の中身を出さず、「地図を読み込んでいます…」「グラフを読み込んでいます…」の枠）。
    - **図の操作**: 地図の印・形を押すと、地図に留まる（拡大ビューは開かず、詳細も取らない。選択中の候補のカードが地図の中に出る）。地図の「写真を比べる」・候補の一覧の項目は、その回答の拡大ビューを**写真の比較で開く**（「写真を比べる」は地図を動かさず、一覧は地図もその候補へ寄せる）。グラフの行・凡例・集計の帯・地区の選択・「強調表示を解除」は、その回答の状態を変える。グラフの図の「地図で見る」（絞り込み中だけ出る）は、**同じ回答に地図の図が無いとき（比較）だけ**出し、押すと拡大ビューを地図で開く（地図の図があるとき〔件数〕は、地図がすぐ近くにあるので出さない）。
    - **「拡大」**: 見える文字は「拡大」、読み上げの名前は「地図を拡大ビューで開く」「グラフを拡大ビューで開く」（地図の部品〔Leaflet〕のズームインの名前「地図を拡大」と取り違えないため）。押すと、その回答の拡大ビューを、その図の画面（地図・グラフ）で開く（`actions.expand` の `view`）。閉じたとき、フォーカスは、その「拡大」ボタンへ戻る（図の中の部品から開いたとき〔「写真を比べる」・一覧・グラフの「地図で見る」〕も、戻し先は、その図の「拡大」ボタン）。
    - **重さ**: 地図（Leaflet）は、図が画面に近づくまでマウントしない（`IntersectionObserver`。見る枠はチャットのスクロール領域〔親の枠で切られるので、窓ではなくこの枠を基準にする〕・余白 200px。`frontend/lib/use-near-viewport.ts`）。`IntersectionObserver` が無い環境（jsdom・古いブラウザー）では、すぐマウントする。出す前の枠は、地図と同じ高さの読み込み中の枠（出たとき、下の内容が動かない）。**一度マウントしたら保つ**（離れても外さない）。グラフは HTML と CSS だけなので、すぐ出す。**拡大ビューを開いているあいだも、図は外さない**（同じ要素のまま。後ろのチャットの見た目と、地図の位置を変えない。Leaflet は拡大ビューと図で 2 つになるが、後ろは `inert` で、操作も読み上げも届かない）。拡大ビューの地図と図の地図は、地区の選択の `id` が重ならない（`useId`）。
    - **ホイール**: 図の地図は、フォーカスが地図に無いあいだ、ホイールで拡大・縮小しない（チャットをホイールで流すとき、地図の上を通っても止まらないように）。地図を押す・Tab で入ると、ホイールでも拡大・縮小できる（`LeafletMap` の `guardWheel`。図のときだけ。拡大ビューの地図は、いつもどおり）。指で触る端末の 1 本指のドラッグは、地図が受ける（チャットのスクロールが、地図の上から始めると地図の移動になる。**実機では未確認**）。
    - **読み上げ・キーボード**: 図は、名前つきの region（名前は「地図」「グラフ」）で、`aria-live="off"`。チャットの記録（`role="log"`・`aria-live="polite"`・`aria-relevant="additions"`）は、回答が増えたときに、増えた部分を読み上げるので、図の中身（地図の印・凡例・一覧）まで読み上げないよう、図の側を `off` にする（図を記録の外に置くと、見た目の並びと DOM の順がずれるので、記録の中に置く）。図の中の、自分で知らせる部品（地図の選択の知らせ。`aria-live="polite"`）は、そのまま読み上げる。地図の印・一覧・凡例・グラフの行・「拡大」は、すべて Tab・Enter・Space で届き、Tab で図の外へ抜けられる（フォーカストラップを作らない。`tabindex` は正の値を使わない）。**読み上げソフトでの挙動は未確認**。
    - **壊れたとき**: 図の中身の描画が壊れても、図の枠と「拡大」は残り、中に日本語のエラー（`role="alert"`）と「もう一度表示する」を出す（チャット・ほかの図は巻き込まない）。
  - **拡大ビューを開く**（`frontend/components/HomeClient.tsx`）: 図の「拡大」・カードのボタン（「詳細」「詳細を開く」、地図の表示の「地図で見る」）・最初の画面の「解析した地区を地図で見る」を**押したときだけ**開く（図の地図の「写真を比べる」・一覧、グラフの図の「地図で見る」も、図の中から開く操作）。**回答が届いても、拡大ビューは開かず、画面は替わらない**（図は回答の中に出るだけ。地図の表示の回答も同じ。拡大ビューへ広げるのは、押したとき）。開く画面は、押したボタンで決まる: 「地図を拡大」＝地図、「グラフを拡大」＝グラフ、「地図で見る」（`map_focus`）＝地図（その候補を目立たせて範囲へ寄せる。最初の画面の「解析した地区を地図で見る」からなら全地区）、「詳細」「詳細を開く」・図の地図の一覧＝写真の比較（その候補を選び、地図もその候補へ寄せる）、図の地図の「写真を比べる」＝写真の比較（地図は動かさない）。開いたあとは、タブ（利用者の操作）でも画面を替えられる。
  - **拡大の単位は、回答 1 件**: 拡大ビューは同時に 1 つだけ。回答ごとに、地図・グラフ・写真の比較の状態（選んでいるタブ・絞り込み・強調・選んだ候補・寄せ先）を持ち、会話のあいだ保つ（保存はしない）。その状態は、回答の中の図と共有する（上の「回答の中の図」）。その回答を**はじめて図に出すとき・はじめて開くとき**の早いほうで、回答の結果から決める（絞り込みは下の「回答の条件」、強調・選択は `map_focus`・検出画像・「詳細」の候補）。**開き直すときは、利用者が図・拡大ビューで変えたタブ・絞り込み・選択をそのまま残し**、押したボタンの画面を選ぶ。別の回答のカードを押すと、その回答の状態で開く（前の回答の状態は残る）。最初の画面の「解析した地区を地図で見る」は、回答を持たない 1 つの状態（全地区・地図）として扱う。**地図の拡大・移動は保たない**（閉じると地図は外れる。開き直すと、保っている寄せ先へ寄せ、無ければ地区の枠が収まる範囲を見せる）。
  - **見た目**（`frontend/components/ExpandedView.tsx`。新しいコンポーネント）: ダイアログ（`role="dialog"`・`aria-modal="true"`・名前は「結果」）。中は、タブの帯（下の「拡大ビューのタブ」）と、右端の「閉じる」ボタン、その下に 3 つの画面。**開いてからマウントする**（地図の Leaflet が、大きさの無い枠で始まらないように）。閉じると全部外す。
    - 幅 1024px 以上: 画面の中央の大きなダイアログ（窓の四方から 24px あけ、幅は最大 1440px、高さは窓の高さ − 48px）。後ろは暗くし、後ろの暗い部分を押す（押し始めも押し終わりも後ろのとき）と閉じる。
    - 幅 1023px 以下: 窓いっぱいの全面のシート（余白・角丸なし）。
    - 開いているあいだ、後ろのページ（チャット・サイドパネル）は操作できず、スクロールもしない（`inert`・スクロールの固定）。
  - **フォーカス・閉じる**: 開くと、フォーカスを拡大ビューの中へ移す（選んでいるタブ。詳細の見出しへ移す操作のときは、その見出し）。閉じる（「閉じる」ボタン・Esc・後ろの暗い部分）と、開いたボタンへ戻す（そのボタンが無ければ、チャットの入力欄）。Tab は拡大ビューの中だけを巡る。**Esc**: 写真の比較の詳細の中での Esc は、これまでどおり詳細だけを閉じ、拡大ビューは閉じない。それ以外の場所の Esc は、拡大ビューを閉じる（例外は、地図で候補を選んでいるとき。地図の既存の動作のまま、1 回目の Esc は選択の解除だけ、2 回目で閉じる）。開く・閉じるを、live region で知らせない（フォーカスの移動で足りる。旧: 自動で画面を替えたときの知らせは、自動の切り替えが無くなったので無い）。
  - **「新しい会話」**（チャット列のボタン・サイドパネルのボタン）: 拡大ビューを閉じ、回答の中の図も含めて会話を空にし、回答ごとの状態をすべて捨てる（前の会話の絞り込み・強調・選んだ候補・タブ・寄せ先が、次の会話に残らないように）。
  - **コード上の注記**: 次は無くす。`HomeClient` の `defaultResultOpen`・`resultOpen`・`expanded`・`revealNonce`・live region（`announcement`）、`ResultArea` の「拡大」ボタン・`revealOnMount`・`revealNonce`、`ChatActions` の `answered`、`lib/result-view.ts` の `viewForResults`、CSS の `.home--expanded` と、チャットと結果領域を並べる・積む切り替え。結果領域の中の動き（`ResultArea`・`MapPanel`・`AreaChartView`・`CandidateDrawer`）は、ダイアログの中で今までどおり。検査は、ボタンを押して拡大ビューを開いてから行う。
  - **チャットの最初の位置**（`frontend/components/chat/ChatPanel.tsx`）: 開いた直後（発言が 1 件も無い）は、チャットの一覧を一番上のままにして、説明の見出し「熊本の街の変化を、写真と会話で調べる」から読み始められるようにする。発言の追加・送信中・失敗の変化のあと（発言が 1 件以上）だけ、いちばん下へ動かす。「新しい会話」で発言が 0 件に戻ったときは、一番上へ戻す。
  - **拡大ビューのタブ**（`frontend/components/ResultArea.tsx`。拡大ビューの中身）: 「地図」「グラフ」「写真の比較」。WAI-ARIA の tabs で、選ぶと同時に切り替わる。選んでいるタブだけが Tab キーの順に入り、タブの間は ←・→・Home・End で動く（Alt・Ctrl・Cmd・Shift が付いた組み合わせは、ブラウザー・OS の操作なので処理しない）。3 つの画面は、どれも外さず、選んでいない画面は隠すだけにする（地図の位置・拡大を保つため）。
  - **画面が替わるときのフォーカス**: 見ていた画面の中（詳細の「地図で見る」・グラフの「地図で見る」など）にフォーカスがあるまま、その画面が隠れるときだけ、選ばれたタブへフォーカスを移す（フォーカスが消えないように）。タブの操作と、画面の外にあるフォーカスは、動かさない。
  - **回答の条件**（`frontend/lib/result-view.ts` の `MapFilter`・`filterFromResults`）: 回答の `count`・`compare` が持つ `filter`（§4.5）を、拡大ビューの地図・グラフ・集計の帯へ、**同じ条件で**反映する（その回答の図を**はじめて出すとき**・拡大ビューを**はじめて開くとき**の早いほう。あとは、利用者が変えた状態を保つ）。候補の一覧へは、下記のとおり（地区は 1 つのときだけ）。
    - 地区: `area_id`（1 つ）ならその地区、`area_ids`（2 つ以上）ならそれらの地区、どちらも無ければ全地区。複数のときの表示名は、API の `scope`（例「中央区」）をそのまま出し、`scope` が無ければ「N 地区」と数だけ言う（件数・座標・面積と同じく、LLM の文章や推測で作らない）。複数のとき、地図はそれらの地区の候補だけを描き、地区の選択ボックスの先頭に「{scope}（複数の地区）」を出し、集計の帯（分類ごとの件数）はそれらの地区の和にし、グラフはそれらの地区の行だけを出す。
    - 分類: `count` の `cls` があればその 1 分類だけ、無ければ 3 分類すべて。知らない文字列の分類は、条件が無いものとして扱う（存在しない分類で地図が空にならない）。`compare` の `cls` は並べ替えの分類で、比較のカードは 3 分類と合計を出すので、分類の条件にはせず、3 分類すべてにする。
    - 1 つの回答に条件を持つ結果が複数あれば、最後のもの。1 つも無ければ、いまの絞り込みのまま。条件が空（全地区・全分類）なら「すべて」に戻す。
    - 回答カードの「対象・条件」の行（`frontend/components/chat/AnswerScope.tsx`）の地区・分類も、同じ「最後の `count` か `compare`」から作る（右の絞り込みと食い違わない。先に `count`、あとに `compare` なら、`compare` の条件）。最後が `count` のときは地区と分類の 2 行、最後が `compare` のときは地区の行だけで、分類の行は出さない（比較のカードは 3 分類と合計を並べ、`filter.cls` は並べ替えの分類にすぎないため）。ほかに、比べる地区の名前と、写真の年の行を、結果の値からだけ作る（LLM の文章や推測は使わない）。
    - 利用者が地図・グラフで地区・分類を選ぶと、その回答の絞り込みを書き換える（図でも拡大ビューでも同じ。どちらにも写る）（地区を 1 つ選ぶと、複数地区の条件は外れる）。集計の帯の「条件を解除」で、すべてに戻す。
    - 候補の一覧は、API が地区も分類も 1 つしか受けない（契約は変えない）。地区は、対象が 1 つの地区のときだけ、その地区で絞る。複数の地区のときは、一覧の本体を出さず、「地区を 1 つに絞ると、一覧が出ます。」と言う。分類は、1 つだけ表示しているときはその分類で絞り、2 分類以上を表示しているときは 3 分類すべてを出す（この旨を、一覧の見出しの直後に書く）。
  - **回答の中の図の「拡大」と、カードのボタン**: 図の「拡大」を押すと、その回答の拡大ビューを、その図の画面で開く（上の「拡大ビューを開く」「拡大の単位」）。カードのボタンは、地図の表示の「地図で見る」（候補を目立たせ、範囲へ寄せて、地図で開く）と、「詳細」「詳細を開く」（写真の比較）だけ。件数・比較の「グラフで見る」「地図で見る」は、図が代わるので無い。はじめて開くときは、その回答の条件（上の規則で、その回答の結果から決めたもの）で開く。図で変えた絞り込み・選択があれば、そのまま開く。開き直すときは、利用者が変えた絞り込みのまま。
  - **印・形を押したとき**: 地図に留まる（画面を替えない）。その候補を強調し、**選択中の候補のカード**を地図の中に重ねて出す（「選択中の候補」・分類のバッジ・候補 ID・「写真を比べる」ボタン。`frontend/components/map/MapPanel.tsx`）。カードは地図の枠（`.map-stage`）の中の下端の中央寄せ（下から 30px。幅は 520px まで）で、地図の大きさは変わらないので、押した印は動かない。DOM では地図の本体より後ろに置く。`onComparePhotos` が無いとき、または選んだ ID が地図の候補データに無いときは、カードを出さない。カードを避けて地図を動かす処理は無い（地図の下端に近い印は、カードの下に隠れることがある。実画面では未確認）。押したときだけ、「写真の比較」へ切り替える。
    - 読み上げ: 見えない live region（`aria-live="polite"`・`aria-atomic="true"`。`role="status"` は、タイルの通知に譲る）を常に描き、選ぶと「候補 {id} を選びました。「写真を比べる」で写真を比べられます。」を出す。選択が外れる・カードを出さないときは空にする。
    - 拡大ビューの候補の一覧と、チャットの表の「詳細」から開く操作は、「開く」操作なので、写真の比較へ切り替えて、地図もその候補へ寄せる。寄せるときの余白は四方 32px（詳細は地図に重ならないので、右端をあけない）。
  - **写真の比較**（`frontend/components/CandidateDrawer.tsx`。旧: 重なって開くドロワー）: 候補を選んでいないときは、選び方の案内を出す（この枠はフォーカスを受ける。フォーカスの輪は、親の `overflow` に切られないよう、枠の内側に描く）。選んでいるときは、その候補の詳細を、このタブの中に埋め込んで出す（地図に重ならない）。内容は、2018・2023 の切り出し画像を並べる（`/api/candidates/{id}/image`）、分類のバッジと平易な説明、根拠の数字（`evidence`）、位置、データの出どころ、「地図で見る」（地図のタブへ切り替えて、その候補へ寄せる）、「閉じる」（選択を外す。Esc でも閉じる）。チャットの「詳細」「詳細を開く」から開いたときは、その候補を選び、見出しへフォーカスを移す。
    - **詳細は、「写真の比較」が一度見えるまでマウントしない**（`frontend/components/HomeClient.tsx` の `PhotosPanel`）: 地図の印を選んだだけでは、`GET /api/candidates/{id}` を呼ばない（印を続けて押しても 0 回）。「写真を比べる」を押す・「写真の比較」のタブを選ぶ・チャットの「詳細」「詳細を開く」から開く、のどれかで写真の比較が見えたときに、初めてマウントして 1 回取る。一度見えた詳細は、別のタブへ替えても保ち、戻しても取り直さない。選んだ候補が替わったら、前の詳細は外し、新しい候補は、また見えるまでマウントしない。見えたときにマウントするので、見出しへフォーカスを移すかどうかも、そのときの選び方で決まる（「写真を比べる」とチャットの「詳細」「詳細を開く」は移す。タブ操作は、フォーカスを奪わない）。
    - **閉じたあとのフォーカス**: 「閉じる」・Esc で閉じる直前に、フォーカスが詳細の中にあれば、先に「写真の比較」のタブへ移す（詳細が外れると、フォーカスのあった要素ごと消え、フォーカスが body に落ちるため）。拡大ビューごと閉じるときは、上の「フォーカス・閉じる」に従う（開いたボタンへ戻る）。閉じる直前にフォーカスが詳細の外（チャットの入力など）にあるときは、動かさない。
  - **幅**: チャットは常に 1 列（会話・「新しい会話」の行・入力欄・最初の画面は、幅 46rem（`--chat-w`）の列を中央に置く。左右の余白は `--chat-pad` = `max(1.25rem, (幅 − 46rem) / 2)` で、3 つとも同じ式。外側の枠・背景・角丸は無い。420px 以下は余白 0.75rem）。回答の中の図も、この列の中（結果カードと同じ幅）。チャットと結果領域を左右に並べる・縦に積む切り替えと、結果領域が見える所までのスクロールは無い。拡大ビューは、1024px 以上でダイアログ、1023px 以下で全面のシート（上の「見た目」）。窓が 1257px 以上のときは、拡大ビューの中の写真の比較の中身の最大幅を `clamp(1040px, 70vw, 1440px)` にする（それ未満は拡大ビューの幅いっぱい）。
  - **チャットの見た目**（`frontend/components/chat/ChatPanel.tsx`・`Composer.tsx`・`app/globals.css`。ユーザー決定 2026-11-25: DocuNavi のチャットと同じ見た目にする。値は DocuNavi の `frontend/src/styles.css` の宣言をそのまま写す）: **質問**は右寄せ・最大幅 85%・枠なしの無彩色の淡い背景（`--surface-muted`）・文字は通常の色・1rem。**質問の前**に、送った時刻を中央に薄く出す（`<time>`。「今日 9:05」「昨日 20:41」「11月14日 21:02」「2025年11月14日 21:02」。`frontend/lib/sentAt.ts`。時刻は端末で付ける画面だけの値で、`/api/chat` へは送らない。送信に失敗した質問にも付き、「もう一度送る」で時刻は変えない）。**回答の本文**は 1rem・行間 1.85・`--text-body`（少し淡い色）。結果カード・条件の帯・表の文字は、これまでの大きさ。**入力欄**は角丸の 1 つの枠（フォーカスが中にあるあいだ、主色の縁とフォーカスの輪）で、中に伸びる入力（`textarea`。1 行から最大 13rem）と、下の行の右に**丸いアイコンだけの送信ボタン**（名前「送信」・title「送信（Enter）」）。Enter で送り、Shift+Enter で改行し、日本語入力の変換を確定する Enter では送らない。空・空白だけの間と、返答待ちの間は、ボタンも Enter も送らない。**続けて聞く**（DocuNavi の `.follow-ups`・`.follow-up` と同じ宣言。`frontend/components/chat/ChatPanel.tsx`）: 回答が届いたあと（返答待ち・失敗のときは出さない）、会話の中の、最後の回答の下に、上に区切りの線を引いて、まだ聞いていない質問の例を最大 3 件、縦に並べる（枠なし・0.85rem・`--text-muted`・先頭に「↳ 」・触れると主色と下線。見出しの文字は出さず、名前は aria-label「続けて聞く」）。押すとその質問を送り、入力欄へフォーカスを移す。以前の、入力欄の上の丸い質問の例の行は無い。**最初の画面の質問の例**は、DocuNavi の `.example-chips`・`.example-chip` と同じ宣言（幅いっぱいの角丸の長方形のボタンを縦に並べる。違いは、幅を 34rem までにすることと、見出しとの間の余白だけ）。範囲外の例は、破線の枠でも区別する。**「新しい会話」**のボタン（入力欄の上。同じ幅の列の右端）は、サイドパネルの無い幅（1023px 以下）だけで見える（1024px 以上は、サイドパネルの同じ処理のボタンだけ。DocuNavi のチャットには無い）。
- 地図（拡大ビューの「地図」）: 地理院タイルを直接読む（標準地図・2018 年の写真 `nendophoto2018`・2023 年の写真 `nendophoto2023`。帯の外・範囲外のタイルが 404 でも崩れない。出典の表示）。解析した 12 地区の枠を描く。候補のポリゴンを 3 分類の色（色だけに頼らず、形・線種・分類の印でも区別）で描く。パネルは縦の flex で、地図（`.map-stage`）が、上下の帯の残りの高さをすべて取る（最小 320px）。帯は縮めず、中身が収まらないときだけ、パネルがスクロールする。上から、次の順に並べる。帯（ツールバー・集計の帯・現在表示の帯）は、幅が足りなければ折り返す（はみ出さない）。
  - **ツールバー**: 地図の種類・地区の選択・「解析した地区の枠」を、1 行に並べる（狭い幅では折り返す）。ボタン・選択・チェックは 36px。
  - **集計の帯**（`frontend/components/map/SummaryStrip.tsx`）: 「対象」・分類ごとの件数・（条件があれば）「条件を解除」。数字は `/api/areas` の件数を足したもので、地区の条件だけを反映する。**分類ごとの件数は、そのまま表示の切り替えのチェックボックス**（`role="group"`「表示する分類（色・線・形で区別）」）で、分類の印（色・線・形）・短い名前・件数を 1 つのラベルにまとめる。**地図に重ねる凡例は無い**（同じ内容を 2 か所に出さない）。押すと `filter.classes` だけを替え、地区（`areaId`）と複数の地区（`areaIds`・`scope`）の条件は保つ。選んでいる分類は、色だけでなく、チェック・太い枠・地色で見分ける。外した分類は「（非表示）」。分類の一部だけを表示しているときは、「全 m 件のうち、表示中 n 件」と「条件を解除」を出す。読み上げの名前は、分類の全文と件数（例「新規出現（旧写真に無い）、9 件」）。
  - **地図**: 地図の上に重ねるのは、候補の読み込み中（`role="status"`）と、読み込みの失敗（`role="alert"`。再試行つき）の、小さい通知 1 つだけ。候補と地区の一覧が両方失敗したときは 1 つにまとめ、再試行は両方を取り直す。下端に、選択中の候補のカード（上の「印・形を押したとき」）。
  - **現在表示の帯**（`.map-status`。1 行。長いときは折り返す）: 現在の表示・「強調表示を解除」・案内「印・形を選ぶと「写真を比べる」が出ます。」・地図についての通知（写真が無い範囲のタイルの通知は `role="status"`。「候補は印で表示しています。拡大すると建物の形が見えます。」。候補が 0 件のときの文）。**通知は、地図に重ねず、この帯に出す**。
  - **「候補を一覧で見る（面積の大きい順）」**（既定は閉じている）: 一覧の項目のフォーカスの輪が切れないよう、スクロールする枠に 6px の余白を取る（負の余白で位置は保つ）。
- グラフ（拡大ビューの「グラフ」。`frontend/components/chart/AreaChartView.tsx`）: 地区ごとの件数を、3 分類の積み上げ横棒で出す（棒は HTML と CSS だけ。色・縁の線・模様で分類を区別）。合計の多い順。行を押すとその地区だけに絞り込み（もう一度押すと全地区へ）、凡例のボタンで分類を切り替える。どちらも、地図と共通の絞り込み。「表で見る」で、同じ数字を表でも読める。
- `/accuracy`: `/api/metrics` の数字。調整用／評価用の区別、「新築の再現率: 未測定」、閾値は未検証の初期値であることを書く。**順は、要点（見出しの数字 3 つ・閾値の注意）→ 既知の限界 → 出典と規約 → 「詳しい測定を見る（開発者向け）」（はじめは畳む。調整用と評価用の表・写真の年の比較・選んだ設定・地区ごとの値・評価の注記・由来）**（2026-11-25、ユーザー決定。長い説明を最初に読ませない）。入口は、アカウントのメニューの「このアプリの精度」と、チャットの精度カードのリンク。
  - 見出しの数字（物体単位 F1・画素 IoU）には、**どの年の写真で測った値か**を明記する（`protocol.year`。無ければ 2018）。「再現率」は、「建物の抽出の再現率（基盤地図情報に対する値）」と「新築の再現率（未測定）」を、必ず修飾して書き分ける。
  - `year_compare` があれば、もう一方の年の写真での値と、年で比べる表を出す。無い・形が違うときは、その部分を出さず、画面は落ちない。
  - 限界欄に、`existing_absent_in_2018` から描く「2018 年の写真での見落とし」（既存の建物のうち、2018 年の抽出が何も見ていない割合。手ラベルの代わりにならない）、参照が写真より古い可能性（推定）と物体単位の適合率が合成値であること、年ごとの再現率の違い（数字だけ。原因は書かない）を載せる。数字はデータから描き、手書きにしない。
  - 評価の内部のキー名（`pixel_iou` など）は、日本語の見出しにする。
- `/accuracy` の末尾: 既知の限界（写真が無い期間・2018 年は帯状の範囲だけ・タイルの縁・誤検出の可能性・撮影月が不明・正解が無い・未実装のもの＝衛星の「変化の当たり」・パネル・人による確認・公開）と、出典と規約（地理院タイル、基盤地図情報、モデル `giswqs/whu-building-unetplusplus-efficientnet-b4`＝Apache-2.0・学習データ WHU の利用条件は不明・地理院タイルの機械学習での大量利用は未確認）。最初のチャット画面は、見出し・1 行の説明（候補であり新築と断定しない）・地図のボタン・質問の例だけを出し、対象・地区の名前・比較・出典・3 分類・範囲外の質問は「くわしく」（閉じた状態）に入れる。入力欄の下にモデル名の注記は出さない（モデルの印は、サイドパネル・上の横帯に 1 か所）。
- ブラウザから API へは、同じオリジンの `/api/*`（Next の rewrites。転送先は実行時の環境変数 `API_URL`）。ただし `/api/auth/*`（ログイン・JWKS）は web 自身の Route Handler が受け、api へは転送しない（§2.1）。
- ログインの依存: `better-auth` 1.7.18 と `pg`（版を固定し、ロックファイルに含める）。ほかの新しいサービス・言語・DB は足さない。
- 技術: Next.js（最新の安定版を、版を固定して）、React、TypeScript strict、Node 24、`output: "standalone"`。地図は Leaflet か MapLibre GL JS（版を固定。選んだ理由を 1 行）。`npm ci` で入れる（ロックファイルをコミット対象に含める）。

### 7.1 会話の履歴（ログイン中だけ）

位置づけ: **仕様のみ。実装は Go への切り替えのあと**（API の形は §4.4、保存の動き・認可は §2.3）。サイドパネルの枠・アカウントのメニュー・拡大ビューは、§7 のとおり。本文の〔J5〕・〔J6〕は、ユーザー決定ではなく起草者の判断（§2.3 の冒頭。ADR 0006）。

#### 7.1.1 置き場

- **幅 1024px 以上の左サイドパネル（開いた表示）の中、「新しい会話」の下・アカウントの上**に、「会話の履歴」の領域を足す（DocuNavi は「新しい会話」の下・アカウントの上）。残りの高さを使い、中だけをスクロールする。見た目は DocuNavi の `thread-*` に合わせ、TownScan の色の変数を使う。
- 細い帯（閉じた表示）では、一覧を出さない（DocuNavi と同じ。履歴・文字は隠す）。「新しい会話」の「＋」は、いまのまま。
- **1023px 以下は、サイドパネルを重ねて開けるが、一覧の入口は、初版では作らない（決定）。** 保存は続く（同じ人が広い画面で開けば見える）。DocuNavi は、狭い画面でもサイドバーを開く作り（閉じると完全に隠す。`useWideScreen`・`ws-shell[data-side]`）で、狭い画面の一覧は、CSS のコメントで「崩れないことの確認だけで、モバイル向けの最適化はしない」とある（`styles.css`）。実際に狭い画面で一覧が使えるかは、確かめていない。TownScan も、狭い幅でサイドパネルを重ねて開ける（上の横帯は 2026-11-25 にやめた）ので、あとで一覧を足せる。

#### 7.1.2 一覧の状態

見出しは「会話の履歴」、領域の名前（読み上げ）は「会話の一覧」（DocuNavi と同じ文言）。

| 状態 | いつ | 表示 |
|---|---|---|
| ログインしていない（ログインを使える設定） | 未ログイン | 1〜2 行の案内「ログインすると、会話を保存して、ここから開き直せます。」と、`/login` への入口。何も無いのと区別がつくように、領域は出す（DocuNavi も、使えない理由を示すため、領域を出す） |
| ログインを使えない設定 | `isAuthConfigured()` が偽 | 「ログインを設定していない環境では、会話は保存されません。」。入口は出さない |
| 読み込み中 | 最初の取得 | 「読み込み中…」（`role="status"`） |
| 失敗 | 取得の失敗 | 「会話の一覧を取得できませんでした。しばらく待ってから再試行してください。」（`role="alert"`）＋「再読み込み」（DocuNavi と同じ文言） |
| 空 | 0 件 | 「まだ会話がありません。質問を送ると、ここに並びます。」（DocuNavi と同じ文言） |
| 一覧 | 1 件以上 | 項目の並び（§7.1.3） |
| ログインの期限切れ | 取り直しても 401（§7.1.7） | 「ログインの有効期限が切れました。ログインし直してください。」＋`/login` への入口 |

- **未ログインのとき、履歴の API を呼ばない。** 画面の中の会話は、今までどおり。
- 取り直している間も、前の一覧を出し続ける（ちらつかせない。DocuNavi と同じ）。
- 文言は、未ログイン・設定なしの 2 つとも、この文書の案のとおりで決定（ユーザー決定。ADR 0006 の D12）。

#### 7.1.3 項目と操作

- 項目は、題名（`title`。長いときは「…」で省く。`title` 属性に全文）と、更新時刻（`ja-JP`・月日と時分。DocuNavi の `formatTime` と同じ）。開いている会話に `aria-current="true"`。
- 項目を押す → その会話を開く（§7.1.4）。**生成中（`sending`）は、開いている会話を削除できず、別の会話にも移れない**（生成が止まってしまうため。DocuNavi と同じ）。
- 一覧は、回答が最後まで届く（または止まる）たびと、削除のあとに取り直す（DocuNavi の `settledCount`）。
- **「新しい会話」**（サイドパネルのボタンと、チャット列のボタン。どちらもいまの処理）: 返答待ちの通信を止め、発言を 0 件に戻し、**開いている会話 ID を忘れる**（`sessionStorage` の値を消す。「保存を飛ばした」印も戻す。§7.1.7）。次に送るとき、新しい `conversation_id` を作る。拡大ビューは、§7 の「新しい会話」のとおり（閉じて、回答ごとの状態を捨てる）。ほかのページ（精度）からは、ID を消してからホームへ移る。
- **ほかのページ（`/accuracy`）で項目を押す** → 開く会話の ID を `sessionStorage` に書いてから、ホーム（`/`）へ移る。ホームのチャットは、立ち上がったときに保存された ID を見て、開き直す。
- **ログイン中は、`/accuracy` から `/` へ（ロゴ・ブラウザーの戻る）戻っても、`sessionStorage` に会話 ID があれば、最後に開いていた会話を開き直す**（決定。いまは、ほかのページへ移ると会話が消える。「新しい会話」は ID を消してから移るので、開き直さない）。

#### 7.1.4 開き直し（再開）

1. 押したら、返答待ちを止め、発言を空にし、**拡大ビューも「新しい会話」と同じに閉じて、回答ごとの状態を捨て**（前の会話の絞り込み・強調・選んだ候補・タブ・寄せ先が残らないように）、会話 ID を `sessionStorage`（キー案 `townscan:conversation_id`。タブごと）に書く。
   - **新しい会話の ID を `sessionStorage` に書くのは、`conversation_id` つきで送った最初の回答が届いたとき**（保存されたとき）〔J6〕。最初の送信が失敗した・保存を飛ばして送り直した（§7.1.7）のに ID だけが残り、再読み込みで「見つかりません」になるのを避ける。
2. `GET /api/conversations/{id}/messages` を取る。取っている間、チャット欄には説明（`Welcome`）ではなく「これまでのやり取りを読み込んでいます…」（`role="status"`）を出す（DocuNavi と同じ文言）。取得の間に別の会話へ移った・新しい会話にした・送信を始めたなら、遅れて届いた結果は捨てる（DocuNavi の `jobRef`）。
3. 届いたら、`ChatEntry`（`role`・`content`・`results`・`tool_calls`）として並べる（形が合わない `results` は、今の画面と同じく、壊れずに飛ばす）。以後、続きを送れる（送る `messages` は、今と同じく画面の発言から作り、`conversation_id` を付ける）。並べた位置は、いまの「回答が届いたあと」の規則（長い回答は質問の先頭が見える位置）と同じ。**拡大ビューは開かず、画面は替えない**（回答が届いたときと同じ。§7）。回答の中の図は、回答が届いたときと同じく、回答の中に出る（地図は画面に近づくまでマウントしない）。解析結果が変わっていた回答の扱いは §7.1.5。
4. **失敗:** 「過去のやり取りを読み込めませんでした。もう一度読み込むか、新しい会話を始めてください。」（`role="alert"`。DocuNavi と同じ文言）＋「再試行」＋「新しい会話」。失敗しても会話 ID は捨てない（再試行できるように）。
5. **404（会話が無い）は、失敗と分ける:** 「この会話は見つかりませんでした。削除されたか、保存の上限（1 人 50 件・最後の動きから 7 日）で消えた可能性があります。」を出し、会話 ID を忘れる（`sessionStorage` を消す）。DocuNavi は 404 も同じ失敗の表示で、再試行しても直らない（保存期間を過ぎたタブで起きうる）。この差は、TownScan が上限を持つため。**文は「可能性」で書く:** 50 件の整理は保存のたびに効くが、7 日の掃除は手で流す（§2.3.8）ので、7 日を過ぎた会話が必ず消えているとは言えない。
6. **再読み込み・ホームへの戻り:** ログイン中は、`sessionStorage` に会話 ID があれば、立ち上がりのときに自動で開き直す（DocuNavi の `restoredRef`）。DocuNavi の `docs/api.md` は「ページの再読み込みだけでは取得しない」と書くが、コード（`useChat.ts`）は取得する。コードに合わせた。ログインしていないときは、ID を見ない（残っていれば消す）。
7. 読み上げ: 開き直しで並べる発言は、読み上げない（並べ終えるまで `aria-busy` を真にする。実際の読み上げでの挙動は未確認）。フォーカスは動かさない（押した一覧のボタンに残す）。

#### 7.1.5 開き直した会話の、拡大ビューと解析結果の食い違い

拡大ビュー（地図・グラフ・写真の比較）の回答ごとの状態（選んでいるタブ・絞り込み・選んだ候補・強調・寄せ先）は、保存しない。**保存した回答の `results` から、その回答の拡大ビューを、カードのボタンを押してはじめて開くときに決める**（§7「拡大の単位は、回答 1 件」。通すのは保存された値だけで、値を作り直さない）。

規則:

0. 開き直しの始めに、拡大ビューを「新しい会話」と同じ状態へ戻す（閉じて、回答ごとの状態を捨てる。§7.1.4 の 1）。
1. 開き直した会話の回答を並べても、**拡大ビューは開かず、画面は替わらない**（回答が届いたときと同じ。§7）。そのため、読み上げ・スクロール・フォーカスの移動も無い。
2. **待つ:** 規則 3 の比較は、`GET /api/health`（`HealthProvider`）の読み込みが終わってから（成功・失敗どちらでも）、1 回だけ行う（終わるまでの扱いは、実装のときに決める。未確認）。
3. **解析結果（run）が変わっていたら、その回答は「別の解析結果に基づく回答」として扱う**（拡大ビューを開かせない。規則 4）。回答ごとに、作ったときの run といまの run を比べる:
   - 作ったとき: 回答の `results` の `provenance.run_id`（`refusal` には無い）と、その回答の `run_created_at`（§2.3.2・§4.4）〔J4〕。
   - いま: `GET /api/health` の `run.run_id` と `run.created_at`（`HealthProvider` が持つ）。
   - **`run_id` が同じでも、`run_created_at` が違えば、別の解析結果。** 実データの `run_id` は run のフォルダ名（`pipeline/run_postprocess.py` の `default_run_id`）で、`created` の既定は現在時刻。ローダーは同じ `run_id` の行を消して入れ直す（`backend/app/load.py` の `write_run`）。同じ `run1` を後処理し直して読み込み直すと、候補 ID・件数が変わっても `run_id` は同じで、`created_at` だけが変わる。
   - 時刻は、文字列ではなく時刻として（`Date.parse` のミリ秒）比べる（表記が違いうるため）。
   - 回答に `provenance` があるのに `run_created_at` が null のときは、別の解析結果と見る（安全側）。`refusal` だけの回答は、run に依らないので、別の解析結果とは見ない。
   - 現在の run が分からない（health の取得に失敗）ときも、別の解析結果と見る（食い違いを見せない側に倒す）。
   - 残る穴: 後処理の `--created` で、同じ時刻を明示して入れ直した場合は見分けられない（ADR 0006 の未確認）。
4. 別の解析結果の回答があるときは、会話の先頭に注意書き「この会話の一部は、いまとは別の解析結果に基づいています。件数や地図は、いまのデータと食い違うことがあります。」を 1 行出す。**その回答のカードの、拡大ビューへ進むボタンは、押せなくし、回答の中の図（地図・グラフ）は出さない**（ボタン: 地図の表示の「地図で見る」、表の行の「詳細」、検出画像の「詳細を開く」。図は、いまのデータで描くので、食い違った地図・グラフを見せない。押すと、いまのデータに無い地区・候補を開いてしまう。質問の例のボタン〔`ask`〕は、新しい質問を送るだけなので、そのまま使える）。カードの数字・文は、保存された値のまま読める。**検出画像のカードは、写真も読み込まない**〔J5〕（保存された画像の URL は、別の解析結果では、無い候補・別の建物を指しうるため。代わりに「別の解析結果の写真は表示しません」と出す。この 1 点は、ユーザー決定の「ボタンを無効にする」への、起草者の追加）。実装の目安: `ChatEntry` に印（例 `staleRun`）を足し、`ResultCard` へ渡して、ボタンの `disabled` と写真の抑止に使い、`ChatPanel` は図（`renderFigure`）を呼ばない（`frontend/components/chat/types.ts`・`ChatPanel.tsx`・`ResultCard.tsx`・`cards.tsx`）。

**理由:** 回答の `results` は、その時点の run（`kind` が `synthetic` か `real` かも含む）の値で、候補 ID（`c-x-y-n`）・地区の `filter` も run ごとに違う。解析結果は、読み込み直すと入れ替わる（`python -m app.load`。表示するのは最新の run）。合成データで話した会話を、実データになってから開くと、カードの件数と地図が食い違う。TownScan は、「古い run の画面を作らない」とする（DocuNavi は、保存した検索範囲がいま見えないとき〔`scope_unavailable`〕、範囲を主張せず、続きは保存された範囲で探す）。

#### 7.1.6 削除（2 段階）

DocuNavi の `ThreadSidebar` と同じ。

1. 項目の右のゴミ箱（`aria-label`「「{題名}」を削除」・`title`「削除」）を押すと、その場でボタンが「削除する」「やめる」に替わる（同時に確認が出るのは 1 件だけ）。誤って押しても、まだ消えない。
2. 「削除する」→ `DELETE`。成功したら一覧を取り直す。**開いていた会話を消したときは、画面も最初の状態に戻す**（会話 ID を忘れる）。404 は成功として扱う。
3. 失敗したら、一覧の上に「会話を削除できませんでした。しばらく待ってから再試行してください。」（`role="alert"`。DocuNavi と同じ文言）。
4. 開いている会話は、生成中は削除できない（ボタンを無効にする）。
5. 取り消しの案内・ゴミ箱の一覧は作らない（削除は物理削除。§2.3.7）。

#### 7.1.7 再読み込み・ログアウト・ログインの期限切れ

- **ログアウト:** 既存のサーバーアクションで `/` へ戻る（画面が作り直される）。保存した会話は消えない（ログインし直せば見える）。`sessionStorage` の会話 ID は、未ログインで立ち上がったときに消す（次に同じタブで別の人がログインしても、前の人の ID を開こうとしない。開こうとしても、サーバーは 404 を返す）。
- **ログインの期限切れ**（セッションは 14 日で、延長しない。`frontend/lib/auth.ts`）: 履歴の API が、取り直しても 401 のとき、画面は「ログインしていない」扱いにする。一覧は §7.1.2 の「期限切れ」の表示。チャットは**止めない**: 送るときの `conversation_id` を外して（保存せずに）送り直し、回答の下に注記を出す。「ログインしなくても全機能が使える」を、ログインの失敗で崩さない。
  - **保存を飛ばしたあとの整合の規則:** 上の送り直しで保存を 1 度でも飛ばした会話では、**それ以降の送信にも `conversation_id` を付けない**（画面の会話の状態として、その会話の間だけ持つ。「新しい会話」・開き直しで戻る。理由は §2.3.4）。保存済みの部分は、そのまま残る（開き直すと、飛ばす前までが見える）。
  - **注記**（飛ばした回答に 1 回だけ。以降の回答には繰り返さない）:「ログインを確認できなかったため、この回答から保存されません。続きを保存するには、新しい会話を始めてください。」
  - **LLM の呼び出し回数:** 401 は、LLM を呼ぶ前に返る（トークンが不正・期限切れ、または `auth_user` に行が無い。§4.4・§2.3.3）。初回の 401 →（§2.3.6）トークンを取り直して再送 → 2 回目の 401 → 保存なしの送り直し、で、LLM を呼ぶのは**最後の 1 回だけ**。例外は、存在の確認の直後に利用者の行が消える競合だけで、保存の段の 401 になり、LLM を 1 回余分に呼ぶ（まれ。許容する）。
- **ログインの確認だけが 503**（JWKS に届かない・設定が無い）のときも、同じく保存せずに送り直し、同じ注記と同じ規則（以降も `conversation_id` を付けない）。
- **DB が使えない 503**（`db_unavailable`）は、送り直さない（チャット自体が DB を使うため）。既存の「送信できませんでした」＋「もう一度送る」。この失敗は、保存を飛ばしたことにならない（その往復は、回答も保存も無く、画面も失敗の印をつける。「もう一度送る」で再送すれば、同じ `conversation_id` で保存される）。
- **`conversation_full`（422）**: 再送しても直らないので、「もう一度送る」を出さず、メッセージ（「この会話は長くなりすぎました。新しい会話を始めてください」）と「新しい会話」を示す。
- **別のタブで消した会話に続きを送る:** 保存先が無いので、続きだけの新しい会話として保存される（DocuNavi も同じ。返答の生成中に同じ会話を削除したときの挙動は、DocuNavi も未確認と書く）。

#### 7.1.8 そのほか

- 狭い幅・細い帯・テーマ（ライト・ダーク）・キーボード操作（項目とゴミ箱が Tab の順に入る。確認の 2 つのボタンへフォーカスが移る）は、DocuNavi の `ThreadSidebar` に合わせて作り、実画面で確かめる（未確認）。
- 画面の部品の置き場の案（新設の予定。いまは無い）: `frontend/lib/conversations-api.ts`（3 本の呼び出し）、`frontend/lib/auth-token.ts`（§2.3.6）、`frontend/lib/use-conversations.ts`（`frontend` に `hooks/` は無く、フックは `lib/use-api.ts` のように `lib/` に置く）、`frontend/components/ConversationList.tsx`（サイドパネルの中）。サイドパネルとチャットのつなぎは、既存の `NewConversation.tsx`（登録の仕組み）に、「開く」「いま開いている会話」「生成中」を足して広げる。
- 画面に、件数の上限（50 件）を知らせる表示は、初版では作らない（古い会話が自動で消えることは、404 の文でだけ伝わる。ADR 0006 の未確認）。

## 8. 出口条件（実行して確かめる）

| # | 検査 | 担当 |
|---|---|---|
| E1 | `scripts/verify.sh repo` が合格 | 統合 |
| E2 | `pipeline` の単体テストが合格（タイル計算・ベクトル化・基盤地図情報の読み込み・評価指標・3 分類を、合成データで） | pipeline |
| E3 | `backend` のテストが合格（DB を使うもの、`guard_numbers`、範囲外の拒否、画像の切り出し、ローダーの冪等性） | backend |
| E4 | `frontend` の型検査・lint・テスト・`next build` が合格 | frontend |
| E5 | `scripts/dev-up.sh` で 3 つが起動し、`/api/health`・web の `/`・web 経由の `/api/candidates` が応答。3 つの使用メモリを実測して記録 | backend + 統合 |
| E6 | 実データを読み込み、DB の件数 = `candidates.geojson` の件数 = UI の件数 | メイン |
| E7 | Chrome で、質問 → 結果カード → 拡大ビュー（地図・グラフ）→ 詳細（2018/2023 の写真）→ 精度の画面、の一連を操作して確認（スクリーンショット） | メイン |
| E8 | `frontend` のテストが、回答の中の図と拡大ビュー（§7）を確かめる: ①最初の画面はチャットだけで、結果つきの回答が届いても、拡大ビューは開かず、画面は替わらない（図は回答の中に出る） ②**図の出る条件**: 件数＝地図とグラフ、比較＝グラフ、地図の表示＝地図。表・検出画像・精度・お断り・壊れた結果は出さない（件数・比較のカードに「グラフで見る」「地図で見る」は無く、地図の表示の「地図で見る」は残る） ③図の「地図を拡大」「グラフを拡大」・カードのボタンで、その回答の画面（地図・グラフ・写真の比較）が `role="dialog"`・`aria-modal="true"` で開き、「閉じる」・Esc で閉じて、開いたボタン（図の「拡大」を含む）へフォーカスが戻る（詳細の中の Esc は、詳細だけを閉じる） ④回答ごとにタブ・絞り込み・選んだ候補を保ち、**図で変えた絞り込み・選択が拡大ビューに引き継がれ（逆も）**、鍵（回答）を渡す操作が別の回答の状態を壊さない ⑤「新しい会話」で拡大ビューを閉じ、図も回答ごとの状態も捨てる ⑥比較のカードは上位 5 地区までで、5 を超えるとき「全 N 地区中 5 地区を表示」と出る ⑦**地図は、画面に近づくまでマウントしない**（`IntersectionObserver` が無い環境では、すぐマウントする）。一度マウントしたら保つ。図は名前つきの region（`aria-live="off"`）で、記録（`role="log"`）の中にあり、Tab で図の外へ抜けられる ⑧地図・グラフ・写真の比較・回答の条件の既存のテストが、拡大ビューの中で同じ振る舞いで通る | frontend |
| E9 | 会話の履歴（§2.3・§4.3・§4.4・§7.1。**仕様のみ。実装は Go への切り替えのあと。まだ一度も流していない**）。次の 3 つが、すべて合格する（内訳は下の「E9 の内訳」）: ①`scripts/test-contract.sh go` が、構成 `history` の H-系（26 行）と、既存の構成へ足す H-A5〜A7（3 行）に加えて、既存の検査（H-A3 = `contract/test_auth_independence.py`。変更しない）まで、全件合格する。**Python の API には H-系を流さない**: `scripts/test-contract.sh python` では、H-系が deselect され、落ちない ②`api/` の `go vet` と `go test -race -count=1` が、下の「契約にしない」項目（並行・巻き戻し・LLM を呼ぶ前の拒否・ログ・保守コマンドなど）を含めて合格する ③`frontend` の型検査・lint・Vitest が、下の「画面（Vitest）」の項目を含めて合格する | api（Go）・contract・frontend |

**E9 の内訳**（契約の検査 `contract/` に足すもの。**仕様のみ。いまの `contract/` に、これらの検査は無い**。DocuNavi の対応する検査は、`tests/test_threads.py` の関数名で示す）:

**前提:** 契約の検査は、HTTP だけで叩く（アプリのコードを import しない）。履歴は、Python の API には入れない（ADR 0006 の D8）ので、新しい構成 **`history`**（環境は `main` と同じ。合成データ・偽の JWKS）を作り、`scripts/test-contract.sh` の既定の構成の並びには、**対象が `go` のときだけ**入れる。認証の設定が無い・JWKS に届かない・DB が止まる、の検査（H-A5〜A7）は、既存の構成（`noauth`・`badauth`・`jwksdown`・`dbdown`）に足す。

**Python の API に流さない仕組み**〔J7〕: H-系の検査はすべて、機能の印 `@pytest.mark.history` を付ける（構成の印 `variant` とは別）。`contract/conftest.py` は、環境変数 `CONTRACT_FEATURES` に `history` が無いとき、この印の検査を deselect する。`scripts/test-contract.sh` は、対象が `go` のときだけ `CONTRACT_FEATURES=history` を検査のコンテナへ渡す。これが無いと、既存の構成に足す H-A5〜A7 が、履歴の経路を持たない Python の API（404）に流れて落ちる。`contract/conftest.py` の `VARIANTS`・`DATA_VARIANTS` と、`scripts/test-contract.sh` の構成の表（`phase_env`。`history` は `main` と同じ設定）にも `history` を足す。

**検査の数（構成ごとの内訳）:** 下の表は 30 行。`history` に新しく入るのが **26 行**（H-A1・A2・A4、L1〜L8、M1〜M5、D1〜D3、C1〜C7）、既存の構成に足すのが **3 行**（H-A5 は `noauth`・`badauth`、H-A6 は `jwksdown`、H-A7 は `dbdown`。H-A5 は 2 つの構成で流れる）、既存の検査（`main` の `test_auth_independence.py`。変更しない）が 1 行（H-A3）。

**データの準備の追加（利用者の行）**〔J7〕: 偽の JWT の `sub` に対応する `auth_user` の行が要る（外部キー・LLM の前の存在の確認）。検査は互いの状態に依存してはならない（H-L1 の「一覧が空」や、H-L4・H-L5 の件数は、同じ利用者を別の検査が使うと順序で壊れる）ので、**検査ごとに別の利用者を使う**:

- `scripts/test-contract.sh` の、データを読み込む段のあと（`auth_user` の表ができたあと）に、使い捨ての DB へ、**検査用の利用者を十分な人数（案: 200 人）**入れる（`docker exec` で `psql`。`INSERT INTO auth_user (id, name, email, "emailVerified") SELECT … FROM generate_series(1, 200) …`）。`id` は `ct_user_000001` の形（`sub` の規則 `[A-Za-z0-9_-]{8,64}` に合う）。契約の検査自身は DB に触れない。
- 検査の側（`contract/support/fakes.py` と `contract/conftest.py`）に、`fresh_user()`（同じ実行の中で重ならない `sub` を返す。プールを使い切ったら、はっきり失敗する）を足す。`make_token(sub=…)` で別の利用者の JWT を作れる（`fakes.py` の `make_token(**overrides)` が `claims` の項目を上書きする）。**行の無い利用者**（H-A4）は、プールの外の固定の `sub`（例 `ct_nouser_000001`）。
- 後始末はしない（DB は、実行ごとの使い捨て）。**`history` 構成は、使い捨ての DB 専用**（同じ DB に 2 回流すと、利用者が新しくならず、H-L1 などが落ちる）。`contract/README.md` の「データの準備」に、この制約と、手で用意するときの SQL を書く（`contract/README.md` の更新は、実装の段）。

| # | 検査 | 構成 | 確かめること | DocuNavi の対応 |
|---|---|---|---|---|
| H-A1 | 未ログインは 3 経路とも 401 | history | 一覧・発言の取得・削除を、`Authorization` 無し・`Basic`・`Bearer` だけ・でたらめ・期限切れ・`aud` 違いで叩く → 401・`{error:{code:"unauthorized",message:"ログインしてください"}}`・`WWW-Authenticate: Bearer`・`Cache-Control: no-store`。どれも同じ応答。形が違う ID（422 になる ID）でも、ログインが先なので 401 | `test_list_needs_a_token_when_auth_is_required`・`test_messages_need_a_token…`・`test_delete_needs_a_token…` |
| H-A2 | `conversation_id` つきの chat は、未ログインなら 401 で、保存も回答もしない。本文の不正は、ログインより先に 422 | history | `Authorization` 無し・不正・期限切れで `POST /api/chat`＋`conversation_id` → 401。そのあと有効な JWT の利用者で一覧が空のまま（保存されていない）。応答に回答（`message`）が無い。**さらに、未ログインでも、本文が不正（空の発言・最後が assistant・形が違う `conversation_id`）なら 422（本文が先）** | — |
| H-A3 | `conversation_id` なしの chat は、ログインの有無に影響されない | main（既存） | 既存の `test_auth_independence.py` が、そのまま合格する（`Authorization` の有無・不正で応答が同じ）。変更しない | — |
| H-A4 | `auth_user` に行が無い `sub` | history | 行の無い利用者の有効な JWT で、chat＋`conversation_id` → 401（保存は増えない）。一覧は 200・空、発言の取得・削除は 404（行は確かめない）。**LLM を呼ぶ前に確かめること**は、契約からは見えない（模擬モデルは決定的で、呼び出しが数えられない）ので、Go のテストで持つ（偽の LLM の呼び出しが 0 回） | — |
| H-A5 | ログインの設定が無い構成は 503 | noauth・badauth | 3 経路と chat＋`conversation_id` が、JWT の有無・形を見る前に 503 `unavailable`。**3 経路の 503 は `Cache-Control: no-store`**。`conversation_id` なしの chat は 200（従来どおり） | `/api/me` の `test_me_unconfigured.py` に準じる |
| H-A6 | JWKS に届かない構成 | jwksdown | `Authorization` 無し → 401。形は正しいトークン → 503 `unavailable`（鍵を取れないため。3 経路は `no-store`）。`conversation_id` なしの chat は 200 | 同上 |
| H-A7 | DB が止まったとき | dbdown | 有効な JWT で 3 経路と chat＋`conversation_id` → 503 `db_unavailable`（3 経路は `no-store`）。chat は回答が無い。応答に接続先・例外の文字列を含まない | `test_store_failure_is_a_fixed_503` |
| H-L1 | 一覧が空 | history | 新しい利用者の一覧 → 200・`{"conversations":[]}` | `test_list_is_empty_for_a_user_without_threads` |
| H-L2 | 保存と一覧の形 | history | `conversation_id` つきの chat 1 回 → 一覧が 1 件。キーの集合は `{id,title,created_at,updated_at}` だけ。`id` は送った値。時刻は ISO 8601 で読め、`created_at` ≤ `updated_at` | `test_list_returns_only_the_users_own_threads_newest_first` |
| H-L3 | 題名の規則 | history | 短い質問はそのまま。ちょうど 40 文字はそのまま。41 文字は先頭 39 文字＋「…」（コードポイントで数える。日本語で確かめる）。連続する空白・タブ・改行・全角空白（U+3000）・NBSP（U+00A0）は、半角空白 1 つにまとめ、前後は除く。2 回目以降の質問で題名は変わらない。**新しい会話で `messages` に過去の往復があるとき（別のタブで消した会話に続きを送った場合）、題名は最後のユーザー発言で、保存されるのもその往復だけ（発言の取得が 2 件）** | `test_title_is_the_first_user_message_even_after_more_turns`・`test_make_title_collapses_whitespace_and_truncates` |
| H-L4 | 並び | history | 3 件作る → 新しい順。古い会話に続けると先頭に上がる（「同時刻は `id` の昇順」は、HTTP からは固定できないので、Go のテスト側） | `test_list_returns_only_the_users_own_threads_newest_first` |
| H-L5 | 件数の上限と、保存時の整理 | history | 1 人で 51 件作る → 一覧は 50 件で、**最も古い 1 件は消えている**（その会話の発言の取得は 404）。残る 50 件の発言は取れる。古い方の会話に続けて保存すると、その会話は先頭に上がり、代わりに最も古い別の会話が消える（DocuNavi は上限を差し替えて確かめる。契約は HTTP だけなので、実際に 51 件作る） | `test_list_is_capped_to_the_newest_threads` |
| H-L6 | 本人だけが見える | history | A の会話は B の一覧に出ない。B の一覧の応答の全文に、A の質問の文字列が無い | `test_list_returns_only_the_users_own_threads_newest_first` |
| H-L7 | 保存されないもの | history | `conversation_id` なし、または **`conversation_id: null`**（「無し」と読む）の chat（有効な JWT つきでも）は、一覧を増やさない | — |
| H-L8 | 保存は回答を変えない | history | 同じ質問を、`conversation_id` あり・なしで送って、`message` が同じ（模擬モデルは決定的） | — |
| H-M1 | 発言の往復と、見るだけでは更新しない | history | 2 往復 → `messages` が user・assistant・user・assistant の順。ユーザーの発言は `{role,content}` だけ。回答は、その回答を返した chat の `message` と **JSON として等しい**（`content`・`results`・`tool_calls`。キーの順は問わない）。保存したものにも、返答の数字の検査（`contract/support/chat.py`）を流す。**2 つの会話を作り、古い方の発言を取っても、一覧の並びと `updated_at` は変わらない** | `test_messages_returns_the_conversation_in_order` |
| H-M2 | 形が違う ID | history | `a:b`・空白・129 文字・`""` など → 422 `validation_error`（`details[].loc` は配列 `["path","conversation_id"]`／chat の本文は `["body","conversation_id"]`）。入力値は応答に出ない | `test_messages_reject_ids_that_could_carry_a_prefix`・`test_delete_rejects_ids_that_could_carry_a_prefix` |
| H-M3 | 無い ID・他人の ID は同じ 404 | history | 存在しない ID → 404 `not_found`。他人（A の会話を B が）→ 同じ 404 で、本文も文字単位で同じ。B の操作のあと、A の会話は変わらない | `test_messages_of_an_unknown_thread_is_404`・`test_messages_of_another_users_thread_is_404` |
| H-M4 | ヘッダー | history | 3 経路の 200・**204**・401・404・422 の応答がどれも `Cache-Control: no-store`（503 は H-A5・A6・A7）。`POST /api/chat` には付かない（既存のまま） | — |
| H-M5 | 回答を作った run | history | 回答の発言の `run_created_at` が、`GET /api/health` の `run.created_at` と同じ時刻（時刻として比べる。表記は問わない）。ユーザーの発言には、このキーが無い | — |
| H-D1 | 本人の削除 | history | 204・本文なし。一覧から消える。発言の取得は 404。二度目は 404。ほかの会話は残る | `test_user_can_delete_their_own_thread` |
| H-D2 | 他人は消せない | history | B の DELETE → 404（本文は存在しない ID と同じ）。A の会話は残り、A の発言の取得は変わらない | `test_user_cannot_delete_another_users_thread` |
| H-D3 | 本当に消える | history | 消した ID に同じ ID で chat → 新しい会話で、発言の取得が 2 件（古い発言が戻らない） | `test_user_can_delete_their_own_thread`（履歴そのものが消えている） |
| H-C1 | 追記 | history | 同じ ID に 2 往復 → 同じ会話に追記（一覧は 1 件）。順は `seq` どおり | `test_title_is_the_first_user_message_even_after_more_turns` |
| H-C2 | 同じ ID を別の人が使う | history | A と B が同じ `conversation_id` で chat → 別々の会話。互いの発言が見えない。B の送信で A の会話は変わらない | （`conversation_key` の効果） |
| H-C3 | 失敗した往復は保存しない | history | 最後が assistant の `messages`（422）・空の発言（422）・**空白だけの発言（U+001F だけ・`　\n\t`。Python の `strip()` と同じ集合で空と判定する）**に `conversation_id` → 保存されない（一覧・発言の数が変わらない） | — |
| H-C4 | 質問の上限 | history | 2000 文字は保存でき、発言の取得で同じ文字列。2001 文字は 422（既存）で保存されない | — |
| H-C5 | 1 会話の発言数の上限（500 件） | history | 250 往復で 500 件に達した会話に続けると 422 `conversation_full`。回答は無く、保存は増えない。別の会話は影響を受けない（模擬モデルで 250 往復。実行は数秒の見込みで、実測はしていない） | — |
| H-C6 | 結果の往復 | history | 件数・表・比較・地図・検出画像・精度・断りの結果を含む回答を保存し、発言の取得で値が一致（数値・配列の順・入れ子） | （出典が付く回答の検査: `test_thread_messages_endpoint_returns_sources_only_where_present`） |
| H-C7 | NUL を含む発言 | history | `conversation_id` つきで、`messages` のどれかの `content` に NUL → 422 `validation_error`（`details[].loc` は `["body","messages","<番号>","content"]`）。保存されない。同じ本文を `conversation_id` なしで送ると 200（従来どおり） | — |

**既存の検査へ足すもの（`main`。契約の追加）:** `contract/test_chat_behavior.py` の「空の発言」の例（`"   "`・`"　\n\t"`）に、U+001C〜U+001F だけの発言を足す（Python の `strip()` はこれらを空白と見て 422 にする。Go の `unicode.IsSpace` だけでは通ってしまう。§4.4 の空白の集合）。

**契約にしない（Go のテスト `go test -race`・保守コマンドのテストに持つ）:**

- 同じ会話への同時の書き込みで `seq` が重複・欠落しない（行のロックと、同じ人の鍵）。`updated_at` が逆戻りしない。**同時の `DELETE` が入っても、保存が 401 に取り違えられない**（`ON CONFLICT DO UPDATE`。`conversations_user_fk` 以外の 23503 は 500）。同じ人の同時の保存で、1 人 50 件の整理がデッドロックしない。
- 一覧の「同時刻は `id` の昇順」（HTTP からは、同時刻を作れない）。
- 題名の作り方の単体（空白の扱い: Go の正規表現 `\s` は ASCII だけなので使わず、`unicode.IsSpace` に U+001C〜U+001F を足した関数で畳む。U+001F の畳み込み・題名が空になったときの「（題名なし）」。コードポイントで数える）。
- 保存のトランザクションの巻き戻し（上限の超過・外部キー違反）。**LLM を呼ぶ前に** `auth_user` の存在・NUL・発言数を断ること（偽の LLM の呼び出しが 0 回）。保存の失敗の分類（接続系は 503・それ以外は 500・`conversations_user_fk` の 23503 だけ 401）。
- ログに、質問の本文・題名・`results`・生の利用者 ID・会話 ID が出ない（ログを捕まえて確かめる。**`AccessLog` がテンプレートで記録する**こと、どのルートにも合わない要求は `?` になること）。
- 保守コマンド: 既定は削除しない・`--apply` で消す・境界（ちょうど N 日）・`--older-than-days 0` を断る・件数だけ表示。

**画面（Vitest。`frontend` のテスト）**: 一覧の 6 つの状態・2 段階の削除・生成中の無効化・開き直し（取得中・失敗・404 の文）・**開き直した会話で、拡大ビューが開かない・画面が替わらない（読み上げ・スクロール・フォーカスの移動が無い）こと**・解析結果が違う回答の扱い（**`run_id` が同じで `run_created_at` が違う場合**・health が取れない場合・`refusal` だけの回答）・トークンの取り直し（60 秒前・401 で 1 回）・期限切れのときの保存なしの送り直し（**以降の送信に `conversation_id` を付けない**・注記は 1 回）・`conversation_full` で「もう一度送る」を出さない・**未ログインでは履歴の API も `/api/auth/token` も呼ばない**・`sessionStorage` の扱い（未ログインで消す・新しい会話で消す・最初の回答が届いてから書く）。DocuNavi の `Threads.test.tsx` の観点に合わせる。

確認できていないことは「確認済み」と書かない。実データでの精度は、12 地区・初期値の閾値という限定つきの数字である。
