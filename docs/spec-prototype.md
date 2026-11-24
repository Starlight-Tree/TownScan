# たたき台の仕様（ローカルで動き、UI で操作できる縦切り）

状態: 2026-11-24 起草（ユーザー依頼「アプリをローカル環境で動かして UI で操作できるたたき台になるところまで」）。**この文書が契約**。実装はここに従い、変えるときは先にここを直す。
改訂 2026-11-25: §4.2（`reason` から `small` を外す）と §6（縁の除外を左右対称に・追加の診断・参照の時期の注記）を、実装と監査の指摘に合わせて直した。
改訂 2026-11-25（2）: **任意のログイン**（Google だけ。ユーザー依頼「サイドバーも統一感を出して。そこのメニューも同様に」「プロフィールアイコンとかアカウントのロジックも同じにしておいて」。JobNavi・DocuNavi にそろえる）を足した。§2.1（認証）・§4.4（`GET /api/me`）・§7（サイドバー・アカウントのメニュー・`/login`）。既存の機能（チャット・地図・詳細・精度・このアプリについて）の契約は変えない。
改訂 2026-11-25（3）: 独立検証の指摘に合わせ、§2.1・§4.4（形が不正な `AUTH_ISSUER`・`AUTH_JWKS_URL` は起動を止めず、警告を出して検証を無効にする。JWT の `email_verified`。`email`・`name`・`picture` の整形の規則）と §7（ログインしていないときの印は「≡」）を、実装に合わせて直した。
改訂 2026-11-25（4）: `/` の画面（§7）を、右に「結果領域」（地図・グラフ・写真の比較のタブ）を置く設計に書き換えた（旧: 右に地図、候補の詳細は重なって開くドロワー）。回答の型から画面への自動の切り替え、手で選んだタブを保つこと、回答の条件（地区が 1 つ・複数・全地区、分類）を地図・グラフ・集計の帯へ同じに反映し、候補の一覧へは、地区が 1 つのときだけ地区で絞って反映すること（API が地区を 1 つしか受けないため。複数の地区のときは、一覧の本体を出さず、案内を出す）、印を押したときは地図に留まり「写真を比べる」で切り替わること、回答カードのボタンでその回答の条件を復元すること、「拡大」、縦に積む幅のスクロールを定めた。§4.5 は、backend がすでに返している `filter` の形（`area_ids`・`scope`、表と比較にも付く）に合わせて直した。API の振る舞いは変えない。
改訂 2026-11-25（5）: **任意の実 LLM（Gemini）**を足した（ユーザー承認 2026-11-25「いいよ　さっさとつないで試してよ」→ Gemini の無料キー）。§1・§2.2（環境変数。新設）・§3・§4.4（`/api/health` の `llm`・`llm_model`、`POST /api/chat` の 502）・§4.5（Gemini を選んだときの役割・安全・失敗）を、実装に合わせて直した。既定は模擬のまま。決定の理由・データの扱いは [ADR 0003](decisions/0003-llm-provider.md)。**実 API での動作は未確認**（キーが入ったあとに確かめる）。
改訂 2026-11-25（6）: `/` の画面（§7）を、実装に合わせて直した。分類の凡例を地図の上から外して集計の帯のチェックボックスへ移し、地図についての通知を地図の下の 1 行の帯へ移した。選択中の候補は、地図に重なるカード（地図の大きさは変わらない）にし、読み上げを足した。「拡大」の列幅を 340px から 280px にした。チャットは、開いた直後に説明の見出しから読み始められるようにした。詳細（写真の比較）は、「写真の比較」が見えるまでマウントも通信もしない。詳細を閉じたあとのフォーカスが body に落ちないようにした。回答の「対象・条件」は、右の絞り込みと同じ「最後の `count` か `compare`」から作る。API の振る舞いは変えない。**実画面（ブラウザー）では未確認**（コードと jsdom のテストで確かめた。幅の見積もりは CSS からの計算）。
位置づけ: [plan.md](plan.md) の P2（建物抽出と評価）・P3（差分・API・DB）・P4（チャット）を、薄く一通り通す。GEE 層（P5）・パネル（P6）・公開（P7）は対象外。

## 1. 何ができれば「たたき台」か

