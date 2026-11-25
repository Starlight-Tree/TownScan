#!/usr/bin/env bash
# 検査をまとめて流す。CI（.github/workflows/ci.yml）と同じ入口。仕様: docs/spec-prototype.md §8（E1〜E4）
# 使い方: scripts/verify.sh [repo|pipeline|loader|contract|frontend|all]（省略時は all）
#   repo      版の整合・設定・構文・リンク。軽く、どこでも流せる。
#   pipeline  pipeline/tests の単体テスト（pytest）。.python-version と同じ版の Python と、requirements.txt の依存が要る。
#             見つからなければ、開発コンテナの venv（~/.venvs/townscan）でテストを流す（ホストから devcontainer exec）。
#   loader    scripts/test-loader.sh（ローダーの DB のテスト pipeline/dbtests とスクリプトのテスト scripts/tests。使い捨ての Postgres で pytest）。Docker が要る。開発コンテナの中では Docker が無いので流せない。
#   contract  scripts/test-contract.sh（API の契約の検査 contract/。使い捨ての Postgres と API を起動して HTTP で叩く）。Docker が要る。コンテナの中では流せない。
#   frontend  frontend の npm ci → npm run verify（型検査・lint・テスト・next build）。Node 24 が要る。
#             Node が 24 でなければ npx で Node 24 を得る。コンテナの中では流さない（Docker VM の空きメモリーが少ない。仕様 §2）。
# 流せる環境が無い段（docker が無い・依存が入っていない・コンテナの中など）は、合格にせず「未実行（理由）」と出して失敗扱いにする。
# 段のディレクトリがまだ無いものだけは、「未実行」と出すが失敗には数えない（コードがまだ無いだけ）。
# 環境変数（どれも省略できる）:
#   TOWNSCAN_PYTHON            pipeline の検査に使う python（依存入り）。省略時は ~/.venvs/townscan → python3 → python の順に探す
#   TOWNSCAN_VENV              開発コンテナの venv（既定 ~/.venvs/townscan）
#   VERIFY_ALLOW_CONTAINER=1   frontend をコンテナの中でも流す（Docker VM に空きメモリーがあると確かめたときだけ）
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

skip() { # skip <名前> <理由> — 環境が無くて流せない段。合格にせず、失敗扱いにする（偽の合格を作らない）
  report+=("未実行 ${1}（${2}）"); failed=1
}

in_container() { [ -f /.dockerenv ] || [ -n "${REMOTE_CONTAINERS:-}" ]; }

# pipeline: 依存（requirements.txt）が入っていて、版が .python-version と同じ Python なら終了コード 0
PIPELINE_PROBE='import sys, numpy, PIL, shapely, pyproj, rasterio, pytest; sys.exit(sys.version_info[:2] != tuple(map(int, open(".python-version").read().split(".")[:2])))'

check_pipeline() {
  local py="" c
  for c in "${TOWNSCAN_PYTHON:-}" "${TOWNSCAN_VENV:-$HOME/.venvs/townscan}/bin/python" python3 python; do
    if [ -n "$c" ] && command -v "$c" >/dev/null 2>&1 && "$c" -c "$PIPELINE_PROBE" >/dev/null 2>&1; then py="$c"; break; fi
  done
  if [ -n "$py" ]; then
    run "pipeline（単体テスト）" "$py" -m pytest pipeline/tests -q -p no:cacheprovider
  elif command -v devcontainer >/dev/null 2>&1 && command -v docker >/dev/null 2>&1; then
    # ホスト: 開発コンテナの venv で流す（CLAUDE.md の運用。コンテナは起動済みであること。ここでは起動しない）
    local venv_py='~/.venvs/townscan/bin/python'  # コンテナの中で展開する
    if devcontainer exec --workspace-folder . bash -lc "$venv_py -c \"\$0\"" "$PIPELINE_PROBE" >/dev/null 2>&1; then
      run "pipeline（単体テスト・開発コンテナの中）" \
        devcontainer exec --workspace-folder . bash -lc "$venv_py -m pytest pipeline/tests -q -p no:cacheprovider"
    else
      skip "pipeline（単体テスト）" "開発コンテナで依存を確かめられなかった。townscan-devcontainer が起動していない、venv が無い、依存が足りない、のどれか。コンテナの中で scripts/setup-dev.sh を流す"
    fi
  else
    skip "pipeline（単体テスト）" "Python $(cat .python-version) と requirements.txt の依存が見つからず、devcontainer・docker も無い。scripts/setup-dev.sh か pip install -r requirements.txt"
  fi
}

