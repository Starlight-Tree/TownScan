import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useState, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResultView } from '../lib/result-view';
import { ExpandedView } from './ExpandedView';

const panels = (over: Partial<Record<ResultView, ReactNode>> = {}): Record<ResultView, ReactNode> => ({
  map: (
    <>
      <button type="button">地図の最初</button>
      <button type="button">地図の最後</button>
    </>
  ),
  chart: <button type="button">グラフの中のボタン</button>,
  photos: <p>写真の比較の中身</p>,
  ...over,
});

/** 親（HomeClient）と同じく、開く・閉じるを親が持つ。外（チャットの入力・開くボタン）と、後ろのページも置く */
function Harness({
  content = panels(),
  returnFocusTo,
  onCloseSpy,
}: {
  content?: Record<ResultView, ReactNode>;
  returnFocusTo?: () => HTMLElement | null;
  onCloseSpy?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<ResultView>('map');
  return (
    <>
      <div data-testid="page">
        <input id="chat-input" aria-label="質問を入力" />
        <button type="button" onClick={(e) => { openerRef.current = e.currentTarget; setOpen(true); }}>
          拡大ビューを開く
        </button>
      </div>
      {open && (
        <ExpandedView
          view={view}
          onViewChange={setView}
          panels={content}
          returnFocusTo={returnFocusTo ?? (() => openerRef.current)}
          onClose={() => {
            onCloseSpy?.();
            setOpen(false);
          }}
        />
      )}
    </>
  );
}
const openerRef: { current: HTMLElement | null } = { current: null };

const openButton = () => screen.getByRole('button', { name: '拡大ビューを開く' });
const dialog = () => screen.queryByRole('dialog', { name: '結果' });
const tab = (name: string) => screen.getByRole('tab', { name });
const closeButton = () => within(screen.getByRole('dialog')).getByRole('button', { name: '閉じる' });
const open = () => userEvent.click(openButton());

afterEach(() => {
  document.body.style.overflow = '';
  document.body.style.paddingRight = '';
  openerRef.current = null;
});

describe('拡大ビュー: ダイアログの構造', () => {
  it('role="dialog"・aria-modal="true"・名前は「結果」。マウントしているあいだだけ開いている（開く前は無い）', async () => {
    render(<Harness />);
    expect(dialog()).toBeNull();
    await open();
    const d = screen.getByRole('dialog', { name: '結果' });
    expect(d).toHaveAttribute('aria-modal', 'true');
    expect(d).toHaveAccessibleName('結果');
    await userEvent.click(closeButton());
    expect(dialog()).toBeNull();
  });

  it('後ろのページと別の層に置く（body 直下）。タブの帯の右端に「閉じる」。3 つの画面は中に入る', async () => {
    const { container } = render(<Harness />);
    await open();
    const d = screen.getByRole('dialog');
    expect(container).not.toContainElement(d);
    expect(d.parentElement!.parentElement).toBe(document.body);
    const list = screen.getByRole('tablist');
    expect(list.nextElementSibling).toBe(closeButton());
    expect(list).not.toContainElement(closeButton());
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['地図', 'グラフ', '写真の比較']);
    expect(within(d).getByRole('tabpanel', { name: '地図' })).toBeVisible();
  });

  it('タブの操作は、そのまま使える（選ぶと切り替わる）。開く・閉じるを知らせる live region は、枠に持たない', async () => {
    render(<Harness />);
    await open();
    await userEvent.click(tab('グラフ'));
    expect(screen.getByRole('button', { name: 'グラフの中のボタン' })).toBeVisible();
    const d = screen.getByRole('dialog');
    expect(d.querySelector('[aria-live], [role="status"], [role="alert"]')).toBeNull();
    expect(d.parentElement!.querySelector(':scope > [aria-live], :scope > [role="status"]')).toBeNull();
  });
});

