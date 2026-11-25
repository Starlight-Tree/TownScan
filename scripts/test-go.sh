#!/usr/bin/env bash
# Go の API（api/）の検査を、1 つのコマンドで再現する（ホストの Docker を使う。ホストに Go は要らない）。
# 使い方: scripts/test-go.sh [go test の引数...]    例: scripts/test-go.sh -run Router ./internal/httpx
#         scripts/test-go.sh --download            （初回だけ。Go の公式プロキシから、モジュールを取ってくる）
#
# やること（失敗したら、その時点で止まる）:
#   1. gofmt -l（出力があれば失敗）  2. go vet ./...
#   3. 使い捨ての Postgres（tsgo-test-db・mem_limit 256m・データは tmpfs・公開しない）を、外へ出られないネットワークで起動し、
#      pipeline/sql/schema.sql・auth.sql の写しが一致することも確かめながら、go test -race -count=1 ./... を流す
#      （DB のテストは、テストごとに新しいデータベースを作る。TEST_DATABASE_URL を渡すので、skip されない）
# Go は、ローカルのイメージ docunavi-dev（/usr/local/go に 1.26.x。ダウンロード不要）で流す。ホストのユーザーで動かすので、作業ツリーに root 所有のファイルは残らない。
# モジュールは、Docker の名前つきボリューム townscan-gomodcache（GOMODCACHE=/gomod）から読む。流すときは GOPROXY=off・外へ出られないネットワークなので、
# 取りに行かない（Go の公式プロキシとチェックサム DB の検証は、--download のときの標準のまま。無効にする設定は使わない）。
# ビルドのキャッシュは tsgo-gobuildcache（残す。消すときは docker volume rm）。
# 触るもの: tsgo-test-* のコンテナ・ネットワーク（終わったら消す）と、上の 2 つのボリューム。
# townscan-db・townscan-api・townscan-web・townscan-devcontainer、ポート 8500・3500・5432 には触らない。
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

GO_IMG=docunavi-dev          # Go 1.26.x（/usr/local/go）。gcc もある（-race に要る）
UTIL_IMG=alpine:latest       # ボリュームの所有者の設定だけに使う
PG_IMG=postgres:17
MODCACHE=townscan-gomodcache
BUILDCACHE=tsgo-gobuildcache
# 同時に複数本流すときは、TSGO_TEST_PREFIX を変える（コンテナ・ネットワークの名前の頭。前回の残りの片付けも、この名前のものだけ）
TSGO_TEST_PREFIX="${TSGO_TEST_PREFIX:-tsgo-test}"
DB="$TSGO_TEST_PREFIX-db"
NET="$TSGO_TEST_PREFIX-net"
RUNNER="$TSGO_TEST_PREFIX-go"
UIDGID="$(id -u):$(id -g)"

for img in "$GO_IMG" "$UTIL_IMG" "$PG_IMG"; do
  docker image inspect "$img" >/dev/null 2>&1 || { echo "イメージ $img がありません（ローカルに無いと、この検査は流せません。pull はしません）" >&2; exit 1; }
done

ensure_volume() { # 無ければ作り、実行ユーザーが書けるようにする（作ったときだけ）
  if ! docker volume inspect "$1" >/dev/null 2>&1; then
    docker volume create "$1" >/dev/null
    docker run --rm -v "$1:/v" --entrypoint /bin/chown "$UTIL_IMG" "$UIDGID" /v
  fi
}

# go を、ホストのユーザーで流す。使い方: go_in_docker "NETWORK" "GOPROXY の値" [docker の追加の引数...] -- go のサブコマンド...
go_in_docker() {
  local net="$1" proxy="$2"; shift 2
  local extra=()
  while [ "$1" != "--" ]; do extra+=("$1"); shift; done
  shift
  docker run --rm --user "$UIDGID" --memory 1g --network "$net" ${extra[@]+"${extra[@]}"} \
    -e HOME=/tmp -e GOCACHE=/gocache -e GOMODCACHE=/gomod -e GOTOOLCHAIN=local -e GOPROXY="$proxy" \
    -v "$MODCACHE:/gomod" -v "$BUILDCACHE:/gocache" -v "$ROOT/api:/src" -w /src \
    --entrypoint /usr/local/go/bin/go "$GO_IMG" "$@"
}

ensure_volume "$MODCACHE"
ensure_volume "$BUILDCACHE"

