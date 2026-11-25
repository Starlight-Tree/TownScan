import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { health, jsonResponse } from '../tests/fixtures';
import { AppSidebar } from './AppSidebar';
import type { SidebarItem } from './AppSidebar';
import { HealthProvider } from './HealthProvider';
import { NewConversationProvider, useRegisterNewConversation } from './NewConversation';

const nav = vi.hoisted(() => ({ pathname: '/', push: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname, useRouter: () => ({ push: nav.push }) }));

const items: SidebarItem[] = [
  { href: '/', label: 'チャットと地図', icon: 'chat' },
  { href: '/accuracy', label: 'このアプリの精度', icon: 'accuracy' },
];
const setup = (pathname: string, props: Partial<Parameters<typeof AppSidebar>[0]> = {}) => {
  nav.pathname = pathname;
  return render(
    <AppSidebar brand="TownScan" brandHref="/" navLabel="主なページ" items={items} {...props}>
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

  it('ロゴの下、行き先の上に、ボタンとして出る（名前は画面に出さない文字で持ち、ツールチップにもなる）', () => {
    setup('/');
    const menu = screen.getByRole('navigation', { name: '主なページ' });
    const button = within(menu).getByRole('button', { name: '新しい会話' });
    expect(button).toHaveAttribute('data-tip', '新しい会話');
    expect(within(button).getByText('新しい会話')).toHaveClass('app-rail-label');
    const order = [...menu.querySelectorAll('a, button')].map((e) => e.textContent?.trim());
    expect(order.indexOf('新しい会話')).toBeGreaterThan(order.indexOf('TownScan'));
    expect(order.indexOf('新しい会話')).toBeLessThan(order.indexOf('チャットと地図'));
  });

  it('ホームのチャットが開いていれば、そのチャットを新しくし、ページは移らない', async () => {
    const onNew = vi.fn();
    nav.pathname = '/';
    render(
      <NewConversationProvider>
        <HomeChat onNew={onNew} />
        <AppSidebar brand="TownScan" brandHref="/" navLabel="主なページ" items={items} />
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
        <AppSidebar brand="TownScan" brandHref="/" navLabel="主なページ" items={items} />
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
  it('ロゴ・2 つの行き先・下部の中身を出す（名前は、画面に出さない文字で持つ）', () => {
    setup('/');
    const menu = screen.getByRole('navigation', { name: '主なページ' });
    expect(within(menu).getByRole('link', { name: 'TownScan' })).toHaveAttribute('href', '/');
    expect(within(menu).getByRole('link', { name: 'チャットと地図' })).toHaveAttribute('href', '/');
    expect(within(menu).getByRole('link', { name: 'このアプリの精度' })).toHaveAttribute('href', '/accuracy');
    expect(within(menu).queryByRole('link', { name: 'このアプリについて' })).not.toBeInTheDocument();
    expect(screen.getByText('下部の中身')).toBeInTheDocument();
    // 名前は、ホバーで出るツールチップの文字にもなる
    expect(screen.getByRole('link', { name: 'このアプリの精度' })).toHaveAttribute('data-tip', 'このアプリの精度');
    // 項目の名前は、閉じた細い帯でも読み上げに残るよう、画面に出さない文字の要素で持つ
    expect(screen.getByText('このアプリの精度')).toHaveClass('app-rail-label');
  });

  it('各項目に、アイコン（線画の SVG。読み上げの対象にしない）がある', () => {
    setup('/');
    for (const name of ['チャットと地図', 'このアプリの精度']) {
      const svg = screen.getByRole('link', { name }).querySelector('svg');
      expect(svg, name).not.toBeNull();
      expect(svg).toHaveAttribute('aria-hidden', 'true');
      expect(svg).toHaveAttribute('stroke-width', '1.6');
      expect(svg).toHaveAttribute('width', '20');
    }
  });

  it('テーマの切り替えは、サイドパネルには出さない（アカウントのメニューの中）', () => {
    setup('/');
    expect(screen.queryByRole('group', { name: 'テーマ' })).not.toBeInTheDocument();
  });

  it.each([
    ['/', 'チャットと地図'],
    ['/accuracy', 'このアプリの精度'],
  ])('%s では、「%s」だけに aria-current を付ける', (pathname, label) => {
    setup(pathname);
    const current = screen.getAllByRole('link').filter((a) => a.getAttribute('aria-current') === 'page');
    expect(current.map((a) => a.textContent)).toEqual([label]);
  });

  it('配下のパスは、その項目の続き。頭だけ同じ別のパスは、続きとみなさない', () => {
    const { unmount } = setup('/accuracy/detail');
    expect(screen.getByRole('link', { name: 'このアプリの精度' })).toHaveAttribute('aria-current', 'page');
    unmount();
    setup('/accuracyx');
    expect(screen.getByRole('link', { name: 'このアプリの精度' })).not.toHaveAttribute('aria-current');
  });

  it('「/」の項目は、無関係なパス（/login）では current にならない', () => {
    setup('/login');
    expect(screen.queryByRole('link', { current: 'page' })).not.toBeInTheDocument();
  });

  describe('開閉', () => {
    it('はじめは開いていて、閉じるボタンがある（開くボタンは無い）', () => {
      setup('/');
      expect(screen.getByRole('complementary')).toHaveAttribute('data-open', 'true');
      expect(screen.getByRole('button', { name: 'サイドパネルを閉じる' })).toHaveAttribute('aria-expanded', 'true');
      expect(screen.queryByRole('button', { name: 'サイドパネルを開く' })).not.toBeInTheDocument();
    });

    it('閉じると、開くボタンに替わってフォーカスが移り、行き先と下部の中身は残る。開くと元に戻る', async () => {
      setup('/');
      await userEvent.click(screen.getByRole('button', { name: 'サイドパネルを閉じる' }));
      expect(screen.getByRole('complementary')).toHaveAttribute('data-open', 'false');
      const open = screen.getByRole('button', { name: 'サイドパネルを開く' });
      expect(open).toHaveAttribute('aria-expanded', 'false');
      expect(open).toHaveFocus();
      expect(screen.queryByRole('button', { name: 'サイドパネルを閉じる' })).not.toBeInTheDocument();
      // 閉じても、ロゴと行き先のリンクと、下部の中身は DOM に残る（細い帯が使う）
      expect(screen.getByRole('link', { name: 'TownScan' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'チャットと地図' })).toHaveAttribute('aria-current', 'page');
      expect(screen.getByText('下部の中身')).toBeInTheDocument();

      await userEvent.click(open);
      expect(screen.getByRole('complementary')).toHaveAttribute('data-open', 'true');
      expect(screen.getByRole('button', { name: 'サイドパネルを閉じる' })).toHaveFocus();
      expect(screen.queryByRole('button', { name: 'サイドパネルを開く' })).not.toBeInTheDocument();
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
      expect(screen.getByRole('button', { name: 'サイドパネルを開く' })).toHaveFocus();
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
        <AppSidebar brand="TownScan" brandHref="/" navLabel="主なページ" items={items}>
          <p>下部の中身</p>
        </AppSidebar>,
      );
      expect(screen.getByRole('complementary')).toHaveAttribute('data-open', 'false');
      expect(screen.getByRole('link', { name: 'このアプリの精度' })).toHaveAttribute('aria-current', 'page');
    });
  });
});

describe('AppSidebar（API の状態の印）', () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const withHealth = (pathname = '/') => {
    nav.pathname = pathname;
    return render(
      <HealthProvider>
        <AppSidebar brand="TownScan" brandHref="/" navLabel="主なページ" items={items}>
          <p>下部の中身</p>
        </AppSidebar>
      </HealthProvider>,
    );
  };

  it('llm が mock のとき「模擬モデルで応答しています」を、アカウントの上に出す（細い帯では名前をツールチップと読み上げで持つ）', async () => {
    fetchMock.mockResolvedValue(jsonResponse(health));
    const { container } = withHealth();
    const text = await screen.findByText('模擬モデルで応答しています');
    expect(text).toHaveClass('app-rail-label');
    const pill = text.closest('.app-status-pill')!;
    expect(pill).toHaveClass('pill--warn');
    expect(pill).toHaveAttribute('data-tip', '模擬モデルで応答しています');
    expect(pill.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    // 下部の並びは、状態の印 → アカウント（children）
    const foot = container.querySelector('.app-rail-foot')!;
    expect([...foot.children].map((c) => c.className.split(' ')[0] || c.tagName)).toEqual(['app-status', 'P']);
    expect(container.querySelector('.app-status')).toHaveAttribute('aria-live', 'polite');
  });

  it('health は同じオリジンの /api/health を読む', async () => {
    fetchMock.mockResolvedValue(jsonResponse(health));
    withHealth();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/health');
    await screen.findByText('模擬モデルで応答しています');
  });

  it('mock 以外では、モデル名の印（警告の色ではない）。読み込み中・失敗では、何も出さない', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ...health, llm: 'gemini' }));
    const { unmount } = withHealth();
    const text = await screen.findByText('モデル: gemini');
    expect(text.closest('.app-status-pill')).not.toHaveClass('pill--warn');
    expect(screen.queryByText('模擬モデルで応答しています')).not.toBeInTheDocument();
    unmount();

    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const { container } = withHealth();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.querySelector('.app-status-pill')).toBeNull();
    expect(container.querySelector('.app-status')).toBeEmptyDOMElement();
  });

  it('HealthProvider が無くても（読み込み中のまま）落ちない', () => {
    setup('/');
    expect(document.querySelector('.app-status-pill')).toBeNull();
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

  it('1024px 以上では、上の横帯（AppHeader の <header>）を出さない。バナー（合成データ・API 不通）は、どちらの幅でも出す', () => {
    const wide = block('@media (min-width: 1024px) {\n  .app:has(> .app-sidebar)');
    expect(wide).toContain('.app__column > .app-header { display: none; }');
    // バナーを隠す規則は、どこにも無い
    expect(css).not.toMatch(/\.banner[^{]*\{[^}]*display:\s*none/);
  });

  it('チャット（`/`）は 1 列だけ: サイドパネルの開閉で、本文の並び（左右・縦積み）を切り替える規則は無い（開いても、細い帯でも、チャットは残りの幅の中央に収まる）', () => {
    expect(css).not.toContain('@media (min-width: 1024px) and (max-width: 1256px)');
    expect(css).not.toMatch(/\.app:has\(\.app-sidebar\[data-open='true'\]\)[^{]*\.home/);
    expect(css).not.toMatch(/\.app:has\(\.app-sidebar\[data-open='true'\]\)[^{]*\.result-area/);
  });
});
