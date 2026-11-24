#!/usr/bin/env bash
# 契約の検査（contract/）を、使い捨ての環境で 1 つのコマンドで流す（ホストの Docker を使う）。仕様: contract/README.md・docs/decisions/0005-api-in-go.md
# 使い方: scripts/test-contract.sh [python|go] [pytest の引数...]   例: scripts/test-contract.sh python -k chat -x
#   対象（省略時は python）: 契約を満たすことを確かめる API の実装。
#     python  いまの API（backend/ のイメージの runtime）。
#     go      Go の API（api/）。api/Dockerfile がまだ無いので、「未対応」と出して終わる（終了コード 2）。api/ ができたら、下の「対象」の節が使う。
#
# やること（どの対象でも同じ。API のコードは、対象のイメージの中だけ。検査は HTTP だけで叩く）:
#   1. イメージを作る: 検査を流すイメージ（contract/Dockerfile。pytest・PyJWT・Pillow だけで、アプリのコードは無い）、
#      データを読み込むイメージ（backend/ の runtime。`python -m app.load` は、API が Go になっても Python の仕事）、対象の API のイメージ。
#   2. 使い捨ての Postgres（townscan-contract-db・mem_limit 256m・データは tmpfs）を、外へ出られない専用ネットワーク（--internal）で起動する。
#   3. 合成データ（backend/tests/synthetic.py の run と写真タイル。画像の 404 を確かめる故障つき）を、専用ボリュームに書き、
#      `python -m app.load --run` で DB へ入れる。
#   4. API の「構成」ごとに、API を起動 → 検査の pytest を流す → API を止める（contract/README.md の「API の構成」。既定は次の順）:
#        empty（データ無し）→ main（認証あり・全検査の本体）→ noauth・badauth（認証の設定が無い・不正）→ jwksdown（JWKS に届かない）→ dbdown（DB が止まる）
#   5. 結果を表にして、起動したものを全部消す（名前が townscan-contract-* のものだけ）。
#
# 守ること: ポートを公開しない（ホストの 8500・3500・5432 などに触れない）。townscan-db・townscan-api・townscan-web・townscan-devcontainer・
#   townscan-test-* には触れない。外への通信・実 API（Gemini など）は無い（LLM_PROVIDER=mock。ネットワークは --internal）。
#   重い Docker の処理は 1 つずつ（イメージのビルド → DB → API → 検査の順。並べて流さない）。
#
# 環境変数（どれも省略できる。開発用）:
#   CONTRACT_PHASES    流す構成（空白区切り）。既定は上の順の全部。例: CONTRACT_PHASES=main scripts/test-contract.sh python -k chat
#                      empty を入れるときは先頭に置く（空の DB に API を向ける。データの読み込みはそのあと）。
set -euo pipefail
cd "$(dirname "$0")/.."

# ---- 引数 ----
usage() { echo "使い方: $0 [python|go] [pytest の引数...]" >&2; exit 2; }
TARGET=python
case "${1:-}" in
  python|go) TARGET="$1"; shift ;;
  ""|-*) ;;  # 対象を省略して、pytest の引数だけを渡す
  *) usage ;;
esac
PYTEST_ARGS=("$@")

# ---- 名前・値（townscan-contract-* だけを作り、消す） ----
PREFIX=townscan-contract
NET="$PREFIX-net"
DB="$PREFIX-db"
API="$PREFIX-api"
RUNNER="$PREFIX-runner"   # 検査を流すコンテナの名前。偽の JWKS サーバーがこの中で動き、API はこの名前で JWKS を取りに来る
VOL="$PREFIX-work"        # 合成データ（run と写真タイル）を置くボリューム
RUNNER_IMAGE="$PREFIX-runner"
LOADER_IMAGE="$PREFIX-api-python"  # データの読み込み（app.load）に使う。対象が python のときは、API のイメージでもある
DBNAME=townscan_contract
SYNTHETIC=backend/tests/synthetic.py
PHASES="${CONTRACT_PHASES:-empty main noauth badauth jwksdown dbdown}"
AUTH_ISSUER="https://auth.contract.test"   # contract/support/fakes.py の ISSUER の既定と同じ
JWKS_PORT=8901                              # 同じく JWKS_PORT の既定（runner の中。ネットワークの外へは公開しない）
JWKS_URL="http://$RUNNER:$JWKS_PORT/api/auth/jwks"
PW="$(openssl rand -hex 12)"  # 使い捨てのパスワード（DB と一緒に消える。表示しない）
DB_URL="postgresql://townscan:$PW@$DB:5432/$DBNAME"

