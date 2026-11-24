#!/usr/bin/env bash
# backend のテストを 1 つのコマンドで再現する（ホストの Docker を使う）。
# 使い方: scripts/test-backend.sh [pytest の引数...]   例: scripts/test-backend.sh -k chat -x
#
# やること: テスト用イメージ（backend/Dockerfile の test）を作る → 使い捨ての Postgres（townscan-test-db・mem_limit 256m・
# データは tmpfs）を専用ネットワークで起動 → その中でテストを流す → 終わったら DB とネットワークを止めて消す。
# 他のコンテナ・ネットワークには触らない（名前が townscan-test-* のものだけ）。DB は公開しない。
set -euo pipefail
cd "$(dirname "$0")/.."

DB=townscan-test-db
NET=townscan-test-net
IMG=townscan-backend-test
RUNNER=townscan-test-runner
PW="$(openssl rand -hex 12)"  # 使い捨てのパスワード（DB と一緒に消える。表示しない）

cleanup() {
  docker rm -f "$RUNNER" >/dev/null 2>&1 || true
  docker rm -f "$DB" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup  # 前回の残りがあれば片付ける（名前が townscan-test-* のものだけ）

echo "== テスト用イメージを作る"
docker build --quiet --target test -t "$IMG" backend >/dev/null

echo "== 使い捨ての Postgres を起動する（${DB}・mem_limit 256m）"
docker network create --internal "$NET" >/dev/null
docker run -d --name "$DB" --network "$NET" --memory 256m --memory-swap 256m \
  --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_USER=townscan -e POSTGRES_PASSWORD="$PW" -e POSTGRES_DB=townscan_test \
  postgres:17 -c fsync=off -c shared_buffers=32MB -c max_connections=30 >/dev/null

for i in $(seq 1 60); do
  # -h 127.0.0.1: 初回の初期化中の一時サーバー（ソケットだけ待ち受ける）を、起動済みと見なさないため
  if docker exec "$DB" pg_isready -h 127.0.0.1 -U townscan -d townscan_test >/dev/null 2>&1; then break; fi
  if [ "$i" = 60 ]; then echo "Postgres が 60 秒以内に起動しませんでした" >&2; exit 1; fi
  sleep 1
done

echo "== テストを流す"
set +e
# dev-up.sh のテスト（tests/test_dev_up.py）が読めるよう、スクリプトを読み取り専用で渡す（偽の docker で流すので、本物の docker は使わない）
docker run --rm --name "$RUNNER" --network "$NET" --memory 384m \
  -v "$PWD/scripts/dev-up.sh:/scripts/dev-up.sh:ro" -e DEV_UP_SCRIPT=/scripts/dev-up.sh \
  -e TEST_DATABASE_URL="postgresql://townscan:$PW@$DB:5432/townscan_test" \
  "$IMG" python -m pytest -q "$@"
status=$?
set -e

echo "== 使用メモリー（テスト後の DB）"
docker stats --no-stream --format '{{.Name}}  {{.MemUsage}}（上限に対して {{.MemPerc}}）' "$DB" || true
exit "$status"
