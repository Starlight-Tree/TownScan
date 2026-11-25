#!/usr/bin/env bash
# 検出画像（GET /api/candidates/{id}/image）の差分検査: Python の API（Pillow）と Go の API（x/image）で、同じ候補・同じ size の画像を作り、
# 画素の平均絶対差（0〜255）を測る（ホストの Docker を使う。外部へは通信しない）。使い方: api/difftest/image.sh
#
# run.sh（JSON の差分検査）とは別の道具で、名前の頭も別（tsgo-imgdiff-。環境変数 IMGDIFF_PREFIX で変える）。tsgo-diff-* には触れない。
# やること: Go の静的バイナリを作る（モジュールは townscan-gomodcache から。ネットワーク無し）→ 使い捨ての Postgres を内部ネットワークで起動 →
# データ（合成の run + 不規則な形の候補。質感のある写真）を専用ボリュームに書き、Python のローダーで DB へ入れる →
# 両方の API を同じ DB・同じ写真に向けて起動 → image_diff.py で比べる → 自分のものだけを止めて消す。
# 触るもの: ${IMGDIFF_PREFIX}-* のコンテナ・ネットワーク・ボリュームと、ビルドのキャッシュ tsgo-gobuildcache・townscan-gomodcache（残す）。
# townscan-db・townscan-api（コンテナ。イメージは使う）・townscan-web・townscan-devcontainer・ポート 8500・3500・5432 には触らない。DB は公開しない。
# 終了コード: 0 = 構造が一致し、差が上限の内。1 = それ以外。
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$PWD"
HERE="$ROOT/api/difftest"

PREFIX="${IMGDIFF_PREFIX:-tsgo-imgdiff}"
NET="$PREFIX-net"
DB="$PREFIX-db"
PY="$PREFIX-py"
GO="$PREFIX-go"
BIN="$PREFIX-bin"      # Go のバイナリ
DATA="$PREFIX-data"    # run と写真タイル
MODCACHE=townscan-gomodcache
BUILDCACHE=tsgo-gobuildcache
PY_IMG=townscan-api            # Python の API（実行用）。コードは、作業ツリーの backend/app を重ねる
TEST_IMG=townscan-backend-test # Python 3.13・Pillow・ローダー（app.load）の依存
GO_IMG=docunavi-dev            # Go 1.26.10（/usr/local/go）。ダウンロード不要
RUN_IMG=alpine:latest          # 静的バイナリの実行用
UIDGID="$(id -u):$(id -g)"
PW="$(openssl rand -hex 12)"   # 使い捨てのパスワード（DB と一緒に消える。表示しない）
DBURL="postgresql://townscan:$PW@$DB:5432/townscan_imgdiff"

for img in "$PY_IMG" "$TEST_IMG" "$GO_IMG" "$RUN_IMG" postgres:17; do
  docker image inspect "$img" >/dev/null 2>&1 || { echo "イメージ $img がありません（ローカルに無いと、この検査は流せません。pull はしません）" >&2; exit 1; }
done

