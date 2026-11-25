#!/usr/bin/env bash
# api の LLM を一時的に模擬にして、コマンドを 1 つ流し、終わったら（失敗・中断でも）必ず既定（gemini）へ戻す。
# 使うのは Claude Code の内部の検証だけ（利用者は使わない。ユーザー決定 2026-11-25）。戻し忘れを仕組みで防ぐための入口で、
# 模擬へ手で切り替える（LLM_PROVIDER=mock scripts/dev-up.sh など）代わりに、こちらを使う。
# 使い方: scripts/with-mock-llm.sh <コマンド> [引数…]      例: scripts/with-mock-llm.sh curl -s http://127.0.0.1:8500/api/health
# やること: api だけを作り直す（イメージ・web・db は触らない）→ /api/health の llm が mock になるのを待つ → コマンド →
#          （終了時）api を既定へ作り直す → llm が gemini に戻ったのを確かめる。戻せなかったときは、非 0 で終わり、理由を出す。
# 秘密の置き場は dev-up.sh と同じ（TOWNSCAN_INFISICAL_PROJECT_ID があれば infisical run、無ければ .env）。値は表示しない。
set -uo pipefail
cd "$(dirname "$0")/.."

die() { echo "エラー: $*" >&2; exit 1; }
[ $# -gt 0 ] || die "使い方: scripts/with-mock-llm.sh <コマンド> [引数…]"
command -v docker >/dev/null || die "docker が見つかりません（ホストで実行してください）"

HEALTH_URL="http://127.0.0.1:8500/api/health"
INFISICAL_PROJECT="${TOWNSCAN_INFISICAL_PROJECT_ID:-}"
INFISICAL_ENV="${TOWNSCAN_INFISICAL_ENV:-dev}"

# api を作り直す（$1 = mock のとき模擬、空のとき既定）。LLM_PROVIDER は、ここで明示的に付ける・外す
recreate_api() {
  if [ -n "$INFISICAL_PROJECT" ]; then
    if [ -n "$1" ]; then
      LLM_PROVIDER="$1" infisical run --projectId "$INFISICAL_PROJECT" --env "$INFISICAL_ENV" -- docker compose up -d --no-deps --force-recreate api >/dev/null
    else
      env -u LLM_PROVIDER infisical run --projectId "$INFISICAL_PROJECT" --env "$INFISICAL_ENV" -- docker compose up -d --no-deps --force-recreate api >/dev/null
    fi
  else
    if [ -n "$1" ]; then
      LLM_PROVIDER="$1" docker compose up -d --no-deps --force-recreate api >/dev/null
    else
      env -u LLM_PROVIDER docker compose up -d --no-deps --force-recreate api >/dev/null
    fi
  fi
}

# /api/health の llm が $1 になるのを待つ（最大 90 秒）
wait_llm() {
  local want="$1" deadline=$((SECONDS + 90)) body got
  while [ "$SECONDS" -lt "$deadline" ]; do
    body="$(curl -fsS -m 3 "$HEALTH_URL" 2>/dev/null || true)"
    got="$(printf '%s' "$body" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("llm",""))
except Exception: print("")' 2>/dev/null)"
    [ "$got" = "$want" ] && return 0
    sleep 2
  done
  return 1
}

restore() {
  local status=$?
  trap - EXIT INT TERM
  echo "== 既定の LLM（gemini）へ戻す" >&2
  if recreate_api "" && wait_llm gemini; then
    echo "== 戻しました: /api/health の llm = gemini" >&2
    exit "$status"
  fi
  echo "エラー: gemini へ戻せませんでした（キーが無い・api が起動しない、など）。scripts/dev-up.sh を流して戻してください。いまの api は模擬のままか、止まっている可能性があります" >&2
  exit 1
}
trap restore EXIT INT TERM

echo "== api を模擬の LLM で作り直す（このコマンドの間だけ。終わったら自動で gemini へ戻す）" >&2
recreate_api mock || die "api を模擬で作り直せませんでした"
wait_llm mock || die "api の llm が mock になりませんでした"

"$@"
