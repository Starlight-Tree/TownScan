import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { health, jsonResponse } from '../../tests/fixtures';

vi.mock('next/navigation', () => ({ usePathname: () => '/accuracy', useRouter: () => ({ push: vi.fn() }), redirect: vi.fn() }));

const jar = vi.hoisted(() => ({ names: [] as string[] }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ getAll: () => jar.names.map((name) => ({ name, value: 'v' })), get: () => undefined, set: () => {} }),
  headers: async () => new Headers({ cookie: 'x=1' }),
}));
// Better Auth は、本物を動かさない（DB・Google へつなげない）
const getSession = vi.hoisted(() => vi.fn());
const getAuth = vi.hoisted(() => vi.fn());
vi.mock('../../lib/auth', () => ({ getAuth }));

const { default: SiteLayout } = await import('./layout');

const fetchMock = vi.fn<typeof fetch>();
const show = async () => render(await SiteLayout({ children: <p>本文の中身</p> }));

// ログインを使える設定（lib/auth-config.ts の 5 つの変数がそろっている）。個々のテストが、足りない状態へ替える
const AUTH_ENV = {
  BETTER_AUTH_SECRET: 'test-secret-'.padEnd(40, 'x'),
  BETTER_AUTH_URL: 'http://localhost:3500',
  GOOGLE_CLIENT_ID: 'client-id',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  DATABASE_URL: 'postgresql://u:p@db:5432/d',
};

beforeEach(() => {
  for (const [name, value] of Object.entries(AUTH_ENV)) vi.stubEnv(name, value);
  jar.names = [];
  getSession.mockReset();
  getAuth.mockReset();
  getAuth.mockReturnValue({ api: { getSession } });
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(jsonResponse(health));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('(site) の枠', () => {
  it('本文の列に、バナーと本文（main#main）が入り、サイドパネルは、その左に並ぶ。上の横帯は無い（狭い幅の細い行は、サイドパネルの一部）', async () => {
    const { container } = await show();
    const app = container.querySelector('.app')!;
    expect([...app.children].map((c) => c.className)).toEqual(['app-narrow-bar', 'app-sidebar', 'app__column']);
    const column = app.querySelector('.app__column')!;
    expect(container.querySelector('header')).toBeNull();
    expect(column.querySelector('main#main')).toHaveTextContent('本文の中身');
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });

  it('サイドパネルに、ブランド・開閉のボタン・「新しい会話」がある。ページへの入口の欄は無い（精度は、アカウントのメニューの中）', async () => {
    await show();
    const side = screen.getByRole('complementary');
    expect(within(side).getByRole('link', { name: 'TownScan' })).toHaveAttribute('href', '/');
    expect(within(side).queryByRole('link', { name: 'チャットと地図' })).not.toBeInTheDocument();
    expect(within(side).queryByRole('link', { name: 'このアプリの精度' })).not.toBeInTheDocument();
    expect(within(side).getByRole('button', { name: 'サイドパネルを閉じる' })).toBeInTheDocument();
    // DocuNavi と同じ位置の「新しい会話」（NewConversationProvider が枠に入っている）
    expect(within(side).getByRole('button', { name: '新しい会話' })).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });

  it('ログインしていない（Cookie が無い）とき: Better Auth も DB も呼ばず、サイドパネルに「ログイン」の入口（Google でログイン）がある（アカウントのメニューは 1 つだけ）', async () => {
    await show();
    expect(getAuth).not.toHaveBeenCalled();
    const button = screen.getByRole('button', { name: 'ログイン・テーマのメニュー' });
    expect(button.closest('aside')).not.toBeNull();
    await userEvent.click(button);
    expect(screen.getByRole('menuitem', { name: 'Google でログイン' })).toHaveAttribute('href', '/login');
    expect(screen.getByRole('menuitem', { name: 'このアプリの精度' })).toHaveAttribute('href', '/accuracy');
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });

  it('Google でのログインの設定が無い環境では、メニューに「Google でログイン」を出さない（押しても、ボタンの無いページへ着くだけ）。テーマだけのメニュー', async () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', '');
    await show();
    expect(getAuth).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'ログイン・テーマのメニュー' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'メニュー' }));
    const menu = screen.getByRole('menu', { name: 'メニュー' });
    expect(within(menu).queryByRole('menuitem', { name: 'Google でログイン' })).not.toBeInTheDocument();
    expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(3);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });

  it('ログイン中: サイドパネルに、名前つきのアカウントのメニューが 1 つ。メール・ログアウトが出る', async () => {
    jar.names = ['townscan.session_token'];
    getSession.mockResolvedValue({ session: {}, user: { id: 'u-1', email: 'hanako@example.com', name: '試験 花子', image: 'https://lh3.googleusercontent.com/a/x=s96-c' } });
    const { container } = await show();
    const button = screen.getByRole('button', { name: '試験 花子のアカウントメニュー' });
    expect(container.querySelectorAll('.account-avatar img')).toHaveLength(1);
    await userEvent.click(button);
    const menu = screen.getByRole('menu', { name: 'アカウント' });
    expect(within(menu).getByText('hanako@example.com')).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'ログアウト' })).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });

  it('名前が空なら、メールアドレスを名前に使う', async () => {
    jar.names = ['townscan.session_token'];
    getSession.mockResolvedValue({ session: {}, user: { id: 'u-1', email: 'hanako@example.com', name: '', image: null } });
    await show();
    expect(screen.getByRole('button', { name: 'hanako@example.comのアカウントメニュー' })).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });

  it('Better Auth が失敗しても（DB に届かない）、画面は壊さず、ログインしていない扱いにする', async () => {
    jar.names = ['townscan.session_token'];
    vi.spyOn(console, 'error').mockImplementation(() => {});
    getSession.mockRejectedValue(new Error('connect ECONNREFUSED'));
    await show();
    expect(screen.getByRole('button', { name: 'ログイン・テーマのメニュー' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveTextContent('本文の中身');
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });

  it('設定が足りなくても（getAuth が null）、同じ', async () => {
    jar.names = ['townscan.session_token'];
    getAuth.mockReturnValue(null);
    await show();
    expect(screen.getByRole('button', { name: 'ログイン・テーマのメニュー' })).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });

  it('合成データのバナーは、本文の列に 1 つだけ出す', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ...health, run: { ...health.run, kind: 'synthetic' } }));
    const { container } = await show();
    await waitFor(() => expect(container.querySelectorAll('.banner--synthetic')).toHaveLength(1));
    const banner = container.querySelector('.banner--synthetic')!;
    expect(banner.parentElement).toHaveClass('app__column');
    expect(screen.getAllByRole('status')).toContain(banner);
  });
});
