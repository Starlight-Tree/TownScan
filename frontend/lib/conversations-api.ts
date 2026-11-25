import { ApiError, sendRequest } from './api';
import type { ConversationSummary, StoredMessage, ToolCall, ToolResult } from './api-types';

// 会話の履歴の 3 本（仕様 §4.4）。どれも Authorization: Bearer が要る（lib/auth-token.ts が付ける。401 は 1 回だけ取り直して送り直す）。
// 利用者は、API が JWT の sub だけから決める（ここでは、利用者の ID を送らない）。質問・回答・題名・会話 ID は、ログにも例外の文にも出さない。
// ログインしていない人の画面では、ここを一度も呼ばない（呼ぶかどうかは、サーバーの layout が決めた真偽値。components/HistoryProvider.tsx）。

/**
 * 失敗の種類（画面が分けて扱うものだけ）。
 * - unauthorized: 401（ログインが切れた。取り直しても 401）
 * - not_found: 404（会話が無い・他人の会話。区別しない）
 * - unprocessable: 422（会話 ID の形が違う）
 * - other: それ以外（DB が使えない 503・想定外の 500・通信の失敗・応答の形が違う）
 */
export type ConversationErrorKind = 'unauthorized' | 'not_found' | 'unprocessable' | 'other';

export class ConversationsApiError extends ApiError {
  readonly kind: ConversationErrorKind;

  constructor(error: ApiError, kind: ConversationErrorKind) {
    super(error.message, error.status, error.code);
    this.name = 'ConversationsApiError';
    this.kind = kind;
  }
}

function kindOf(status: number): ConversationErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 404) return 'not_found';
  if (status === 422) return 'unprocessable';
  return 'other';
}

/** 失敗の種類。履歴の API 以外の失敗（中断・想定外の例外）は other */
export function conversationErrorKind(error: unknown): ConversationErrorKind {
  return error instanceof ConversationsApiError ? error.kind : 'other';
}

const invalidBody = (status: number) => new ConversationsApiError(new ApiError('サーバーの応答の形が正しくありません。', status, 'invalid_body'), 'other');

/** 履歴の API を呼ぶ（JWT つき）。失敗は ConversationsApiError にする。中断（AbortError）は、そのまま投げる */
async function call(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await sendRequest(path, init, true);
  } catch (e) {
    if (e instanceof ApiError) throw new ConversationsApiError(e, kindOf(e.status));
    throw e;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    throw invalidBody(res.status);
  }
}

/** 本人の会話の一覧（更新が新しい順・最大 50 件。ページ分けは無い）。形が合わなければ失敗 */
export async function listConversations(signal?: AbortSignal): Promise<ConversationSummary[]> {
  const res = await call('/conversations', { signal });
  const body = await readJson(res);
  if (!isRecord(body) || !Array.isArray(body.conversations)) throw invalidBody(res.status);
  const out: ConversationSummary[] = [];
  for (const item of body.conversations) {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.title !== 'string') throw invalidBody(res.status);
    out.push({
      id: item.id,
      title: item.title,
      created_at: typeof item.created_at === 'string' ? item.created_at : '',
      updated_at: typeof item.updated_at === 'string' ? item.updated_at : '',
    });
  }
  return out;
}

/**
 * 会話の発言（古い順）。回答の results・tool_calls は、保存された値をそのまま持つ（値を作り直さない）。
 * 配列でないときは空にする（壊れずに飛ばす。今の画面の、届いた回答の扱いと同じ）。run_created_at が文字列でなければ null。
 * role・content の形が違う発言があれば失敗（途中までの会話を、完全なものとして見せない）
 */
export async function getConversationMessages(id: string, signal?: AbortSignal): Promise<StoredMessage[]> {
  const res = await call(`/conversations/${encodeURIComponent(id)}/messages`, { signal });
  const body = await readJson(res);
  if (!isRecord(body) || !Array.isArray(body.messages)) throw invalidBody(res.status);
  const out: StoredMessage[] = [];
  for (const item of body.messages) {
    if (!isRecord(item) || typeof item.content !== 'string') throw invalidBody(res.status);
    if (item.role === 'user') {
      out.push({ role: 'user', content: item.content });
    } else if (item.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: item.content,
        results: Array.isArray(item.results) ? (item.results as ToolResult[]) : [],
        tool_calls: Array.isArray(item.tool_calls) ? (item.tool_calls as ToolCall[]) : [],
        run_created_at: typeof item.run_created_at === 'string' ? item.run_created_at : null,
      });
    } else {
      throw invalidBody(res.status);
    }
  }
  return out;
}

/** 会話を 1 件消す（204）。すでに無い（404）ときは成功として扱う（目的の状態になっている。DocuNavi の deleteThread と同じ） */
export async function deleteConversation(id: string): Promise<void> {
  try {
    await call(`/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch (e) {
    if (e instanceof ConversationsApiError && e.kind === 'not_found') return;
    throw e;
  }
}
