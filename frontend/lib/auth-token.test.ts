import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFetchRouter, deferred, fakeJwt, jwtExpiringIn, type FetchRouter } from '../tests/history-helpers';
import { jsonResponse } from '../tests/fixtures';
import {
  clearAccessToken,
  fetchAuthorized,
  getAccessToken,
  refreshAccessToken,
  REFRESH_MARGIN_SECONDS,
  SessionExpiredError,
  TOKEN_PATH,
  TokenUnavailableError,
} from './auth-token';

let router: FetchRouter;

beforeEach(() => {
  clearAccessToken();
  window.localStorage.clear();
  window.sessionStorage.clear();
  router = createFetchRouter();
  vi.stubGlobal('fetch', router.fn);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const TOKEN = `GET ${TOKEN_PATH}`;

describe('JWT の取得（メモリにだけ置く）', () => {
  it('同じオリジンの GET /api/auth/token で取り、期限内は持っているものを返す（取りに行くのは 1 回）', async () => {
    const token = jwtExpiringIn(900);
    router.on(TOKEN, () => jsonResponse({ token }));
    expect(await getAccessToken()).toBe(token);
    expect(await getAccessToken()).toBe(token);
    expect(router.count(TOKEN)).toBe(1);
    const [call] = router.to(TOKEN);
    expect(call?.method).toBe('GET');
    expect(call?.init?.credentials).toBe('same-origin');
    expect(call?.init?.cache).toBe('no-store');
  });

  it('期限の 60 秒前になったら、使う前に取り直す（61 秒前まではそのまま）', async () => {
    expect(REFRESH_MARGIN_SECONDS).toBe(60);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-25T00:00:00Z'));
    const first = jwtExpiringIn(900, 'first');
    const second = jwtExpiringIn(900 + 840, 'second');
    router.on(TOKEN, (_call, nth) => jsonResponse({ token: nth === 0 ? first : second }));
    expect(await getAccessToken()).toBe(first);
    // 期限の 61 秒前: まだ使える
    vi.setSystemTime(new Date('2026-11-25T00:00:00Z').getTime() + (900 - 61) * 1000);
    expect(await getAccessToken()).toBe(first);
    expect(router.count(TOKEN)).toBe(1);
    // 期限の 60 秒前: 取り直す
    vi.setSystemTime(new Date('2026-11-25T00:00:00Z').getTime() + (900 - 60) * 1000);
    expect(await getAccessToken()).toBe(second);
    expect(router.count(TOKEN)).toBe(2);
  });

  it('exp が読めないトークンは、毎回取り直す', async () => {
    router.on(TOKEN, () => jsonResponse({ token: 'not-a-jwt' }));
    await getAccessToken();
    await getAccessToken();
    expect(router.count(TOKEN)).toBe(2);
  });

  it('同時に何本の要求があっても、取りに行くのは 1 回', async () => {
    const gate = deferred<Response>();
    router.on(TOKEN, () => gate.promise);
    const pending = [getAccessToken(), getAccessToken(), getAccessToken()];
    const token = jwtExpiringIn(900);
    gate.resolve(jsonResponse({ token }));
    expect(await Promise.all(pending)).toEqual([token, token, token]);
    expect(router.count(TOKEN)).toBe(1);
  });

  it('セッションが無い（4xx）ときは null で、持っていたトークンも捨てる。通信の失敗・5xx は TokenUnavailableError（ログアウトとは見ない）', async () => {
    router.on(TOKEN, () => jsonResponse({ message: 'Unauthorized' }, 401));
    expect(await getAccessToken()).toBeNull();

    router.on(TOKEN, () => jsonResponse({}, 500));
    await expect(getAccessToken()).rejects.toBeInstanceOf(TokenUnavailableError);
    router.on(TOKEN, () => jsonResponse({}, 429));
    await expect(getAccessToken()).rejects.toBeInstanceOf(TokenUnavailableError);
    router.on(TOKEN, () => jsonResponse({}, 408));
    await expect(getAccessToken()).rejects.toBeInstanceOf(TokenUnavailableError);
    router.on(TOKEN, () => Promise.reject(new TypeError('network')));
    await expect(getAccessToken()).rejects.toBeInstanceOf(TokenUnavailableError);
    router.on(TOKEN, () => new Response('<html>', { status: 200 }));
    await expect(getAccessToken()).rejects.toBeInstanceOf(TokenUnavailableError);
  });

  it('通信が失敗しても、期限内のトークンは捨てない（まだ使える）', async () => {
    const token = jwtExpiringIn(900);
    router.on(TOKEN, () => jsonResponse({ token }));
    await getAccessToken();
    router.on(TOKEN, () => jsonResponse({}, 500));
    // 期限内なので、取りに行かず、持っているものを返す
    expect(await getAccessToken()).toBe(token);
    expect(router.count(TOKEN)).toBe(1);
  });

  it('トークンは localStorage・sessionStorage に書かない', async () => {
    const token = jwtExpiringIn(900);
    router.on(TOKEN, () => jsonResponse({ token }));
    router.on('GET /api/conversations', () => jsonResponse({ conversations: [] }));
    await fetchAuthorized('/api/conversations');
    for (const storage of [window.localStorage, window.sessionStorage]) {
      expect(storage.length).toBe(0);
      expect(JSON.stringify({ ...storage })).not.toContain(token);
    }
  });

  it('clearAccessToken のあとは、取り直す', async () => {
    router.on(TOKEN, () => jsonResponse({ token: jwtExpiringIn(900) }));
    await getAccessToken();
    clearAccessToken();
    await getAccessToken();
    expect(router.count(TOKEN)).toBe(2);
  });
});

describe('fetchAuthorized（401 は 1 回だけ取り直して送り直す）', () => {
  const API = 'GET /api/conversations';

  it('Authorization: Bearer を付けて送る。401 以外の応答は、そのまま返す（呼び出し側が見る）', async () => {
    const token = jwtExpiringIn(900);
    router.on(TOKEN, () => jsonResponse({ token }));
    router.on(API, () => jsonResponse({ error: { code: 'internal_error', message: 'x' } }, 500));
    const res = await fetchAuthorized('/api/conversations', { headers: { accept: 'application/json' } });
    expect(res.status).toBe(500);
    const [call] = router.to(API);
    expect(call?.headers.get('authorization')).toBe(`Bearer ${token}`);
    expect(call?.headers.get('accept')).toBe('application/json');
    expect(router.count(API)).toBe(1);
  });

  it('401 が返ったら、1 回だけ取り直して送り直す（新しいトークンで）', async () => {
    router.on(TOKEN, (_c, nth) => jsonResponse({ token: jwtExpiringIn(900, nth === 0 ? 'old' : 'new') }));
    // 1 回目の送信（古いトークン）を 401 にし、2 回目（新しいトークン）を 200 にする
    router.on(API, (_call, nth) => (nth === 0 ? jsonResponse({}, 401) : jsonResponse({ conversations: [] })));
    const res = await fetchAuthorized('/api/conversations');
    expect(res.status).toBe(200);
    expect(router.count(API)).toBe(2);
    expect(router.count(TOKEN)).toBe(2);
    const [first, second] = router.to(API);
    expect(first?.headers.get('authorization')).not.toBe(second?.headers.get('authorization'));
  });

  it('取り直しても 401 なら、SessionExpiredError（送り直しは 1 回だけ）', async () => {
    router.on(TOKEN, (_c, nth) => jsonResponse({ token: jwtExpiringIn(900, `t${nth}`) }));
    router.on(API, () => jsonResponse({}, 401));
    await expect(fetchAuthorized('/api/conversations')).rejects.toBeInstanceOf(SessionExpiredError);
    expect(router.count(API)).toBe(2);
    expect(router.count(TOKEN)).toBe(2);
  });

  it('トークンを取れない（セッションが無い）ときは、API を呼ばずに SessionExpiredError', async () => {
    router.on(TOKEN, () => jsonResponse({}, 401));
    await expect(fetchAuthorized('/api/conversations')).rejects.toBeInstanceOf(SessionExpiredError);
    expect(router.count(API)).toBe(0);
  });

  it('401 のあとの取り直しが、通信の失敗・5xx なら TokenUnavailableError（ログアウトとは見ない）', async () => {
    router.on(TOKEN, (_c, nth) => (nth === 0 ? jsonResponse({ token: jwtExpiringIn(900) }) : jsonResponse({}, 503)));
    router.on(API, () => jsonResponse({}, 401));
    await expect(fetchAuthorized('/api/conversations')).rejects.toBeInstanceOf(TokenUnavailableError);
    expect(router.count(API)).toBe(1);
  });

  it('同時の 401 でも、取り直しに行くのは 1 回（先に取り直した新しいトークンを、あとの要求も使う）', async () => {
    const tokens: string[] = [];
    router.on(TOKEN, (_c, nth) => {
      const token = jwtExpiringIn(900, nth === 0 ? 'old' : 'new');
      tokens.push(token);
      return jsonResponse({ token });
    });
    // 古いトークンは 401、新しいトークンは 200
    router.on(API, (call) => (call.headers.get('authorization') === `Bearer ${tokens[0]}` ? jsonResponse({}, 401) : jsonResponse({ conversations: [] })));
    const [a, b] = await Promise.all([fetchAuthorized('/api/conversations'), fetchAuthorized('/api/conversations')]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(router.count(TOKEN)).toBe(2);
  });

  it('refreshAccessToken は、失敗したトークンと同じものが残っていれば、取り直す', async () => {
    const old = fakeJwt(Math.floor(Date.now() / 1000) + 900, 'old');
    router.on(TOKEN, (_c, nth) => jsonResponse({ token: nth === 0 ? old : fakeJwt(Math.floor(Date.now() / 1000) + 900, 'new') }));
    expect(await getAccessToken()).toBe(old);
    const next = await refreshAccessToken(old);
    expect(next).not.toBe(old);
    expect(router.count(TOKEN)).toBe(2);
    // すでに新しいトークンがあるなら、取りに行かない
    expect(await refreshAccessToken(old)).toBe(next);
    expect(router.count(TOKEN)).toBe(2);
  });
});
