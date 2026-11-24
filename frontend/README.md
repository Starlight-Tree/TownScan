# TownScan frontend

Next.js 16（App Router・TypeScript strict・Node 24）。仕様は [../docs/spec-prototype.md](../docs/spec-prototype.md) §7。

- 画面: `/`（左にチャット、右に結果領域）・`/accuracy`（精度・既知の限界・出典と規約）・`/login`（任意のログイン）・`/healthz`（コンテナのヘルスチェック）
  結果領域（`components/ResultArea.tsx`）は、地図・グラフ・写真の比較（候補の詳細。`components/CandidateDrawer.tsx`）のタブ。チャットの回答に合わせて自動で切り替わり（`lib/result-view.ts`）、「拡大」でチャットの列を狭めて広げられる。
- 枠: 幅 1024px 以上は左のサイドパネル（`AppSidebar`。JobNavi・DocuNavi と同じ。開いた表示と細い帯をボタンで切り替える。はじめは開いた状態で、保存しない）。1023px 以下は上の横帯（`AppHeader`。ブランド・3 つのページ・状態の印・テーマ・アカウント）。合成データ・API 不通のバナーは、どちらの幅でも本文の上に出る。`/login` はサイドパネルなし。
  `app/(site)/` が枠つきの 3 ページ、`app/(auth)/` がログイン。
- API: ブラウザからは同じオリジンの `/api/*` だけを呼ぶ。転送は `proxy.ts`（実行時の環境変数 `API_URL`。既定 `http://127.0.0.1:8500`）。ただし `/api/auth/*`（ログイン）は転送せず、この画面のサーバー（`app/api/auth/[...all]/route.ts`）が受ける。
  `next.config` の `rewrites` はビルド時に転送先が固定されるため使っていない（実測）。
- 地図: Leaflet 1.9.4。地理院タイル（標準地図・`nendophoto2018`・`nendophoto2023`）を直接読む。

## ログイン（任意。Better Auth・Google だけ）

ログインは**任意**。しなくても、チャット・地図・精度は、今までどおり使える（ログインの有無で、機能や API の応答は変わらない）。ログインすると、サイドパネルの下（1023px 以下は上の横帯の右端）のアカウントに、プロフィール画像（無い・読めないときは人型アイコン。`https://` の画像だけ表示）・メール・ログアウトが出る。
JobNavi・DocuNavi と同じ作り: Better Auth 1.7.18（版は固定）が、この画面のサーバーの中で動き、`pg` の接続プールで、TownScan の Postgres の `auth_` の表（`backend/db/auth.sql`）に入れる。

| 場所 | 役目 |
|---|---|
| `lib/auth.ts`・`lib/auth-config.ts` | Better Auth の設定（Google だけ・セッション 14 日・Cookie の接頭辞 `townscan`・JWT は ES256・15 分・`aud` は `townscan`）と、設定値の検査 |
| `lib/session.ts` | `currentUser()`。ログイン中の利用者を返す。Cookie（`townscan.session_token`）が無い訪問者では、Better Auth も DB も呼ばない。未設定・失敗のときは `null`（ログインしていない扱いで、画面は壊れない） |
| `actions/auth.ts` | `googleLoginAction`（Google の同意画面へ）・`logoutAction` |
| `app/api/auth/[...all]/route.ts` | Better Auth の入口（Google への行き来・Cookie・JWKS `/api/auth/jwks`）。未設定なら 503 |
| `proxy.ts` | `/api/*` を API へ転送する。`/api/auth/*` だけは転送しない |

環境変数（画面のサーバーだけが読む。**どれも `NEXT_PUBLIC_` を付けない**。値はこのファイルにも書かない）:

- `BETTER_AUTH_URL`: ブラウザーから見たこの画面の URL（開発では `http://localhost:3500`）。JWT の `iss` と、Google のリダイレクト URI の元
- `BETTER_AUTH_SECRET`: 32 文字以上の乱数。`scripts/dev-up.sh` が `.env` に 1 回だけ作る。**決めたら変えない**（DB の署名鍵と Google のトークンの暗号化に使う。変えると全員がログアウトに見える）
- `GOOGLE_CLIENT_ID`・`GOOGLE_CLIENT_SECRET`: Google の OAuth クライアント（ウェブ アプリケーション）。自分で作って `.env` に書く。**Google 側の承認済みのリダイレクト URI は `http://localhost:3500/api/auth/callback/google`**
- `DATABASE_URL`: Postgres への接続（`compose.yaml` が組む）
- `JWT_AUDIENCE`（任意。既定 `townscan`）: JWT の `aud`。API の `AUTH_AUDIENCE` と同じ値

