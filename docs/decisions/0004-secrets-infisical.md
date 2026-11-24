# 0004 秘密の置き場: Infisical（JobNavi・DocuNavi と同じ）。起動は `infisical run`

状態: **承認済み**（ユーザー、2026-11-25「全て承認」。登録のしかたの 2 案のうち、Infisical 案）。スクリプトと起動の分岐は実装済み。**実際の Infisical への登録と、`infisical run` での起動は、ユーザーが `townscan` プロジェクトを作ったあとに行う（この文書の時点では未実行・未確認）。**

## 決めたこと

- 秘密は、JobNavi・DocuNavi と同じく、**Infisical（プロジェクト `townscan`・環境 `dev`・パス `/`）に置く**。対象は次の 4 つ（名前は、`compose.yaml`・`frontend/lib/auth.ts`・`backend/app/config.py` が実際に読むもの）。
  - `GOOGLE_CLIENT_ID`・`GOOGLE_CLIENT_SECRET`: Google の OAuth クライアント（種類: ウェブ）。web（Better Auth）が読む。
  - `BETTER_AUTH_SECRET`: 署名鍵と Google のトークンの暗号化に使う乱数。web が読む。**決めたら変えない**（[spec-prototype.md](../spec-prototype.md) §2.1）。
  - `GEMINI_API_KEY`（任意）: Gemini の無料キー。api が読む（[ADR 0003](0003-llm-provider.md)）。
- 登録は `scripts/login-secrets.sh <プロジェクト ID> [環境名] [--from-json <パス>]`。**ユーザーが自分の端末で実行する**（エージェントは実行しない・値を見ない）。JobNavi の同名のスクリプトを土台にし、安全装置は変えない（対話端末でなければ何もしない・権限 600 の一時ファイル・終了時に削除・値を引数や履歴に残さない・登録後はキー名と値の有無だけで確認）。
- 起動は `infisical run --projectId <ID> --env dev -- docker compose up -d`。`scripts/dev-up.sh` は、環境変数 `TOWNSCAN_INFISICAL_PROJECT_ID`（プロジェクト ID。秘密ではない。環境は `TOWNSCAN_INFISICAL_ENV`、既定 `dev`）があるときだけ、この形で起動する。**無いときは、従来どおり**（`.env` を compose が読む）で動く。どちらで起動したかは 1 行表示する。
- **`.env` に残すもの**: `POSTGRES_PASSWORD`（`scripts/dev-up.sh` が作る乱数。DB のボリュームと対で、作り直すと接続できなくなる。外部の資格情報ではない）と、秘密でない設定（`LLM_PROVIDER`・`GEMINI_MODEL`・`BETTER_AUTH_URL`・`JWT_AUDIENCE`・`WEB_TARGET`）。
- Infisical を使うとき、`scripts/dev-up.sh` は **`.env` に `BETTER_AUTH_SECRET` を足さない**（2 か所に別の値ができるのを避ける。`infisical run` の値は、compose では `.env` より優先される）。

## 理由（背景）

- **JobNavi・DocuNavi と同じにする**（ユーザーの決定: 3 つのアプリは同じ作りにそろえる）。JobNavi は、ログインの 3 つの値を `scripts/login-secrets.sh` で Infisical に登録し、`infisical run` で起動している。DocuNavi は `docunavi-local` に置いている。
- **値をエージェントにも `.env` にも出さない。** `.env` は、ガードが読ませない運用なので、書くのも確かめるのも人が手でやることになり、平文のファイルが作業ツリーに残る。スクリプトなら、値は画面にも履歴にも出ず、登録後はキー名と値の有無だけを確かめられる。
- **実際に事故があった。** 2026-11-25 に、Google の OAuth クライアントの作成ダイアログに表示された値が画面に写り込み、露出した秘密を失効させ（削除して作り直した）（履歴から消すだけでは足りないので、失効させた）。値を画面に出す経路を減らすため、Console からダウンロードした JSON を `--from-json` で取り込む（値は、`python3 -I` のプロセスの中だけで取り出し、標準出力・標準エラー・コマンドの引数に出さない。登録に成功したときだけ、その JSON を削除する）。

## 結果