1. 熊本の 12 地区（z18 タイル 12 枚。2018・2023 年の写真が両方ある）で、事前学習モデルの建物抽出 → 2 時点の差分 → 「新規出現候補」3 分類が、**実データで**出る（Colab の T4 で推論）。
2. `docker compose up` で db・api・web が立ち上がり、ブラウザ（`http://127.0.0.1:3500`）で、チャットで質問でき、地図に候補が出て、1 棟ずつ 2018 / 2023 の写真を見比べられる。
3. 「このアプリの精度」の画面に、**実測した数字**（基盤地図情報 2018-10 版を参照にした建物抽出の指標）が出る。新築の再現率は手ラベルが無いので「未測定」と明示する。
4. 数字・件数・座標は、ツールの結果だけから出る（LLM に書かせない。模擬モデルが既定で、任意で Gemini を選べる。LLM の役割はツールの選択と説明文だけ。§2.2・§4.5）。範囲外は断る。
5. 合成データ（テスト用）と実データを取り違えない（§4 の `run.kind`、UI のバナー）。

対象外（やらない・やったと書かない）: GEE 層、パネル、確認モード（人の確定）、認証（ただし、**任意のログインだけ** §2.1 に足した。機能の制限・権限の分けには使わない）、公開、地区の行政区画の厳密な境界、PostGIS。実 LLM は、**任意で選べる Gemini だけ**を §2.2・§4.5 に足した（既定は模擬。ほかの LLM は対象外）。

## 2. 構成

```
host ブラウザ ──> web (Next.js, 127.0.0.1:3500) ──/api/* を転送──> api (FastAPI, 127.0.0.1:8500) ──> db (Postgres 17, 公開しない)
                                                                  └─ ./data/townscan を読み取り専用でマウント（写真タイル）
```

- 起動はホストの Docker Compose（`compose.yaml`）。ポートは `127.0.0.1` だけに公開（既存の jobnavi 3200/8200・shoporder 3400/8400・docunavi 5433 と重ねない）。db は公開しない。
- Docker VM は 8 GB で、他プロジェクトが約 5.3 GB を使っている。**本番ビルド（`next build` + standalone 実行）**にし、compose の `mem_limit` を db 256m・api 512m・web 512m とする。実測の使用量を報告する。
- **メモリーの制約（2026-11-24 夜に実測）:** Docker VM の空きは約 0.5 GB（`free -m` の available 519 MB。jobnavi-frontend 1.9 GB・shoporder-frontend 3.3 GB が常駐）。ここで `next build`・`tsc`・`vitest` のような重い処理を流すと、OOM キラーが他プロジェクトのコンテナを落とす恐れがある。**他プロジェクトのコンテナは止めない・触らない。** よって **frontend の重い処理（`npm ci`・型検査・テスト・`next build`）はホストの Node 24 で行う**（理由: VM の空きメモリー。ホストの RAM は 17 GB。Node 24 は `npx -y -p node@24 -- <コマンド>` で得られる。実測で node v24.22.3）。Python の処理（pipeline・backend の単体テスト）は軽いので開発コンテナで行う。
- web のイメージは 2 つの target を持つ: `runtime`（イメージの中で `npm ci` と `next build` まで行う。メモリーに余裕のある環境・CI 用）と `prebuilt`（ホストで作った `.next/standalone` を載せるだけ。この VM ではこちらを使う）。`scripts/dev-up.sh` は `WEB_BUILD=host`（既定）／`docker` で選ぶ。
- コード・テストの実行は、可能なものは開発コンテナ（`devcontainer exec --workspace-folder /Users/Home/Projects/TownScan bash -lc '…'`、venv は `~/.venvs/townscan`）で行う。compose・DB を使うものはホストの Docker。
- 秘密: DB のパスワードは `scripts/dev-up.sh` が初回に乱数で `.env`（gitignore 済み）へ書く。ログイン（§2.1）を足したあとは、`BETTER_AUTH_SECRET`（同じく dev-up.sh が、無いときだけ 1 回足す）と、`GOOGLE_CLIENT_ID`・`GOOGLE_CLIENT_SECRET`（利用者が自分で `.env` に書く。無くても動く）が加わる。それ以外の秘密は無い。`.env` は読まない・表示しない。
- ログイン（任意）を足したあとの経路: web（Next.js）の中で Better Auth が動き、`/api/auth/*` は web 自身が受ける（`/api/*` の転送より先。api へは行かない）。web は db（`backend-net`）に届き、`auth_` の表だけを読み書きする。api は、web の JWKS（`http://web:3000/api/auth/jwks`）を取りに行って JWT を検証するだけ。ポート・公開範囲（127.0.0.1 のみ・db は非公開）は変えない。

