import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONVERSATION_ID_KEY, writeConversationId } from '../lib/conversation-session';
import { clearAccessToken } from '../lib/auth-token';
import { jsonResponse } from '../tests/fixtures';
import { createFetchRouter, jwtExpiringIn } from '../tests/history-helpers';
import { AppSidebar } from './AppSidebar';
import { HistoryProvider } from './HistoryProvider';
import { NewConversationProvider, useRegisterNewConversation } from './NewConversation';

const nav = vi.hoisted(() => ({ pathname: '/', push: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname, useRouter: () => ({ push: nav.push }) }));

const inside = () => within(screen.getByRole('complementary'));
const setup = (pathname: string, props: Partial<Parameters<typeof AppSidebar>[0]> = {}) => {
  nav.pathname = pathname;
  return render(
    <AppSidebar brand="TownScan" brandHref="/" navLabel="主なページ" {...props}>
      <p>下部の中身</p>
    </AppSidebar>,
  );
};

function HomeChat({ onNew }: { onNew: () => void }) {
  useRegisterNewConversation(onNew);
  return null;
}

describe('AppSidebar の「新しい会話」（DocuNavi と同じ位置）', () => {
  beforeEach(() => nav.push.mockReset());

  it('ロゴの下に、ボタンとして出る（名前は画面に出さない文字で持ち、ツールチップにもなる）', () => {
    setup('/');
    const menu = screen.getByRole('navigation', { name: '主なページ' });
    const button = within(menu).getByRole('button', { name: '新しい会話' });
    expect(button).toHaveAttribute('data-tip', '新しい会話');
    expect(within(button).getByText('新しい会話')).toHaveClass('app-rail-label');
    const order = [...menu.querySelectorAll('a, button')].map((e) => e.textContent?.trim());
    expect(order.indexOf('新しい会話')).toBeGreaterThan(order.indexOf('TownScan'));
  });

  it('ホームのチャットが開いていれば、そのチャットを新しくし、ページは移らない', async () => {
    const onNew = vi.fn();
    nav.pathname = '/';
    render(
      <NewConversationProvider>
        <HomeChat onNew={onNew} />
        <AppSidebar brand="TownScan" brandHref="/" navLabel="主なページ" />
      </NewConversationProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: '新しい会話' }));
    expect(onNew).toHaveBeenCalledTimes(1);
    expect(nav.push).not.toHaveBeenCalled();
  });

  it('ほかのページ（チャットが無い）では、ホームへ移る', async () => {
    nav.pathname = '/accuracy';
    render(
      <NewConversationProvider>
        <AppSidebar brand="TownScan" brandHref="/" navLabel="主なページ" />
      </NewConversationProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: '新しい会話' }));
    expect(nav.push).toHaveBeenCalledWith('/');
  });

  it('CSS: 開いた表示では枠のあるボタン、細い帯ではほかのアイコンと同じ', () => {
    const css = readFileSync(join(process.cwd(), 'app', 'globals.css'), 'utf8');
    expect(css).toMatch(/\.app-sidebar\[data-open='true'\] \.app-new\s*\{[^}]*border:\s*1px solid var\(--border\)/);
    expect(css).not.toMatch(/\.app-sidebar\[data-open='false'\] \.app-new\s*\{[^}]*border:/);
  });
});

