#!/usr/bin/env bash
# TownScan をローカルで起動する（ホストの Docker。開発コンテナの中では実行しない）。仕様: docs/spec-prototype.md §2・§8 E5
# 使い方: scripts/dev-up.sh [--no-web]
#   --no-web       db と api だけ起動する（frontend がまだ無いとき・API だけ確かめたいとき）
#   WEB_BUILD=host    （既定）frontend をホストの Node 24 でビルドしてから、できた .next/standalone を載せて web を作る
#   WEB_BUILD=docker  web のイメージの中でビルドする（Docker VM に空きメモリーがあるとき・CI 用）
# やること: .env を作る（無ければ。乱数のパスワード。値は表示しない）→ frontend をビルド → docker compose up -d --build
#          → healthy を待つ → 実データがあれば DB へ読み込む → URL を表示。
# 何度流しても同じ（.env は作り直さない。実データの読み込みは同じ run_id を置き換える）。
# .env が無いのに DB のボリュームが残っているときは、新しいパスワードを作らずに止まる（DB と合わなくなるため。直し方を表示する）。
set -euo pipefail
cd "$(dirname "$0")/.."

die() { echo "エラー: $*" >&2; exit 1; }

NO_WEB=0
for arg in "$@"; do
  case "$arg" in
    --no-web) NO_WEB=1 ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) die "不明な引数: $arg（使い方: scripts/dev-up.sh [--no-web]）" ;;
  esac
done
WEB_BUILD="${WEB_BUILD:-host}"
case "$WEB_BUILD" in host|docker) ;; *) die "WEB_BUILD は host か docker です（実際: $WEB_BUILD）" ;; esac

command -v docker >/dev/null || die "docker が見つかりません（ホストで実行してください）"
docker info >/dev/null 2>&1 || die "Docker が動いていません"

# 1. .env（秘密は乱数で作り、値は表示しない。既にあれば触らない）
# Postgres は POSTGRES_PASSWORD を「空のデータで初期化するとき」にしか読まない。DB のボリュームが残っているのに
# パスワードを作り直すと、DB と合わなくなり、api が永久に起動しない。だから、その組み合わせになる前に止める。
PGDATA_VOLUME="${COMPOSE_PROJECT_NAME:-townscan}_townscan-pgdata"
pgdata_hint() {
  cat >&2 <<EOF
注意: DB のボリューム（$PGDATA_VOLUME）が残っています。.env のパスワードを変えると、DB に接続できなくなります。
  次のどちらかにしてください。
  - 元の .env（元の POSTGRES_PASSWORD）を戻す
  - DB の中身を捨ててよいなら、docker compose down -v でボリュームごと消してから、もう一度このスクリプトを実行する
    （DB の中身も消えます。実データは data/townscan/run1/out から、このスクリプトが読み込み直します）
EOF
}
if [ ! -f .env ]; then
  if docker volume inspect "$PGDATA_VOLUME" >/dev/null 2>&1; then
    pgdata_hint
    die ".env がありませんが、DB のボリュームが既にあります。新しい乱数のパスワードでは接続できないため、.env を作らずに止めました"
  fi
  ( umask 077; printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 24)" > .env )
  echo "== .env を作りました（乱数のパスワード。値は表示しません）"
else
  if ! grep -Eq '^POSTGRES_PASSWORD=[A-Za-z0-9]+$' .env; then
    if docker volume inspect "$PGDATA_VOLUME" >/dev/null 2>&1; then pgdata_hint; fi
    die ".env に POSTGRES_PASSWORD（英数字だけ）がありません。直してください（.env.example を参照）。消して作り直すのは、DB のボリュームが無いときだけです"
  fi
fi

# api に読み取り専用でマウントする場所（無いと Docker が root 所有で作ってしまう）
mkdir -p data/townscan

# 2. web（frontend のビルド）
if [ "$NO_WEB" = 1 ]; then
  SERVICES=(db api)
else
  SERVICES=(db api web)
  [ -f frontend/package.json ] || die "frontend/ がまだありません。db と api だけなら --no-web で起動できます"
  if [ "$WEB_BUILD" = host ]; then
    command -v npx >/dev/null || die "npx が見つかりません（ホストに Node が要ります。WEB_BUILD=docker なら不要）"
    echo "== frontend をホストの Node 24 でビルドする（Docker VM の空きメモリーが少ないため。仕様 §2）"
    ( cd frontend && npx -y -p node@24 -- sh -c 'npm ci && npm run build' )
    [ -d frontend/.next/standalone ] || die "frontend/.next/standalone ができていません（next.config の output: \"standalone\" を確認）"
    export WEB_TARGET=prebuilt
  else
    export WEB_TARGET=runtime
  fi
fi

# 3. 起動
echo "== docker compose up -d --build ${SERVICES[*]}"
docker compose up -d --build "${SERVICES[@]}"

# 4. healthy を待つ
echo "== healthy を待つ（最大 5 分）"
deadline=$((SECONDS + 300))
for svc in "${SERVICES[@]}"; do
  while :; do
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "townscan-$svc" 2>/dev/null || echo missing)"
    case "$status" in
      healthy) echo "   $svc: healthy"; break ;;
      unhealthy)
        docker compose logs --tail 30 "$svc" >&2 || true
        # パスワードの食い違い（パスワードを作り直した・変えた）は api のログには出ない。db のログで見分けて、直し方を出す
        db_log="$(docker compose logs --tail 50 db 2>&1 || true)"
        case "$db_log" in *"password authentication failed"*) pgdata_hint ;; esac
        die "$svc が unhealthy です（上のログを確認）" ;;
    esac
    [ "$SECONDS" -lt "$deadline" ] || { docker compose logs --tail 30 "$svc" >&2 || true; die "$svc が時間内に healthy になりませんでした（状態: $status）"; }
    sleep 2
  done
done

# 5. 実データがあれば読み込む（api のコンテナの中で。データは読み取り専用でマウント済み）
if [ -f data/townscan/run1/out/run.json ]; then
  echo "== 実データを読み込む（同じ run_id なら置き換え）"
  docker compose exec -T api python -m app.load --run /data/townscan/run1/out
else
  echo "== 実データ（data/townscan/run1/out/run.json）がまだ無いので、読み込みは飛ばします。"
  echo "   pipeline の出力を置いたあとで: docker compose exec -T api python -m app.load --run /data/townscan/run1/out"
fi

# 6. 結果
echo
echo "== 状態"
curl -fsS http://127.0.0.1:8500/api/health || true
echo
echo "API  : http://127.0.0.1:8500/api/health  （仕様: http://127.0.0.1:8500/api/docs）"
if [ "$NO_WEB" = 0 ]; then echo "画面 : http://127.0.0.1:3500"; fi
echo "メモリー: docker stats --no-stream ${SERVICES[*]/#/townscan-}"
echo "止める: docker compose down（データは残る。DB ごと消すときは -v）"
