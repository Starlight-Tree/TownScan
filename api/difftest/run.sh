#!/usr/bin/env bash
# Python の API と Go の API の差分検査（ホストの Docker を使う。外部へは通信しない）。
# 使い方: api/difftest/run.sh
#
# やること: Go の静的バイナリを作る（モジュールは townscan-gomodcache から。ネットワーク無し）→ 使い捨ての Postgres（tsgo-diff-db）を内部ネットワークで起動 →
# Python の API（townscan-api のイメージに、この作業ツリーの backend/app・backend/db を重ねる）と Go の API（バイナリ）を、同じ DB に向けて起動 →
# 段階ごとに DB の中身を変えて、diff.py で同じ入力を両方に送り、応答（状態・ヘッダー・本文）を比べる → 終わったら自分のものだけを止めて消す。
#   empty      run が 1 つも無い            synthetic  合成データ（Python のローダーが入れる。3 地区・9 候補）
#   rich       30 地区・620 候補・評価       bare       run だけがある（地区・候補・評価が無い）
#   tie        同じ created_at の run（run_id の大きい方）   weird  NaN の面積・配列の評価（どちらも 500）
#   dbdown     DB を止める（503 の形）
# 触るもの: tsgo-diff-* のコンテナ・ネットワーク・ボリューム（tsgo-diff-bin）と、ビルドのキャッシュ tsgo-gobuildcache・townscan-gomodcache（残す）。
# townscan-db・townscan-api・townscan-web・townscan-devcontainer・ポート 8500・3500・5432 には触らない。DB は公開しない。
# 終了コード: 0 = どの段階も、差分が 0。1 = 差分あり、または準備の失敗。
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$PWD"
HERE="$ROOT/api/difftest"

# 同時に複数本流すときは、DIFF_PREFIX を変える（コンテナ・ネットワーク・ボリュームの名前の頭。前回の残りの片付けも、この名前のものだけ）
P="${DIFF_PREFIX:-tsgo-diff}"
NET="$P-net"
DB="$P-db"
PY="$P-py"
GO="$P-go"
BIN="$P-bin"
MODCACHE=townscan-gomodcache
BUILDCACHE=tsgo-gobuildcache
PY_IMG=townscan-api            # Python の API（実行用）。コードは、作業ツリーの backend/app を重ねる
TEST_IMG=townscan-backend-test # Python 3.13 と、ローダー（app.load）の依存。diff.py の実行にも使う
GO_IMG=docunavi-dev            # Go 1.26.10（/usr/local/go）。ダウンロード不要
RUN_IMG=alpine:latest          # 静的バイナリの実行用
UIDGID="$(id -u):$(id -g)"
PW="$(openssl rand -hex 12)"   # 使い捨てのパスワード（DB と一緒に消える。表示しない）
DBURL="postgresql://townscan:$PW@$DB:5432/townscan_test"

for img in "$PY_IMG" "$TEST_IMG" "$GO_IMG" "$RUN_IMG" postgres:17; do
  docker image inspect "$img" >/dev/null 2>&1 || { echo "イメージ $img がありません（ローカルに無いと、この検査は流せません。pull はしません）" >&2; exit 1; }
done

