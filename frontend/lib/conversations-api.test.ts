import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFetchRouter, jwtExpiringIn, type FetchRouter } from '../tests/history-helpers';
import { count, jsonResponse } from '../tests/fixtures';
import { clearAccessToken, TOKEN_PATH } from './auth-token';
import {
  ConversationsApiError,
  conversationErrorKind,
  deleteConversation,
  getConversationMessages,
  listConversations,
} from './conversations-api';

let router: FetchRouter;
const TOKEN = `GET ${TOKEN_PATH}`;

beforeEach(() => {
  clearAccessToken();
  router = createFetchRouter();
  router.on(TOKEN, () => jsonResponse({ token: jwtExpiringIn(900) }));
  vi.stubGlobal('fetch', router.fn);
});
afterEach(() => vi.unstubAllGlobals());

const errorBody = (code: string, message = '固定の文') => ({ error: { code, message } });

describe('一覧（GET /api/conversations）', () => {
  it('JWT を付けて同じオリジンの /api/conversations を呼び、会話の並びをそのまま返す', async () => {
    const items = [
      { id: 'c2', title: '新しい方', created_at: '2026-11-25T01:00:00+00:00', updated_at: '2026-11-25T02:00:00Z' },
      { id: 'c1', title: '古い方', created_at: '2026-11-24T01:00:00+00:00', updated_at: '2026-11-24T01:05:00+00:00' },
    ];
    router.on('GET /api/conversations', () => jsonResponse({ conversations: items }));
    expect(await listConversations()).toEqual(items);
    const [call] = router.to('GET /api/conversations');
    expect(call?.headers.get('authorization')).toMatch(/^Bearer /);
    // 利用者・会話 ID を、クエリ・本文で送らない（API は JWT の sub だけから決める）
    expect(call?.url).toBe('/api/conversations');
  });

  it('0 件は空の配列。形が合わない応答は、失敗（other）', async () => {
    router.on('GET /api/conversations', () => jsonResponse({ conversations: [] }));
    expect(await listConversations()).toEqual([]);
    for (const body of [{}, { conversations: 'x' }, { conversations: [{ id: 1, title: 'x' }] }, { conversations: [null] }, []]) {
      router.on('GET /api/conversations', () => jsonResponse(body));
      await expect(listConversations()).rejects.toMatchObject({ kind: 'other', code: 'invalid_body' });
    }
  });

  it('401 は、1 回だけ取り直して送り直し、それでも 401 なら unauthorized。ほかの失敗は other', async () => {
    router.on('GET /api/conversations', () => jsonResponse(errorBody('unauthorized'), 401));
    const error = await listConversations().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConversationsApiError);
    expect(conversationErrorKind(error)).toBe('unauthorized');
    expect(router.count('GET /api/conversations')).toBe(2);

    router.on('GET /api/conversations', () => jsonResponse(errorBody('db_unavailable'), 503));
    expect(conversationErrorKind(await listConversations().catch((e: unknown) => e))).toBe('other');
    router.on('GET /api/conversations', () => jsonResponse(errorBody('internal_error'), 500));
    expect(conversationErrorKind(await listConversations().catch((e: unknown) => e))).toBe('other');
  });

  it('ログイン中のトークンを取れないとき: セッションが無ければ unauthorized、通信・5xx は other（code は auth_unavailable）', async () => {
    router.on(TOKEN, () => jsonResponse({}, 401));
    expect(conversationErrorKind(await listConversations().catch((e: unknown) => e))).toBe('unauthorized');
    expect(router.count('GET /api/conversations')).toBe(0);
    clearAccessToken();
    router.on(TOKEN, () => jsonResponse({}, 502));
    const error = await listConversations().catch((e: unknown) => e);
    expect(conversationErrorKind(error)).toBe('other');
    expect(error).toMatchObject({ code: 'auth_unavailable' });
  });

  it('履歴の API の失敗でないもの（中断など）は other', () => {
    expect(conversationErrorKind(new Error('x'))).toBe('other');
    expect(conversationErrorKind(null)).toBe('other');
  });
});

