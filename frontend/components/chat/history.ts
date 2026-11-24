import type { ChatRequestMessage } from '../../lib/api-types';
import type { ChatEntry } from './types';

// API（backend/app/routes.py の ChatRequest・ChatMessage）の上限。超えると 422 になり、以後の質問も同じ履歴で失敗し続ける
export const MAX_CONTENT_LENGTH = 2000;
export const MAX_MESSAGES = 40;

// サーバーは文字数を Unicode のコードポイントで数える。JS の length より多く数えることは無いので、コードポイントで切る
function clip(text: string): string {
  const chars = Array.from(text);
  return chars.length > MAX_CONTENT_LENGTH ? chars.slice(0, MAX_CONTENT_LENGTH).join('') : text;
}

/**
 * 画面の会話から、API へ送る messages を作る。
 * - 送信に失敗した発言（failed）は、サーバーに届いていないので含めない
 * - 上限の件数に収まるよう古い方から落とす。落とした結果が assistant から始まらないよう、先頭は user にそろえる
 */
export function buildRequestMessages(entries: readonly ChatEntry[], text: string): ChatRequestMessage[] {
  const past = entries.filter((e) => !e.failed).map<ChatRequestMessage>((e) => ({ role: e.role, content: clip(e.content) }));
  const recent = past.slice(-(MAX_MESSAGES - 1));
  const firstUser = recent.findIndex((m) => m.role === 'user');
  return [...(firstUser < 0 ? [] : recent.slice(firstUser)), { role: 'user', content: clip(text) }];
}
