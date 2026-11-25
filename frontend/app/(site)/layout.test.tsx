import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatPanel } from '../../components/chat/ChatPanel';
import { clearAccessToken } from '../../lib/auth-token';
import { health, jsonResponse } from '../../tests/fixtures';
import { createFetchRouter, jwtExpiringIn } from '../../tests/history-helpers';

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
  vi.unstubAllGlobals();
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

describe('会話の履歴（ログイン中だけ）: サーバーの layout が決めた真偽値を、コンテキストで渡す（仕様 §2.3.6）', () => {
  const LIST = [{ id: 'c1', title: '新規出現の候補は何件ありますか？', created_at: '2026-11-25T01:00:00+00:00', updated_at: '2026-11-25T01:05:00+00:00' }];
  const showChat = async () => render(await SiteLayout({ children: <ChatPanel actions={{ expand: vi.fn() }} /> }));
  const routes = () => {
    clearAccessToken();
    window.sessionStorage.clear();
    const router = createFetchRouter();
    router.on('GET /api/health', () => jsonResponse(health));
    router.on('GET /api/auth/token', () => jsonResponse({ token: jwtExpiringIn(900) }));
    router.on('GET /api/conversations', () => jsonResponse({ conversations: LIST }));
    router.on('POST /api/chat', () => jsonResponse({ message: { role: 'assistant', content: '回答です。', results: [], tool_calls: [] } }));
    vi.stubGlobal('fetch', router.fn);
    return router;
  };
  const ask = async (text: string) => userEvent.type(screen.getByRole('textbox', { name: '質問を入力' }), `${text}{Enter}`);

  it('ログインしていない（ログインを使える設定）: 案内と入口を出し、質問を送っても、/api/auth/token も /api/conversations も一度も呼ばない。conversation_id も付けない', async () => {
    const router = routes();
    await showChat();
    const side = screen.getByRole('complementary');
    expect(within(side).getByRole('region', { name: '会話の一覧' })).toHaveTextContent('ログインすると、会話を保存して、ここから開き直せます。');
    expect(within(side).getByRole('link', { name: 'Google でログイン' })).toHaveAttribute('href', '/login');
    await ask('何件ありますか？');
    await screen.findByText('回答です。');
    expect(router.countPrefix('/api/auth/token')).toBe(0);
    expect(router.countPrefix('/api/conversations')).toBe(0);
    expect(router.to('POST /api/chat')[0]?.body).toEqual({ messages: [{ role: 'user', content: '何件ありますか？' }] });
    expect(window.sessionStorage.length).toBe(0);
  });

  it('ログインを使えない設定（Google の設定が無い）: 案内だけ。同じく、一度も呼ばない', async () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', '');
    const router = routes();
    await showChat();
    const list = within(screen.getByRole('complementary')).getByRole('region', { name: '会話の一覧' });
    expect(list).toHaveTextContent('ログインを設定していない環境では、会話は保存されません。');
    expect(within(list).queryByRole('link')).not.toBeInTheDocument();
    await ask('何件ありますか？');
    await screen.findByText('回答です。');
    expect(router.countPrefix('/api/auth/token')).toBe(0);
    expect(router.countPrefix('/api/conversations')).toBe(0);
    expect(router.to('POST /api/chat')[0]?.body).not.toHaveProperty('conversation_id');
  });

  it('Cookie があっても、セッションが無効（Better Auth が null）なら、ログインしていない扱いで、一度も呼ばない', async () => {
    jar.names = ['townscan.session_token'];
    getSession.mockResolvedValue(null);
    const router = routes();
    await showChat();
    expect(screen.getByRole('region', { name: '会話の一覧' })).toHaveTextContent('ログインすると');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(router.countPrefix('/api/auth/token')).toBe(0);
    expect(router.countPrefix('/api/conversations')).toBe(0);
  });

  it('ログイン中: サイドパネルに会話の一覧を出し（JWT つきで取る）、質問には conversation_id を付けて送る', async () => {
    jar.names = ['townscan.session_token'];
    getSession.mockResolvedValue({ session: {}, user: { id: 'u-1', email: 'hanako@example.com', name: '試験 花子', image: null } });
    const router = routes();
    await showChat();
    const side = screen.getByRole('complementary');
    expect(await within(side).findByTitle('新規出現の候補は何件ありますか？')).toBeInTheDocument();
    expect(within(side).getByRole('heading', { name: '会話の履歴' })).toBeInTheDocument();
    expect(router.to('GET /api/conversations')[0]?.headers.get('authorization')).toMatch(/^Bearer /);
    // 一覧は、「新しい会話」の下・アカウントの上
    const order = [...side.querySelectorAll('.app-new, .thread-sidebar, .app-rail-foot')].map((e) => ['app-new', 'thread-sidebar', 'app-rail-foot'].find((name) => e.classList.contains(name)));
    expect(order).toEqual(['app-new', 'thread-sidebar', 'app-rail-foot']);
    await ask('何件ありますか？');
    await screen.findByText('回答です。');
    const body = router.to('POST /api/chat')[0]?.body as { conversation_id?: string };
    expect(body.conversation_id).toBeTruthy();
    expect(window.sessionStorage.getItem('townscan:conversation_id')).toBe(body.conversation_id);
  });
});
