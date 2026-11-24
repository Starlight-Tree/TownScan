# TownScan frontend

Next.js 16（App Router・TypeScript strict・Node 24）。仕様は [../docs/spec-prototype.md](../docs/spec-prototype.md) §7。

- 画面: `/`（チャットと地図）・`/accuracy`・`/about`・`/healthz`（コンテナのヘルスチェック）
- API: ブラウザからは同じオリジンの `/api/*` だけを呼ぶ。転送は `proxy.ts`（実行時の環境変数 `API_URL`。既定 `http://127.0.0.1:8500`）。
  `next.config` の `rewrites` はビルド時に転送先が固定されるため使っていない（実測）。
- 地図: Leaflet 1.9.4。地理院タイル（標準地図・`nendophoto2018`・`nendophoto2023`）を直接読む。

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

`npm start` は `dev/start.mjs` を通す。standalone 出力（`.next/standalone/server.js`）には `.next/static`（CSS・JS）と `public`（アイコン）が入らないので、起動の前にそれらを `.next/standalone/` の下へ写す（`server.js` だけを実行すると、HTML は返っても CSS・JS が 404 になる）。Docker の `prebuilt`／`runtime` は Dockerfile の COPY で同じことをしている。

`MOCK_RUN_KIND=real` でバナーの無い状態、チャットに「エラーを起こして」と送ると 500（エラー表示の確認用）。

## 実 API が契約に合っているかを調べる

```sh
npx -y -p node@24 -- node dev/check-api.mjs http://127.0.0.1:8500   # backend 直
npx -y -p node@24 -- node dev/check-api.mjs http://127.0.0.1:3500   # web 経由（プロキシも）
```

## Docker

`Dockerfile` に 2 つの target。`runtime` はイメージの中でビルド、`prebuilt` はホストで作った `.next/standalone` を載せるだけ。どちらも非 root・`HOSTNAME=0.0.0.0`・`PORT=3000`・ヘルスチェック付き。