describe('拡大ビュー: 後ろのページ（inert・スクロールの固定）', () => {
  it('開くと、body の、ダイアログ以外の子すべてに inert を付ける。閉じたら外す。もともと inert だったものは、そのまま', async () => {
    const stays = document.createElement('div');
    stays.setAttribute('inert', '');
    document.body.append(stays);
    const { container } = render(<Harness />);
    const other = document.createElement('nav');
    document.body.append(other);
    await open();
    const root = screen.getByRole('dialog').parentElement!;
    expect(container).toHaveAttribute('inert');
    expect(other).toHaveAttribute('inert');
    expect(root).not.toHaveAttribute('inert');
    expect(screen.getByRole('dialog').closest('[inert]')).toBeNull();
    await userEvent.click(closeButton());
    expect(container).not.toHaveAttribute('inert');
    expect(other).not.toHaveAttribute('inert');
    expect(stays).toHaveAttribute('inert'); // こちらが付けたものではないので、外さない
    stays.remove();
    other.remove();
  });

  it('開いているあいだ、後ろのスクロールを固定する。閉じたら、元の値へ戻す', async () => {
    document.body.style.overflow = 'scroll';
    render(<Harness />);
    await open();
    expect(document.body.style.overflow).toBe('hidden');
    await userEvent.click(closeButton());
    expect(document.body.style.overflow).toBe('scroll');
  });

  it('スクロールバーが消えて、ページが横にずれないよう、その幅だけ右の余白を足す。閉じたら戻す', async () => {
    const innerWidth = vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1024);
    const clientWidth = vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1009);
    render(<Harness />);
    await open();
    expect(document.body.style.paddingRight).toBe('15px');
    await userEvent.click(closeButton());
    expect(document.body.style.paddingRight).toBe('');
    innerWidth.mockRestore();
    clientWidth.mockRestore();
  });
});