cleanup() {
  docker rm -f "$PY" "$GO" "$DB" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker volume rm "$BIN" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup  # 前回の残りがあれば片付ける（名前が tsgo-diff-* のものだけ）

ensure_volume() { # 無ければ作り、実行ユーザーが書けるようにする（作ったときだけ）
  if ! docker volume inspect "$1" >/dev/null 2>&1; then
    docker volume create "$1" >/dev/null
    docker run --rm -v "$1:/v" --entrypoint /bin/chown "$RUN_IMG" "$UIDGID" /v
  fi
}

echo "== Go の静的バイナリを作る（CGO_ENABLED=0・-trimpath。モジュールは取りに行かない）"
ensure_volume "$MODCACHE"
ensure_volume "$BUILDCACHE"
docker volume create "$BIN" >/dev/null
docker run --rm -v "$BIN:/v" --entrypoint /bin/chown "$RUN_IMG" "$UIDGID" /v
docker run --rm --user "$UIDGID" --memory 1g --network none \
  -e HOME=/tmp -e GOCACHE=/gocache -e GOMODCACHE=/gomod -e GOTOOLCHAIN=local -e GOPROXY=off -e CGO_ENABLED=0 \
  -v "$MODCACHE:/gomod" -v "$BUILDCACHE:/gocache" -v "$ROOT/api:/src:ro" -v "$BIN:/out" -w /src \
  --entrypoint /usr/local/go/bin/go "$GO_IMG" build -trimpath -ldflags="-s -w" -o /out/api ./cmd/api

echo "== 使い捨ての Postgres を起動する（${DB}・mem_limit 256m・公開しない）"
docker network create --internal "$NET" >/dev/null
docker run -d --name "$DB" --network "$NET" --memory 256m --memory-swap 256m --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_USER=townscan -e POSTGRES_PASSWORD="$PW" -e POSTGRES_DB=townscan_test \
  postgres:17 -c fsync=off -c shared_buffers=32MB -c max_connections=30 >/dev/null
for i in $(seq 1 60); do
  # -h 127.0.0.1: 初回の初期化中の一時サーバー（ソケットだけ待ち受ける）を、起動済みと見なさないため
  if docker exec "$DB" pg_isready -h 127.0.0.1 -U townscan -d townscan_test >/dev/null 2>&1; then break; fi
  if [ "$i" = 60 ]; then echo "Postgres が 60 秒以内に起動しませんでした" >&2; exit 1; fi
  sleep 1
done

echo "== Python の API（${PY}）と Go の API（${GO}）を、同じ DB に向けて起動する"
docker run -d --name "$PY" --network "$NET" --memory 512m \
  -e DATABASE_URL="$DBURL" -e TILES_DIR=/nonexistent \
  -v "$ROOT/backend/app:/code/app:ro" -v "$ROOT/backend/db:/code/db:ro" "$PY_IMG" >/dev/null
docker run -d --name "$GO" --network "$NET" --memory 128m --user 65532:65532 \
  -e DATABASE_URL="$DBURL" -v "$BIN:/app:ro" --entrypoint /app/api "$RUN_IMG" >/dev/null

# diff.py を、使い捨てのコンテナ（Python 3.13）で流す。標準ライブラリだけ
diff_phase() {
  docker run --rm --network "$NET" --memory 128m -v "$HERE:/difftest:ro" --entrypoint python "$TEST_IMG" \
    -I /difftest/diff.py --python "http://$PY:8000" --go "http://$GO:8000" --phase "$@"
}
seed() { # 追加のデータ（seed.py が書いた SQL）を、1 つのトランザクションで流す
  python3 -I "$HERE/seed.py" "$1" | docker exec -i "$DB" psql -v ON_ERROR_STOP=1 -1 -q -U townscan -d townscan_test >/dev/null
}
failed=0
phase() { diff_phase "$@" || failed=1; }

phase empty --wait 90

echo "== 合成データ（backend/tests/synthetic.py の出力）を、Python のローダーで入れる"
docker run --rm --network "$NET" --memory 256m -e DATABASE_URL="$DBURL" \
  -v "$ROOT/backend/app:/code/app:ro" -v "$ROOT/backend/db:/code/db:ro" -v "$ROOT/backend/tests/fixtures/synthetic_run:/fixture:ro" \
  --entrypoint python "$TEST_IMG" -m app.load --run /fixture
phase synthetic

for p in rich bare tie weird; do
  echo "== 追加のデータ: $p"
  seed "$p"
  phase "$p"
done

echo "== DB を止める（503 の形。Python の API は、接続を待つので、1 件ごとに約 10 秒かかる）"
docker stop "$DB" >/dev/null
phase dbdown

echo "== Go の API の記録（末尾 6 行）と使用メモリー"
docker logs "$GO" 2>&1 | tail -6
if docker logs "$GO" 2>&1 | grep -qF "$PW"; then
  echo "× Go の API のログに DB のパスワードが出ています" >&2
  failed=1
else
  echo "○ Go の API のログに DB のパスワードは出ていません"
fi
docker stats --no-stream --format '{{.Name}}  {{.MemUsage}}（上限に対して {{.MemPerc}}）' "$GO" "$PY" || true

if [ "$failed" = 0 ]; then echo "== 差分検査: すべての段階で差分 0"; else echo "== 差分検査: 差分あり（上の [差分] を見てください）" >&2; fi
exit "$failed"