check_loader() {
  if ! command -v docker >/dev/null 2>&1 || ! command -v openssl >/dev/null 2>&1; then
    skip "loader（pytest・使い捨ての Postgres）" "docker か openssl が無い。DB のテストは docker で使い捨ての Postgres を起動する。ホストか CI で流す"
  elif ! docker info >/dev/null 2>&1; then
    skip "loader（pytest・使い捨ての Postgres）" "Docker が動いていない"
  else
    run "loader（pytest・使い捨ての Postgres）" bash scripts/test-loader.sh
  fi
}

check_contract() {
  if ! command -v docker >/dev/null 2>&1 || ! command -v openssl >/dev/null 2>&1; then
    skip "contract（API の契約の検査）" "docker か openssl が無い。使い捨ての Postgres と API を docker で起動する。ホストか CI で流す"
  elif ! docker info >/dev/null 2>&1; then
    skip "contract（API の契約の検査）" "Docker が動いていない"
  else
    run "contract（API の契約の検査・使い捨ての Postgres と API）" bash scripts/test-contract.sh go
  fi
}

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true; }

# Node $1 で npm ci → npm run verify（型検査 → lint → テスト → next build）。サブシェルなので cd は呼び出し元に残らない
check_frontend_cmd() (
  cd frontend || exit 1
  if [ "$(node_major)" = "$1" ]; then
    npm ci && npm run verify
  else
    npx -y -p "node@$1" -- sh -c 'npm ci && npm run verify'
  fi
)

check_frontend() {
  local name="frontend（型検査・lint・テスト・next build）" want
  want="$(cut -d. -f1 .node-version)"
  if in_container && [ "${VERIFY_ALLOW_CONTAINER:-0}" != 1 ]; then
    skip "$name" "コンテナの中では流さない。Docker VM の空きメモリーが少なく、next build で他のコンテナが落ちる恐れがある（仕様 §2 参照）。ホストで scripts/verify.sh frontend を流す"
  elif [ "$(node_major)" = "$want" ] || command -v npx >/dev/null 2>&1; then
    run "$name" check_frontend_cmd "$want"
  else
    skip "$name" "Node ${want} も npx も無い。CI は setup-node、ホストは npx -y -p node@${want} で得る"
  fi
}

run_stage() { # run_stage <名前> <ディレクトリ> <段の関数> — ディレクトリが無い（コードがまだ無い）段は、未実行と出して失敗には数えない
  local name="$1" dir="$2" fn="$3"
  if [ -d "$dir" ]; then "$fn"; else report+=("未実行 ${name}（${dir} がまだ無い）"); fi
}

usage() { echo "使い方: $0 [repo|pipeline|loader|contract|frontend|all]" >&2; exit 2; }
[ "$#" -le 1 ] || usage
case "$target" in repo|pipeline|loader|contract|frontend|all) ;; *) usage ;; esac

selected() { [ "$target" = all ] || [ "$target" = "$1" ]; }
if selected repo; then run "repo（版の整合・設定・構文・リンク）" check_repo; fi
if selected pipeline; then run_stage "pipeline" pipeline check_pipeline; fi
if selected loader; then run_stage "loader" pipeline/dbtests check_loader; fi
if selected contract; then run_stage "contract" contract check_contract; fi
if selected frontend; then run_stage "frontend" frontend check_frontend; fi

printf '%s\n' "${report[@]}"
exit "$failed"
