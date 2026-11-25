#!/usr/bin/env bash
# ローダーの DB のテスト（pipeline/dbtests）と、スクリプトのテスト（scripts/tests）を、1 つのコマンドで再現する（ホストの Docker を使う）。
# 使い方: scripts/test-loader.sh [pytest の引数...]   例: scripts/test-loader.sh -k loader -x
#
# やること: テスト用イメージ（pipeline/loader.Dockerfile の test）を作る → 使い捨ての Postgres（townscan-test-db・mem_limit 256m・
# データは tmpfs）を専用ネットワークで起動 → その中でテストを流す → 終わったら DB とネットワークを止めて消す。
# 他のコンテナ・ネットワークには触らない（名前が townscan-test-* のものだけ）。DB は公開しない。
set -euo pipefail
cd "$(dirname "$0")/.."

DB=townscan-test-db
NET=townscan-test-net
IMG=townscan-loader-test
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
docker build --quiet --target test -f pipeline/loader.Dockerfile -t "$IMG" pipeline >/dev/null

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
# リポジトリを読み取り専用で重ねる（テストとスクリプトは /repo から読む。dev-up.sh・login-secrets.sh のテストは偽の docker・infisical で流すので、
# 本物の docker・infisical は使わない）
docker run --rm --name "$RUNNER" --network "$NET" --memory 384m \
  -v "$PWD:/repo:ro" -w /repo \
  -e TEST_DATABASE_URL="postgresql://townscan:$PW@$DB:5432/townscan_test" \
  "$IMG" python -m pytest -q -p no:cacheprovider --rootdir /repo pipeline/dbtests scripts/tests "$@"
status=$?
set -e

echo "== 使用メモリー（テスト後の DB）"
docker stats --no-stream --format '{{.Name}}  {{.MemUsage}}（上限に対して {{.MemPerc}}）' "$DB" || true
exit "$status"
