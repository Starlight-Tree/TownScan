#!/usr/bin/env bash
# フックの検査（ホストで実行。curl・python3 が要る）。使い方: scripts/hooks/test-hooks.sh
set -uo pipefail
cd "$(dirname "$0")"
fail=0
check() { # 名前 期待(block|pass) 実際の出力
  local name="$1" want="$2" out="$3" got=pass
  case "$out" in *'"decision":"block"'*|*'"permissionDecision": "deny"'*) got=block ;; esac
  if [ "$got" = "$want" ]; then echo "ok   $name"; else echo "FAIL $name（期待 $want・実際 $got）"; fail=1; fi
}
# --- Stop: 確認先を、こちらで立てた小さなサーバーに向ける
tmp="$(mktemp -d)"; trap 'kill "$srv" 2>/dev/null; rm -rf "$tmp"' EXIT
serve() { # 応答の llm 値
  printf '{"status":"ok","llm":"%s"}' "$1" > "$tmp/api-health"
  mkdir -p "$tmp/api"; cp "$tmp/api-health" "$tmp/api/health"
}
serve mock
( cd "$tmp" && exec python3 -I -m http.server 18599 --bind 127.0.0.1 >/dev/null 2>&1 ) & srv=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do curl -fsS --max-time 1 http://127.0.0.1:18599/api/health >/dev/null 2>&1 && break; sleep 0.3; done
export LLM_HEALTH_URL=http://127.0.0.1:18599/api/health
check "Stop: mock で 1 回目は止める"           block "$(echo '{"stop_hook_active":false}' | ./stop-check-llm.sh)"
check "Stop: mock でも stop_hook_active なら通す" pass  "$(echo '{"stop_hook_active": true}' | ./stop-check-llm.sh)"
serve gemini
check "Stop: gemini なら通す"                   pass  "$(echo '{}' | ./stop-check-llm.sh)"
export LLM_HEALTH_URL=http://127.0.0.1:1/api/health
check "Stop: api に届かなければ通す"             pass  "$(echo '{}' | ./stop-check-llm.sh)"
# --- PreToolUse
pre() { printf '%s' "$1" | ./pretool-guard-llm.sh; }
bash_in() { python3 -I -c 'import json,sys; print(json.dumps({"tool_name":"Bash","tool_input":{"command":sys.argv[1]}}))' "$1"; }
check "Pre: 直接の代入を拒否"                  block "$(pre "$(bash_in 'LLM_PROVIDER=mock scripts/dev-up.sh')")"
check "Pre: export を拒否"                     block "$(pre "$(bash_in 'cd x && export LLM_PROVIDER=mock; docker compose up -d')")"
check "Pre: env を拒否"                        block "$(pre "$(bash_in 'env LLM_PROVIDER=mock docker compose up -d api')")"
check "Pre: 別の変数の後ろの代入を拒否"          block "$(pre "$(bash_in 'WEB_BUILD=host LLM_PROVIDER=mock scripts/dev-up.sh')")"
check "Pre: docker -e を拒否"                  block "$(pre "$(bash_in 'docker run -e LLM_PROVIDER=mock img')")"
check "Pre: with-mock-llm.sh は通す"           pass  "$(pre "$(bash_in 'scripts/with-mock-llm.sh curl -s http://127.0.0.1:8500/api/health')")"
check "Pre: gemini の代入は通す"               pass  "$(pre "$(bash_in 'LLM_PROVIDER=gemini scripts/dev-up.sh')")"
check "Pre: 文章・heredoc の中の記述は通す"      pass  "$(pre "$(bash_in $'python3 - <<EOF\nprint("使い方: `LLM_PROVIDER=mock scripts/dev-up.sh`")\nEOF')")"
check "Pre: grep の検索語は通す"                pass  "$(pre "$(bash_in "git grep -n 'LLM_PROVIDER=mock' -- docs")")"
check "Pre: compose.yaml に既定 mock を書くのを拒否" block "$(pre '{"tool_name":"Edit","tool_input":{"file_path":"/p/compose.yaml","new_string":"LLM_PROVIDER: \"${LLM_PROVIDER:-mock}\""}}')"
check "Pre: docs への Edit は通す"              pass  "$(pre '{"tool_name":"Edit","tool_input":{"file_path":"/p/docs/a.md","new_string":"LLM_PROVIDER=mock"}}')"
check "Pre: 壊れた入力は通す"                   pass  "$(pre 'not json')"
exit "$fail"
