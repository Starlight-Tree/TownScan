import { act, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAccessToken, getAccessToken } from '../lib/auth-token';
import { createFetchRouter, jwtExpiringIn, type FetchRouter } from '../tests/history-helpers';
import { jsonResponse } from '../tests/fixtures';
import { HistoryProvider, useHistory, type HistoryValue } from './HistoryProvider';

let router: FetchRouter;
let latest: HistoryValue;

function Probe() {
  const history = useHistory();
  // テストから、いまの値（markExpired・list.reload）を呼ぶために控える
  useEffect(() => {
    latest = history;
  });
  return <p data-testid="probe">{`${history.loggedIn ? 'in' : 'out'}|${history.active ? 'active' : 'inactive'}|${history.expired ? 'expired' : 'valid'}|${history.list.state.status}`}</p>;
}

beforeEach(() => {
  clearAccessToken();
  router = createFetchRouter();
  router.on('GET /api/auth/token', () => jsonResponse({ token: jwtExpiringIn(900) }));
  router.on('GET /api/conversations', () => jsonResponse({ conversations: [] }));
  vi.stubGlobal('fetch', router.fn);
});
afterEach(() => vi.unstubAllGlobals());

describe('HistoryProvider（ログイン中か・期限切れ・一覧）', () => {
  it('Provider が無いときは、ログインしていない・使えない設定と同じ（何も呼ばない）', async () => {
    render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('out|inactive|valid|unavailable');
    expect(latest.loginAvailable).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(router.calls).toHaveLength(0);
  });

  it('ログインしていない: 一覧を取りに行かず、トークンも取らない。持っていたトークンは捨てる', async () => {
    router.on('GET /api/auth/token', () => jsonResponse({ token: jwtExpiringIn(900) }));
    await getAccessToken();
    expect(router.count('GET /api/auth/token')).toBe(1);
    render(
      <HistoryProvider loggedIn={false} loginAvailable>
        <Probe />
      </HistoryProvider>,
    );
    expect(screen.getByTestId('probe')).toHaveTextContent('out|inactive|valid|unavailable');
    expect(latest.loginAvailable).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(router.count('GET /api/conversations')).toBe(0);
    // 捨てたので、次に使うときは取り直す
    await getAccessToken();
    expect(router.count('GET /api/auth/token')).toBe(2);
  });

  it('ログイン中: 一覧を取りに行く（JWT つき）', async () => {
    render(
      <HistoryProvider loggedIn loginAvailable>
        <Probe />
      </HistoryProvider>,
    );
    expect(screen.getByTestId('probe')).toHaveTextContent('in|active|valid|loading');
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('in|active|valid|ready'));
    expect(router.count('GET /api/conversations')).toBe(1);
  });

  it('期限切れ（markExpired）: ログインしていない扱いになり、以降は取りに行かない。サーバーが決めた loggedIn は変わらない', async () => {
    render(
      <HistoryProvider loggedIn loginAvailable>
        <Probe />
      </HistoryProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('ready'));
    act(() => latest.markExpired());
    expect(screen.getByTestId('probe')).toHaveTextContent('in|inactive|expired|unavailable');
    latest.list.reload();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(router.count('GET /api/conversations')).toBe(1);
  });

  it('1023px 以下でも、ログイン中なら、一覧を取りに行く（重ねて開くパネルに出すため）', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })));
    render(
      <HistoryProvider loggedIn loginAvailable>
        <Probe />
      </HistoryProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('in|active|valid|ready'));
    expect(router.count('GET /api/conversations')).toBe(1);
  });
});
