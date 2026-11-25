import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationSummary } from '../lib/api-types';
import { clearAccessToken } from '../lib/auth-token';
import { CONVERSATION_ID_KEY, readConversationId, writeConversationId } from '../lib/conversation-session';
import { createFetchRouter, jwtExpiringIn, type FetchRouter } from '../tests/history-helpers';
import { jsonResponse } from '../tests/fixtures';
import {
  ConversationList,
  ConversationListView,
  MSG_EXPIRED,
  MSG_NOT_CONFIGURED,
  MSG_NO_CONVERSATIONS,
  MSG_SIGNED_OUT,
  type ConversationsView,
} from './ConversationList';
import { HistoryProvider } from './HistoryProvider';
import { NewConversationProvider, useRegisterConversationOpen, useRegisterNewConversation } from './NewConversation';

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: nav.push }), usePathname: () => '/' }));

const c = (id: string, title: string, updated = '2026-11-25T01:05:00+00:00'): ConversationSummary => ({ id, title, created_at: '2026-11-25T01:00:00+00:00', updated_at: updated });
const LIST = [c('c1', '新規出現の候補は何件ありますか？'), c('c2', '地区ごとの候補数を比べて', '2026-11-24T10:30:00+09:00')];

/** 項目の「開く」ボタン（title 属性が題名。ゴミ箱の名前「「題名」を削除」と取り違えない） */
const openButton = (region: HTMLElement, title: string) => within(region).getByTitle(title);

function setupView(view: ConversationsView, props: Partial<Parameters<typeof ConversationListView>[0]> = {}) {
  const onSelect = vi.fn();
  const onDelete = vi.fn<(id: string) => Promise<string | null>>(async () => null);
  const onRetry = vi.fn();
  render(<ConversationListView view={view} currentId={null} busy={false} onSelect={onSelect} onDelete={onDelete} onRetry={onRetry} {...props} />);
  return { onSelect, onDelete, onRetry, region: screen.getByRole('region', { name: '会話の一覧' }) };
}

describe('一覧の見出し・名前（DocuNavi と同じ文言）', () => {
  it('見出しは「会話の履歴」、領域の名前（読み上げ）は「会話の一覧」。<aside> の入れ子（ランドマークの二重）にしない', () => {
    const { region } = setupView({ status: 'ready', conversations: LIST });
    expect(within(region).getByRole('heading', { name: '会話の履歴', level: 2 })).toBeInTheDocument();
    expect(region.tagName).toBe('SECTION');
    expect(region).toHaveClass('thread-sidebar');
  });
});