describe('発言（GET /api/conversations/{id}/messages）', () => {
  const stored = {
    messages: [
      { role: 'user', content: '何件？' },
      { role: 'assistant', content: '件数です。', results: [count], tool_calls: [{ name: 'count_candidates', args: {} }], run_created_at: '2026-11-24T03:00:00+00:00' },
      { role: 'user', content: '続き' },
      { role: 'assistant', content: 'お断り', results: 'x', tool_calls: null, run_created_at: 5 },
    ],
  };

  it('古い順のまま、保存された results・tool_calls をそのまま持つ。配列でないものは空、run_created_at が文字列でなければ null', async () => {
    router.on('GET /api/conversations/abc-1/messages', () => jsonResponse(stored));
    const messages = await getConversationMessages('abc-1');
    expect(messages).toEqual([
      { role: 'user', content: '何件？' },
      { role: 'assistant', content: '件数です。', results: [count], tool_calls: [{ name: 'count_candidates', args: {} }], run_created_at: '2026-11-24T03:00:00+00:00' },
      { role: 'user', content: '続き' },
      { role: 'assistant', content: 'お断り', results: [], tool_calls: [], run_created_at: null },
    ]);
  });

  it('会話 ID は、パスで 1 回だけ符号化して送る（本文・クエリには載せない）', async () => {
    router.on('GET /api/conversations/a%2Fb/messages', () => jsonResponse({ messages: [] }));
    expect(await getConversationMessages('a/b')).toEqual([]);
    expect(router.to('GET /api/conversations/a%2Fb/messages')[0]?.body).toBeUndefined();
  });

  it('404 は not_found（無い会話も他人の会話も同じ）。422 は unprocessable', async () => {
    router.on('GET /api/conversations/zzz/messages', () => jsonResponse(errorBody('not_found', '会話が見つかりません'), 404));
    expect(conversationErrorKind(await getConversationMessages('zzz').catch((e: unknown) => e))).toBe('not_found');
    router.on('GET /api/conversations/zzz/messages', () => jsonResponse(errorBody('validation_error'), 422));
    expect(conversationErrorKind(await getConversationMessages('zzz').catch((e: unknown) => e))).toBe('unprocessable');
  });

  it('role・content の形が違う発言があれば、失敗（途中までの会話を、完全なものとして見せない）', async () => {
    for (const messages of [[{ role: 'system', content: 'x' }], [{ role: 'user' }], [null], 'x']) {
      router.on('GET /api/conversations/abc-1/messages', () => jsonResponse({ messages }));
      await expect(getConversationMessages('abc-1')).rejects.toMatchObject({ kind: 'other' });
    }
  });
});

describe('削除（DELETE /api/conversations/{id}）', () => {
  it('204 は成功。すでに無い（404）ときも成功として扱う（目的の状態になっている）', async () => {
    router.on('DELETE /api/conversations/abc-1', () => new Response(null, { status: 204 }));
    await expect(deleteConversation('abc-1')).resolves.toBeUndefined();
    expect(router.to('DELETE /api/conversations/abc-1')[0]?.headers.get('authorization')).toMatch(/^Bearer /);
    router.on('DELETE /api/conversations/abc-1', () => jsonResponse(errorBody('not_found'), 404));
    await expect(deleteConversation('abc-1')).resolves.toBeUndefined();
  });

  it('ほかの失敗は投げる（401 は unauthorized、DB の 503 は other）', async () => {
    router.on('DELETE /api/conversations/abc-1', () => jsonResponse(errorBody('unauthorized'), 401));
    expect(conversationErrorKind(await deleteConversation('abc-1').catch((e: unknown) => e))).toBe('unauthorized');
    router.on('DELETE /api/conversations/abc-1', () => jsonResponse(errorBody('db_unavailable'), 503));
    expect(conversationErrorKind(await deleteConversation('abc-1').catch((e: unknown) => e))).toBe('other');
  });
});
