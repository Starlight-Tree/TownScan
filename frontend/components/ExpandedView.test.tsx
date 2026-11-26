import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResultView } from '../lib/result-view';
import { ExpandedView } from './ExpandedView';
import { ResultTabs } from './ResultArea';

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

const BASE = 'ev-test';

interface HarnessProps {
  content?: Record<ResultView, ReactNode>;
  question?: string | null;
  returnFocusTo?: () => HTMLElement | null;
  onCloseSpy?: () => void;
  onBackSpy?: () => void;
}

/**
 * 親（HomeClient）と同じく、開く・閉じるを親が持つ。外（チャットの入力・開くボタン）も置く。
 * タブの帯（4 つのタブと、右端の「閉じる」）は、拡大ビューの外（チャットの上）にある。同じ baseId で、外に置く
 */
function Harness({ content = panels(), question = '新規出現は何件？', returnFocusTo, onCloseSpy, onBackSpy }: HarnessProps) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<ResultView>('map');
  const [nonce, setNonce] = useState(0);
  const close = () => {
    onCloseSpy?.();
    setOpen(false);
  };
  return (
    <>
      <div data-testid="page">
        <input id="chat-input" aria-label="質問を入力" />
        <button
          type="button"
          onClick={(e) => {
            openerRef.current = e.currentTarget;
            setOpen(true);
            setNonce((n) => n + 1);
          }}
        >
          拡大ビューを開く
        </button>
      </div>
      {open && (
        <div data-testid="outer-tabs">
          <ResultTabs
            baseId={BASE}
            tabs={['chat', 'map', 'chart', 'photos']}
            selected={view}
            onSelect={(id) => id !== 'chat' && setView(id)}
            trailing={
              <button type="button" onClick={close}>
                閉じる
              </button>
            }
            onEscape={close}
          />
        </div>
      )}
      {open && (
        <ExpandedView
          baseId={BASE}
          view={view}
          onViewChange={setView}
          panels={content}
          question={question}
          openNonce={nonce}
          onBackToChat={() => onBackSpy?.()}
          returnFocusTo={returnFocusTo ?? (() => openerRef.current)}
          onClose={close}
        />
      )}
    </>
  );
}
const openerRef: { current: HTMLElement | null } = { current: null };

const openButton = () => screen.getByRole('button', { name: '拡大ビューを開く' });
/** 拡大ビューの枠（開いていなければ null） */
const root = () => document.querySelector<HTMLElement>('.expanded-view');
const outerTab = (name: string) => within(screen.getByTestId('outer-tabs')).getByRole('tab', { name });
const closeButton = () => within(screen.getByTestId('outer-tabs')).getByRole('button', { name: '閉じる' });
const open = () => userEvent.click(openButton());

afterEach(() => {
  document.body.style.overflow = '';
  document.body.style.paddingRight = '';
  openerRef.current = null;
});

describe('拡大ビュー: タブの画面の側の構造。モーダルでも、領域（横パネル）でもない', () => {
  it('マウントしているあいだだけ開いている（開く前は無い）。dialog でも region でもなく、aria-modal も無い', async () => {
    render(<Harness />);
    expect(root()).toBeNull();
    await open();
    expect(root()).not.toBeNull();
    expect(root()).not.toHaveAttribute('aria-modal');
    expect(root()).not.toHaveAttribute('role');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('region', { name: '結果' })).toBeNull();
    await userEvent.click(closeButton());
    expect(root()).toBeNull();
  });

  it('タブの帯は、外（チャットの上）にある。中にタブの帯を持たず、外のタブの aria-controls が中の画面を指す。中は、質問の行と 3 つの画面。「閉じる」は外の帯に置く', async () => {
    render(<Harness />);
    await open();
    const outer = screen.getByTestId('outer-tabs');
    expect(within(outer).getAllByRole('tab').map((t) => t.textContent)).toEqual(['チャット', '地図', 'グラフ', '写真の比較']);
    expect(root()!.querySelector('[role="tablist"]')).toBeNull();
    expect(within(root()!).getAllByRole('tabpanel', { hidden: true })).toHaveLength(3);
    expect(outer.querySelector('.result-area__bar')).toContainElement(closeButton());
    expect(within(root()!).queryByRole('button', { name: '閉じる' })).toBeNull();
    const mapTab = outerTab('地図');
    const target = document.getElementById(mapTab.getAttribute('aria-controls')!)!;
    expect(root()).toContainElement(target);
    expect(target).toHaveAttribute('aria-labelledby', mapTab.id);
    // 選ぶと切り替わる
    expect(mapTab).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(outerTab('グラフ'));
    expect(outerTab('グラフ')).toHaveAttribute('aria-selected', 'true');
    expect(within(root()!).getByRole('button', { name: 'グラフの中のボタン' })).toBeVisible();
    // 開く・閉じるを知らせる live region は、枠に持たない
    expect(root()!.querySelector('[aria-live], [role="status"], [role="alert"]')).toBeNull();
  });

  it('どの回答かを示す行: 回答の質問（全文は title）と「チャットへ戻る」。質問が無いとき（最初の画面の地図）は「解析した地区」。「チャットへ戻る」は、親へ伝えるだけ（閉じない）', async () => {
    const back = vi.fn();
    const { unmount } = render(<Harness question="新規出現は何件ありますか？" onBackSpy={back} />);
    await open();
    expect(within(root()!).getByText(/新規出現は何件ありますか？/)).toHaveAttribute('title', '新規出現は何件ありますか？');
    await userEvent.click(within(root()!).getByRole('button', { name: 'チャットへ戻る' }));
    expect(back).toHaveBeenCalledTimes(1);
    expect(root()).not.toBeNull();
    unmount();

    render(<Harness question={null} />);
    await open();
    expect(within(root()!).getByText('解析した地区')).toBeInTheDocument();
  });
});