# ---- 対象（API の実装）の差し込み口 ----
# 新しい実装は、ここに 1 つ足す（contract/README.md の「新しい実装の足し方」）。決めるもの:
#   TARGET_IMAGE  API のイメージ名
#   TARGET_PORT   API がコンテナの中で待ち受けるポート（compose.yaml の api と同じ 8000）
#   target_build  イメージを作る関数
# API は、環境変数 DATABASE_URL・TILES_DIR・LLM_PROVIDER・AUTH_ISSUER・AUTH_JWKS_URL・AUTH_AUDIENCE（compose.yaml の api と同じ名前）だけで構成され、
# 引数なしの起動（イメージの CMD）で `/api/*` を待ち受ける。
TARGET_PORT=8000
case "$TARGET" in
  python)
    TARGET_IMAGE="$LOADER_IMAGE"
    target_build() { docker build --quiet --target runtime -t "$TARGET_IMAGE" backend >/dev/null; }
    ;;
  go)
    TARGET_IMAGE="$PREFIX-api-go"
    if [ ! -f api/Dockerfile ]; then
      echo "未対応: 対象 go は、まだ流せません（Go の API。api/Dockerfile がありません）。" >&2
      echo "        docs/decisions/0005-api-in-go.md の順序で api/ を作ったあと、この対象が使えます（api/Dockerfile の runtime ターゲットを使います）。" >&2
      exit 2
    fi
    target_build() { docker build --quiet --target runtime -t "$TARGET_IMAGE" api >/dev/null; }
    ;;
esac

# ---- 前提 ----
if ! command -v docker >/dev/null 2>&1 || ! command -v openssl >/dev/null 2>&1; then
  echo "docker か openssl が見つかりません（契約の検査は、使い捨ての Postgres と API を docker で起動します）" >&2; exit 1
fi
if ! docker info >/dev/null 2>&1; then echo "Docker が動いていません" >&2; exit 1; fi

LOG=""
cleanup() {
  docker rm -f "$RUNNER" "$API" "$DB" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker volume rm "$VOL" >/dev/null 2>&1 || true
  [ -z "$LOG" ] || rm -f "$LOG"
}
trap cleanup EXIT
cleanup  # 前回の残りがあれば片付ける（名前が townscan-contract-* のものだけ）
LOG="$(mktemp "${TMPDIR:-/tmp}/townscan-contract.XXXXXX")"

# 検査を流す docker run の共通部分（読み取り専用・権限なし・メモリー上限。contract/ は読み取り専用で渡す）
runner_run() { # runner_run <docker run の追加引数...> -- <コマンド...>
  docker run --rm --network "$NET" --memory 256m --memory-swap 256m --cap-drop ALL --security-opt no-new-privileges \
    --read-only --tmpfs /tmp -v "$PWD/contract:/contract:ro" -w /contract "$@"
}

started=$SECONDS
echo "== イメージを作る（対象: ${TARGET}）"
docker build --quiet -t "$RUNNER_IMAGE" contract >/dev/null
docker build --quiet --target runtime -t "$LOADER_IMAGE" backend >/dev/null
[ "$TARGET_IMAGE" = "$LOADER_IMAGE" ] || target_build

echo "== 使い捨ての Postgres を起動する（${DB}・mem_limit 256m・外へ出られないネットワーク）"
docker network create --internal "$NET" >/dev/null
docker volume create "$VOL" >/dev/null
docker run -d --name "$DB" --network "$NET" --memory 256m --memory-swap 256m \
  --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_USER=townscan -e POSTGRES_PASSWORD="$PW" -e POSTGRES_DB="$DBNAME" \
  postgres:17 -c fsync=off -c shared_buffers=32MB -c max_connections=30 >/dev/null
for i in $(seq 1 60); do
  # -h 127.0.0.1: 初回の初期化中の一時サーバー（ソケットだけ待ち受ける）を、起動済みと見なさないため
  if docker exec "$DB" pg_isready -h 127.0.0.1 -U townscan -d "$DBNAME" >/dev/null 2>&1; then break; fi
  if [ "$i" = 60 ]; then echo "Postgres が 60 秒以内に起動しませんでした" >&2; exit 1; fi
  sleep 1
done

echo "== 合成データを書く（run と写真タイル。画像の 404 を確かめる故障つき）"
runner_run --user 0:0 -v "$VOL:/work" -v "$PWD/$SYNTHETIC:/synthetic/synthetic.py:ro" "$RUNNER_IMAGE" \
  python /contract/prepare_data.py --synthetic /synthetic/synthetic.py --out /work

loader_run() { # loader_run <コマンド...> — データの読み込みに使うイメージ（backend の runtime。DB へ届く）
  docker run --rm --network "$NET" --memory 256m --memory-swap 256m --cap-drop ALL --security-opt no-new-privileges \
    --read-only --tmpfs /tmp -v "$VOL:/work:ro" -e DATABASE_URL="$DB_URL" "$LOADER_IMAGE" "$@"
}

start_api() { # start_api <API に足す -e の並び...>
  docker run -d --name "$API" --network "$NET" --memory 512m --memory-swap 512m \
    --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp \
    -v "$VOL:/work:ro" \
    -e DATABASE_URL="$DB_URL" -e TILES_DIR=/work/tiles -e LLM_PROVIDER=mock \
    "$@" "$TARGET_IMAGE" >/dev/null
}

