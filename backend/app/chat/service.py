"""チャット 1 往復: messages → ツール呼び出し → 結果 → 返答文 → 数字の検査 → 返答。

返答文を作るのは、既定は模擬モデル（規則）、LLM_PROVIDER=gemini のときは Gemini（function calling）。
どちらも、結果（results）は ToolRegistry が DB から作り、返答文は同じ guard_numbers を通る。
"""

from __future__ import annotations

import itertools
import logging

import psycopg

from .. import queries
from .gemini_model import GeminiClient, GeminiModel
from .guard import guard_numbers
from .mock_model import MockModel
from .tools import ToolContext, ToolRegistry, refusal

log = logging.getLogger("townscan")

# 文脈に使うのは、送られた messages の末尾だけ（会話の全履歴を送ってくる client でも、受け付ける。上限は routes.MAX_CHAT_MESSAGES）
CONTEXT_MESSAGES = 20
NO_DATA_MESSAGE = "データがまだ読み込まれていません。python -m app.load で、pipeline の出力を読み込んでください。"

# LLM の文を guard が替えた回数（このプロセスの通算。回数だけ数える。本文はログに出さない）
_guard_replacements = itertools.count(1)


def answer(conn: psycopg.Connection, registry: ToolRegistry, messages: list[dict], llm: GeminiClient | None = None) -> dict:
    """llm が None なら模擬モデル。実 LLM が使えないときは、gemini_model.LlmUnavailable を上げる（模擬には切り替えない）。"""
    messages = messages[-CONTEXT_MESSAGES:]
    run = queries.current_run(conn)
    from_llm = False
    if run is None:
        results = [refusal("no_data", NO_DATA_MESSAGE, [])]
        calls = [{"name": "refuse", "args": {"reason": "no_data"}}]
        content = NO_DATA_MESSAGE
    else:
        ctx = ToolContext(conn=conn, run=run, areas=queries.list_areas(conn, run["run_id"]))
        if llm is None:
            model = MockModel(ctx.areas)
            calls = model.plan(messages)
            results = [registry.call(ctx, c["name"], c["args"]) for c in calls]
            content = model.compose(results)
        else:
            calls, results, content = GeminiModel(llm, ctx.areas).run(ctx, registry, messages)
            from_llm = True
    # 返答文の数字は、結果の値だけから出ていること。満たさなければ返さず、安全なテンプレートにする
    guarded = guard_numbers(content, results)
    if from_llm and guarded != content:
        log.warning("LLM の返答文を安全なテンプレートに差し替えました（通算 %d 回）", next(_guard_replacements))
    return {"message": {"role": "assistant", "content": guarded, "results": results, "tool_calls": calls}}