describe('AppSidebar', () => {
  it('ロゴと「新しい会話」と下部の中身を出す。ページへの入口（行き先の欄）は無い', () => {
    setup('/');
    const menu = screen.getByRole('navigation', { name: '主なページ' });
    expect(within(menu).getByRole('link', { name: 'TownScan' })).toHaveAttribute('href', '/');
    expect(within(menu).getAllByRole('link')).toHaveLength(1);
    expect(screen.queryByRole('link', { name: 'このアプリの精度' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'チャットと地図' })).not.toBeInTheDocument();
    expect(screen.getByText('下部の中身')).toBeInTheDocument();
  });

  it('テーマの切り替えは、サイドパネルには出さない（アカウントのメニューの中）', () => {
    setup('/');
    expect(screen.queryByRole('group', { name: 'テーマ' })).not.toBeInTheDocument();
  });

  describe('開閉', () => {
    it('はじめは開いていて、閉じるボタンがある（開くボタンは無い）', () => {
      setup('/');
      expect(screen.getByRole('complementary')).toHaveAttribute('data-open', 'true');
      expect(screen.getByRole('button', { name: 'サイドパネルを閉じる' })).toHaveAttribute('aria-expanded', 'true');
      expect(inside().queryByRole('button', { name: 'サイドパネルを開く' })).not.toBeInTheDocument();
    });

    it('閉じると、開くボタンに替わってフォーカスが移り、ロゴと下部の中身は残る。開くと元に戻る', async () => {
      setup('/');
      await userEvent.click(screen.getByRole('button', { name: 'サイドパネルを閉じる' }));
      expect(screen.getByRole('complementary')).toHaveAttribute('data-open', 'false');
      const open = inside().getByRole('button', { name: 'サイドパネルを開く' });
      expect(open).toHaveAttribute('aria-expanded', 'false');
      expect(open).toHaveFocus();
      expect(screen.queryByRole('button', { name: 'サイドパネルを閉じる' })).not.toBeInTheDocument();
      // 閉じても、ロゴのリンクと、下部の中身は DOM に残る（細い帯が使う）
      expect(screen.getByRole('link', { name: 'TownScan' })).toBeInTheDocument();
      expect(screen.getByText('下部の中身')).toBeInTheDocument();

      await userEvent.click(open);
      expect(screen.getByRole('complementary')).toHaveAttribute('data-open', 'true');
      expect(screen.getByRole('button', { name: 'サイドパネルを閉じる' })).toHaveFocus();
      expect(inside().queryByRole('button', { name: 'サイドパネルを開く' })).not.toBeInTheDocument();
    });

    it('閉じた帯の空き部分（下敷きのボタン）をクリックしても開く。下敷きは読み上げ・Tab の対象にしない', async () => {
      const { container } = setup('/');
      expect(container.querySelector('.app-rail-open')).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'サイドパネルを閉じる' }));
      const underlay = container.querySelector<HTMLButtonElement>('.app-rail-open');
      expect(underlay).toBeInTheDocument();
      expect(underlay).toHaveAttribute('aria-hidden', 'true');
      expect(underlay).toHaveAttribute('tabindex', '-1');
      await userEvent.click(underlay!);
      expect(screen.getByRole('complementary')).toHaveAttribute('data-open', 'true');
      expect(screen.getByRole('button', { name: 'サイドパネルを閉じる' })).toHaveFocus();
      expect(container.querySelector('.app-rail-open')).not.toBeInTheDocument();
    });

    it('キーボード（Enter）でも開閉できる', async () => {
      setup('/');
      screen.getByRole('button', { name: 'サイドパネルを閉じる' }).focus();
      await userEvent.keyboard('{Enter}');
      expect(inside().getByRole('button', { name: 'サイドパネルを開く' })).toHaveFocus();
      await userEvent.keyboard('{Enter}');
      expect(screen.getByRole('button', { name: 'サイドパネルを閉じる' })).toHaveFocus();
    });

    it('開閉の状態は保存しない（localStorage・sessionStorage に書かず、作り直すと、また開いた状態から）', async () => {
      const local = vi.spyOn(Storage.prototype, 'setItem');
      const { unmount } = setup('/');
      await userEvent.click(screen.getByRole('button', { name: 'サイドパネルを閉じる' }));
      expect(screen.getByRole('complementary')).toHaveAttribute('data-open', 'false');
      expect(local).not.toHaveBeenCalled();
      unmount();
      setup('/');
      expect(screen.getByRole('complementary')).toHaveAttribute('data-open', 'true');
      expect(window.localStorage.length).toBe(0);
      expect(window.sessionStorage.length).toBe(0);
    });

    it('ページが変わっても（pathname が変わって描画し直しても）、開閉の状態は変わらない', async () => {
      const { rerender } = setup('/');
      await userEvent.click(screen.getByRole('button', { name: 'サイドパネルを閉じる' }));
      nav.pathname = '/accuracy';
      rerender(
        <AppSidebar brand="TownScan" brandHref="/" navLabel="主なページ">
          <p>下部の中身</p>
        </AppSidebar>,
      );
      expect(screen.getByRole('complementary')).toHaveAttribute('data-open', 'false');
    });
  });
});

