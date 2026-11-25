# TownScan frontend

Next.js 16（App Router・TypeScript strict・Node 24）。仕様は [../docs/spec-prototype.md](../docs/spec-prototype.md) §7。

- 画面: `/`（チャットの 1 列）・`/accuracy`（精度・既知の限界・出典と規約）・`/login`（任意のログイン）・`/healthz`（コンテナのヘルスチェック）
  結果のうち、グラフ・地図は、回答の中の**図**として、結果カードの並びの下に出る（件数＝地図とグラフ、比較＝グラフ、地図の表示＝地図。`components/AnswerFigure.tsx`・`lib/answer-view.ts` の `figureKinds`。地図は画面に近づくまでマウントしない）。
  図の「拡大」、結果カードの「詳細」「詳細を開く」「地図で見る」（地図の表示）、最初の画面の「解析した地区を地図で見る」を押したときだけ、拡大ビュー（`components/ExpandedView.tsx`。ダイアログ）が開く。回答が届いただけでは開かない。
  拡大ビューの中身は `components/ResultArea.tsx`（地図・グラフ・写真の比較のタブ。候補の詳細は `components/CandidateDrawer.tsx`）。状態の単位は回答 1 件で、タブ・絞り込み・選んだ候補は回答ごとに保ち、回答の中の図と拡大ビューが共有する（`lib/answer-view.ts`・`components/HomeClient.tsx`）。
- 枠: 幅 1024px 以上は左のサイドパネル（`AppSidebar`。JobNavi・DocuNavi と同じ。開いた表示と細い帯をボタンで切り替える。はじめは開いた状態で、保存しない）。1023px 以下は、はじめは閉じていて、上の細い 1 行のボタンで、サイドパネルを重ねて開く（背景・Esc・閉じるボタン・ページの移動で閉じる）。上の横帯は無い。状態の印（模擬モデルなど）も出さない。合成データ・API 不通のバナー（`AppBanners`）は、どちらの幅でも本文の上に出る。`/login` はサイドパネルなし。
  `app/(site)/` が枠つきの 3 ページ、`app/(auth)/` がログイン。
- API: ブラウザからは同じオリジンの `/api/*` だけを呼ぶ。転送は `proxy.ts`（実行時の環境変数 `API_URL`。既定 `http://127.0.0.1:8500`）。ただし `/api/auth/*`（ログイン）は転送せず、この画面のサーバー（`app/api/auth/[...all]/route.ts`）が受ける。
  `next.config` の `rewrites` はビルド時に転送先が固定されるため使っていない（実測）。
- 地図: Leaflet 1.9.4。地理院タイル（標準地図・`nendophoto2018`・`nendophoto2023`）を直接読む。

## ログイン（任意。Better Auth・Google だけ）

ログインは**任意**。しなくても、チャット・地図・精度は、今までどおり使える（ログインの有無で、機能や API の応答は変わらない）。ログインすると、サイドパネルの下のアカウントに、プロフィール画像（無い・読めないときは人型アイコン。`https://` の画像だけ表示）・メール・ログアウトが出る。
JobNavi・DocuNavi と同じ作り: Better Auth 1.7.18（版は固定）が、この画面のサーバーの中で動き、`pg` の接続プールで、TownScan の Postgres の `auth_` の表（`pipeline/sql/auth.sql`）に入れる。

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

ブラウザーから API を呼ぶ（同じオリジンの `/api/*`）。API へ JWT を渡すのは、会話の履歴（下）だけ。API の `GET /api/me` は、JWT を JWKS（`/api/auth/jwks`）で検証して `{sub, email, name, picture}` を返す入口で、アカウントのロジックの確認用。

テストは、Better Auth と Google をモックする（`lib/session.test.ts`・`actions/auth.test.ts`・`app/api/auth/[...all]/route.test.ts` ほか）。本物の Google との往復は、OAuth クライアントを作ったあとに、手で確かめる。

## 会話の履歴（ログイン中だけ。仕様 `docs/spec-prototype.md` §2.3・§7.1）

ログインしている人だけ、会話を API（Go）に保存し、サイドパネルの「会話の履歴」から開き直し・削除できる。ログインしていなければ、今までどおり（会話は画面の中だけ。`conversation_id` も JWT も付けず、`/api/auth/token`・`/api/conversations` を一度も呼ばない）。

