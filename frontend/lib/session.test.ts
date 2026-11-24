import { APIError } from 'better-auth/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const jar = vi.hoisted(() => ({ names: [] as string[] }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ getAll: () => jar.names.map((name) => ({ name, value: 'v' })) }),
  headers: async () => new Headers({ cookie: 'x=1' }),
}));

// Better Auth は、本物を動かさない（DB・Google へつなげない）。サーバー側の関数だけを差し替える
const getSession = vi.hoisted(() => vi.fn());
const getAuth = vi.hoisted(() => vi.fn());
vi.mock('./auth', () => ({ getAuth }));

const { currentUser, displayName } = await import('./session');

const row = { id: 'u-1', email: 'hanako@example.com', name: '試験 花子', image: 'https://lh3.googleusercontent.com/a/example=s96-c' };

beforeEach(() => {
  jar.names = [];
  getSession.mockReset();
  getAuth.mockReset();
  getAuth.mockReturnValue({ api: { getSession } });
});
afterEach(() => vi.restoreAllMocks());

describe('currentUser', () => {
  it('Cookie が無ければ、Better Auth も DB も呼ばず、null（ほとんどの訪問者はこれ）', async () => {
    expect(await currentUser()).toBeNull();
    expect(getAuth).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
  });

  it('別のアプリの Cookie（既定の better-auth・jobnavi）だけなら、呼ばない（接頭辞は townscan）', async () => {
    jar.names = ['better-auth.session_token', 'jobnavi.session_token', 'townscan-theme', 'townscan.dont_remember'];
    expect(await currentUser()).toBeNull();
    expect(getSession).not.toHaveBeenCalled();
  });

  it('townscan のセッション Cookie があれば、Better Auth に聞いて、画面に出す分だけを返す', async () => {
    jar.names = ['townscan.session_token'];
    getSession.mockResolvedValue({ session: { id: 's' }, user: { ...row, emailVerified: true, createdAt: new Date() } });
    expect(await currentUser()).toEqual({ id: 'u-1', email: 'hanako@example.com', name: '試験 花子', image: row.image });
    expect(getSession).toHaveBeenCalledOnce();
    expect((getSession.mock.calls[0]![0] as { headers: Headers }).headers.get('cookie')).toBe('x=1');
  });

  it('https の Cookie（__Secure- 付き）でも聞く', async () => {
    jar.names = ['__Secure-townscan.session_token'];
    getSession.mockResolvedValue({ session: {}, user: row });
    expect((await currentUser())?.email).toBe('hanako@example.com');
  });

  it('名前・画像が無い（null・空）ときは、空の名前・null の画像にする', async () => {
    jar.names = ['townscan.session_token'];
    getSession.mockResolvedValue({ session: {}, user: { id: 'u-2', email: 'a@example.com', name: null, image: '' } });
    expect(await currentUser()).toEqual({ id: 'u-2', email: 'a@example.com', name: '', image: null });
  });

  it('期限切れ・失効（getSession が null）なら null', async () => {
    jar.names = ['townscan.session_token'];
    getSession.mockResolvedValue(null);
    expect(await currentUser()).toBeNull();
  });

  it('設定が足りない（getAuth が null）なら、Better Auth を呼ばず null。画面は壊さない', async () => {
    jar.names = ['townscan.session_token'];
    getAuth.mockReturnValue(null);
    expect(await currentUser()).toBeNull();
    expect(getSession).not.toHaveBeenCalled();
  });

  it('401（ログインしていない）は、記録せず null', async () => {
    jar.names = ['townscan.session_token'];
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    getSession.mockRejectedValue(new APIError('UNAUTHORIZED'));
    expect(await currentUser()).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('DB に届かないなどの失敗は、ログに 1 行だけ残して null（画面は、ログインしていない扱いで動く）', async () => {
    jar.names = ['townscan.session_token'];
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    getSession.mockRejectedValue(new Error('relation "auth_session" does not exist'));
    expect(await currentUser()).toBeNull();
    expect(spy).toHaveBeenCalledWith('auth: currentUser failed: Error: relation "auth_session" does not exist');
  });
});

describe('displayName', () => {
  it('Google の名前。無ければ、メールアドレス', () => {
    expect(displayName({ name: '試験 花子', email: 'hanako@example.com' })).toBe('試験 花子');
    expect(displayName({ name: '', email: 'hanako@example.com' })).toBe('hanako@example.com');
  });
});
