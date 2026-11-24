#!/usr/bin/env bash
# 開発コンテナの Python 環境を作る（何度流しても同じ。コンテナを作り直すと venv は消えるので、そのとき流す）。
# 使い方（開発コンテナの中で）: scripts/setup-dev.sh
# venv はコンテナの中（~/.venvs/townscan）に置く。ホストの作業ツリーに Linux 用の実行ファイルを書かないため。
set -euo pipefail
cd "$(dirname "$0")/.."

VENV="${TOWNSCAN_VENV:-$HOME/.venvs/townscan}"
if [ ! -x "$VENV/bin/python" ]; then
  python -m venv "$VENV"
fi
"$VENV/bin/python" -m pip install --quiet --upgrade pip
if [ -f requirements.txt ]; then
  "$VENV/bin/pip" install --quiet -r requirements.txt
else
  echo "requirements.txt が無いので requirements.in から入れる（版を固定するには、入れたあとに pip freeze で requirements.txt を作る）" >&2
  "$VENV/bin/pip" install --quiet -r requirements.in
fi
echo "venv: $VENV"
"$VENV/bin/python" - <<'PY'
import importlib.metadata as m
for name in ("numpy", "pillow", "shapely", "pyproj", "rasterio", "pytest"):
    print(f"  {name} {m.version(name)}")
PY
