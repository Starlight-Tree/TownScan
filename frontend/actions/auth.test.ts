import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, { value: string; options?: Record<string, unknown> }>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (k: string) => (store.has(k) ? { name: k, value: store.get(k)!.value } : undefined),
    getAll: () => [...store.entries()].map(([name, c]) => ({ name, value: c.value })),
    set: (k: string, value: string, options?: Record<string, unknown>) => void store.set(k, { value, options }),
    delete: (k: string) => void store.delete(k),
  }),
  headers: async () => new Headers({ cookie: 'x=1' }),
}));
class Redirected extends Error {
  constructor(readonly to: string) {
    super(to);
  }
}
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Redirected(to);
  },
}));

// Better Auth は、本物を動かさない（DB・Google へつなげない）。サーバー側の関数だけを差し替える
const api = vi.hoisted(() => ({ signInSocial: vi.fn(), signOut: vi.fn() }));
const authRef = vi.hoisted(() => ({ current: null as { api: typeof api } | null }));
vi.mock('../lib/auth', () => ({ getAuth: () => authRef.current }));

const { googleLoginAction, logoutAction } = await import('./auth');

beforeEach(() => {
  store.clear();
  api.signInSocial.mockReset();
  api.signOut.mockReset();
  authRef.current = { api };
});

describe('googleLoginAction', () => {
  it('Google の同意画面の URL へ移す。失敗・取り消しの戻りはログイン画面にする', async () => {
    api.signInSocial.mockResolvedValue({ url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1', redirect: true });
    await expect(googleLoginAction()).rejects.toMatchObject({ to: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' });
    expect(api.signInSocial).toHaveBeenCalledOnce();
    expect(api.signInSocial.mock.calls[0]![0].body).toEqual({ provider: 'google', callbackURL: '/', errorCallbackURL: '/login' });
  });

  it('設定が足りないときは、Better Auth を呼ばずに、ログイン画面へ（まだ設定されていません）', async () => {
    authRef.current = null;
    await expect(googleLoginAction()).rejects.toMatchObject({ to: '/login?error=not_configured' });
    expect(api.signInSocial).not.toHaveBeenCalled();
  });

  it('Better Auth が失敗しても（URL が無い・例外）、例外の文字列を出さず、ログイン画面へ', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    api.signInSocial.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:5432'));
    await expect(googleLoginAction()).rejects.toMatchObject({ to: '/login?error=google_failed' });
    api.signInSocial.mockResolvedValue({ redirect: false });
    await expect(googleLoginAction()).rejects.toMatchObject({ to: '/login?error=google_failed' });
  });
});

describe('logoutAction', () => {
  it('Better Auth でサーバー側の印を消し、/ へ移す', async () => {
    api.signOut.mockResolvedValue({ success: true });
    await expect(logoutAction()).rejects.toMatchObject({ to: '/' });
    expect(api.signOut).toHaveBeenCalledOnce();
  });

  it('設定が足りなくても、この端末の townscan の Cookie を消して、/ へ移す', async () => {
    authRef.current = null;
    store.set('townscan.session_token', { value: 'x' });
    await expect(logoutAction()).rejects.toMatchObject({ to: '/' });
    expect(store.get('townscan.session_token')).toMatchObject({ value: '', options: { maxAge: 0 } });
  });

  it('Better Auth に届かなくても、この端末の townscan の Cookie だけは消す（ほかのアプリの Cookie・テーマの保存は残す）', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    store.set('townscan.session_token', { value: 'x' });
    store.set('__Secure-townscan.session_token', { value: 'y' });
    store.set('better-auth.session_token', { value: 'docunavi' }); // 同じ localhost の別のアプリ（接頭辞が違う）
    store.set('jobnavi.session_token', { value: 'jobnavi' });
    api.signOut.mockRejectedValue(new Error('down'));
    await expect(logoutAction()).rejects.toMatchObject({ to: '/' });
    // 期限切れにして上書きする。https の Cookie は、Secure を付けないと、ブラウザーが消させない
    expect(store.get('townscan.session_token')).toMatchObject({ value: '', options: { maxAge: 0, secure: false } });
    expect(store.get('__Secure-townscan.session_token')).toMatchObject({ value: '', options: { maxAge: 0, secure: true } });
    expect(store.get('better-auth.session_token')?.value).toBe('docunavi');
    expect(store.get('jobnavi.session_token')?.value).toBe('jobnavi');
  });
});