### 2.1 認証（任意のログイン）

位置づけ: **ログインは任意**。チャット・地図・詳細・精度・このアプリについては、ログインなしで今まどおり使える。ログインすると、サイドバーの下のアカウントに、プロフィール画像（または人型アイコン）・メール・ログアウトが出る（§7）。**それ以外の機能の制限は足さない**（ログインの有無で、API の応答・件数・機能を変えない）。

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

- **DB**: Better Auth の表は `auth_` 付きの 5 つ（`auth_user`・`auth_session`・`auth_account`・`auth_verification`・`auth_jwks`）。列名・型・外部キーは、JobNavi の `backend/app/migrations/0004_better_auth.sql`（Better Auth 1.7.18 が決めた camelCase の列名。引用符つき）の 5 つの表と同じ。`users` への列追加は TownScan には無い（アプリ側にプロフィールの表を持たない）。`auth_user.lastName`・`firstName` は JobNavi のプロフィール用の追加列で、TownScan のコードは読み書きしない（あっても無くてもよい。NULL 可）。置き場は `backend/db/auth.sql`（冪等: `CREATE TABLE IF NOT EXISTS`・`CREATE INDEX IF NOT EXISTS`。`DROP`・`TRUNCATE` は書かない）。すでにあるボリュームにも入る形で適用する（適用の方法は、`schema.sql` の適用の仕組みに合わせる。実装の側が決め、そこに書く）。`auth_` の表を読み書きするのは web だけで、api は読まない（JWT を検証して `sub`・`email`・`name`・`picture` を使うだけ）。
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
| POST `/api/chat` | 入力 `{messages:[{role,content}]}`、出力 `{message:{role:"assistant", content, results:ToolResult[], tool_calls:[{name,args}]}}` |
| GET `/api/me` | 任意のログイン（§2.1）の受け口。`Authorization: Bearer <JWT>` を検証し、`{sub, email, name, picture}` を返す |

エラーは `{error:{code,message}}` と適切な HTTP ステータス。存在しない id は 404、不正な引数は 422。`POST /api/chat` で実 LLM（§2.2）が使えないときは **502** `{error:{code:"llm_unavailable", message:"いまは LLM が応答できません。少し待ってからもう一度お試しください"}}`（模擬には切り替えない。§4.5）。

`GET /api/me`（§2.1 の JWT。ほかの入口は `Authorization` を見ない・ログインを要さない。**いまの機能は、ログインなしで今まどおり使える**）:

- 成功 200: `{sub, email, name, picture}`。`sub` は JWT の `sub`（必須）。`email`・`name`・`picture` は、JWT に無い・空・文字列でない・下の整形の規則に合わないときは `null`。応答に `Cache-Control: no-store`。
  - 整形の規則（実装は `backend/app/jwt_auth.py` の `_identity`。`email`・`picture` は前後の空白を除いてから見る）: `picture` は、claim `picture`（無ければ `image`）が `https://` で始まる 2048 文字までのときだけ（それ以外は `null`）。`email` は、`@` を含む 254 文字までのときだけ（含まない・254 文字を超えるときは `null`）。`name` は、印字できない文字（制御文字のほか、全角空白・ゼロ幅の文字も）を除いて、100 文字までに切る（空になれば `null`）。JWT の `email_verified` は読まない。JWT の中身・`Authorization` の値は、ログにも応答にも出さない（ログに残すのは失敗の種類だけ）。