| 場所 | 役割 |
|---|---|
| `app/(site)/layout.tsx` | `currentUser()` の真偽値（ログイン中か）と `isAuthConfigured()`（ログインを使える設定か）を、`HistoryProvider` で画面の部品へ渡す。ログインの有無が変わったら、本文を作り直す |
| `components/HistoryProvider.tsx` | ログイン中か・期限切れ（取り直しても 401）か・会話の一覧（`useConversations`）。一覧は、出す幅（1024px 以上）のときだけ取る |
| `lib/auth-token.ts` | `GET /api/auth/token` で JWT を取り、メモリにだけ置く。期限の 60 秒前に取り直す・同時の取得は 1 回・401 は 1 回だけ取り直して送り直す。localStorage・sessionStorage・URL・ログには出さない |
| `lib/conversations-api.ts`・`lib/use-conversations.ts` | 履歴の 3 本（一覧・発言・削除）と、一覧の取得・状態・取り直し。失敗は 401・404・422・その他の型にする |
| `lib/conversation-session.ts` | 開いている会話の ID（`sessionStorage` の `townscan:conversation_id`）。タブごと。ID は画面が `crypto.randomUUID()` で作る |
| `components/ConversationList.tsx` | サイドパネルの一覧（「新しい会話」の下・アカウントの上）。DocuNavi の `ThreadSidebar` と同じ `thread-*` のクラス・CSS・文言。細い帯には出さない。1023px 以下の重ねて開くパネルには、開いたときだけ出す |
| `components/NewConversation.tsx` | サイドパネルとチャットのつなぎ（「新しい会話」「会話を開く」「いま開いている会話・生成中」） |
| `components/chat/ChatPanel.tsx`・`components/chat/conversation.ts` | 保存（最初の回答が届いてから ID を書く）・開き直し（取得中の遅れた結果は捨てる）・ログインの確認が通らないときの「保存せずに送り直し」・別の解析結果の回答の扱い |

- ログインの確認が通らない（取り直しても 401、またはログインの確認だけが 503）ときは、`conversation_id` を外して送り直し、回答の下に注記を 1 回出す。その会話では、以降の送信にも付けない。
- 開き直した会話の回答は、作ったときの run（`provenance.run_id` と `run_created_at`）が、いまの run（`/api/health`）と違えば、注意書きを出し、拡大ビューへ進むボタンを押せなくし、回答の中の図・写真を出さない。
- テストは、`fetch` を差し替える（`tests/history-helpers.ts`）。実際の Google・Go の API との往復は、統合のあと、実画面で確かめる。

## 重い処理はホストの Node 24 で

Docker VM の空きメモリーが少ないので、`npm ci`・型検査・テスト・`next build` はホストで行う（`npx -y -p node@24` で Node 24 を得る）。

```sh
cd frontend
npx -y -p node@24 -- sh -c 'npm ci && npm run verify'   # 型検査 → lint → テスト → next build
```

`next build` は、書体 Inter を Google Fonts（fonts.googleapis.com・fonts.gstatic.com）からビルド時に取得する（`next/font/google`。JobNavi・DocuNavi と同じ）。ビルドの環境は外部に出られること。実行時には出ない。

## 画面を確かめる（実 API）

```sh
scripts/dev-up.sh                                                 # リポジトリの直下で（ホスト）。db・api（Go）・web を起動する
npx -y -p node@24 -- sh -c 'API_URL=http://127.0.0.1:8500 PORT=3501 npm run dev'   # 開発サーバーを別に立てるとき（api は dev-up の Go）
# 本番相当: npm run build のあと
npx -y -p node@24 -- sh -c 'API_URL=http://127.0.0.1:8500 PORT=3501 HOSTNAME=127.0.0.1 npm start'
```

`npm start` は `dev/start.ts` を通す（Node 24 の型除去でそのまま実行する。型は `npm run typecheck` が見る）。standalone 出力（`.next/standalone/server.js`）には `.next/static`（CSS・JS）と `public`（アイコン）が入らないので、起動の前にそれらを `.next/standalone/` の下へ写す（`server.js` だけを実行すると、HTML は返っても CSS・JS が 404 になる）。Docker の `prebuilt`／`runtime` は Dockerfile の COPY で同じことをしている。

API の応答が契約に合っているかは、リポジトリの `contract/`（`scripts/test-contract.sh`）が確かめる。

## Docker

`Dockerfile` に 2 つの target。`runtime` はイメージの中でビルド、`prebuilt` はホストで作った `.next/standalone` を載せるだけ。どちらも非 root・`HOSTNAME=0.0.0.0`・`PORT=3000`・ヘルスチェック付き。
