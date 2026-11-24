import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { health, jsonResponse } from '../../tests/fixtures';

vi.mock('next/navigation', () => ({ usePathname: () => '/about', redirect: vi.fn() }));

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

beforeEach(() => {
  jar.names = [];
  getSession.mockReset();
  getAuth.mockReset();
  getAuth.mockReturnValue({ api: { getSession } });
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(jsonResponse(health));
  vi.stubGlobal('fetch', fetchMock);
});

describe('(site) の枠', () => {
  it('本文の列に、上の横帯と本文（main#main）が入り、サイドパネルは、その左に並ぶ', async () => {
    const { container } = await show();
    const app = container.querySelector('.app')!;
    expect([...app.children].map((c) => c.className)).toEqual(['app-sidebar', 'app__column']);
    const column = app.querySelector('.app__column')!;
    expect(column.querySelector('header.app-header')).not.toBeNull();
    expect(column.querySelector('main#main')).toHaveTextContent('本文の中身');
    await screen.findAllByText('模擬モデルで応答しています');
  });

  it('サイドパネルに、ブランド・3 つのページ・開閉のボタンがある。いまのページ（/about）に aria-current', async () => {
    await show();
    const side = screen.getByRole('complementary');
    expect(within(side).getByRole('link', { name: 'TownScan' })).toHaveAttribute('href', '/');
    expect(within(side).getByRole('link', { name: 'チャットと地図' })).toHaveAttribute('href', '/');
    expect(within(side).getByRole('link', { name: 'このアプリの精度' })).toHaveAttribute('href', '/accuracy');
    expect(within(side).getByRole('link', { name: 'このアプリについて' })).toHaveAttribute('aria-current', 'page');
    expect(within(side).getByRole('button', { name: 'サイドパネルを閉じる' })).toBeInTheDocument();
    await screen.findAllByText('模擬モデルで応答しています');
  });

  it('ログインしていない（Cookie が無い）とき: Better Auth も DB も呼ばず、サイドパネルと上の横帯の両方に「メニュー」（Google でログイン）がある', async () => {
    await show();
    expect(getAuth).not.toHaveBeenCalled();
    const buttons = screen.getAllByRole('button', { name: 'メニュー' });
    expect(buttons).toHaveLength(2);
    expect(buttons.map((b) => b.closest('aside, header')?.tagName)).toEqual(['ASIDE', 'HEADER']);
    await userEvent.click(buttons[1]!);
    expect(screen.getByRole('menuitem', { name: 'Google でログイン' })).toHaveAttribute('href', '/login');
    await screen.findAllByText('模擬モデルで応答しています');
  });

  it('ログイン中: サイドパネルと上の横帯の両方に、名前つきのアカウントのメニュー。メール・ログアウトが出る', async () => {
    jar.names = ['townscan.session_token'];
    getSession.mockResolvedValue({ session: {}, user: { id: 'u-1', email: 'hanako@example.com', name: '試験 花子', image: 'https://lh3.googleusercontent.com/a/x=s96-c' } });
    const { container } = await show();
    const buttons = screen.getAllByRole('button', { name: '試験 花子のアカウントメニュー' });
    expect(buttons).toHaveLength(2);
    expect(container.querySelectorAll('.account-avatar img')).toHaveLength(2);
    await userEvent.click(buttons[0]!);
    const menu = screen.getByRole('menu', { name: 'アカウント' });
    expect(within(menu).getByText('hanako@example.com')).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'ログアウト' })).toBeInTheDocument();
    await screen.findAllByText('模擬モデルで応答しています');
  });

  it('名前が空なら、メールアドレスを名前に使う', async () => {
    jar.names = ['townscan.session_token'];
    getSession.mockResolvedValue({ session: {}, user: { id: 'u-1', email: 'hanako@example.com', name: '', image: null } });
    await show();
    expect(screen.getAllByRole('button', { name: 'hanako@example.comのアカウントメニュー' })).toHaveLength(2);
    await screen.findAllByText('模擬モデルで応答しています');
  });

  it('Better Auth が失敗しても（DB に届かない）、画面は壊さず、ログインしていない扱いにする', async () => {
    jar.names = ['townscan.session_token'];
    vi.spyOn(console, 'error').mockImplementation(() => {});
    getSession.mockRejectedValue(new Error('connect ECONNREFUSED'));
    await show();
    expect(screen.getAllByRole('button', { name: 'メニュー' })).toHaveLength(2);
    expect(screen.getByRole('main')).toHaveTextContent('本文の中身');
    await screen.findAllByText('模擬モデルで応答しています');
  });

  it('設定が足りなくても（getAuth が null）、同じ', async () => {
    jar.names = ['townscan.session_token'];
    getAuth.mockReturnValue(null);
    await show();
    expect(screen.getAllByRole('button', { name: 'メニュー' })).toHaveLength(2);
    await screen.findAllByText('模擬モデルで応答しています');
  });

  it('合成データのバナーは、本文の列（上の横帯の外）に 1 つだけ出す', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ...health, run: { ...health.run, kind: 'synthetic' } }));
    const { container } = await show();
    await waitFor(() => expect(container.querySelectorAll('.banner--synthetic')).toHaveLength(1));
    const banner = container.querySelector('.banner--synthetic')!;
    expect(banner.parentElement).toHaveClass('app__column');
    expect(banner.closest('header')).toBeNull();
    expect(screen.getAllByRole('status')).toContain(banner);
  });
});
