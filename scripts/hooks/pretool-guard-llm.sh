#!/usr/bin/env bash
# Claude Code の PreToolUse フック（Bash・Edit・Write）: api の LLM を、手で模擬にする操作を拒否する。
# 模擬は scripts/with-mock-llm.sh <コマンド> だけで使う（終わると自動で gemini へ戻る）。
# 拒否するもの: コマンドの先頭・; && || | の直後・export／env／-e／--env の直後・ほかの VAR=値 の直後に置いた LLM_PROVIDER=mock の代入。
#   Edit・Write は、compose.yaml と .env 系に、LLM_PROVIDER の既定を mock にする書き方（:-mock・=mock）を入れる操作。
# 通すもの: scripts/with-mock-llm.sh を含むコマンド。文章・heredoc の中の「LLM_PROVIDER=mock」の記述（代入の位置ではないため）。
# 失敗は通す側に倒す（フックの不具合で作業を止めない）。ガードであり、完全な防御ではない
#   （別のスクリプト・設定ファイル経由、Claude Code を通さない操作、MCP は防げない）。
exec python3 -I -c '
import json, re, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
tool = d.get("tool_name", "")
ti = d.get("tool_input") or {}
reason = None
if tool == "Bash":
    cmd = ti.get("command", "") or ""
    if "with-mock-llm.sh" not in cmd:
        pre = r"(?:^|[;&|(]\s*|\bexport\s+|\benv\s+|(?:-e|--env)[\s=]+|\b\w+=\S+\s+)"
        if re.search(pre + r"[\"\x27]?LLM_PROVIDER=[\"\x27]?mock\b", cmd.lstrip()):
            reason = "LLM_PROVIDER=mock を直接付ける操作は使いません。模擬の検証は scripts/with-mock-llm.sh <コマンド> を使ってください（終わると自動で gemini へ戻ります）。"
elif tool in ("Edit", "Write"):
    path = ti.get("file_path", "") or ""
    base = path.rsplit("/", 1)[-1]
    text = (ti.get("new_string") if tool == "Edit" else ti.get("content")) or ""
    if (base == "compose.yaml" or base.startswith(".env")) and re.search(r"LLM_PROVIDER[\"\x27]?\s*(?::-|=|:\s*[\"\x27]?)\s*[\"\x27]?mock\b", text):
        reason = "compose.yaml・.env に、LLM_PROVIDER の既定を mock にする書き方は入れません（既定は gemini。ユーザー決定 2026-11-25）。"
if reason:
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": reason}}, ensure_ascii=False))
'