describe('拡大ビュー: フォーカス（中へ入り、中を巡り、閉じると戻る）', () => {
  it('開くと、フォーカスは選んでいるタブへ移る', async () => {
    render(<Harness />);
    await open();
    expect(tab('地図')).toHaveFocus();
  });

  it('中の部品がすでにフォーカスを受けていれば（詳細の見出しなど）、動かさない', async () => {
    function Focuser() {
      useEffect(() => {
        document.getElementById('inner-target')?.focus();
      }, []);
      return (
        <button type="button" id="inner-target">
          中のフォーカス先
        </button>
      );
    }
    render(<Harness content={panels({ map: <Focuser /> })} />);
    await open();
    expect(screen.getByRole('button', { name: '中のフォーカス先' })).toHaveFocus();
  });

  it('閉じると、開いたボタンへフォーカスが戻る（「閉じる」・Esc・後ろの暗い部分のどれでも）', async () => {
    render(<Harness />);
    for (const how of ['button', 'escape', 'backdrop'] as const) {
      await open();
      expect(tab('地図')).toHaveFocus();
      if (how === 'button') await userEvent.click(closeButton());
      else if (how === 'escape') await userEvent.keyboard('{Escape}');
      else await userEvent.click(screen.getByRole('dialog').parentElement!);
      expect(dialog(), how).toBeNull();
      expect(openButton(), how).toHaveFocus();
    }
  });

  it('戻し先が無い・外れているときは、チャットの入力欄へ', async () => {
    const gone = document.createElement('button');
    const { unmount } = render(<Harness returnFocusTo={() => gone} />);
    await open();
    await userEvent.click(closeButton());
    expect(screen.getByRole('textbox', { name: '質問を入力' })).toHaveFocus();
    unmount();
    render(<Harness returnFocusTo={() => null} />);
    await open();
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('textbox', { name: '質問を入力' })).toHaveFocus();
  });

  it('戻し先は、閉じるときに決める（開いたあとに替わった戻し先を使う）', async () => {
    const later = document.createElement('button');
    document.body.append(later);
    let target: HTMLElement | null = null;
    render(<Harness returnFocusTo={() => target} />);
    await open();
    target = later;
    await userEvent.click(closeButton());
    expect(later).toHaveFocus();
    later.remove();
  });

  it('Tab は中だけを巡る: 最後の次は最初、最初で Shift+Tab は最後。隠れた画面・閉じた details の中身・tabindex=-1 の部品は、端に数えない', async () => {
    render(
      <Harness
        content={panels({
          map: (
            <>
              <button type="button">地図の最初</button>
              <button type="button" tabIndex={-1}>
                矢印キーで動かす部品
              </button>
              <details>
                <summary>閉じた details</summary>
                <button type="button">details の中</button>
              </details>
              <button type="button" tabIndex={-1}>
                最後の矢印キーで動かす部品
              </button>
            </>
          ),
        })}
      />,
    );
    await open();
    // 順に: 選んでいるタブ → 閉じる → 地図の最初 → 閉じた details の summary（これが最後。隠れた画面・後ろのページの要素へは行かない）
    expect(tab('地図')).toHaveFocus();
    await userEvent.tab();
    expect(closeButton()).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: '地図の最初' })).toHaveFocus();
    const summary = screen.getByText('閉じた details');
    summary.focus();
    // 最後（summary）の次は、最初（選んでいるタブ）へ回す。ブラウザーの既定の動き（外へ出る）は、止める
    expect(fireEvent.keyDown(summary, { key: 'Tab' })).toBe(false);
    expect(tab('地図')).toHaveFocus();
    // 最初で Shift+Tab は、最後（summary。閉じた details の中のボタンでも、tabindex=-1 の部品でもない）へ
    expect(fireEvent.keyDown(tab('地図'), { key: 'Tab', shiftKey: true })).toBe(false);
    expect(summary).toHaveFocus();
    expect(screen.getByTestId('page')).not.toContainElement(document.activeElement as HTMLElement);
  });

  it('details を開くと、その中身も巡る（最後は、中のボタン）。隠れた画面（hidden）の中身は、どの画面でも数えない', async () => {
    render(
      <Harness
        content={panels({
          map: (
            <details open>
              <summary>開いた details</summary>
              <button type="button">details の中</button>
            </details>
          ),
        })}
      />,
    );
    await open();
    const inner = screen.getByRole('button', { name: 'details の中' });
    inner.focus();
    expect(fireEvent.keyDown(inner, { key: 'Tab' })).toBe(false);
    expect(tab('地図')).toHaveFocus();
    expect(screen.getByRole('button', { name: 'グラフの中のボタン', hidden: true })).not.toHaveFocus();
    expect(fireEvent.keyDown(tab('地図'), { key: 'Tab', shiftKey: true })).toBe(false);
    expect(inner).toHaveFocus();
  });

  it('keydown の Tab は、端で preventDefault して回す。途中では奪わない', async () => {
    render(<Harness />);
    await open();
    const last = screen.getByRole('button', { name: '地図の最後' });
    last.focus();
    expect(fireEvent.keyDown(last, { key: 'Tab' })).toBe(false);
    expect(tab('地図')).toHaveFocus();
    const first = screen.getByRole('button', { name: '地図の最初' });
    first.focus();
    expect(fireEvent.keyDown(first, { key: 'Tab' })).toBe(true); // 中ほど。ブラウザーに任せる
  });

  it('外へ出たフォーカスは、中へ引き戻す（inert を実装しない環境でも、後ろへ入れない）', async () => {
    render(<Harness />);
    await open();
    screen.getByRole('button', { name: '地図の最後' }).focus();
    act(() => screen.getByRole('textbox', { name: '質問を入力' }).focus());
    expect(screen.getByRole('button', { name: '地図の最後' })).toHaveFocus();
  });

  it('フォーカスが中に無いとき（中の何も無い所を押して body へ落ちたあと）の Tab は、中の端へ入れる', async () => {
    render(<Harness />);
    await open();
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
    await userEvent.tab();
    expect(tab('地図')).toHaveFocus();
    (document.activeElement as HTMLElement).blur();
    await userEvent.tab({ shift: true });
    expect(screen.getByRole('button', { name: '地図の最後' })).toHaveFocus();
  });

  it('ダイアログの枠自身も、フォーカスを受けられる（tabindex=-1）。中の何も無い所を押しても、Esc が届く', async () => {
    render(<Harness />);
    await open();
    const d = screen.getByRole('dialog');
    expect(d).toHaveAttribute('tabindex', '-1');
    await userEvent.click(d);
    expect(d).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(dialog()).toBeNull();
  });
});