**未設定のときの動き**: 上の必須の 5 つ（`JWT_AUDIENCE` を除く）のどれかが空、または `BETTER_AUTH_SECRET` が 32 文字未満・`BETTER_AUTH_URL` が http(s) の URL でないときは、`/login` が「Google でのログインは、まだ設定されていません」と出し（ボタンは出さない）、`/api/auth/*` は 503 を返す。サイドパネルのメニューは、ログインしていない人のもの（テーマとログインの入口）になる。ほかの画面・API は、今までどおり動く。環境変数を直したら、画面のコンテナを再起動する（設定は起動後に読み直さない）。

ブラウザーで開く URL は、`BETTER_AUTH_URL` と同じホスト（`http://localhost:3500`）にする。Cookie はホストごとなので、`127.0.0.1` で開くと、Google から戻ったあとのログインの印が見えない（未確認の一般論。実際の確認は、OAuth クライアントを作ったあと）。

ブラウザーから API を呼ぶ（同じオリジンの `/api/*`）ので、API へ渡す JWT（JobNavi の `userToken`）は、今は使っていない。API の `GET /api/me` は、JWT を JWKS（`/api/auth/jwks`）で検証して `{sub, email, name, picture}` を返す入口で、アカウントのロジックの確認用。

テストは、Better Auth と Google をモックする（`lib/session.test.ts`・`actions/auth.test.ts`・`app/api/auth/[...all]/route.test.ts` ほか）。本物の Google との往復は、OAuth クライアントを作ったあとに、手で確かめる。

## 重い処理はホストの Node 24 で

Docker VM の空きメモリーが少ないので、`npm ci`・型検査・テスト・`next build` はホストで行う（`npx -y -p node@24` で Node 24 を得る）。

```sh
cd frontend
npx -y -p node@24 -- sh -c 'npm ci && npm run verify'   # 型検査 → lint → テスト → next build
```

`next build` は、書体 Inter を Google Fonts（fonts.googleapis.com・fonts.gstatic.com）からビルド時に取得する（`next/font/google`。JobNavi・DocuNavi と同じ）。ビルドの環境は外部に出られること。実行時には出ない。

## 画面を確かめる（スタブ API）

```sh
npx -y -p node@24 -- sh -c 'MOCK_API_PORT=8599 node dev/mock-api.mjs'            # スタブ（合成データ。run.kind=synthetic）
npx -y -p node@24 -- sh -c 'API_URL=http://127.0.0.1:8599 PORT=3500 npm run dev'  # 開発サーバー
# 本番相当: npm run build のあと
npx -y -p node@24 -- sh -c 'API_URL=http://127.0.0.1:8599 PORT=3500 HOSTNAME=127.0.0.1 npm start'
```

`npm start` は `dev/start.ts` を通す（Node 24 の型除去でそのまま実行する。型は `npm run typecheck` が見る）。standalone 出力（`.next/standalone/server.js`）には `.next/static`（CSS・JS）と `public`（アイコン）が入らないので、起動の前にそれらを `.next/standalone/` の下へ写す（`server.js` だけを実行すると、HTML は返っても CSS・JS が 404 になる）。Docker の `prebuilt`／`runtime` は Dockerfile の COPY で同じことをしている。

`MOCK_RUN_KIND=real` でバナーの無い状態、チャットに「エラーを起こして」と送ると 500（エラー表示の確認用）。

## 実 API が契約に合っているかを調べる

```sh
npx -y -p node@24 -- node dev/check-api.mjs http://127.0.0.1:8500   # backend 直
npx -y -p node@24 -- node dev/check-api.mjs http://127.0.0.1:3500   # web 経由（プロキシも）
```

## Docker

`Dockerfile` に 2 つの target。`runtime` はイメージの中でビルド、`prebuilt` はホストで作った `.next/standalone` を載せるだけ。どちらも非 root・`HOSTNAME=0.0.0.0`・`PORT=3000`・ヘルスチェック付き。
