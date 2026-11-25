'use client';

import { createContext, useContext } from 'react';
import type { ToolCall } from '../../lib/api-types';

/**
 * この結果カードを作ったツール呼び出し（回答の tool_calls の、同じ順番の 1 件）。
 * 「根拠を見る」の中で見せる（回答の下に、別の「使ったツール」の行は出さない）。結果と呼び出しの数が合わないときは、渡さない
 */
export const ToolCallContext = createContext<ToolCall | null>(null);

export function useToolCall(): ToolCall | null {
  return useContext(ToolCallContext);
}