# 構成ごとの API の追加の環境変数。AUTH_AUDIENCE はどの構成でも設定しない（既定 townscan の検査を兼ねる）
phase_env() { # phase_env <構成> → ENVARGS
  case "$1" in
    empty|noauth) ENVARGS=() ;;                        # ログインの設定なし（AUTH_* が無い）
    main|dbdown)  ENVARGS=(-e "AUTH_ISSUER=$AUTH_ISSUER" -e "AUTH_JWKS_URL=$JWKS_URL") ;;
    badauth)      ENVARGS=(-e "AUTH_ISSUER=localhost:3500" -e "AUTH_JWKS_URL=$JWKS_URL") ;;  # 形が不正な URL（http(s) でない）
    jwksdown)     ENVARGS=(-e "AUTH_ISSUER=$AUTH_ISSUER" -e "AUTH_JWKS_URL=http://127.0.0.1:9/api/auth/jwks") ;;  # 届かない（接続拒否）
    *) echo "未知の構成: $1（使えるのは empty main noauth badauth jwksdown dbdown）" >&2; exit 2 ;;
  esac
}

LOADED=0
total_passed=0
total_failed=0
failed=0
declare -a report=()

load_data() {
  echo "== データを読み込む（python -m app.load --run /work/run）"
  loader_run python -m app.load --run /work/run
  LOADED=1
}

run_phase() { # run_phase <構成>
  local variant="$1" status line passed failed_n errors_n
  phase_env "$variant"
  if [ "$variant" = empty ]; then
    # 空の DB: 表だけがある（API の実装が表を作る・作らないに依らない）。データはまだ読み込まない
    loader_run python -c "import os, psycopg; from app.db import apply_schema; apply_schema(psycopg.connect(os.environ['DATABASE_URL'], autocommit=True))"
  elif [ "$LOADED" = 0 ]; then
    load_data
  fi

  echo "== 構成 $variant: API を起動する"
  start_api ${ENVARGS[@]+"${ENVARGS[@]}"}
  if ! runner_run "$RUNNER_IMAGE" python /contract/wait_ready.py "http://$API:$TARGET_PORT" --timeout 60; then
    echo "-- API のログ（末尾）" >&2; docker logs --tail 30 "$API" >&2 || true
    docker rm -f "$API" >/dev/null 2>&1 || true
    report+=("失敗   ${variant}（API が起動しませんでした）"); failed=1
    return 0
  fi
  if [ "$variant" = dbdown ]; then
    echo "-- DB を止める（${DB}）"
    docker stop -t 2 "$DB" >/dev/null
  fi

  echo "== 構成 $variant: 検査を流す"
  set +e
  runner_run --name "$RUNNER" \
    -e "API_BASE_URL=http://$API:$TARGET_PORT" -e "CONTRACT_VARIANT=$variant" \
    -e "CONTRACT_AUTH_ISSUER=$AUTH_ISSUER" -e "CONTRACT_JWKS_PORT=$JWKS_PORT" \
    "$RUNNER_IMAGE" python -m pytest -q --no-header -rfE ${PYTEST_ARGS[@]+"${PYTEST_ARGS[@]}"} 2>&1 | tee "$LOG"
  status=${PIPESTATUS[0]}
  set -e
  line="$(tail -n 1 "$LOG")"  # 例: "238 passed, 120 deselected in 3.42s"
  passed="$(echo "$line" | grep -Eo '[0-9]+ passed' | grep -Eo '[0-9]+' || true)"
  failed_n="$(echo "$line" | grep -Eo '[0-9]+ failed' | grep -Eo '[0-9]+' || true)"
  errors_n="$(echo "$line" | grep -Eo '[0-9]+ errors?' | grep -Eo '[0-9]+' || true)"
  total_passed=$((total_passed + ${passed:-0}))
  total_failed=$((total_failed + ${failed_n:-0} + ${errors_n:-0}))
  # 5 = 該当する検査が無い（-k などで絞ったとき、別の構成のものしか無い場合）。絞っていないときは失敗
  if [ "$status" = 0 ] || { [ "$status" = 5 ] && [ "${#PYTEST_ARGS[@]}" -gt 0 ]; }; then
    report+=("合格   ${variant}（${line}）")
  else
    report+=("失敗   ${variant}（終了コード ${status}。${line}）"); failed=1
    echo "-- API のログ（末尾）" >&2; docker logs --tail 15 "$API" >&2 || true
  fi
  docker rm -f "$API" >/dev/null 2>&1 || true
}

for variant in $PHASES; do
  run_phase "$variant"
done

echo
echo "== 契約の検査の結果（対象: ${TARGET}）"
printf '%s\n' ${report[@]+"${report[@]}"}
echo "合計: 合格 ${total_passed}・失敗 ${total_failed}・所要 $((SECONDS - started)) 秒（イメージのビルドを含む）"
exit "$failed"