- **401** `{error:{code:"unauthorized", message}}`（固定の文。理由は返さない。`WWW-Authenticate: Bearer` を付ける）: `Authorization` が無い・`Bearer` でない・JWT が壊れている・署名が合わない・`alg` が ES256 でない・`aud`／`iss`／`exp`／`sub` が合わない（期限切れを含む）。
- **503** `{error:{code:"unavailable", message}}`: `AUTH_ISSUER`・`AUTH_JWKS_URL` のどちらかが無い、または URL の形が不正（ログインの設定が無い扱い。起動は止まらない。§2.1。JWT の有無を見る前に返す）、または JWKS を取りに行けず前に取れた鍵も無い。ほかの入口には影響しない。
- 使うのはアカウントのロジック（ログインの確認・JWT と JWKS の疎通の確かめ）だけ。チャット・地図・詳細・精度などの入口は、これを呼ばず、これに依存しない。

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
  - **幅 1024px 以上: 左のサイドパネル。** 開いた表示（上にロゴと名前・閉じるボタン、続いて行き先（アイコン＋名前）、下にアカウント（アバター＋名前））と、アイコンだけの**細い帯**を、ボタンで切り替える。はじめは開いた状態で、保存はしない。細い帯では、ロゴの位置が「サイドパネルを開く」ボタンになり（ホバー・フォーカスでロゴが開閉の絵に変わる）、帯の空き部分をクリックしても開く。名前は、ホバーとキーボードのフォーカスで、アイコンの右に出る。開閉したら、フォーカスを、いま押せる側のボタンへ移す。開いているページの項目に `aria-current="page"` を付ける。
  - **幅 1023px 以下: 上の横の帯**（ブランド・行き先・状態の表示「模擬モデルで応答しています」・テーマ・アカウント）。開閉のボタンは出さず、名前を文字で見せる。
  - 行き先は、既存の 3 ページ（`/`・`/accuracy`・`/about`。名前は今の AppHeader のとおり）。合成データのバナーと API 不通のバナーは、どちらの幅でも本文の上に出す（内容・文言は変えない）。
- **アカウントのメニュー**（サイドバー下のアバターのボタン。1023px 以下は上の帯の右端）: 押すとメニューが開く（細い帯では右へ、開いたパネルでは上へ）。パネルを開いているときは、ボタンにアバターと名前が並ぶ。
  - ログイン中: メールアドレス（先頭）・テーマ（ライト / ダーク / システム。選ぶと localStorage に保存し、以後は OS より優先する。「システム」で OS に従う状態へ戻す）・ログアウト。アバターは**プロフィール画像**（Google の `image`。`https://` のときだけ表示し、無い・読めないときは人型アイコン）。ログアウトはサーバーアクションでセッションを消し、`/` へ戻る。
  - ログインしていない: 「≡」（メニューの印。JobNavi と同じ。人型アイコンはログイン中の画像が無いときだけ）、テーマ、ログイン（`/login`）の入口。
  - 開いたら先頭の項目にフォーカスを置く。↑↓ で移動、Esc で閉じてボタンへ戻る、メニューの外を押しても閉じる。
