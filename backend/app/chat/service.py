"""チャット 1 往復: messages → ツール呼び出し → 結果 → 返答文 → 数字の検査 → 返答。"""

from __future__ import annotations

import psycopg

from .. import queries
from .guard import guard_numbers
from .mock_model import MockModel
from .tools import ToolContext, ToolRegistry, refusal

# 文脈に使うのは、送られた messages の末尾だけ（会話の全履歴を送ってくる client でも、受け付ける。上限は routes.MAX_CHAT_MESSAGES）
CONTEXT_MESSAGES = 20
NO_DATA_MESSAGE = "データがまだ読み込まれていません。python -m app.load で、pipeline の出力を読み込んでください。"


def answer(conn: psycopg.Connection, registry: ToolRegistry, messages: list[dict]) -> dict:
    messages = messages[-CONTEXT_MESSAGES:]
    run = queries.current_run(conn)
    if run is None:
        results = [refusal("no_data", NO_DATA_MESSAGE, [])]
        calls = [{"name": "refuse", "args": {"reason": "no_data"}}]
        content = NO_DATA_MESSAGE
    else:
        ctx = ToolContext(conn=conn, run=run, areas=queries.list_areas(conn, run["run_id"]))
        model = MockModel(ctx.areas)
        calls = model.plan(messages)
        results = [registry.call(ctx, c["name"], c["args"]) for c in calls]
        content = model.compose(results)
    # 返答文の数字は、結果の値だけから出ていること。満たさなければ返さず、安全なテンプレートにする
    content = guard_numbers(content, results)
    return {"message": {"role": "assistant", "content": content, "results": results, "tool_calls": calls}}
