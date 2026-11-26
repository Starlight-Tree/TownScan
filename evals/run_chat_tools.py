#!/usr/bin/env python3
"""チャットが、質問ごとに期待したツールを呼ぶかを測る（docs/plan.md の P4 の出口条件）。

手元で動いている API（実データを読み込んだもの）に、1 問ずつ送る。判定するのは、呼んだツールの名前と、
結果の絞り込み（範囲・分類）か断りの理由だけ。返答の本文は判定しない（人が読むときは --show-replies）。

何も付けないと、送らずに件数だけを出す。送るのは --run。API の LLM が実 Gemini のときは、
質問文とツールの結果が Google へ送られるので、--real も要る。標準ライブラリだけで動く。
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

CASES = Path(__file__).with_name("chat_tool_cases.json")
LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}
# 実 Gemini は、1 問で、ツールを選ぶ呼び出しと本文を書く呼び出しの、約 2 回（再試行があれば増える）
CALLS_PER_QUESTION = 2


def judge(case: dict, reply: dict) -> list[str]:
    """期待と違う点の一覧（空なら合格）。"""
    names = [c.get("name") for c in reply.get("tool_calls") or []]
    if names != [case["tool"]]:
        return [f"ツール: 期待 {case['tool']} / 実際 {', '.join(map(str, names)) or 'なし'}"]
    results = reply.get("results") or []
    if len(results) != 1:
        return [f"結果の数: 期待 1 / 実際 {len(results)}"]
    result = results[0]
    problems = []
    if "reasons" in case:
        if result.get("type") != "refusal" or result.get("reason") not in case["reasons"]:
            problems.append(f"断りの理由: 期待 {'・'.join(case['reasons'])} / 実際 {result.get('reason') or result.get('type')}")
    elif result.get("type") == "refusal":
        problems.append(f"断った: {result.get('reason')}")
    for key, want in (case.get("filter") or {}).items():
        got = (result.get("filter") or {}).get(key, "")
        if got != want:
            problems.append(f"{key}: 期待 {want or '指定なし'} / 実際 {got or '指定なし'}")
    return problems


def request(url: str, body: dict | None = None) -> dict:
    data = None if body is None else json.dumps(body).encode()
    headers = {} if data is None else {"Content-Type": "application/json"}
    with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=headers), timeout=90) as res:
        return json.load(res)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--run", action="store_true", help="API へ質問を送る")
    parser.add_argument("--real", action="store_true", help="API の LLM が実 Gemini でも送る")
    parser.add_argument("--base", default="http://127.0.0.1:8500", help="手元の API の URL")
    parser.add_argument("--interval", type=float, help="質問の間隔（秒）。既定は、実 Gemini が 7、模擬が 0")
    parser.add_argument("--only", nargs="+", metavar="ID", help="この id の質問だけ")
    parser.add_argument("--show-replies", action="store_true", help="返答の本文も出す（判定には使わない）")
    args = parser.parse_args()

    cases = json.loads(CASES.read_text(encoding="utf-8"))
    if args.only:
        unknown = set(args.only) - {c["id"] for c in cases}
        if unknown:
            parser.error(f"知らない id: {', '.join(sorted(unknown))}")
        cases = [c for c in cases if c["id"] in args.only]
    if urllib.parse.urlsplit(args.base).hostname not in LOCAL_HOSTS:
        parser.error("--base は手元の API（127.0.0.1・localhost）だけ")

    print(f"質問 {len(cases)} 件（実 Gemini なら、呼び出しは約 {len(cases) * CALLS_PER_QUESTION} 回）")
    if not args.run:
        print("何も送っていません。送るには --run を付けます。")
        return 0

    try:
        health = request(f"{args.base}/api/health")
    except (urllib.error.URLError, OSError, ValueError) as e:
        print(f"API に届きません: {e}", file=sys.stderr)
        return 2
    llm = health.get("llm")
    if llm != "mock" and not args.real:
        print(f"API の LLM は {llm} です。実 API を呼ぶには --real を付けます。", file=sys.stderr)
        return 2
    run_kind = (health.get("run") or {}).get("kind")
    if run_kind != "real":
        print(f"実データが読み込まれていません（run の種類: {run_kind}）。質問の地区名は実データのものです。", file=sys.stderr)
        return 2
    interval = args.interval if args.interval is not None else (0.0 if llm == "mock" else 7.0)
    print(f"LLM: {llm} {health.get('llm_model', '') if llm != 'mock' else ''}".rstrip())

    passed = 0
    for i, case in enumerate(cases):
        if i and interval:
            time.sleep(interval)
        content = None
        try:
            data = request(f"{args.base}/api/chat", {"messages": [{"role": "user", "content": case["question"]}]})
            reply = data.get("message", data)
            problems = judge(case, reply)
            content = reply.get("content")
        except urllib.error.HTTPError as e:
            problems = [f"HTTP {e.code}"]
        except (urllib.error.URLError, OSError, ValueError) as e:
            problems = [f"通信の失敗: {e}"]
        passed += not problems
        print(f"{'合格  ' if not problems else '不合格'} {case['id']}" + (f"  {' / '.join(problems)}" if problems else ""), flush=True)
        if args.show_replies and content is not None:
            print(f"       問: {case['question']}\n       答: {content}", flush=True)

    print(f"結果: {passed}／{len(cases)} 件が合格")
    return 0 if passed == len(cases) else 1


if __name__ == "__main__":
    sys.exit(main())