- `/login`: **ログインは Google だけ**（見出し・1 行の案内・「Google でログイン」ボタン。はじめての人は、ログインするとそのまま登録される）。ログイン済みなら `/` へ。失敗は固定の文で出す（理由・秘密を含めない）。設定が足りないときは「まだ設定されていません」（§2.1）。**ログインは任意**: しなくても、全ページ・全機能を今まどおり使える。
- `/`: 左にチャット、右に**結果領域**（地図・グラフ・写真の比較）。チャットは結果カードを §4.5 の型ごとに描く（`switch` を網羅的にし、`never` で漏れを検出）。サジェストのチップ。送信中・エラーの状態。「模擬モデルで応答しています」の表示（`/api/health` の `llm`）。`run.kind = synthetic` のとき、目立つバナー「合成データ（テスト用）」。
  - **チャットの最初の位置**（`frontend/components/chat/ChatPanel.tsx`）: 開いた直後（発言が 1 件も無い）は、チャットの一覧を一番上のままにして、説明の見出し「熊本の街の変化を、写真と会話で調べる」から読み始められるようにする。発言の追加・送信中・失敗の変化のあと（発言が 1 件以上）だけ、いちばん下へ動かす。「新しい会話」で発言が 0 件に戻ったときは、一番上へ戻す。
  - **結果領域のタブ**（`frontend/components/ResultArea.tsx`）: 「地図」「グラフ」「写真の比較」。WAI-ARIA の tabs で、選ぶと同時に切り替わる。選んでいるタブだけが Tab キーの順に入り、タブの間は ←・→・Home・End で動く（Alt・Ctrl・Cmd・Shift が付いた組み合わせは、ブラウザー・OS の操作なので処理しない）。3 つの画面は、どれも外さず、選んでいない画面は隠すだけにする（地図の位置・拡大を保つため）。
  - **回答に合わせた自動の切り替え**（`frontend/lib/result-view.ts` の `viewForResults`）: 回答の道具の結果が、`count`・`compare` ならグラフ、`map_focus` なら地図、`detection_image` なら写真の比較へ。`table`・`accuracy`・`refusal` は切り替えない。1 つの回答に当たる型が複数あれば、あとのものを採る。**画面を自動で切り替えるのは、チャットの回答が来たときだけ**。
  - **手で選んだタブは保つ**: 利用者が選んだタブは、次の回答・結果カードのボタン・詳細の操作が来るまで、そのまま。
  - **自動で切り替えたときの知らせ**: 画面に見えない live region（`role="status"`・`aria-live="polite"`）で、「「グラフ」を表示しました」のように読み上げる。利用者自身のタブ操作と、同じ画面への切り替えでは読まない。フォーカスは動かさない（ただし、見ていた画面の中にフォーカスがあるまま、その画面が隠れるときだけ、選ばれたタブへ移す。フォーカスが消えないように）。
  - **回答の条件**（`frontend/lib/result-view.ts` の `MapFilter`・`filterFromResults`）: 回答の `count`・`compare` が持つ `filter`（§4.5）を、地図・グラフ・集計の帯へ、**同じ条件で**反映する。候補の一覧へは、下記のとおり（地区は 1 つのときだけ）。
    - 地区: `area_id`（1 つ）ならその地区、`area_ids`（2 つ以上）ならそれらの地区、どちらも無ければ全地区。複数のときの表示名は、API の `scope`（例「中央区」）をそのまま出し、`scope` が無ければ「N 地区」と数だけ言う（件数・座標・面積と同じく、LLM の文章や推測で作らない）。複数のとき、地図はそれらの地区の候補だけを描き、地区の選択ボックスの先頭に「{scope}（複数の地区）」を出し、集計の帯（分類ごとの件数）はそれらの地区の和にし、グラフはそれらの地区の行だけを出す。
    - 分類: `count` の `cls` があればその 1 分類だけ、無ければ 3 分類すべて。知らない文字列の分類は、条件が無いものとして扱う（存在しない分類で地図が空にならない）。`compare` の `cls` は並べ替えの分類で、比較のカードは 3 分類と合計を出すので、分類の条件にはせず、3 分類すべてにする。
    - 1 つの回答に条件を持つ結果が複数あれば、最後のもの。1 つも無ければ、いまの絞り込みのまま。条件が空（全地区・全分類）なら「すべて」に戻す。
    - 回答カードの「対象・条件」の行（`frontend/components/chat/AnswerScope.tsx`）の地区・分類も、同じ「最後の `count` か `compare`」から作る（右の絞り込みと食い違わない。先に `count`、あとに `compare` なら、`compare` の条件）。最後が `count` のときは地区と分類の 2 行、最後が `compare` のときは地区の行だけで、分類の行は出さない（比較のカードは 3 分類と合計を並べ、`filter.cls` は並べ替えの分類にすぎないため）。ほかに、比べる地区の名前と、写真の年の行を、結果の値からだけ作る（LLM の文章や推測は使わない）。
    - 利用者が地図・グラフで地区・分類を選ぶと、同じ絞り込みを書き換える（地区を 1 つ選ぶと、複数地区の条件は外れる）。集計の帯の「条件を解除」で、すべてに戻す。
    - 候補の一覧は、API が地区も分類も 1 つしか受けない（契約は変えない）。地区は、対象が 1 つの地区のときだけ、その地区で絞る。複数の地区のときは、一覧の本体を出さず、「地区を 1 つに絞ると、一覧が出ます。」と言う。分類は、1 つだけ表示しているときはその分類で絞り、2 分類以上を表示しているときは 3 分類すべてを出す（この旨を、一覧の見出しの直後に書く）。
  - **回答カードのボタン**（件数・比較の「グラフで見る」と、件数の「地図で見る」）: その回答の条件（上の規則で、その回答の結果から決めたもの）を右に復元してから、画面を切り替える。古い回答のカードを押しても、いまの絞り込みではなく、その回答の条件で開く。
  - **印・形を押したとき**: 地図に留まる（画面を替えない）。その候補を強調し、**選択中の候補のカード**を地図の中に重ねて出す（「選択中の候補」・分類のバッジ・候補 ID・「写真を比べる」ボタン。`frontend/components/map/MapPanel.tsx`）。カードは地図の枠（`.map-stage`）の中の下端の中央寄せ（下から 30px。幅は 520px まで）で、地図の大きさは変わらないので、押した印は動かない。DOM では地図の本体より後ろに置く。`onComparePhotos` が無いとき、または選んだ ID が地図の候補データに無いときは、カードを出さない。カードを避けて地図を動かす処理は無い（地図の下端に近い印は、カードの下に隠れることがある。実画面では未確認）。押したときだけ、「写真の比較」へ切り替える。
    - 読み上げ: 見えない live region（`aria-live="polite"`・`aria-atomic="true"`。`role="status"` は、タイルの通知に譲る）を常に描き、選ぶと「候補 {id} を選びました。「写真を比べる」で写真を比べられます。」を出す。選択が外れる・カードを出さないときは空にする。
    - 候補の一覧・チャットの表の詳細から開く操作は、「開く」操作なので、写真の比較へ切り替えて、地図もその候補へ寄せる。寄せるときの余白は四方 32px（詳細は地図に重ならないので、右端をあけない）。
  - **写真の比較**（`frontend/components/CandidateDrawer.tsx`。旧: 重なって開くドロワー）: 候補を選んでいないときは、選び方の案内を出す（この枠はフォーカスを受ける。フォーカスの輪は、親の `overflow` に切られないよう、枠の内側に描く）。選んでいるときは、その候補の詳細を、このタブの中に埋め込んで出す（地図に重ならない）。内容は、2018・2023 の切り出し画像を並べる（`/api/candidates/{id}/image`）、分類のバッジと平易な説明、根拠の数字（`evidence`）、位置、データの出どころ、「地図で見る」（地図のタブへ切り替えて、その候補へ寄せる）、「閉じる」（選択を外す。Esc でも閉じる）。回答が検出画像のときは、その候補を選んで出す。チャットの回答から自動で出すときは、見出しへフォーカスを移さない（入力欄のフォーカスを奪わない）。
    - **詳細は、「写真の比較」が一度見えるまでマウントしない**（`frontend/components/HomeClient.tsx` の `PhotosPanel`）: 地図の印を選んだだけでは、`GET /api/candidates/{id}` を呼ばない（印を続けて押しても 0 回）。「写真を比べる」を押す・「写真の比較」のタブを選ぶ・チャットの「詳細」や検出画像の回答から開く、のどれかで写真の比較が見えたときに、初めてマウントして 1 回取る。一度見えた詳細は、別のタブへ替えても保ち、戻しても取り直さない。選んだ候補が替わったら、前の詳細は外し、新しい候補は、また見えるまでマウントしない。見えたときにマウントするので、見出しへフォーカスを移すかどうかも、そのときの選び方で決まる（「写真を比べる」とチャットの「詳細」は移す。タブ操作と検出画像の自動の選択は、フォーカスを奪わない）。
    - **閉じたあとのフォーカス**: 「閉じる」・Esc で閉じる直前に、フォーカスが詳細の中にあれば、先に「写真の比較」のタブへ移す（詳細が外れると、フォーカスのあった要素ごと消え、フォーカスが body に落ちるため）。チャットの「詳細」から開いた詳細は、これまでどおり、押したボタンへ戻る（こちらが後に働くので優先）。閉じる直前にフォーカスが詳細の外（チャットの入力など）にあるときは、動かさない。
  - **拡大**: タブの帯の右端の「拡大」ボタン（`aria-pressed`。タブの列の外）。押すと、チャットの列を 280px に狭め（通常は `minmax(340px, 440px)`。通常の 440px からは 160px 広がる）、残りを結果領域へ回す（チャットのメッセージ一覧はスクロールのまま、入力欄も残る）。狭くなった列では、質問の例の列を 1 行いっぱいに広げ、「新しい会話」を次の行へ回す。もう一度押すと戻る。保存しない（開き直すと元の大きさ）。押してもフォーカスは動かさない。広げた状態は、回答の到着・タブ操作・回答カードの「グラフで見る」「地図で見る」・地図の表示・詳細の開閉のあとも保ち、戻るのは「拡大」を押し直したときだけ。広げているとき、ボタンは `aria-pressed="true"`・内向きの矢印・太い枠に加え、「（元の大きさに戻す）」の文（見た目の補足。`aria-hidden`）を出す。読み上げの名前は「拡大」のまま、`title` は「元の大きさに戻します」（広げていないときは「チャットの列を狭めて、結果領域を広げます」）。横に並ぶ幅だけで、縦に積む幅（次）では、ボタンを出さない（広げた状態が残っていても、縦に積むときのチャットは全幅で、質問の例の折り返しも効かない）。窓が 1257px 以上のときは、拡大すると、写真の比較の中身の最大幅も、880px から `clamp(1040px, 70vw, 1440px)`（窓の幅の 70%。最小 1040px、最大 1440px）に広げる。
  - **幅**: 1000px 以上は、チャットと結果領域を左右に並べる。1000px 未満は縦に積む（チャット → 結果領域）。左右に並べるかどうかは、窓の幅で決まる（本文の幅ではない）。サイドパネルを開いている間は、本文が窓より 16rem 狭いので、窓が 1024〜1256px のときも縦に積む。縦に戻すのは、サイドパネルを開いているときだけで、細い帯のときは戻さない（窓が 1024〜1056px で、本文が 1000px に満たなくても、左右に並ぶ）。縦に積む幅では、結果領域がチャットの下にあり、画面が替わっても見えないので、画面を替える操作のたび（回答での自動の切り替え・回答カードのボタン・チャットの表の「詳細」・詳細の「地図で見る」・地図の「写真を比べる」。画面が同じままでも）に、結果領域の上端が見える所までスクロールする。利用者自身のタブ操作では動かさない。上端が画面の外（上にはみ出す、または画面の高さの 6 割より下）のときだけ動かし、`prefers-reduced-motion` のときは滑らかに動かさない（すぐ移る）。フォーカスは動かさない。横に並ぶ幅（結果領域が最初から見えている）では、何も起きない。
