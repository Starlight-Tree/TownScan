#!/usr/bin/env bash
# Claude Code の Stop フック: 返答を終えるとき、api の LLM が模擬のままなら、1 回だけ止めて戻させる。
# 止めるのは「api が答え、llm が gemini 以外のとき」だけ。次は何もせず通す（止めない）:
#   ・stop_hook_active が true（すでに 1 回止めた。無限ループを防ぐ）  ・api が止まっている／届かない／遅い（確認の通信は最大 2 秒）
#   ・応答が読めない  ・llm が gemini
# 背景: 模擬は Claude Code の内部の検証だけ（利用者は使わない。ユーザー決定 2026-11-25）。ガードであり、完全な防御ではない
#       （Claude Code を通さない操作・別の端末からの切り替え・Stop が動かない環境では検知できない）。
# テスト用に、確認先は LLM_HEALTH_URL で替えられる。
input="$(cat)"
if printf '%s' "$input" | grep -Eq '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then exit 0; fi
body="$(curl -fsS --max-time 2 "${LLM_HEALTH_URL:-http://127.0.0.1:8500/api/health}" 2>/dev/null)" || exit 0
llm="$(printf '%s' "$body" | grep -Eo '"llm"[[:space:]]*:[[:space:]]*"[a-z]*"' | head -1 | sed -E 's/.*"([a-z]*)"$/\1/')"
[ -n "$llm" ] || exit 0
[ "$llm" != "gemini" ] || exit 0
printf '%s\n' '{"decision":"block","reason":"api の LLM が '"$llm"' のままです（既定は gemini）。模擬へ手で切り替えたなら、scripts/dev-up.sh を付けずに流して戻し、/api/health の llm が gemini になったことを確かめてから終えてください。模擬の検証は scripts/with-mock-llm.sh <コマンド> を使うと、自動で戻ります。"}'
exit 0
