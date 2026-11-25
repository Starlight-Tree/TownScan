import type { BBox, ToolCall, ToolResult } from '../../lib/api-types';
import type { AnswerRef, ExpandRequest } from '../../lib/answer-view';
import type { ResultView } from '../../lib/result-view';

/** チャットの入力欄の id。拡大ビューを閉じるとき、開いたボタンが無ければ、フォーカスをここへ戻す */
export const CHAT_INPUT_ID = 'chat-input';

/**
 * 結果カードから親へ伝える操作。どれも、拡大ビュー（地図・グラフ・写真の比較）を開く。
 * 開くのは押したときだけ（回答が届いただけでは開かない）。どの回答のカードかは、ChatPanel が回答ごとに束ねて渡す
 */
export interface ResultActions {
  /** 候補の詳細を開く（写真の比較。地図もその候補へ寄せる） */
  openCandidate: (id: string) => void;
  /** 地図で、候補を目立たせ、範囲へ寄せて開く */
  focusMap: (target: { bbox: BBox; candidateIds: string[] }) => void;
  /** サジェスト（お断りの提案）を質問として送る */
  ask: (text: string) => void;
  /**
   * 拡大ビューを、その画面（地図・グラフ・写真の比較）で開く。
   * 絞り込みは、そのカードを含む回答の結果から決まる（はじめて開くとき）。開き直すときは、利用者が変えた絞り込みのまま
   */
  showView: (view: ResultView) => void;
}

/** ChatPanel が親（HomeClient）に頼む操作 */
export interface ChatActions {
  /**
   * 拡大ビューを開く。answer は、押したボタンのある回答（最初の画面のボタンは null）。拡大の単位は回答 1 件で、状態は回答ごとに保つ。
   * opener は、押したボタン。閉じたとき、フォーカスをここへ戻す（無い・外れているときは、チャットの入力欄）
   */
  expand: (answer: AnswerRef | null, request: ExpandRequest, opener: HTMLElement | null) => void;
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