describe('拡大ビュー: Esc', () => {
  it('中で Esc を押すと閉じる。閉じたあとは、Esc に反応しない（リスナーを残さない）', async () => {
    const onClose = vi.fn();
    render(<Harness onCloseSpy={onClose} />);
    await open();
    await userEvent.keyboard('{Escape}');
    expect(dialog()).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.keyboard('{Escape}');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('中の部品が Esc を使ったとき（preventDefault）は、閉じない', async () => {
    const onClose = vi.fn();
    render(
      <Harness
        onCloseSpy={onClose}
        content={panels({
          map: (
            <button
              type="button"
              onKeyDown={(e) => {
                if (e.key === 'Escape') e.preventDefault();
              }}
            >
              Esc を使う部品
            </button>
          ),
        })}
      />,
    );
    await open();
    screen.getByRole('button', { name: 'Esc を使う部品' }).focus();
    await userEvent.keyboard('{Escape}');
    expect(dialog()).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('詳細（Esc を stopPropagation するもの）の中の Esc は、拡大ビューを閉じない', async () => {
    const onClose = vi.fn();
    render(
      <Harness
        onCloseSpy={onClose}
        content={panels({
          map: (
            <section
              onKeyDown={(e) => {
                if (e.key === 'Escape') e.stopPropagation();
              }}
            >
              <button type="button">詳細の中</button>
            </section>
          ),
        })}
      />,
    );
    await open();
    screen.getByRole('button', { name: '詳細の中' }).focus();
    await userEvent.keyboard('{Escape}');
    expect(dialog()).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    // 詳細の外の Esc は閉じる
    tab('地図').focus();
    await userEvent.keyboard('{Escape}');
    expect(dialog()).toBeNull();
  });

  it('フォーカスが中に無い（body）ときの Esc でも閉じる。ほかの修飾キー付きでなくても。defaultPrevented のときは閉じない', async () => {
    render(<Harness />);
    await open();
    (document.activeElement as HTMLElement).blur();
    const prevented = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    prevented.preventDefault();
    document.body.dispatchEvent(prevented);
    expect(dialog()).not.toBeNull();
    await userEvent.keyboard('{Escape}');
    expect(dialog()).toBeNull();
  });
});

describe('拡大ビュー: 後ろの暗い部分', () => {
  it('押し始めも押し終わりも後ろのときだけ閉じる。中を押しても、中で押し始めて後ろで離しても、後ろで押し始めて中で離しても、閉じない', async () => {
    render(<Harness />);
    await open();
    const d = screen.getByRole('dialog');
    const back = d.parentElement!;
    await userEvent.click(d);
    await userEvent.click(screen.getByRole('button', { name: '地図の最初' }));
    expect(dialog()).not.toBeNull();
    fireEvent.mouseDown(d);
    fireEvent.mouseUp(back);
    fireEvent.click(back);
    expect(dialog()).not.toBeNull();
    fireEvent.mouseDown(back);
    fireEvent.mouseUp(d);
    fireEvent.click(back);
    expect(dialog()).not.toBeNull();
    await userEvent.click(back);
    expect(dialog()).toBeNull();
  });

  it('click だけ（押し始めを伴わない）では閉じない', async () => {
    render(<Harness />);
    await open();
    fireEvent.click(screen.getByRole('dialog').parentElement!);
    expect(dialog()).not.toBeNull();
  });
});
