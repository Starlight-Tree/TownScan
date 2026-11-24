import type { BBox, MapFocusResult, ToolCall, ToolResult } from '../../lib/api-types';

/** 結果カードから親（地図・ドロワー）へ伝える操作 */
export interface ResultActions {
  /** 候補の詳細を開く（地図もその候補へ寄せる） */
  openCandidate: (id: string) => void;
  /** 地図を範囲へ寄せ、候補を目立たせる */
  focusMap: (target: { bbox: BBox; candidateIds: string[] }) => void;
  /** サジェスト（お断りの提案）を質問として送る */
  ask: (text: string) => void;
}

export interface ChatEntry {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** 送信に失敗した発言（サーバーには届いていない。次の質問の履歴に含めない） */
  failed?: boolean;
  results?: ToolResult[];
  tool_calls?: ToolCall[];
}

export function isMapFocus(result: ToolResult): result is MapFocusResult {
  return result.type === 'map_focus';
}
