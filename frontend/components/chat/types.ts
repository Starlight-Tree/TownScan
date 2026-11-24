import type { BBox, MapFocusResult, ToolCall, ToolResult } from '../../lib/api-types';
import type { MapFilter, ResultView } from '../../lib/result-view';

/** 結果カードから親（HomeClient。右の結果領域の「地図」「グラフ」「写真の比較」）へ伝える操作 */
export interface ResultActions {
  /** 候補の詳細を開く（地図もその候補へ寄せる） */
  openCandidate: (id: string) => void;
  /** 地図を範囲へ寄せ、候補を目立たせる */
  focusMap: (target: { bbox: BBox; candidateIds: string[] }) => void;
  /** サジェスト（お断りの提案）を質問として送る */
  ask: (text: string) => void;
  /**
   * 右の結果領域の画面（地図・グラフ・写真の比較）を切り替える。
   * filter を渡すと、地図・グラフの絞り込みをその条件に替えてから切り替える（回答のカードの「グラフで見る」は、そのカードの条件で開く）。渡さなければ、いまの絞り込みのまま
   */
  showView: (view: ResultView, filter?: MapFilter) => void;
}

/** ChatPanel が親（HomeClient）に頼む操作。結果カードの操作のうち親が持つ分に、回答が届いた通知を足したもの */
export type ChatActions = Pick<ResultActions, 'openCandidate' | 'focusMap' | 'showView'> & {
  /** 回答が届いたとき、その回答の道具の結果を伝える（右の結果領域が、合う画面と絞り込みへ自動で切り替わる。lib/result-view.ts の viewForResults・filterFromResults） */
  answered: (results: ToolResult[]) => void;
};

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