describe('拡大ビュー: 後ろのページは、そのまま（inert にもスクロールの固定もしない）', () => {
  it('開いても、ページのどの要素にも inert を付けず、body のスクロールも固定しない', async () => {
    document.body.style.overflow = 'auto';
    render(<Harness />);
    await open();
    expect(document.querySelector('[inert]')).toBeNull();
    expect(screen.getByTestId('page')).not.toHaveAttribute('inert');
    expect(document.body.style.overflow).toBe('auto');
    expect(document.body.style.paddingRight).toBe('');
    // 後ろ（チャットの入力）を操作できる
    await userEvent.type(screen.getByRole('textbox', { name: '質問を入力' }), 'あ');
    expect(screen.getByRole('textbox', { name: '質問を入力' })).toHaveValue('あ');
    expect(root()).not.toBeNull();
  });
});

describe('拡大ビュー: フォーカス（開くと、選んでいるタブへ。閉じると戻る。Tab は外へも抜けられる）', () => {
  it('開くと、フォーカスは外の帯の、選んでいるタブへ移る', async () => {
    render(<Harness />);
    await open();
    expect(outerTab('地図')).toHaveFocus();
  });

  it('中の部品がすでにフォーカスを受けていれば（詳細の見出しなど）、動かさない', async () => {
    function Child() {
      return (
        <button type="button" ref={(el) => el?.focus()}>
          詳細の見出し
        </button>
      );
    }
    render(<Harness content={panels({ map: <Child /> })} />);
    await open();
    expect(screen.getByRole('button', { name: '詳細の見出し' })).toHaveFocus();
  });

  it('開いたまま、利用者の操作で開き直す（openNonce が変わる）と、フォーカスが外（タブの帯・中の外）にあれば、選んでいるタブへ移し直す。中にあれば動かさない', async () => {
    render(<Harness />);
    await open();
    await userEvent.click(screen.getByRole('textbox', { name: '質問を入力' }));
    expect(outerTab('地図')).not.toHaveFocus();
    await open(); // 外のボタンを押して、開き直す（nonce +1）
    expect(outerTab('地図')).toHaveFocus();
    within(root()!).getByRole('button', { name: '地図の最後' }).focus();
    fireEvent.click(openButton()); // nonce +1。ただし、フォーカスは、いまボタンへ移っていない（fireEvent は移さない）ので、中のまま
    expect(within(root()!).getByRole('button', { name: '地図の最後' })).toHaveFocus();
  });

  it('閉じると、開いたボタンへフォーカスが戻る（「閉じる」・Esc のどちらでも）', async () => {
    render(<Harness />);
    await open();
    await userEvent.click(closeButton());
    expect(openButton()).toHaveFocus();
    await open();
    await userEvent.keyboard('{Escape}');
    expect(root()).toBeNull();
    expect(openButton()).toHaveFocus();
  });

  it('戻し先が無い・外れているときは、チャットの入力欄へ', async () => {
    const gone = document.createElement('button');
    render(<Harness returnFocusTo={() => gone} />);
    await open();
    await userEvent.click(closeButton());
    expect(screen.getByRole('textbox', { name: '質問を入力' })).toHaveFocus();

    render(<Harness returnFocusTo={() => null} />);
    const buttons = screen.getAllByRole('button', { name: '拡大ビューを開く' });
    await userEvent.click(buttons[1]!);
    await userEvent.click(screen.getByRole('button', { name: '閉じる' }));
    expect(screen.getAllByRole('textbox', { name: '質問を入力' })[0]).toHaveFocus();
  });

  it('戻し先は、閉じるときに決める（開いたあとに替わった戻し先を使う）', async () => {
    render(<Harness returnFocusTo={() => document.getElementById('chat-input') as HTMLElement} />);
    await open();
    await userEvent.click(closeButton());
    expect(screen.getByRole('textbox', { name: '質問を入力' })).toHaveFocus();
  });

  it('Tab を、フォーカストラップにしない: 中の最後で Tab を押しても、preventDefault しない（外へ抜けられる）。Shift+Tab も同じ', async () => {
    render(<Harness />);
    await open();
    const last = within(root()!).getByRole('button', { name: '地図の最後' });
    last.focus();
    expect(fireEvent.keyDown(last, { key: 'Tab' })).toBe(true); // preventDefault されていない
    expect(fireEvent.keyDown(outerTab('地図'), { key: 'Tab', shiftKey: true })).toBe(true);
  });

  it('枠自身も、フォーカスを受けられる（tabindex=-1）。中の何も無い所を押しても、Esc が届く', async () => {
    render(<Harness />);
    await open();
    expect(root()).toHaveAttribute('tabindex', '-1');
    root()!.focus();
    await userEvent.keyboard('{Escape}');
    expect(root()).toBeNull();
  });
});

