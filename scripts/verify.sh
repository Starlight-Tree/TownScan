#!/usr/bin/env bash
# 検査をまとめて流す。CI（.github/workflows/ci.yml）と同じ入口。
# 使い方: scripts/verify.sh [repo|backend|frontend|all]（省略時は all）
# 段が無い（コードがまだ無い）ものは「未実行」と出す。合格と区別するため、未実行は成功に数えない。
set -euo pipefail
cd "$(dirname "$0")/.."

target="${1:-all}"
failed=0
declare -a report=()

run() { # run <名前> <コマンド...>
  local name="$1"; shift
  if "$@"; then report+=("合格   $name"); else report+=("失敗   $name"); failed=1; fi
}

check_repo() {
  python3 -X utf8 - <<'PY'
import json, pathlib, re, subprocess, sys

root = pathlib.Path(".")
errors = []

# 1. 版の基準（.python-version・.node-version）と devcontainer.json の features が揃っているか
py = (root / ".python-version").read_text().strip()
node = (root / ".node-version").read_text().strip()
dc_text = (root / ".devcontainer/devcontainer.json").read_text(encoding="utf-8")
dc = json.loads("\n".join(l for l in dc_text.splitlines() if not l.strip().startswith("//")))
feat = dc.get("features", {})
fp = feat.get("ghcr.io/devcontainers/features/python:1", {}).get("version")
fn = feat.get("ghcr.io/devcontainers/features/node:2", {}).get("version")
if fp != py: errors.append(f"Python の版が不一致: .python-version={py} devcontainer.json={fp}")
if fn != node: errors.append(f"Node の版が不一致: .node-version={node} devcontainer.json={fn}")

# 2. 設定ファイルが JSON として読める
json.loads((root / ".claude/settings.json").read_text(encoding="utf-8"))

# 3. シェルスクリプトの構文
for sh in sorted(root.glob("scripts/*.sh")):
    r = subprocess.run(["bash", "-n", str(sh)], capture_output=True, text=True)
    if r.returncode: errors.append(f"構文エラー {sh}: {r.stderr.strip()}")

# 4. Markdown の相対リンクの先が存在するか（http・#・mailto は対象外）
link = re.compile(r"\[[^\]]*\]\(([^)\s]+)\)")
for md in sorted(root.rglob("*.md")):
    if any(p in md.parts for p in ("node_modules", ".git", "data")): continue
    for target in link.findall(md.read_text(encoding="utf-8")):
        if re.match(r"^(https?:|mailto:|#)", target): continue
        path = (md.parent / target.split("#")[0]).resolve()
        if not path.exists(): errors.append(f"リンク切れ {md}: {target}")

if errors:
    print("\n".join(errors), file=sys.stderr); sys.exit(1)
PY
}

run_stage() { # run_stage <名前> <ディレクトリ> — コードがまだ無い段は「未実行」
  local name="$1" dir="$2"
  if [ -d "$dir" ]; then
    report+=("未実行 $name（$dir はあるが、検査がまだ配線されていない。配線するまで合格と見なさない）"); failed=1
  else
    report+=("未実行 $name（$dir がまだ無い）")
  fi
}

case "$target" in repo|backend|frontend|all) ;; *) echo "使い方: $0 [repo|backend|frontend|all]" >&2; exit 2 ;; esac
[[ "$target" =~ ^(repo|all)$ ]] && run "repo（版の整合・設定・構文・リンク）" check_repo
[[ "$target" =~ ^(backend|all)$ ]] && run_stage "backend" backend
[[ "$target" =~ ^(frontend|all)$ ]] && run_stage "frontend" frontend

printf '%s\n' "${report[@]}"
exit "$failed"