- 地図（結果領域の「地図」）: 地理院タイルを直接読む（標準地図・2018 年の写真 `nendophoto2018`・2023 年の写真 `nendophoto2023`。帯の外・範囲外のタイルが 404 でも崩れない。出典の表示）。解析した 12 地区の枠を描く。候補のポリゴンを 3 分類の色（色だけに頼らず、形・線種・分類の印でも区別）で描く。パネルは縦の flex で、地図（`.map-stage`）が、上下の帯の残りの高さをすべて取る（最小 320px）。帯は縮めず、中身が収まらないときだけ、パネルがスクロールする。上から、次の順に並べる。帯（ツールバー・集計の帯・現在表示の帯）は、幅が足りなければ折り返す（はみ出さない）。
  - **ツールバー**: 地図の種類・地区の選択・「解析した地区の枠」を、1 行に並べる（狭い幅では折り返す）。ボタン・選択・チェックは 36px。
  - **集計の帯**（`frontend/components/map/SummaryStrip.tsx`）: 「対象」・分類ごとの件数・（条件があれば）「条件を解除」。数字は `/api/areas` の件数を足したもので、地区の条件だけを反映する。**分類ごとの件数は、そのまま表示の切り替えのチェックボックス**（`role="group"`「表示する分類（色・線・形で区別）」）で、分類の印（色・線・形）・短い名前・件数を 1 つのラベルにまとめる。**地図に重ねる凡例は無い**（同じ内容を 2 か所に出さない）。押すと `filter.classes` だけを替え、地区（`areaId`）と複数の地区（`areaIds`・`scope`）の条件は保つ。選んでいる分類は、色だけでなく、チェック・太い枠・地色で見分ける。外した分類は「（非表示）」。分類の一部だけを表示しているときは、「全 m 件のうち、表示中 n 件」と「条件を解除」を出す。読み上げの名前は、分類の全文と件数（例「新規出現（旧写真に無い）、9 件」）。
  - **地図**: 地図の上に重ねるのは、候補の読み込み中（`role="status"`）と、読み込みの失敗（`role="alert"`。再試行つき）の、小さい通知 1 つだけ。候補と地区の一覧が両方失敗したときは 1 つにまとめ、再試行は両方を取り直す。下端に、選択中の候補のカード（上の「印・形を押したとき」）。
  - **現在表示の帯**（`.map-status`。1 行。長いときは折り返す）: 現在の表示・「強調表示を解除」・案内「印・形を選ぶと「写真を比べる」が出ます。」・地図についての通知（写真が無い範囲のタイルの通知は `role="status"`。「候補は印で表示しています。拡大すると建物の形が見えます。」。候補が 0 件のときの文）。**通知は、地図に重ねず、この帯に出す**。
  - **「候補を一覧で見る（面積の大きい順）」**（既定は閉じている）: 一覧の項目のフォーカスの輪が切れないよう、スクロールする枠に 6px の余白を取る（負の余白で位置は保つ）。