if [ "${1:-}" = "--download" ]; then
  echo "== モジュールを取ってくる（go mod download。Go の公式プロキシ proxy.golang.org とチェックサム DB の検証は、標準のまま）"
  go_in_docker bridge "https://proxy.golang.org,direct" -- mod download
  go_in_docker none off -- mod verify
  echo "== 依存（版つき）。モジュールの全体（go.mod の連なり。推移的なものを含む。ここだけ、go.mod を取りにプロキシへ出る）"
  go_in_docker bridge "https://proxy.golang.org,direct" -- list -m all
  echo "== ビルドとテストに実際に使われるモジュール（標準ライブラリを除く）"
  go_in_docker none off -- list -deps -test -f '{{with .Module}}{{.Path}} {{.Version}}{{end}}' ./... | sort -u | grep -v '^townscan/api' | grep -v '^$'
  echo "== go.sum の行数: $(wc -l < api/go.sum | tr -d ' ')"
  exit 0
fi

# モジュールが無ければ、取りに行かずに、案内して止まる
if ! go_in_docker none off -- list -deps ./... >/dev/null 2>&1; then
  echo "モジュールのキャッシュ（ボリューム $MODCACHE）が足りません。初回だけ、次を実行してください（ネットワークを使います）:" >&2
  echo "  scripts/test-go.sh --download" >&2
  exit 1
fi

cleanup() {
  docker rm -f "$RUNNER" "$DB" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  [ -z "${LOG:-}" ] || rm -f "$LOG"
}
trap cleanup EXIT
cleanup  # 前回の残りがあれば片付ける（名前が tsgo-test-* のものだけ）

started=$SECONDS
echo "== gofmt -l"
unformatted="$(docker run --rm --user "$UIDGID" --memory 512m --network none -v "$ROOT/api:/src" -w /src --entrypoint /usr/local/go/bin/gofmt "$GO_IMG" -l .)"
if [ -n "$unformatted" ]; then
  echo "gofmt の差分があります（gofmt -w で直してください）:" >&2
  echo "$unformatted" >&2
  exit 1
fi

echo "== go vet ./..."
go_in_docker none off -- vet ./...

echo "== 使い捨ての Postgres を起動する（${DB}・mem_limit 256m）"
PW="$(openssl rand -hex 12)"  # 使い捨てのパスワード（DB と一緒に消える。表示しない）
docker network create --internal "$NET" >/dev/null
docker run -d --name "$DB" --network "$NET" --memory 256m --memory-swap 256m --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_USER=townscan -e POSTGRES_PASSWORD="$PW" -e POSTGRES_DB=townscan_test \
  "$PG_IMG" -c fsync=off -c shared_buffers=32MB -c max_connections=100 >/dev/null
for i in $(seq 1 60); do
  # -h 127.0.0.1: 初回の初期化中の一時サーバー（ソケットだけ待ち受ける）を、起動済みと見なさないため
  if docker exec "$DB" pg_isready -h 127.0.0.1 -U townscan -d townscan_test >/dev/null 2>&1; then break; fi
  if [ "$i" = 60 ]; then echo "Postgres が 60 秒以内に起動しませんでした" >&2; exit 1; fi
  sleep 1
done

echo "== go test -race -count=1 ${*:-./...}"
LOG="$(mktemp)"
set +e
go_in_docker "$NET" off --name "$RUNNER" \
  -e TEST_DATABASE_URL="postgresql://townscan:$PW@$DB:5432/townscan_test" \
  -e PIPELINE_SQL_DIR=/pipeline-sql -v "$ROOT/pipeline/sql:/pipeline-sql:ro" \
  -- test -race -count=1 -v "${@:-./...}" >"$LOG" 2>&1
status=$?
set -e

# 見やすく: パッケージごとの結果・失敗・skip（理由つき）だけを出す。失敗のときは、全文を出す
grep -E '^(ok|FAIL|\?|panic:)|^\s*--- FAIL' "$LOG" || true
if grep -qE '^\s*--- SKIP' "$LOG"; then
  echo "-- skip されたテスト（理由つき）"
  grep -B1 -E '^\s*--- SKIP' "$LOG" || true
fi
if [ "$status" != 0 ]; then
  echo "---- 全文（失敗のため）----" >&2
  cat "$LOG" >&2
fi
tests="$(grep -c '^--- PASS' "$LOG" || true)"
subtests="$(grep -cE '^\s+--- PASS' "$LOG" || true)"
failed="$(grep -cE '^\s*--- FAIL' "$LOG" || true)"
skipped="$(grep -cE '^\s*--- SKIP' "$LOG" || true)"
echo "== 結果: テスト ${tests} 件（サブテスト ${subtests} 件）合格・失敗 ${failed} 件・skip ${skipped} 件 / 所要 $((SECONDS - started)) 秒（コンテナの起動・DB の待ちを含む）"

echo "== 使用メモリー（テスト後の DB）"
docker stats --no-stream --format '{{.Name}}  {{.MemUsage}}（上限に対して {{.MemPerc}}）' "$DB" || true
exit "$status"
