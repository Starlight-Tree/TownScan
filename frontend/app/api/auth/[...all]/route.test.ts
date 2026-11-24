import { beforeEach, describe, expect, it, vi } from 'vitest';

const authRef = vi.hoisted(() => ({ current: null as object | null }));
vi.mock('../../../../lib/auth', () => ({ getAuth: () => authRef.current }));
const handler = vi.hoisted(() => ({
  GET: vi.fn(async () => new Response('get-ok')),
  POST: vi.fn(async () => new Response('post-ok')),
}));
vi.mock('better-auth/next-js', () => ({ toNextJsHandler: () => handler }));

const { GET, POST } = await import('./route');

const request = (method: string) => new Request('http://localhost:3500/api/auth/get-session', { method });

beforeEach(() => {
  authRef.current = null;
  handler.GET.mockClear();
  handler.POST.mockClear();
});

describe('/api/auth/[...all]', () => {
  it('設定が足りないときは、503 と固定の本文（画面は「まだ設定されていません」と出す）', async () => {
    for (const res of [await GET(request('GET')), await POST(request('POST'))]) {
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'not_configured' });
    }
    expect(handler.GET).not.toHaveBeenCalled();
    expect(handler.POST).not.toHaveBeenCalled();
  });

  it('設定があれば、Better Auth のハンドラーへ渡す', async () => {
    authRef.current = {};
    expect(await (await GET(request('GET'))).text()).toBe('get-ok');
    expect(await (await POST(request('POST'))).text()).toBe('post-ok');
  });
});