- グラフ（結果領域の「グラフ」。`frontend/components/chart/AreaChartView.tsx`）: 地区ごとの件数を、3 分類の積み上げ横棒で出す（棒は HTML と CSS だけ。色・縁の線・模様で分類を区別）。合計の多い順。行を押すとその地区だけに絞り込み（もう一度押すと全地区へ）、凡例のボタンで分類を切り替える。どちらも、地図と共通の絞り込み。「表で見る」で、同じ数字を表でも読める。
- `/accuracy`: `/api/metrics` の数字。調整用／評価用の区別、「新築の再現率: 未測定」、閾値は未検証の初期値であることを書く。
  - 見出しの数字（物体単位 F1・画素 IoU）には、**どの年の写真で測った値か**を明記する（`protocol.year`。無ければ 2018）。「再現率」は、「建物の抽出の再現率（基盤地図情報に対する値）」と「新築の再現率（未測定）」を、必ず修飾して書き分ける。
  - `year_compare` があれば、もう一方の年の写真での値と、年で比べる表を出す。無い・形が違うときは、その部分を出さず、画面は落ちない。
  - 限界欄に、`existing_absent_in_2018` から描く「2018 年の写真での見落とし」（既存の建物のうち、2018 年の抽出が何も見ていない割合。手ラベルの代わりにならない）、参照が写真より古い可能性（推定）と物体単位の適合率が合成値であること、年ごとの再現率の違い（数字だけ。原因は書かない）を載せる。数字はデータから描き、手書きにしない。
  - 評価の内部のキー名（`pixel_iou` など）は、日本語の見出しにする。
