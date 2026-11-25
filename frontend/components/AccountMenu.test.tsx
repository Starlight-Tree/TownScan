import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { THEME_KEY } from '../lib/theme';
import { AccountMenu } from './AccountMenu';
import { ThemeSwitch } from './ThemeSwitch';

const nav = vi.hoisted(() => ({ pathname: '/' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname }));

const setup = () => render(<AccountMenu name="試験 花子" email="hanako@example.com" logout={vi.fn(async () => {})} />);
const openButton = () => screen.getByRole('button', { name: '試験 花子のアカウントメニュー' });

afterEach(() => {
  nav.pathname = '/';
  delete document.documentElement.dataset.theme;
  window.localStorage.removeItem(THEME_KEY);
});

describe('AccountMenu（ログイン中）', () => {
  it('はじめは閉じていて、押すとメール・テーマ・このアプリの精度・ログアウトが出る（この順）', async () => {
    setup();
    const button = openButton();
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
    expect(screen.queryByText('hanako@example.com')).not.toBeInTheDocument();

    await userEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    const menu = screen.getByRole('menu', { name: 'アカウント' });
    expect(button).toHaveAttribute('aria-controls', menu.id);
    // 先頭は、メールアドレスだけ（名前は、パネルを開いているときのボタンに出る。JobNavi・DocuNavi と同じ）
    expect(within(menu).queryByText(/試験 花子/)).not.toBeInTheDocument();
    expect(within(menu).getByText('hanako@example.com')).toBeInTheDocument();
    expect(within(menu).getAllByRole('menuitemradio').map((n) => n.getAttribute('aria-label'))).toEqual(['ライト', 'ダーク', 'システム']);
    expect(within(menu).getByRole('menuitem', { name: 'ログアウト' })).toBeInTheDocument();
    const order = [...menu.querySelectorAll('.account-who, [role^="menuitem"]')].map((e) => (e.getAttribute('aria-label') ?? e.textContent ?? '').trim());
    expect(order).toEqual(['hanako@example.com', 'ライト', 'ダーク', 'システム', 'このアプリの精度', 'ログアウト']);
  });

  it('JobNavi にある「表示名を変更」は出さない（TownScan は名前を持たない）', async () => {
    setup();
    await userEvent.click(openButton());
    expect(screen.queryByRole('menuitem', { name: '表示名を変更' })).not.toBeInTheDocument();
  });

  it('「このアプリの精度」は /accuracy へのリンク。押すとメニューは閉じる。開いているページ（/accuracy 以下）だけ aria-current', async () => {
    const { unmount } = setup();
    await userEvent.click(openButton());
    const item = screen.getByRole('menuitem', { name: 'このアプリの精度' });
    expect(item).toHaveAttribute('href', '/accuracy');
    expect(item).not.toHaveAttribute('aria-current');
    await userEvent.click(item);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    unmount();

    nav.pathname = '/accuracy/x';
    const again = setup();
    await userEvent.click(openButton());
    expect(screen.getByRole('menuitem', { name: 'このアプリの精度' })).toHaveAttribute('aria-current', 'page');
    again.unmount();

    nav.pathname = '/accuracyx';
    setup();
    await userEvent.click(openButton());
    expect(screen.getByRole('menuitem', { name: 'このアプリの精度' })).not.toHaveAttribute('aria-current');
  });

  it('ログアウトは、渡された関数を呼ぶフォームの送信', async () => {
    const logout = vi.fn(async () => {});
    render(<AccountMenu name="試験 花子" email="hanako@example.com" logout={logout} />);
    await userEvent.click(openButton());
    await userEvent.click(screen.getByRole('menuitem', { name: 'ログアウト' }));
    expect(logout).toHaveBeenCalledOnce();
  });

  it('開いたら先頭の項目にフォーカスし、↑↓ で動く', async () => {
    setup();
    await userEvent.click(openButton());
    expect(screen.getByRole('menuitemradio', { name: 'ライト' })).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}');
    expect(screen.getByRole('menuitem', { name: 'ログアウト' })).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitemradio', { name: 'ライト' })).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitemradio', { name: 'ダーク' })).toHaveFocus();
  });

  it('Esc と、外を押したときに閉じる。Esc ではボタンにフォーカスが戻る', async () => {
    setup();
    const button = openButton();
    await userEvent.click(button);
    await userEvent.keyboard('{Escape}');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(button).toHaveFocus();

    await userEvent.click(button);
    await userEvent.click(document.body);
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('メニューの中を押しても、閉じない（外を押したときだけ）', async () => {
    setup();
    await userEvent.click(openButton());
    await userEvent.click(screen.getByText('hanako@example.com'));
    expect(openButton()).toHaveAttribute('aria-expanded', 'true');
  });

  it('Tab でメニューの外へ出ると閉じる', async () => {
    setup();
    await userEvent.click(openButton());
    await userEvent.keyboard('{Tab}');
    expect(openButton()).toHaveAttribute('aria-expanded', 'false');
  });

  describe('プロフィール画像', () => {
    const withImage = (image: string | null | undefined) =>
      render(<AccountMenu name="試験 花子" email="hanako@example.com" image={image} logout={vi.fn(async () => {})} />);
    const img = (container: HTMLElement) => container.querySelector<HTMLImageElement>('.account-avatar img');

    it('https の画像は、アバターに出す（読み上げの対象にはしない）', () => {
      const { container } = withImage('https://lh3.googleusercontent.com/a/example=s96-c');
      expect(img(container)).toHaveAttribute('src', 'https://lh3.googleusercontent.com/a/example=s96-c');
      expect(img(container)).toHaveAttribute('alt', '');
      expect(img(container)).toHaveAttribute('referrerpolicy', 'no-referrer');
      expect(container.querySelector('.account-avatar svg')).toBeNull();
      expect(container.querySelector('.account-avatar')).toHaveAttribute('aria-hidden', 'true');
    });

    it('画像が無い・https でない（http・javascript:・data:）ときは、人型アイコン', () => {
      for (const image of [undefined, null, '', 'http://example.com/a.png', 'javascript:alert(1)', 'data:image/png;base64,AAAA', '//example.com/a.png', 'HTTPS://example.com/a.png']) {
        const { container, unmount } = withImage(image);
        expect(img(container), String(image)).toBeNull();
        expect(container.querySelector('.account-avatar svg'), String(image)).not.toBeNull();
        unmount();
      }
    });

    it('画像を読めなかったら、人型アイコンに戻す', () => {
      const { container } = withImage('https://example.com/broken.png');
      fireEvent.error(img(container)!);
      expect(img(container)).toBeNull();
      expect(container.querySelector('.account-avatar svg')).not.toBeNull();
    });

    it('画像の URL が変わったら、また試す', () => {
      const { container, rerender } = withImage('https://example.com/broken.png');
      fireEvent.error(img(container)!);
      rerender(<AccountMenu name="試験 花子" email="hanako@example.com" image="https://example.com/new.png" logout={vi.fn(async () => {})} />);
      expect(img(container)).toHaveAttribute('src', 'https://example.com/new.png');
    });

    it('ログインしていないときは、画像を渡されても出さない', () => {
      const { container } = render(<AccountMenu image="https://example.com/a.png" loginHref="/login" />);
      expect(img(container)).toBeNull();
    });
  });

  it('テーマを選ぶと適用して保存し、「システム」で選択を取り消す。開き直すと、保存した選択が選ばれている', async () => {
    setup();
    await userEvent.click(openButton());
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'ダーク' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem(THEME_KEY)).toBe('dark');
    expect(screen.getByRole('menuitemradio', { name: 'ダーク' })).toHaveAttribute('aria-checked', 'true');

    await userEvent.keyboard('{Escape}');
    await userEvent.click(openButton());
    expect(screen.getByRole('menuitemradio', { name: 'ダーク' })).toHaveAttribute('aria-checked', 'true');

    await userEvent.click(screen.getByRole('menuitemradio', { name: 'システム' }));
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(window.localStorage.getItem(THEME_KEY)).toBeNull();
    expect(screen.getByRole('menuitemradio', { name: 'システム' })).toHaveAttribute('aria-checked', 'true');
  });

  it('保存済みのテーマを、開いたときに選ばれた状態で出す', async () => {
    window.localStorage.setItem(THEME_KEY, 'light');
    setup();
    await userEvent.click(openButton());
    expect(screen.getByRole('menuitemradio', { name: 'ライト' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('menuitemradio', { name: 'システム' })).toHaveAttribute('aria-checked', 'false');
  });

  it('上の横帯のテーマの切り替え（ThemeSwitch）と、同じ選択を見る（片方で選ぶと、もう片方も変わる）', async () => {
    render(
      <>
        <ThemeSwitch />
        <AccountMenu name="試験 花子" email="hanako@example.com" logout={vi.fn(async () => {})} />
      </>,
    );
    // 帯のテーマの切り替えで選ぶ（メニューの外を押すので、メニューは閉じる）→ 開き直すと、同じ選択
    await userEvent.click(screen.getByRole('button', { name: 'ダーク' }));
    await userEvent.click(openButton());
    expect(screen.getByRole('menuitemradio', { name: 'ダーク' })).toHaveAttribute('aria-checked', 'true');
    // メニューで選ぶと、開いたまま、帯の切り替えも変わる
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'ライト' }));
    expect(screen.getByRole('button', { name: 'ライト' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'ダーク' })).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('AccountMenu（パネルを開いたときの名前と矢印）', () => {
  it('ボタンに、名前と矢印を持つ（見せるかどうかは、サイドパネルの開閉を見る CSS が決める。読み上げの名前は変えない）', () => {
    setup();
    const button = openButton();
    expect(within(button).getByText('試験 花子')).toHaveAttribute('aria-hidden', 'true');
    expect(within(button).getByText('▴')).toHaveAttribute('aria-hidden', 'true');
    expect(button).toHaveAccessibleName('試験 花子のアカウントメニュー');
    // 細い帯のツールチップ（data-tip）の文字
    expect(button).toHaveAttribute('data-tip', 'アカウントメニュー');
  });
});

describe('AccountMenu（ログインしていない）', () => {
  it('テーマと、Google でログインする入口だけを出す（ログアウトとメールは出さない）。ボタンは「ログイン」と名乗る', async () => {
    render(<AccountMenu loginHref="/login" />);
    const button = screen.getByRole('button', { name: 'ログイン・テーマのメニュー' });
    expect(button).toHaveAttribute('data-tip', 'ログイン・テーマ');
    // 見える名前（パネルを開いているとき）は「ログイン」。読み上げの名前は、その文字を含む
    expect(button.querySelector('.account-label')).toHaveTextContent('ログイン');
    expect(button).toHaveAccessibleName(expect.stringContaining('ログイン'));
    await userEvent.click(button);
    const menu = screen.getByRole('menu', { name: 'ログインとテーマ' });
    expect(within(menu).getByRole('menuitem', { name: 'Google でログイン' })).toHaveAttribute('href', '/login');
    expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(3);
    expect(within(menu).queryByRole('menuitem', { name: 'ログアウト' })).not.toBeInTheDocument();
    expect(menu.querySelector('.account-who')).toBeNull();
  });

  it('ログインの入口があるときは、人型のアイコン。≡（メニューの印）は出さない', () => {
    render(<AccountMenu loginHref="/login" />);
    const avatar = screen.getByRole('button', { name: 'ログイン・テーマのメニュー' }).querySelector('.account-avatar')!;
    expect(avatar.querySelector('svg')).not.toBeNull();
    expect(avatar).not.toHaveTextContent('≡');
  });

  it('ログインの入口を押すと、メニューを閉じる（ページ移動で、メニューが残らない）', async () => {
    render(<AccountMenu loginHref="/login" />);
    await userEvent.click(screen.getByRole('button', { name: 'ログイン・テーマのメニュー' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Google でログイン' }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('ログインの入口が無ければ（ログインを使えない設定）、「メニュー」と ≡ で、テーマと「このアプリの精度」だけを出す', async () => {
    render(<AccountMenu />);
    const button = screen.getByRole('button', { name: 'メニュー' });
    expect(button).toHaveAttribute('data-tip', 'メニュー');
    expect(button.querySelector('.account-avatar')).toHaveTextContent('≡');
    expect(button.querySelector('.account-label')).toHaveTextContent('メニュー');
    await userEvent.click(button);
    const menu = screen.getByRole('menu', { name: 'メニュー' });
    expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(3);
    expect(within(menu).getAllByRole('menuitem').map((n) => n.textContent)).toEqual(['このアプリの精度']);
  });

  it('名前・メール・ログアウトの 3 つがそろわなければ、ログイン中とは扱わない', () => {
    render(<AccountMenu name="試験 花子" loginHref="/login" />);
    expect(screen.getByRole('button', { name: 'ログイン・テーマのメニュー' })).toBeInTheDocument();
  });
});