describe('拡大ビュー: Esc（タブの帯・中にフォーカスがあるときだけ。後ろは、非モーダルなので動かさない）', () => {
  it('中で Esc を押すと閉じる。閉じたあとは、Esc に反応しない（リスナーを残さない）', async () => {
    const closed = vi.fn();
    render(<Harness onCloseSpy={closed} />);
    await open();
    await userEvent.keyboard('{Escape}');
    expect(root()).toBeNull();
    expect(closed).toHaveBeenCalledTimes(1);
    await userEvent.keyboard('{Escape}');
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('中の部品が Esc を使ったとき（preventDefault）は、閉じない', async () => {
    function Eater() {
      return (
        <button
          type="button"
          onKeyDown={(e) => {
            if (e.key === 'Escape') e.preventDefault();
          }}
        >
          Esc を使う部品
        </button>
      );
    }
    render(<Harness content={panels({ map: <Eater /> })} />);
    await open();
    screen.getByRole('button', { name: 'Esc を使う部品' }).focus();
    await userEvent.keyboard('{Escape}');
    expect(root()).not.toBeNull();
  });

  it('詳細（Esc を stopPropagation するもの）の中の Esc は、拡大ビューを閉じない', async () => {
    function Detail() {
      return (
        <section
          aria-label="詳細"
          onKeyDown={(e) => {
            if (e.key === 'Escape') e.stopPropagation();
          }}
        >
          <button type="button">詳細の中</button>
        </section>
      );
    }
    render(<Harness content={panels({ map: <Detail /> })} />);
    await open();
    screen.getByRole('button', { name: '詳細の中' }).focus();
    await userEvent.keyboard('{Escape}');
    expect(root()).not.toBeNull();
  });

  it('フォーカスが後ろ（チャットの入力・body）にあるときの Esc は、閉じない（モーダルではない）', async () => {
    render(<Harness />);
    await open();
    await userEvent.click(screen.getByRole('textbox', { name: '質問を入力' }));
    await userEvent.keyboard('{Escape}');
    expect(root()).not.toBeNull();
    (document.activeElement as HTMLElement).blur();
    await userEvent.keyboard('{Escape}');
    expect(root()).not.toBeNull();
  });

  it('後ろの暗い部分は無い（枠の外を押しても、閉じない）', async () => {
    render(<Harness />);
    await open();
    await userEvent.click(screen.getByTestId('page'));
    expect(root()).not.toBeNull();
  });
});