describe('一覧の 6 つの状態（仕様 §7.1.2）', () => {
  it('ログインしていない（ログインを使える設定）: 案内と /login への入口。領域は出す', () => {
    const { region } = setupView({ status: 'signed-out' });
    expect(within(region).getByText(MSG_SIGNED_OUT)).toBeInTheDocument();
    expect(MSG_SIGNED_OUT).toBe('ログインすると、会話を保存して、ここから開き直せます。');
    expect(within(region).getByRole('link', { name: 'Google でログイン' })).toHaveAttribute('href', '/login');
    expect(within(region).queryByRole('list')).not.toBeInTheDocument();
  });

  it('ログインを使えない設定: 案内だけ。入口は出さない', () => {
    const { region } = setupView({ status: 'not-configured' });
    expect(within(region).getByText(MSG_NOT_CONFIGURED)).toBeInTheDocument();
    expect(MSG_NOT_CONFIGURED).toBe('ログインを設定していない環境では、会話は保存されません。');
    expect(within(region).queryByRole('link')).not.toBeInTheDocument();
    expect(within(region).queryByRole('button')).not.toBeInTheDocument();
  });

  it('読み込み中: 「読み込み中…」（role=status）', () => {
    const { region } = setupView({ status: 'loading' });
    expect(within(region).getByRole('status')).toHaveTextContent('読み込み中…');
  });

  it('失敗: 文（role=alert）と「再読み込み」。押すと取り直す', async () => {
    const { region, onRetry } = setupView({ status: 'error', message: '会話の一覧を取得できませんでした。しばらく待ってから再試行してください。' });
    expect(within(region).getByRole('alert')).toHaveTextContent('会話の一覧を取得できませんでした。しばらく待ってから再試行してください。');
    await userEvent.click(within(region).getByRole('button', { name: '再読み込み' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('空: 「まだ会話がありません。質問を送ると、ここに並びます。」', () => {
    const { region } = setupView({ status: 'ready', conversations: [] });
    expect(within(region).getByText(MSG_NO_CONVERSATIONS)).toBeInTheDocument();
    expect(MSG_NO_CONVERSATIONS).toBe('まだ会話がありません。質問を送ると、ここに並びます。');
    expect(within(region).queryByRole('list')).not.toBeInTheDocument();
  });

  it('一覧: 渡された並びのまま、題名（title 属性に全文）と、更新時刻（ja-JP・月日と時分）を出す', () => {
    const { region } = setupView({ status: 'ready', conversations: LIST });
    const items = within(region).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    const open = within(items[0]!).getByTitle('新規出現の候補は何件ありますか？');
    expect(open.tagName).toBe('BUTTON');
    expect(open.querySelector('.thread-title')).toHaveTextContent('新規出現の候補は何件ありますか？');
    expect(open.querySelector('.thread-time')?.textContent).toBe(new Date('2026-11-25T01:05:00+00:00').toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }));
    expect(within(items[1]!).getByTitle('地区ごとの候補数を比べて')).toBeInTheDocument();
  });

  it('時刻が読めない会話も出す（時刻は空）', () => {
    const { region } = setupView({ status: 'ready', conversations: [c('c1', '題名', '')] });
    expect(region.querySelector('.thread-time')?.textContent).toBe('');
  });

  it('ログインの期限切れ: 文と /login への入口', () => {
    const { region } = setupView({ status: 'expired' });
    expect(within(region).getByText(MSG_EXPIRED)).toBeInTheDocument();
    expect(MSG_EXPIRED).toBe('ログインの有効期限が切れました。ログインし直してください。');
    expect(within(region).getByRole('link', { name: 'Google でログイン' })).toHaveAttribute('href', '/login');
  });
});

describe('項目と操作', () => {
  it('開いている会話に aria-current="true"。項目を押すと、その会話を開く', async () => {
    const { region, onSelect } = setupView({ status: 'ready', conversations: LIST }, { currentId: 'c2' });
    const current = openButton(region, '地区ごとの候補数を比べて');
    expect(current).toHaveAttribute('aria-current', 'true');
    expect(current.closest('li')).toHaveAttribute('data-current', 'true');
    const other = openButton(region, '新規出現の候補は何件ありますか？');
    expect(other).not.toHaveAttribute('aria-current');
    await userEvent.click(other);
    expect(onSelect).toHaveBeenCalledWith('c1');
  });

  it('生成中（busy）は、別の会話へ移れない（開いている会話のボタンは押せる）。開いている会話は削除できない（別の会話は削除できる）', () => {
    const { region } = setupView({ status: 'ready', conversations: LIST }, { currentId: 'c2', busy: true });
    expect(openButton(region, '新規出現の候補は何件ありますか？')).toBeDisabled();
    expect(openButton(region, '地区ごとの候補数を比べて')).toBeEnabled();
    expect(within(region).getByRole('button', { name: '「地区ごとの候補数を比べて」を削除' })).toBeDisabled();
    expect(within(region).getByRole('button', { name: '「新規出現の候補は何件ありますか？」を削除' })).toBeEnabled();
  });

  it('生成中でなければ、すべて押せる', () => {
    const { region } = setupView({ status: 'ready', conversations: LIST }, { currentId: 'c2', busy: false });
    for (const button of within(region).getAllByRole('button')) expect(button).toBeEnabled();
  });
});

describe('削除（2 段階）', () => {
  const trash = (region: HTMLElement, title: string) => within(region).getByRole('button', { name: `「${title}」を削除` });

  it('ゴミ箱（aria-label「「題名」を削除」・title「削除」）を押すと、その場で「削除する」「やめる」に替わる。まだ消さない', async () => {
    const { region, onDelete } = setupView({ status: 'ready', conversations: LIST });
    const button = trash(region, '地区ごとの候補数を比べて');
    expect(button).toHaveAttribute('title', '削除');
    await userEvent.click(button);
    expect(onDelete).not.toHaveBeenCalled();
    const item = screen.getByText('地区ごとの候補数を比べて').closest('li') as HTMLElement;
    expect(within(item).getByRole('button', { name: '削除する' })).toBeInTheDocument();
    expect(within(item).getByRole('button', { name: 'やめる' })).toBeInTheDocument();
    expect(within(item).queryByRole('button', { name: /を削除$/ })).not.toBeInTheDocument();
  });

  it('同時に確認が出るのは 1 件だけ。「やめる」で元に戻る', async () => {
    const { region } = setupView({ status: 'ready', conversations: LIST });
    await userEvent.click(trash(region, '地区ごとの候補数を比べて'));
    await userEvent.click(trash(region, '新規出現の候補は何件ありますか？'));
    expect(within(region).getAllByRole('button', { name: '削除する' })).toHaveLength(1);
    expect(within(region).getByRole('button', { name: '「地区ごとの候補数を比べて」を削除' })).toBeInTheDocument();
    await userEvent.click(within(region).getByRole('button', { name: 'やめる' }));
    expect(within(region).queryByRole('button', { name: '削除する' })).not.toBeInTheDocument();
    expect(within(region).getAllByRole('button', { name: /を削除$/ })).toHaveLength(2);
  });

  it('「削除する」で、その会話の削除を頼む。成功なら、何も出ない', async () => {
    const { region, onDelete } = setupView({ status: 'ready', conversations: LIST });
    await userEvent.click(trash(region, '新規出現の候補は何件ありますか？'));
    await userEvent.click(within(region).getByRole('button', { name: '削除する' }));
    expect(onDelete).toHaveBeenCalledWith('c1');
    expect(within(region).queryByRole('alert')).not.toBeInTheDocument();
    expect(within(region).queryByRole('button', { name: '削除する' })).not.toBeInTheDocument();
  });

  it('失敗したら、一覧の上に「会話を削除できませんでした。しばらく待ってから再試行してください。」（role=alert）。次の操作で消える', async () => {
    const message = '会話を削除できませんでした。しばらく待ってから再試行してください。';
    const { region, onDelete } = setupView({ status: 'ready', conversations: LIST });
    onDelete.mockResolvedValueOnce(message);
    await userEvent.click(trash(region, '新規出現の候補は何件ありますか？'));
    await userEvent.click(within(region).getByRole('button', { name: '削除する' }));
    const alert = await within(region).findByRole('alert');
    expect(alert).toHaveTextContent(message);
    expect(alert.compareDocumentPosition(within(region).getByRole('list')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await userEvent.click(trash(region, '地区ごとの候補数を比べて'));
    expect(within(region).queryByRole('alert')).not.toBeInTheDocument();
  });
});

// ---- サイドパネルの一覧（HistoryProvider・NewConversationProvider と結ぶ） ----

let router: FetchRouter;
function Providers({ loggedIn, loginAvailable = true, children }: { loggedIn: boolean; loginAvailable?: boolean; children: ReactNode }) {
  return (
    <HistoryProvider loggedIn={loggedIn} loginAvailable={loginAvailable}>
      <NewConversationProvider>{children}</NewConversationProvider>
    </HistoryProvider>
  );
}

beforeEach(() => {
  clearAccessToken();
  window.sessionStorage.clear();
  nav.push.mockReset();
  router = createFetchRouter();
  router.on('GET /api/auth/token', () => jsonResponse({ token: jwtExpiringIn(900) }));
  router.on('GET /api/conversations', () => jsonResponse({ conversations: LIST }));
  vi.stubGlobal('fetch', router.fn);
});
afterEach(() => vi.unstubAllGlobals());

describe('サイドパネルの一覧（ConversationList）', () => {
  it('ログインしていない: 案内を出し、/api/auth/token も /api/conversations も、一度も呼ばない', async () => {
    render(
      <Providers loggedIn={false}>
        <ConversationList />
      </Providers>,
    );
    expect(screen.getByText(MSG_SIGNED_OUT)).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(router.calls).toHaveLength(0);
  });

  it('ログインを使えない設定: 案内だけ。何も呼ばない', async () => {
    render(
      <Providers loggedIn={false} loginAvailable={false}>
        <ConversationList />
      </Providers>,
    );
    expect(screen.getByText(MSG_NOT_CONFIGURED)).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(router.calls).toHaveLength(0);
  });

  it('Provider が無い（ログインの画面・単体のテスト）ときも、ログインを使えない設定と同じで、何も呼ばない', async () => {
    render(<ConversationList />);
    expect(screen.getByText(MSG_NOT_CONFIGURED)).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(router.calls).toHaveLength(0);
  });

  it('ログイン中: 読み込み中を経て、JWT つきで取った一覧を出す', async () => {
    const gate = vi.fn();
    router.on('GET /api/conversations', async () => {
      gate();
      return jsonResponse({ conversations: LIST });
    });
    render(
      <Providers loggedIn>
        <ConversationList />
      </Providers>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('読み込み中…');
    expect(await screen.findByTitle('新規出現の候補は何件ありますか？')).toBeInTheDocument();
    expect(router.to('GET /api/conversations')[0]?.headers.get('authorization')).toMatch(/^Bearer /);
    expect(router.count('GET /api/conversations')).toBe(1);
  });

  it('取得の失敗は「再読み込み」で取り直せる。取り直している間も、前の一覧を出し続ける', async () => {
    router.on('GET /api/conversations', (_call, nth) => (nth === 0 ? jsonResponse({ error: { code: 'db_unavailable', message: 'x' } }, 503) : jsonResponse({ conversations: LIST })));
    render(
      <Providers loggedIn>
        <ConversationList />
      </Providers>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('会話の一覧を取得できませんでした。しばらく待ってから再試行してください。');
    await userEvent.click(screen.getByRole('button', { name: '再読み込み' }));
    expect(await screen.findByTitle('地区ごとの候補数を比べて')).toBeInTheDocument();
  });

  it('取り直しても 401 なら、ログインしていない扱い（期限切れの案内）にする。ログインの入口つき', async () => {
    router.on('GET /api/conversations', () => jsonResponse({ error: { code: 'unauthorized', message: 'ログインしてください' } }, 401));
    render(
      <Providers loggedIn>
        <ConversationList />
      </Providers>,
    );
    expect(await screen.findByText(MSG_EXPIRED)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Google でログイン' })).toHaveAttribute('href', '/login');
    expect(router.count('GET /api/conversations')).toBe(2);
  });

  it('項目を押すと、チャットが登録した「開く」を呼ぶ（ページは移らない）', async () => {
    const opened = vi.fn();
    function Chat() {
      useRegisterConversationOpen(opened);
      return null;
    }
    render(
      <Providers loggedIn>
        <Chat />
        <ConversationList />
      </Providers>,
    );
    await userEvent.click(await screen.findByTitle('地区ごとの候補数を比べて'));
    expect(opened).toHaveBeenCalledWith('c2');
    expect(nav.push).not.toHaveBeenCalled();
  });

  it('チャットが無いページ（精度）では、会話 ID を sessionStorage に書いてから、ホームへ移る', async () => {
    render(
      <Providers loggedIn>
        <ConversationList />
      </Providers>,
    );
    await userEvent.click(await screen.findByTitle('地区ごとの候補数を比べて'));
    expect(window.sessionStorage.getItem(CONVERSATION_ID_KEY)).toBe('c2');
    expect(nav.push).toHaveBeenCalledWith('/');
  });

  it('削除に成功したら一覧を取り直す。開いていた会話を消したら、チャットを最初の状態に戻す（新しい会話）。404 は成功として扱う', async () => {
    const reset = vi.fn();
    function Chat() {
      useRegisterNewConversation(reset);
      return null;
    }
    let deleted = false;
    router.on('GET /api/conversations', () => jsonResponse({ conversations: deleted ? [LIST[1]!] : LIST }));
    router.on('DELETE /api/conversations/c1', () => {
      deleted = true;
      return jsonResponse({ error: { code: 'not_found', message: '会話が見つかりません' } }, 404);
    });
    writeConversationId('c1');
    render(
      <Providers loggedIn>
        <Chat />
        <ConversationList />
      </Providers>,
    );
    await userEvent.click(await screen.findByRole('button', { name: '「新規出現の候補は何件ありますか？」を削除' }));
    await userEvent.click(screen.getByRole('button', { name: '削除する' }));
    await waitFor(() => expect(screen.queryByTitle('新規出現の候補は何件ありますか？')).not.toBeInTheDocument());
    expect(router.count('GET /api/conversations')).toBe(2);
    // 覚えていた会話（c1）を消した: チャットを新しくする
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('ほかのページで、覚えている会話を消したら、覚えている会話 ID を消す。別の会話を消しても、消さない', async () => {
    router.on('DELETE /api/conversations/c1', () => new Response(null, { status: 204 }));
    router.on('DELETE /api/conversations/c2', () => new Response(null, { status: 204 }));
    writeConversationId('c1');
    render(
      <Providers loggedIn>
        <ConversationList />
      </Providers>,
    );
    await userEvent.click(await screen.findByRole('button', { name: '「地区ごとの候補数を比べて」を削除' }));
    await userEvent.click(screen.getByRole('button', { name: '削除する' }));
    await waitFor(() => expect(router.count('DELETE /api/conversations/c2')).toBe(1));
    expect(readConversationId()).toBe('c1');
    await userEvent.click(await screen.findByRole('button', { name: '「新規出現の候補は何件ありますか？」を削除' }));
    await userEvent.click(screen.getByRole('button', { name: '削除する' }));
    await waitFor(() => expect(readConversationId()).toBeNull());
  });

  it('削除の失敗は、一覧の上に出す（一覧は残る）', async () => {
    router.on('DELETE /api/conversations/c1', () => jsonResponse({ error: { code: 'db_unavailable', message: 'x' } }, 503));
    render(
      <Providers loggedIn>
        <ConversationList />
      </Providers>,
    );
    await userEvent.click(await screen.findByRole('button', { name: '「新規出現の候補は何件ありますか？」を削除' }));
    await userEvent.click(screen.getByRole('button', { name: '削除する' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('会話を削除できませんでした。しばらく待ってから再試行してください。');
    expect(screen.getByTitle('新規出現の候補は何件ありますか？')).toBeInTheDocument();
  });
});

describe('一覧の CSS（DocuNavi の thread-* の宣言と同じ値。色の変数だけ TownScan の名前）', () => {
  const css = readFileSync(join(process.cwd(), 'app', 'globals.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  /** 行頭から始まる規則（`\nsel {`）の宣言を、書かれた順の [プロパティ, 値] で返す */
  function rule(selector: string, nth = 0): Array<[string, string]> {
    let start = -1;
    for (let i = 0; i <= nth; i += 1) start = css.indexOf(`\n${selector} {`, start + 1);
    expect(start, `${selector} が無い`).toBeGreaterThanOrEqual(0);
    const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
    return body
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const i = d.indexOf(':');
        return [d.slice(0, i).trim(), d.slice(i + 1).trim()] as [string, string];
      });
  }

  it('.thread-sidebar・見出し・案内・エラー', () => {
    expect(rule('.thread-sidebar')).toEqual([
      ['display', 'flex'],
      ['flex', 'none'],
      ['flex-direction', 'column'],
      ['width', '16rem'],
      ['min-height', '0'],
      ['padding', '0.75rem 0.5rem 0.75rem 1rem'],
      ['border-right', '1px solid var(--border)'],
      ['overflow-y', 'auto'],
    ]);
    expect(rule('.thread-sidebar-title')).toEqual([
      ['margin', '0 0 0.5rem'],
      ['color', 'var(--text-muted)'],
      ['font-size', '0.8rem'],
      ['font-weight', '600'],
    ]);
    // 案内とエラーは、先頭の宣言（余白・色・大きさ）を共有する。エラーだけ、枠と色を足す
    expect(css).toContain('\n.thread-sidebar-note,\n.thread-sidebar-error {\n  margin: 0.25rem 0;\n  color: var(--text-muted);\n  font-size: 0.85rem;\n}');
    expect(rule('.thread-sidebar-error', 1)).toEqual([
      ['padding', '0.4rem 0.6rem'],
      ['border', '1px solid var(--error-border)'],
      ['border-radius', '0.5rem'],
      ['background', 'var(--error-bg)'],
      ['color', 'var(--error-text)'],
    ]);
  });

  it('一覧・項目・開くボタン・題名・時刻', () => {
    expect(rule('.thread-list')).toEqual([
      ['display', 'flex'],
      ['flex-direction', 'column'],
      ['gap', '0.15rem'],
      ['margin', '0'],
      ['padding', '0'],
      ['list-style', 'none'],
    ]);
    expect(rule('.thread-item')).toEqual([
      ['position', 'relative'],
      ['border-radius', '0.5rem'],
    ]);
    expect(css).toContain('\n.thread-item:hover,\n.thread-item:focus-within {\n  background: var(--surface-muted);\n}');
    expect(rule(".thread-item[data-current='true']")).toEqual([
      ['background', 'var(--surface)'],
      ['box-shadow', '0 0 0 1px var(--border)'],
    ]);
    expect(rule('.thread-open')).toEqual([
      ['display', 'flex'],
      ['flex-direction', 'column'],
      ['width', '100%'],
      ['min-width', '0'],
      ['padding', '0.4rem 3rem 0.4rem 0.6rem'],
      ['border', '0'],
      ['border-radius', '0.5rem'],
      ['background', 'none'],
      ['color', 'var(--text-body)'],
      ['text-align', 'left'],
      ['cursor', 'pointer'],
    ]);
    expect(rule(".thread-item[data-current='true'] .thread-open:not(:disabled)")).toEqual([['color', 'var(--text)']]);
    expect(rule('.thread-open:disabled')).toEqual([
      ['color', 'var(--text-muted)'],
      ['cursor', 'not-allowed'],
    ]);
    expect(rule('.thread-title')).toEqual([
      ['display', '-webkit-box'],
      ['overflow', 'hidden'],
      ['font-size', '0.9rem'],
      ['line-height', '1.4'],
      ['-webkit-box-orient', 'vertical'],
      ['-webkit-line-clamp', '2'],
      ['overflow-wrap', 'anywhere'],
    ]);
    expect(rule('.thread-time')).toEqual([
      ['color', 'var(--text-muted)'],
      ['font-size', '0.75rem'],
    ]);
  });

  it('削除ボタン・確認の 2 つのボタン', () => {
    expect(rule('.thread-delete')).toEqual([
      ['position', 'absolute'],
      ['top', '0.35rem'],
      ['right', '0.35rem'],
      ['display', 'inline-grid'],
      ['place-items', 'center'],
      ['width', '1.7rem'],
      ['height', '1.7rem'],
      ['padding', '0'],
      ['border', '0'],
      ['border-radius', '0.4rem'],
      ['background', 'none'],
      ['color', 'var(--text-muted)'],
      ['cursor', 'pointer'],
      ['opacity', '0'],
    ]);
    expect(css).toContain(
      "\n.thread-item:hover .thread-delete,\n.thread-item:focus-within .thread-delete,\n.thread-item[data-current='true'] .thread-delete {\n  opacity: 1;\n}",
    );
    expect(rule('.thread-delete:hover:not(:disabled)')).toEqual([
      ['background', 'var(--error-bg)'],
      ['color', 'var(--error-text)'],
    ]);
    expect(rule('.thread-delete:disabled')).toEqual([
      ['opacity', '0.4'],
      ['cursor', 'not-allowed'],
    ]);
    expect(rule('.thread-confirm')).toEqual([
      ['display', 'flex'],
      ['gap', '0.35rem'],
      ['padding', '0 0.6rem 0.4rem'],
    ]);
    expect(rule('.thread-confirm-yes')).toEqual([
      ['border-color', 'var(--error-border)'],
      ['background', 'var(--error-bg)'],
      ['color', 'var(--error-text)'],
    ]);
  });

  it('サイドパネルの中: 残りの高さを使って中だけをスクロールする。削除ボタンの余白は、見えるときだけ取る（DocuNavi の .ws-sidebar を .app-sidebar に）', () => {
    expect(rule('.app-sidebar .thread-sidebar')).toEqual([
      ['flex', '1'],
      ['width', 'auto'],
      ['padding', '0.75rem 0 0'],
      ['border-right', '0'],
    ]);
    expect(rule('.app-sidebar .thread-open')).toEqual([['padding-right', '0.6rem']]);
    expect(css).toContain(
      "\n.app-sidebar .thread-item:hover .thread-open,\n.app-sidebar .thread-item:focus-within .thread-open,\n.app-sidebar .thread-item[data-current='true'] .thread-open {\n  padding-right: 2.75rem;\n}",
    );
    expect(rule(".app-sidebar .thread-sidebar-note [role='alert']")).toEqual([
      ['margin', '0 0 0.4rem'],
      ['color', 'var(--error)'],
    ]);
  });

  it('色の直書きが無い（TownScan の変数だけ）。DocuNavi の --danger-*・--ws-* の名前は残っていない', () => {
    const block = css.slice(css.indexOf('\n.thread-sidebar {'));
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|--danger|--ws-/);
  });

  it('細い帯・狭い幅には出さない: DocuNavi の狭い画面の規則（max-width: 700px）は写していない', () => {
    expect(css).not.toMatch(/@media \(max-width: 700px\)[^}]*\.thread-sidebar/);
    expect(css).not.toContain('max-height: 9rem');
  });
});

describe('確認に入ったあとに送信が始まったとき（仕様 §7.1.3・§7.1.6 の 4）', () => {
  it('開いている会話の「削除する」は、生成中は押せない（消すと生成が止まる）。やめるは押せる。生成が終われば、また押せる', async () => {
    const onDelete = vi.fn<(id: string) => Promise<string | null>>(async () => null);
    const props = { view: { status: 'ready', conversations: LIST } as ConversationsView, currentId: 'c2', onSelect: vi.fn(), onDelete, onRetry: vi.fn() };
    const { rerender } = render(<ConversationListView {...props} busy={false} />);
    await userEvent.click(screen.getByRole('button', { name: '「地区ごとの候補数を比べて」を削除' }));
    rerender(<ConversationListView {...props} busy />); // 確認を出したまま、送信が始まった
    const yes = screen.getByRole('button', { name: '削除する' });
    expect(yes).toBeDisabled();
    await userEvent.click(yes);
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'やめる' })).toBeEnabled();
    rerender(<ConversationListView {...props} busy={false} />);
    await userEvent.click(screen.getByRole('button', { name: '削除する' }));
    expect(onDelete).toHaveBeenCalledWith('c2');
  });
});