- 起動は、Infisical を使うなら `infisical run … -- docker compose up -d`。compose は `${VAR:-}` で環境変数を読むので、**素の `docker compose up -d` で作り直すと、Infisical の値が空になる**（ログインは「まだ設定されていません」と出る。`.env` に `LLM_PROVIDER=gemini` があるのに `GEMINI_API_KEY` が空だと、api が起動時にエラーで止まる）。
- **開発コンテナには、Infisical CLI がまだ無い。** 登録と起動は、CLI のあるホスト（`/opt/homebrew/bin/infisical`）で行う。コンテナへ入れるのは、JobNavi・DocuNavi の `.devcontainer/Dockerfile`（公式の .deb を SHA-256 で照合する）と同じ形で、コンテナの作り直し（ホスト専用の作業）のときに行う。今回はしていない。
- `scripts/dev-up.sh` と `scripts/login-secrets.sh` は、JobNavi と同様、ホストで実行する。

## 登録の手順（ユーザー）

1. Infisical に `townscan` プロジェクトを作る（環境 `dev`）。プロジェクト ID を控える。
2. Google Cloud Console で、OAuth クライアント（種類: ウェブ）を作る。承認済みのリダイレクト URI は `http://localhost:3500/api/auth/callback/google`。作成後に、JSON をダウンロードする（作成ダイアログの値は、画面に写さない・誰にも見せない）。
3. 自分の端末（ホスト）で `infisical login` のあと、`scripts/login-secrets.sh <プロジェクト ID> --from-json <JSON のパス>`。Gemini のキーを使うなら、続く入力（画面に出ない）で貼る。空のままなら登録しない。JSON は、登録に成功すると削除される。
4. Gemini を使うなら、`.env` に `LLM_PROVIDER=gemini` を足す（`login-secrets.sh` は設定を登録しない。足さないと、キーを登録しても模擬モデルのまま）。そのうえで、`TOWNSCAN_INFISICAL_PROJECT_ID=<プロジェクト ID> scripts/dev-up.sh`（または `infisical run --projectId <ID> --env dev -- docker compose up -d`）。ログインは <http://localhost:3500> で試す。

## 移行の注意

- すでに `.env` の `BETTER_AUTH_SECRET` で一度でもログインしていて、DB の `auth_jwks` に鍵があるときは、Infisical に**別の値**を作ると、その鍵が読めなくなる（全員がログアウトに見え、web のログに `Failed to decrypt private key`）。ログインしたことがない（`auth_jwks` が空）なら、問題ない。ある場合は、`.env` の値を Infisical に入れるか、`auth_jwks` の行を消す（消すのは承認が要る）。

## 選ばなかった案

- **`.env` のまま（Google の値をユーザーが `.env` に書く）**: JobNavi・DocuNavi とそろわない。値が平文のファイルに残り、ガードに止められる。Infisical を使わない人（クローンしただけの人）のための**代わりの経路としては残す**（`.env.example`・README に書く）。
- **Infisical を必須にする**: クローンしただけでは、TownScan が起動しなくなる。ログインは任意の機能なので、置き場を選べるようにした。
- **プロジェクト ID を設定ファイル（DocuNavi の `.infisical.yaml` のような）に置く**: JobNavi は `--projectId` で明示している。ファイルを増やさず、ID が Git に入らないよう、環境変数にした。
- **Infisical を指定したのに CLI が無いとき、`.env` に黙って切り替える**: ログインの値が空のまま動き、原因が分かりにくい。止めて理由を表示する。

## 未確認

- 実際の Infisical への登録（`townscan` プロジェクトがまだ無い）と、`infisical run` での起動。JobNavi と同じ形だが、TownScan では未実行。
- `--from-json` を、Google が出す本物の JSON で通すこと（偽の値の JSON と、偽の `infisical` で、振る舞いは確かめた。`backend/tests/test_login_secrets.py`）。
- Infisical CLI を開発コンテナへ入れること（コンテナの作り直しのとき）。
- Infisical CLI の版: ホストは 0.45.14、JobNavi で実測したのは 0.44.11。使うフラグ（`secrets set --file`・`export --format`・`run --projectId`）は `--help` で存在を確かめたが、拡張子の無い一時ファイルを `--file` に渡したときの形式の判定と、`export` の出力の形は、0.45.14 では未実行。初回の登録のとき、キー名と値の有無の確認が通ったかを見る。
