# TownScan web（Next.js 16・standalone 出力）。target は 2 つ:
#   runtime  イメージの中で npm ci と next build まで行う（メモリーに余裕のある環境・CI 用）
#   prebuilt ホストで作った .next/standalone（と static・public）を載せるだけ（Docker VM の空きが少ないときはこちら）
#
#   docker build --target runtime  -t townscan-web frontend
#   (cd frontend && npx -y -p node@24 -- sh -c 'npm ci && npm run build') && docker build --target prebuilt -t townscan-web frontend
#
# 実行時の環境変数: API_URL（/api/* の転送先。例 http://api:8000。ビルド時に固定しない）、PORT（既定 3000）

# ---- 共通の土台 ----
FROM node:24-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

# ---- ビルド（runtime だけが使う） ----
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS builder
COPY . .
# ホストの .next が混ざっても、必ずイメージの中で作り直す
RUN rm -rf .next && npm run build

# ---- 実行の土台（2 つの target で共通）----
FROM node:24-slim AS runner-base
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
WORKDIR /app
# node:24-slim には非 root の node（uid 1000）がある
USER node
EXPOSE 3000
# /healthz は web 自身の応答だけを見る（API が落ちていても web は起きている）
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "server.js"]

# ---- target: prebuilt（ホストで next build 済みの成果物を載せる）----
FROM runner-base AS prebuilt
COPY --chown=node:node .next/standalone ./
COPY --chown=node:node .next/static ./.next/static
COPY --chown=node:node public ./public

# ---- target: runtime（イメージの中でビルドした成果物を載せる）----
FROM runner-base AS runtime
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