describe('AppSidebar（1023px 以下: 重ねて開く）', () => {
  beforeEach(() => {
    nav.push.mockReset();
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })));
  });
  afterEach(() => vi.unstubAllGlobals());

  const bar = (container: HTMLElement) => within(container.querySelector<HTMLElement>('.app-narrow-bar')!);
  const aside = () => screen.getByRole('complementary');

  it('はじめは閉じている。上の細い行のボタンで開くと、閉じるボタンにフォーカスが移り、背景の暗い部分（scrim）が出る。いつも開いた表示', async () => {
    const { container } = setup('/');
    expect(aside()).toHaveAttribute('data-drawer', 'closed');
    expect(aside()).toHaveAttribute('data-open', 'true');
    expect(container.querySelector('.app-scrim')).toBeNull();
    const opener = bar(container).getByRole('button', { name: 'サイドパネルを開く' });
    expect(opener).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(opener);
    expect(aside()).toHaveAttribute('data-drawer', 'open');
    expect(opener).toHaveAttribute('aria-expanded', 'true');
    expect(container.querySelector('.app-scrim')).toHaveAttribute('aria-hidden', 'true');
    await waitFor(() => expect(inside().getByRole('button', { name: 'サイドパネルを閉じる' })).toHaveFocus());
  });

  it('閉じるボタン・背景の暗い部分・Esc で閉じて、フォーカスは開くボタンへ戻る', async () => {
    const { container } = setup('/');
    const opener = bar(container).getByRole('button', { name: 'サイドパネルを開く' });
    for (const close of [
      () => userEvent.click(inside().getByRole('button', { name: 'サイドパネルを閉じる' })),
      () => userEvent.click(container.querySelector<HTMLElement>('.app-scrim')!),
      () => userEvent.keyboard('{Escape}'),
    ]) {
      await userEvent.click(opener);
      await waitFor(() => expect(aside()).toHaveAttribute('data-drawer', 'open'));
      await close();
      expect(aside()).toHaveAttribute('data-drawer', 'closed');
      expect(opener).toHaveFocus();
    }
  });

  it('アカウントのメニューの Esc は、メニューだけを閉じる（重ねて開いたパネルは閉じない）', async () => {
    const { container } = render(
      <AppSidebar brand="TownScan" brandHref="/" navLabel="主なページ">
        <div role="menu" aria-label="アカウント">
          <button role="menuitem">メニュー項目</button>
        </div>
      </AppSidebar>,
    );
    await userEvent.click(bar(container).getByRole('button', { name: 'サイドパネルを開く' }));
    screen.getByRole('menuitem', { name: 'メニュー項目' }).focus();
    await userEvent.keyboard('{Escape}');
    expect(aside()).toHaveAttribute('data-drawer', 'open');
  });

  it('「新しい会話」・ロゴを押すと閉じる。ページが変わっても閉じる', async () => {
    const { container, rerender } = setup('/');
    const opener = bar(container).getByRole('button', { name: 'サイドパネルを開く' });
    await userEvent.click(opener);
    await userEvent.click(inside().getByRole('button', { name: '新しい会話' }));
    expect(aside()).toHaveAttribute('data-drawer', 'closed');
    expect(nav.push).toHaveBeenCalledWith('/');

    await userEvent.click(opener);
    await userEvent.click(inside().getByRole('link', { name: 'TownScan' }));
    expect(aside()).toHaveAttribute('data-drawer', 'closed');

    await userEvent.click(opener);
    expect(aside()).toHaveAttribute('data-drawer', 'open');
    nav.pathname = '/accuracy';
    rerender(
      <AppSidebar brand="TownScan" brandHref="/" navLabel="主なページ">
        <p>下部の中身</p>
      </AppSidebar>,
    );
    expect(aside()).toHaveAttribute('data-drawer', 'closed');
  });

  it('PC 幅で細い帯に畳んでいても、狭い幅で重ねて開くときは、開いた表示（ラベルが見える）', async () => {
    const { container } = setup('/');
    // この環境は狭い幅なので、細い帯（rail）にはならない: data-open は、いつも true
    expect(aside()).toHaveAttribute('data-open', 'true');
    expect(container.querySelector('.app-rail-open')).toBeNull();
    expect(inside().queryByRole('button', { name: 'サイドパネルを開く' })).not.toBeInTheDocument();
  });
});

