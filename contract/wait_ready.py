"""API が `GET /api/health` に 200 を返すまで待つ（標準ライブラリだけ）。scripts/test-contract.sh が、構成ごとの起動のあとに使う。

使い方: python contract/wait_ready.py http://townscan-contract-api:8000 [--timeout 60]
終了コード: 0 = 200 が返った / 1 = 期限までに返らなかった（最後の状態を出す）
"""

from __future__ import annotations

import argparse
import http.client
import sys
import time
from urllib.parse import urlsplit


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("base_url")
    ap.add_argument("--timeout", type=float, default=60.0)
    ns = ap.parse_args()
    parts = urlsplit(ns.base_url)
    deadline = time.monotonic() + ns.timeout
    last = "まだ接続していません"
    while time.monotonic() < deadline:
        try:
            conn = http.client.HTTPConnection(parts.hostname, parts.port or 80, timeout=3)
            conn.request("GET", "/api/health")
            status = conn.getresponse().status
            conn.close()
            if status == 200:
                return 0
            last = f"/api/health が {status}"
        except OSError as exc:
            last = f"{type(exc).__name__}: {exc}"
        time.sleep(0.5)
    print(f"API が {ns.timeout:.0f} 秒以内に準備できませんでした（{last}）", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