cleanup() {
  docker rm -f "$PY" "$GO" "$DB" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker volume rm "$BIN" "$DATA" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup  # 前回の残りがあれば片付ける（名前が ${PREFIX}-* のものだけ）

ensure_volume() { # 無ければ作り、実行ユーザーが書けるようにする（作ったときだけ）
  if ! docker volume inspect "$1" >/dev/null 2>&1; then
    docker volume create "$1" >/dev/null
    docker run --rm -v "$1:/v" --entrypoint /bin/chown "$RUN_IMG" "$UIDGID" /v
  fi
}
fresh_volume() { # 新しく作り、実行ユーザーが書けるようにする
  docker volume create "$1" >/dev/null
  docker run --rm -v "$1:/v" --entrypoint /bin/chown "$RUN_IMG" "$UIDGID" /v
}

echo "== Go の静的バイナリを作る（CGO_ENABLED=0・-trimpath。モジュールは取りに行かない）"
ensure_volume "$MODCACHE"
ensure_volume "$BUILDCACHE"
fresh_volume "$BIN"
docker run --rm --user "$UIDGID" --memory 1g --network none \
  -e HOME=/tmp -e GOCACHE=/gocache -e GOMODCACHE=/gomod -e GOTOOLCHAIN=local -e GOPROXY=off -e CGO_ENABLED=0 \
  -v "$MODCACHE:/gomod" -v "$BUILDCACHE:/gocache" -v "$ROOT/api:/src:ro" -v "$BIN:/out" -w /src \
  --entrypoint /usr/local/go/bin/go "$GO_IMG" build -trimpath -ldflags="-s -w" -o /out/api ./cmd/api

echo "== 使い捨ての Postgres を起動する（${DB}・mem_limit 256m・公開しない）"
docker network create --internal "$NET" >/dev/null
docker run -d --name "$DB" --network "$NET" --memory 256m --memory-swap 256m --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_USER=townscan -e POSTGRES_PASSWORD="$PW" -e POSTGRES_DB=townscan_imgdiff \
  postgres:17 -c fsync=off -c shared_buffers=32MB -c max_connections=30 >/dev/null
for i in $(seq 1 60); do
  # -h 127.0.0.1: 初回の初期化中の一時サーバー（ソケットだけ待ち受ける）を、起動済みと見なさないため
  if docker exec "$DB" pg_isready -h 127.0.0.1 -U townscan -d townscan_imgdiff >/dev/null 2>&1; then break; fi
  if [ "$i" = 60 ]; then echo "Postgres が 60 秒以内に起動しませんでした" >&2; exit 1; fi
  sleep 1
done

echo "== データを書く（合成の run + 不規則な形の候補・質感のある写真。image_data.py）"
fresh_volume "$DATA"
docker run --rm --network none --memory 256m --user "$UIDGID" -e HOME=/tmp \
  -v "$DATA:/data" -v "$ROOT/backend/tests/synthetic.py:/synthetic/synthetic.py:ro" -v "$HERE:/difftest:ro" \
  --entrypoint python "$TEST_IMG" -I /difftest/image_data.py --synthetic /synthetic/synthetic.py --out /data

echo "== Python のローダー（app.load）で DB へ入れる"
docker run --rm --network "$NET" --memory 256m -e DATABASE_URL="$DBURL" \
  -v "$ROOT/backend/app:/code/app:ro" -v "$ROOT/backend/db:/code/db:ro" -v "$DATA:/data:ro" \
  --entrypoint python "$TEST_IMG" -m app.load --run /data/run

echo "== Python の API（${PY}）と Go の API（${GO}）を、同じ DB・同じ写真に向けて起動する"
docker run -d --name "$PY" --network "$NET" --memory 512m \
  -e DATABASE_URL="$DBURL" -e TILES_DIR=/data/tiles \
  -v "$ROOT/backend/app:/code/app:ro" -v "$ROOT/backend/db:/code/db:ro" -v "$DATA:/data:ro" "$PY_IMG" >/dev/null
docker run -d --name "$GO" --network "$NET" --memory 128m --user 65532:65532 \
  -e DATABASE_URL="$DBURL" -e TILES_DIR=/data/tiles -v "$BIN:/app:ro" -v "$DATA:/data:ro" --entrypoint /app/api "$RUN_IMG" >/dev/null

echo "== 画像を比べる"
status=0
docker run --rm --network "$NET" --memory 512m -v "$HERE:/difftest:ro" --entrypoint python "$TEST_IMG" \
  -I /difftest/image_diff.py --python "http://$PY:8000" --go "http://$GO:8000" --wait 90 "$@" || status=$?

echo "== Go の API の記録（末尾 4 行）と使用メモリー"
docker logs "$GO" 2>&1 | tail -4
docker stats --no-stream --format '{{.Name}}  {{.MemUsage}}（上限に対して {{.MemPerc}}）' "$GO" "$PY" || true
exit "$status"
