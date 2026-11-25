import type { BBox, ToolCall, ToolResult } from '../../lib/api-types';
import type { AnswerRef, ExpandRequest } from '../../lib/answer-view';

/** チャットの入力欄の id。拡大ビューを閉じるとき、開いたボタンが無ければ、フォーカスをここへ戻す */
export const CHAT_INPUT_ID = 'chat-input';

/**
 * 結果カードから親へ伝える操作。拡大ビュー（地図・グラフ・写真の比較）を開くものと、質問を送るもの。
 * 開くのは押したときだけ（回答が届いただけでは開かない）。どの回答のカードかは、ChatPanel が回答ごとに束ねて渡す。
 * グラフ・地図そのものは、回答の中の図（ChatPanel の renderFigure）に出る。カードのボタンは、図では足りない動作（候補を目立たせて寄せる・詳細）だけ
 */
export interface ResultActions {
  /** 候補の詳細を開く（写真の比較。地図もその候補へ寄せる） */
  openCandidate: (id: string) => void;
  /** 地図で、候補を目立たせ、範囲へ寄せて開く */
  focusMap: (target: { bbox: BBox; candidateIds: string[] }) => void;
  /** サジェスト（お断りの提案）を質問として送る */
  ask: (text: string) => void;
}

/** ChatPanel が親（HomeClient）に頼む操作 */
export interface ChatActions {
  /**
   * 拡大ビューを開く。answer は、押したボタンのある回答（最初の画面のボタンは null）。拡大の単位は回答 1 件で、状態は回答ごとに保つ（回答の中の図と共有する）。
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
  /**
   * 質問を送った時刻（ISO 8601）。利用者の発言だけが持ち、端末で作る（回答には付けない）。質問の前に、薄い時刻として出す（lib/sentAt.ts）。
   * 画面の表示のためだけの値で、API へは送らない（履歴は役割と本文だけ。history.ts）
   */
  sentAt?: string;
  results?: ToolResult[];
  tool_calls?: ToolCall[];
  /**
   * 保存した会話を開き直して並べた回答だけが持つ（この画面で届いた回答は持たない）。runCreatedAt は、その回答を作ったときの run の created_at
   * （run が無かった回答は null）。いまの解析結果と食い違うかを調べるのに使う（components/chat/conversation.ts の runCheck。仕様 §7.1.5）
   */
  restored?: { runCreatedAt: string | null };
  /** 回答の下に 1 回だけ出す注記（保存を飛ばして送り直した回答。仕様 §7.1.7） */
  notice?: string;
}