- `/about`: 使い方（いまの画面に合わせる: 左のチャット、右の結果領域とそのタブ・自動の切り替え、回答のボタン、「写真を比べる」、「拡大」）・3 分類の意味・限界（写真が無い期間・2018 年は帯状の範囲だけ・タイルの縁・誤検出の可能性）・出典と規約（地理院タイル、基盤地図情報、モデル `giswqs/whu-building-unetplusplus-efficientnet-b4`＝Apache-2.0・学習データ WHU の利用条件は不明）。「変化の当たり（衛星）」は未実装と書く。
- ブラウザから API へは、同じオリジンの `/api/*`（Next の rewrites。転送先は実行時の環境変数 `API_URL`）。ただし `/api/auth/*`（ログイン・JWKS）は web 自身の Route Handler が受け、api へは転送しない（§2.1）。
- ログインの依存: `better-auth` 1.7.18 と `pg`（版を固定し、ロックファイルに含める）。ほかの新しいサービス・言語・DB は足さない。
- 技術: Next.js（最新の安定版を、版を固定して）、React、TypeScript strict、Node 24、`output: "standalone"`。地図は Leaflet か MapLibre GL JS（版を固定。選んだ理由を 1 行）。`npm ci` で入れる（ロックファイルをコミット対象に含める）。

## 8. 出口条件（実行して確かめる）

| # | 検査 | 担当 |
|---|---|---|
| E1 | `scripts/verify.sh repo` が合格 | 統合 |
| E2 | `pipeline` の単体テストが合格（タイル計算・ベクトル化・基盤地図情報の読み込み・評価指標・3 分類を、合成データで） | pipeline |
| E3 | `backend` のテストが合格（DB を使うもの、`guard_numbers`、範囲外の拒否、画像の切り出し、ローダーの冪等性） | backend |
| E4 | `frontend` の型検査・lint・テスト・`next build` が合格 | frontend |
| E5 | `scripts/dev-up.sh` で 3 つが起動し、`/api/health`・web の `/`・web 経由の `/api/candidates` が応答。3 つの使用メモリを実測して記録 | backend + 統合 |
| E6 | 実データを読み込み、DB の件数 = `candidates.geojson` の件数 = UI の件数 | メイン |
| E7 | Chrome で、質問 → 結果カード → 地図 → 詳細（2018/2023 の写真）→ 精度の画面、の一連を操作して確認（スクリーンショット） | メイン |

確認できていないことは「確認済み」と書かない。実データでの精度は、12 地区・初期値の閾値という限定つきの数字である。