describe('globals.css のサイドパネルの境目', () => {
  const css = readFileSync(join(process.cwd(), 'app', 'globals.css'), 'utf8');
  const block = (start: string) => {
    const from = css.indexOf(start);
    expect(from, start).toBeGreaterThanOrEqual(0);
    let depth = 0;
    for (let i = css.indexOf('{', from); i < css.length; i += 1) {
      if (css[i] === '{') depth += 1;
      if (css[i] === '}' && --depth === 0) return css.slice(from, i + 1);
    }
    throw new Error('閉じていない');
  };

  it('1024px 未満はサイドパネルを出さない（開閉できるのは 1024px 以上だけ）', () => {
    expect(css).toContain('.app-sidebar { display: none; }');
    const wide = block('@media (min-width: 1024px) {\n  .app:has(> .app-sidebar)');
    expect(wide).toContain('.app-sidebar { flex: 0 0 3.5rem;');
    expect(wide).toContain(".app-sidebar[data-open='true'] { flex-basis: 16rem;");
  });

  it('上の横帯は無い。バナー（合成データ・API 不通）は、どの幅でも出す（隠す規則が無い）', () => {
    expect(css).not.toMatch(/\.app-header[^_\-]/);
    expect(css).not.toMatch(/\.banner[^{]*\{[^}]*display:\s*none/);
  });

  it('1023px 以下: 上の細い行（.app-narrow-bar）と背景の暗い部分は、この幅だけ。サイドパネルは、重ねて開く（固定・全面の高さ・scrim の下）。1024px 以上では、細い行も暗い部分も出さない', () => {
    expect(css).toMatch(/\.app-narrow-bar, \.app-scrim \{ display: none; \}/);
    const narrow = block('@media (max-width: 1023px) {\n  .app-narrow-bar');
    expect(narrow).toContain('.app-narrow-bar { display: flex;');
    expect(narrow).toContain('.app-scrim { display: block; position: fixed;');
    expect(narrow).toMatch(/\.app-sidebar \{ position: fixed; z-index: 40;/);
    expect(narrow).toContain(".app-sidebar[data-drawer='open'] { display: flex; }");
    // 閉じているあいだは出さない（基本の規則）
    expect(css).toContain('.app-sidebar { display: none; }');
    // 重ねて開くパネルは、背景の暗い部分（39）より上（40）
    const z = (re: RegExp) => Number(narrow.match(re)?.[1]);
    expect(z(/\.app-sidebar \{[^}]*z-index: (\d+)/)).toBeGreaterThan(z(/\.app-scrim \{[^}]*z-index: (\d+)/));
  });

  it('指で押せる大きさ: 狭い幅の開く・閉じるボタンは 44px', () => {
    const narrow = block('@media (max-width: 1023px) {\n  .app-narrow-bar');
    expect(narrow).toMatch(/\.app-narrow-bar \.app-icon-btn, \.app-sidebar \.app-icon-btn \{ width: 44px; height: 44px; \}/);
  });

  it('状態の印（模擬モデル・モデル名）の規則は無い', () => {
    expect(css).not.toContain('app-status');
  });

  it('チャット（`/`）は 1 列だけ: サイドパネルの開閉で、本文の並び（左右・縦積み）を切り替える規則は無い（開いても、細い帯でも、チャットは残りの幅の中央に収まる）', () => {
    expect(css).not.toContain('@media (min-width: 1024px) and (max-width: 1256px)');
    expect(css).not.toMatch(/\.app:has\(\.app-sidebar\[data-open='true'\]\)[^{]*\.home/);
    expect(css).not.toMatch(/\.app:has\(\.app-sidebar\[data-open='true'\]\)[^{]*\.result-area/);
  });
});

describe('AppSidebar の会話の履歴の一覧（仕様 §7.1.1）', () => {
  beforeEach(() => {
    nav.push.mockReset();
    window.sessionStorage.clear();
  });
  afterEach(() => vi.unstubAllGlobals());

  const list = () => screen.queryByRole('region', { name: '会話の一覧' });

  it('開いた表示（PC 幅）では、「新しい会話」の下・アカウント（下部の中身）の上に、会話の一覧の領域を出す（ログインしていなくても、領域は出す）', () => {
    setup('/');
    const region = list();
    expect(region).not.toBeNull();
    const nav = screen.getByRole('navigation', { name: '主なページ' });
    const foot = screen.getByText('下部の中身');
    // DOM の順: ロゴ・「新しい会話」（nav）→ 一覧 → 下部の中身
    expect(nav.compareDocumentPosition(region!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(region!.compareDocumentPosition(foot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // サイドパネルの中に 1 つだけ（ランドマークは二重にならない）
    expect(screen.getAllByRole('complementary')).toHaveLength(1);
    expect(screen.getByRole('complementary')).toContainElement(region);
  });

  it('細い帯（閉じた表示）では出さない。開くと、また出る', async () => {
    setup('/');
    await userEvent.click(screen.getByRole('button', { name: 'サイドパネルを閉じる' }));
    expect(screen.getByRole('complementary')).toHaveAttribute('data-open', 'false');
    expect(list()).toBeNull();
    // 「新しい会話」の「＋」は、いまのまま
    expect(screen.getByRole('button', { name: '新しい会話' })).toBeInTheDocument();
    await userEvent.click(inside().getByRole('button', { name: 'サイドパネルを開く' }));
    expect(list()).not.toBeNull();
  });

  it('1023px 以下の重ねて開くパネルには、開いたときだけ出る（閉じている間は描かない）', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })));
    const { container } = setup('/');
    expect(list()).toBeNull();
    await userEvent.click(within(container.querySelector<HTMLElement>('.app-narrow-bar')!).getByRole('button', { name: 'サイドパネルを開く' }));
    expect(screen.getByRole('complementary')).toHaveAttribute('data-drawer', 'open');
    expect(list()).not.toBeNull();
    expect(screen.getByText('会話の履歴')).toBeInTheDocument();
    await userEvent.click(inside().getByRole('button', { name: 'サイドパネルを閉じる' }));
    expect(list()).toBeNull();
  });

  it('1023px 以下: ログイン中に、重ねて開いたパネルの一覧から会話を選ぶと、その会話を開き、パネルを閉じて、フォーカスは開くボタンへ戻る', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })));
    clearAccessToken();
    const router = createFetchRouter();
    router.on('GET /api/auth/token', () => jsonResponse({ token: jwtExpiringIn(900) }));
    router.on('GET /api/conversations', () =>
      jsonResponse({ conversations: [{ id: 'c9', title: '狭い幅で開く会話', updated_at: '2026-11-25T10:00:00Z' }] }),
    );
    vi.stubGlobal('fetch', router.fn);
    nav.pathname = '/';
    const { container } = render(
      <HistoryProvider loggedIn loginAvailable>
        <AppSidebar brand="TownScan" brandHref="/" navLabel="主なページ" />
      </HistoryProvider>,
    );
    const opener = within(container.querySelector<HTMLElement>('.app-narrow-bar')!).getByRole('button', { name: 'サイドパネルを開く' });
    await userEvent.click(opener);
    await userEvent.click(await screen.findByRole('button', { name: /^狭い幅で開く会話/ }));
    expect(window.sessionStorage.getItem(CONVERSATION_ID_KEY)).toBe('c9');
    expect(nav.push).toHaveBeenCalledWith('/');
    expect(screen.getByRole('complementary')).toHaveAttribute('data-drawer', 'closed');
    expect(opener).toHaveFocus();
  });

  it('ほかのページ（精度）の「新しい会話」は、覚えている会話 ID を消してから、ホームへ移る（移った先で、前の会話を開き直さない）', async () => {
    writeConversationId('c1');
    nav.pathname = '/accuracy';
    render(
      <NewConversationProvider>
        <AppSidebar brand="TownScan" brandHref="/" navLabel="主なページ" />
      </NewConversationProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: '新しい会話' }));
    expect(window.sessionStorage.getItem(CONVERSATION_ID_KEY)).toBeNull();
    expect(nav.push).toHaveBeenCalledWith('/');
  });

  it('ホームのチャットが開いているときの「新しい会話」は、チャットの処理に任せ、ここでは会話 ID に触れない', async () => {
    writeConversationId('c1');
    nav.pathname = '/';
    const onNew = vi.fn();
    render(
      <NewConversationProvider>
        <HomeChat onNew={onNew} />
        <AppSidebar brand="TownScan" brandHref="/" navLabel="主なページ" />
      </NewConversationProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: '新しい会話' }));
    expect(onNew).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(CONVERSATION_ID_KEY)).toBe('c1');
  });
});
