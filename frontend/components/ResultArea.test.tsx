import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResultView } from '../lib/result-view';
import { ResultArea } from './ResultArea';

const panels = {
  map: <button type="button">地図の中のボタン</button>,
  chart: <p>グラフの中身</p>,
  photos: <button type="button">写真の中のボタン</button>,
};

/** 親（HomeClient）と同じく、画面の状態を親が持つ形 */
function Harness({ initial = 'map', onChange }: { initial?: ResultView; onChange?: (v: ResultView) => void }) {
  const [view, setView] = useState<ResultView>(initial);
  return (
    <>
      <button type="button" onClick={() => setView('map')}>
        外のボタン（地図へ）
      </button>
      <input aria-label="外の入力" />
      <ResultArea
        view={view}
        onViewChange={(v) => {
          onChange?.(v);
          setView(v);
        }}
        announcement=""
        panels={panels}
      />
    </>
  );
}

const tab = (name: string) => screen.getByRole('tab', { name });

describe('結果領域のタブ（WAI-ARIA の tabs）', () => {
  it('tablist に、地図・グラフ・写真の比較の順でタブが並び、選択中のものが aria-selected', () => {
    render(<Harness />);
    const list = screen.getByRole('tablist');
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['地図', 'グラフ', '写真の比較']);
    expect(list).toContainElement(tab('地図'));
    expect(tab('地図')).toHaveAttribute('aria-selected', 'true');
    expect(tab('グラフ')).toHaveAttribute('aria-selected', 'false');
    expect(tab('写真の比較')).toHaveAttribute('aria-selected', 'false');
  });

  it('タブと tabpanel は、aria-controls と aria-labelledby で結ばれる。選択中の画面だけが見え、ほかは hidden のまま中身を保つ', () => {
    render(<Harness />);
    for (const name of ['地図', 'グラフ', '写真の比較']) {
      const t = tab(name);
      const panel = document.getElementById(t.getAttribute('aria-controls')!)!;
      expect(panel).toHaveAttribute('role', 'tabpanel');
      expect(panel).toHaveAttribute('aria-labelledby', t.id);
    }
    expect(screen.getByRole('tabpanel', { name: '地図' })).toBeVisible();
    // 外さずに hidden にする（Leaflet の状態を保つため）。中身は DOM に残る
    expect(screen.getByText('グラフの中身')).toBeInTheDocument();
    expect(screen.getByText('グラフの中身')).not.toBeVisible();
    expect(screen.getByText('写真の中のボタン')).not.toBeVisible();
    expect(screen.queryByRole('button', { name: '写真の中のボタン' })).not.toBeInTheDocument(); // アクセシビリティの木からは外れる
  });

  it('選択中のタブだけ tabindex=0（roving）。選ぶと移る', async () => {
    render(<Harness />);
    expect(tab('地図')).toHaveAttribute('tabindex', '0');
    expect(tab('グラフ')).toHaveAttribute('tabindex', '-1');
    expect(tab('写真の比較')).toHaveAttribute('tabindex', '-1');
    await userEvent.click(tab('グラフ'));
    expect(tab('地図')).toHaveAttribute('tabindex', '-1');
    expect(tab('グラフ')).toHaveAttribute('tabindex', '0');
  });

  it('クリックで切り替わり、親へ伝わる。Tab キーでタブの帯に入ると選択中のタブ、次の Tab でパネルの中へ出る', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await userEvent.click(tab('写真の比較'));
    expect(onChange).toHaveBeenLastCalledWith('photos');
    expect(tab('写真の比較')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: '写真の中のボタン' })).toBeVisible();

    screen.getByRole('textbox', { name: '外の入力' }).focus();
    await userEvent.tab();
    expect(tab('写真の比較')).toHaveFocus(); // 選択中のタブだけが Tab の順に入る
    await userEvent.tab();
    expect(screen.getByRole('button', { name: '写真の中のボタン' })).toHaveFocus();
  });

  it('矢印キー（左右）・Home・End で、タブの間を動く。端では反対側へ回る。動くとフォーカスも選択も移る', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    tab('地図').focus();

    await userEvent.keyboard('{ArrowRight}');
    expect(tab('グラフ')).toHaveFocus();
    expect(tab('グラフ')).toHaveAttribute('aria-selected', 'true');
    expect(onChange).toHaveBeenLastCalledWith('chart');

    await userEvent.keyboard('{ArrowRight}');
    expect(tab('写真の比較')).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}'); // 右端から左端へ
    expect(tab('地図')).toHaveFocus();
    expect(tab('地図')).toHaveAttribute('aria-selected', 'true');

    await userEvent.keyboard('{ArrowLeft}'); // 左端から右端へ
    expect(tab('写真の比較')).toHaveFocus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(tab('グラフ')).toHaveFocus();

    await userEvent.keyboard('{Home}');
    expect(tab('地図')).toHaveFocus();
    expect(onChange).toHaveBeenLastCalledWith('map');
    await userEvent.keyboard('{End}');
    expect(tab('写真の比較')).toHaveFocus();
    expect(tab('写真の比較')).toHaveAttribute('aria-selected', 'true');
    expect(onChange).toHaveBeenLastCalledWith('photos');
  });

  it('タブの操作に関係の無いキー（上下の矢印・文字）は、何もしない', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    tab('地図').focus();
    await userEvent.keyboard('{ArrowDown}{ArrowUp}a');
    expect(onChange).not.toHaveBeenCalled();
    expect(tab('地図')).toHaveFocus();
  });

  it('announcement は、画面に見えない polite の live region に出る（空なら何も出さない）', () => {
    const { rerender } = render(<ResultArea view="map" onViewChange={() => {}} announcement="" panels={panels} />);
    const live = document.querySelector<HTMLElement>('[aria-live="polite"]')!;
    expect(live).toHaveAttribute('role', 'status');
    expect(live).toHaveClass('visually-hidden');
    expect(live).toBeEmptyDOMElement();
    rerender(<ResultArea view="chart" onViewChange={() => {}} announcement="「グラフ」を表示しました" panels={panels} />);
    expect(live).toHaveTextContent('「グラフ」を表示しました');
  });

  // この 2 つは、フォーカスを動かさずに画面が替わる場合（回答・結果カード・「地図で見る」）。DOM の click() は、フォーカスを動かさない
  it('見ていた画面の中にあったフォーカスは、画面が替わったとき、選ばれたタブへ移す（フォーカスが消えない）', async () => {
    render(<Harness />);
    screen.getByRole('button', { name: '地図の中のボタン' }).focus();
    await act(async () => {
      tab('写真の比較').click();
    });
    expect(tab('写真の比較')).toHaveAttribute('aria-selected', 'true');
    expect(tab('写真の比較')).toHaveFocus();
  });

  it('フォーカスが画面の外（チャットの入力・ボタン）にあるときは、画面が替わっても動かさない', async () => {
    render(<Harness initial="photos" />);
    const outside = screen.getByRole('textbox', { name: '外の入力' });
    outside.focus();
    await act(async () => {
      screen.getByRole('button', { name: '外のボタン（地図へ）' }).click();
    });
    expect(tab('地図')).toHaveAttribute('aria-selected', 'true');
    expect(outside).toHaveFocus();
  });
});

describe('タブの修飾キー（ブラウザー・OS の操作を奪わない）', () => {
  const MODIFIERS = ['altKey', 'ctrlKey', 'metaKey', 'shiftKey'] as const;

  it('修飾キー付きの矢印・Home・End は、何もしない（preventDefault もしない。Alt+← のブラウザーの戻る、Cmd+←、Ctrl+Home が使える）', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    tab('地図').focus();
    for (const modifier of MODIFIERS) {
      for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) {
        // fireEvent は「preventDefault されなかったか」を返す
        expect(fireEvent.keyDown(tab('地図'), { key, [modifier]: true }), `${modifier}+${key}`).toBe(true);
      }
    }
    expect(onChange).not.toHaveBeenCalled();
    expect(tab('地図')).toHaveFocus();
    expect(tab('地図')).toHaveAttribute('aria-selected', 'true');
  });

  it('修飾キーが無ければ、同じキーで動く（preventDefault する）', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    tab('地図').focus();
    expect(fireEvent.keyDown(tab('地図'), { key: 'ArrowRight' })).toBe(false);
    expect(onChange).toHaveBeenLastCalledWith('chart');
    expect(tab('グラフ')).toHaveFocus();
  });
});

describe('拡大のボタン', () => {
  const expandButton = () => screen.getByRole('button', { name: '拡大' });

  it('onToggleExpanded が無ければ出さない', () => {
    render(<ResultArea view="map" onViewChange={() => {}} announcement="" panels={panels} expanded />);
    expect(screen.queryByRole('button', { name: '拡大' })).not.toBeInTheDocument();
  });

  it('タブの帯の右端に出る。tablist の外にあり、tablist にはタブだけが入る', () => {
    render(<ResultArea view="map" onViewChange={() => {}} announcement="" panels={panels} onToggleExpanded={() => {}} />);
    const list = screen.getByRole('tablist');
    expect(list).not.toContainElement(expandButton());
    expect([...list.children].every((c) => c.getAttribute('role') === 'tab')).toBe(true);
    // 帯（タブの列とボタンを並べる親）の中で、ボタンはタブの列のあとにある
    expect(list.nextElementSibling).toBe(expandButton());
    expect(list.parentElement).toBe(expandButton().parentElement);
  });

  it('状態は aria-pressed で持ち、名前は「拡大」のまま（名前は変えない）', () => {
    const { rerender } = render(
      <ResultArea view="map" onViewChange={() => {}} announcement="" panels={panels} expanded={false} onToggleExpanded={() => {}} />,
    );
    expect(expandButton()).toHaveAttribute('aria-pressed', 'false');
    rerender(<ResultArea view="map" onViewChange={() => {}} announcement="" panels={panels} expanded onToggleExpanded={() => {}} />);
    expect(expandButton()).toHaveAttribute('aria-pressed', 'true');
    expect(expandButton()).toHaveAccessibleName('拡大');
  });

  it('広げているときだけ、「元の大きさに戻す」を目に見える文でも出す。名前は「拡大」のまま（補足は読み上げず、説明は title）', () => {
    const { rerender } = render(
      <ResultArea view="map" onViewChange={() => {}} announcement="" panels={panels} expanded={false} onToggleExpanded={() => {}} />,
    );
    expect(expandButton()).not.toHaveTextContent('元の大きさに戻す');
    expect(expandButton()).toHaveAccessibleDescription('チャットの列を狭めて、結果領域を広げます');

    rerender(<ResultArea view="map" onViewChange={() => {}} announcement="" panels={panels} expanded onToggleExpanded={() => {}} />);
    expect(expandButton()).toHaveTextContent('拡大（元の大きさに戻す）');
    const hint = expandButton().querySelector('.result-area__expand-hint')!;
    expect(hint).toHaveAttribute('aria-hidden', 'true');
    expect(expandButton()).toHaveAccessibleName('拡大');
    expect(expandButton()).toHaveAccessibleDescription('元の大きさに戻します');
    expect(expandButton()).toHaveAttribute('aria-pressed', 'true');
  });

  it('expanded を渡さなくても、押していない状態（aria-pressed=false）', () => {
    render(<ResultArea view="map" onViewChange={() => {}} announcement="" panels={panels} onToggleExpanded={() => {}} />);
    expect(expandButton()).toHaveAttribute('aria-pressed', 'false');
  });

  it('アイコンは装飾（aria-hidden）で、向きが状態で変わる。名前には入らない', () => {
    const { rerender } = render(
      <ResultArea view="map" onViewChange={() => {}} announcement="" panels={panels} expanded={false} onToggleExpanded={() => {}} />,
    );
    const icon = () => expandButton().querySelector('svg')!;
    expect(icon()).toHaveAttribute('aria-hidden', 'true');
    const before = icon().querySelector('path')!.getAttribute('d');
    rerender(<ResultArea view="map" onViewChange={() => {}} announcement="" panels={panels} expanded onToggleExpanded={() => {}} />);
    expect(icon()).toHaveAttribute('aria-hidden', 'true');
    expect(icon().querySelector('path')!.getAttribute('d')).not.toBe(before);
    expect(expandButton()).toHaveAccessibleName('拡大');
  });

  it('押すと onToggleExpanded が呼ばれる（クリックも、キーボードの Enter・Space も）', async () => {
    const onToggle = vi.fn();
    render(<ResultArea view="map" onViewChange={() => {}} announcement="" panels={panels} onToggleExpanded={onToggle} />);
    await userEvent.click(expandButton());
    expect(onToggle).toHaveBeenCalledTimes(1);
    expandButton().focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard(' ');
    expect(onToggle).toHaveBeenCalledTimes(3);
  });

  it('押しても、フォーカスを奪わない（自分が持っていれば自分のまま、外にあれば外のまま）。タブも切り替えない', async () => {
    const onToggle = vi.fn();
    const onViewChange = vi.fn();
    function Wrapper() {
      const [expanded, setExpanded] = useState(false);
      return (
        <>
          <input aria-label="チャットの入力" />
          <ResultArea
            view="map"
            onViewChange={onViewChange}
            announcement=""
            panels={panels}
            expanded={expanded}
            onToggleExpanded={() => {
              onToggle();
              setExpanded((v) => !v);
            }}
          />
        </>
      );
    }
    render(<Wrapper />);
    // 外（チャットの入力）にフォーカスがあるときに、DOM の click()（フォーカスを動かさない）で押す
    const input = screen.getByRole('textbox', { name: 'チャットの入力' });
    input.focus();
    await act(async () => {
      expandButton().click();
    });
    expect(expandButton()).toHaveAttribute('aria-pressed', 'true');
    expect(input).toHaveFocus();

    // ボタン自身にフォーカスがあるときは、押したあとも、同じボタンにある（再描画で外れない）
    await userEvent.click(expandButton());
    expect(expandButton()).toHaveAttribute('aria-pressed', 'false');
    expect(expandButton()).toHaveFocus();
    expect(onToggle).toHaveBeenCalledTimes(2);
    expect(onViewChange).not.toHaveBeenCalled();
    expect(tab('地図')).toHaveAttribute('aria-selected', 'true');
  });

  // CSS はテストでは読み込まれないので、規則そのものを確かめる（同じ強さの規則は、順で決まる。順を誤ると、横に並ぶ幅でも出なくなる）
  describe('CSS', () => {
    const css = readFileSync(join(process.cwd(), 'app', 'globals.css'), 'utf8');
    /** 行頭から始まる規則（`\n.sel {`）の、閉じる波括弧までの本文と、位置 */
    const ruleAt = (selectorLine: string) => {
      const index = css.indexOf(`\n${selectorLine} {`);
      const end = css.indexOf('}', index);
      return { index, body: index < 0 ? '' : css.slice(index, end) };
    };

    it('既定は非表示。幅 1000px 以上の @media が、その後ろで表示に戻す', () => {
      const base = ruleAt('.result-area__expand');
      expect(base.index).toBeGreaterThan(-1);
      expect(base.body).toMatch(/display\s*:\s*none/);
      const media = ruleAt('@media (min-width: 1000px) {\n  .result-area__expand');
      expect(media.index).toBeGreaterThan(base.index);
      expect(media.body).toMatch(/display\s*:\s*inline-flex/);
    });

    it('サイドパネルを開いて縦に積む 1024〜1256px では、隠す（同じ幅の条件。より強い規則）', () => {
      const at = css.indexOf('@media (min-width: 1024px) and (max-width: 1256px)');
      expect(at).toBeGreaterThan(-1);
      expect(css.slice(at)).toMatch(
        /\.app:has\(\.app-sidebar\[data-open='true'\]\) \.result-area__expand\s*\{\s*display\s*:\s*none/,
      );
    });

    it('.home--expanded は、幅 1000px 以上の @media の中で、チャットの列を 280px（普通の下限 340px より狭い）にし、結果領域へ残りを回す', () => {
      const at = css.indexOf('\n  .home--expanded {');
      expect(at).toBeGreaterThan(-1);
      // 直前の（行頭の）@media が、幅 1000px 以上
      expect(css.slice(css.lastIndexOf('\n@media', at)).startsWith('\n@media (min-width: 1000px) {')).toBe(true);
      expect(css.slice(at, css.indexOf('}', at))).toMatch(/grid-template-columns\s*:\s*280px\s+minmax\(0,\s*1fr\)/);
      // 普通の列は 340〜440px。拡大は、それより狭い
      expect(css).toMatch(/\.home\s*\{[^}]*grid-template-columns\s*:\s*minmax\(340px,\s*440px\)\s+minmax\(0,\s*1fr\)/);
    });
  });
});

describe('縦に積む幅で、結果領域の上端へスクロールする（revealNonce）', () => {
  const scrollIntoView = vi.fn();
  const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');

  /** jsdom には scrollIntoView が無い。あるものとして差し込み、結果領域の上端の位置（getBoundingClientRect の top）も決める */
  function setup(top: number) {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: scrollIntoView });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ top, bottom: top + 600, left: 0, right: 500, width: 500, height: 600, x: 0, y: top } as DOMRect);
  }

  afterEach(() => {
    scrollIntoView.mockReset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalScrollIntoView) Object.defineProperty(Element.prototype, 'scrollIntoView', originalScrollIntoView);
    else delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  const area = (nonce?: number) => (
    <ResultArea view="map" onViewChange={() => {}} announcement="" panels={panels} revealNonce={nonce} />
  );

  it('初回の描画では、動かさない（revealNonce の初期値があっても）', () => {
    setup(900);
    render(area(0));
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('値が変わったとき、上端が画面の高さの 6 割より下なら、上端へスクロールする（smooth・block: start）', () => {
    setup(window.innerHeight * 0.6 + 40);
    const { rerender } = render(area(0));
    rerender(area(1));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' });
    expect(scrollIntoView.mock.contexts[0]).toBe(screen.getByRole('region', { name: '結果' }));
  });

  it('上端が画面の上にはみ出しているときも、スクロールする', () => {
    setup(-120);
    const { rerender } = render(area(0));
    rerender(area(1));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('上端が見えている（0 以上、6 割以内）なら、何も起きない（横に並ぶ幅は、いつもこの状態）', () => {
    setup(16);
    const { rerender } = render(area(0));
    rerender(area(1));
    expect(scrollIntoView).not.toHaveBeenCalled();
    // 境目（ちょうど 6 割・ちょうど 0）は、見えている側
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({ top: window.innerHeight * 0.6 } as DOMRect);
    rerender(area(2));
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({ top: 0 } as DOMRect);
    rerender(area(3));
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('値が変わらない再描画では、動かさない。変わるたびに動かす', () => {
    setup(900);
    const { rerender } = render(area(0));
    rerender(area(0));
    expect(scrollIntoView).not.toHaveBeenCalled();
    rerender(area(1));
    rerender(area(1));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    rerender(area(2));
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it('revealNonce を渡さなければ、動かさない', () => {
    setup(900);
    const { rerender } = render(area());
    rerender(area());
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('動きを減らす設定（prefers-reduced-motion）のときは、behavior が auto（アニメーションしない）', () => {
    setup(900);
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('prefers-reduced-motion'), media: query }));
    const { rerender } = render(area(0));
    rerender(area(1));
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'auto' });
  });

  it('スクロールしても、フォーカスは動かさない', () => {
    setup(900);
    const { rerender } = render(
      <>
        <input aria-label="チャットの入力" />
        {area(0)}
      </>,
    );
    const input = screen.getByRole('textbox', { name: 'チャットの入力' });
    input.focus();
    rerender(
      <>
        <input aria-label="チャットの入力" />
        {area(1)}
      </>,
    );
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(input).toHaveFocus();
  });

  it('scrollIntoView の無い環境（jsdom）でも、例外を出さない', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ top: 900 } as DOMRect);
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    const { rerender } = render(area(0));
    expect(() => rerender(area(1))).not.toThrow();
  });
});

// CSS はテストでは読み込まれないので、規則そのものを確かめる
describe('結果領域まわりの CSS（拡大のときのチャット・空の状態のフォーカスの輪・詳細の最大幅・コメント）', () => {
  const css = readFileSync(join(process.cwd(), 'app', 'globals.css'), 'utf8');
  /** セレクターが一致する規則（インデントは問わない）の本体を、出てきた順にすべて返す。`{` の直前までの一致なので、別の規則の一部には当たらない */
  const bodies = (selector: string) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return [...css.matchAll(new RegExp(`(?:^|\\n)[ \\t]*${escaped}\\s*\\{([^}]*)\\}`, 'g'))].map((m) => m[1] ?? '');
  };

  it('空の状態（写真の比較の「候補を選ぶと…」。外枠がフォーカスを受ける）は、フォーカスの輪を内側へ描く（親の overflow に切られない）', () => {
    const [body] = bodies('.result-area__empty:focus-visible');
    expect(body, '.result-area__empty:focus-visible が無い').toBeDefined();
    expect(body).toMatch(/outline-offset\s*:\s*-3px/);
    // 外枠は、パネルの置き場（overflow-y: auto）の直下に入る。外へ描くと切れる
    expect(bodies('.result-area__panel')[0]).toMatch(/overflow-y\s*:\s*auto/);
  });

  it('グラフの空の状態の輪は、すでに .area-chart:focus-visible が内側へ描く（ここでは足さない）', () => {
    expect(bodies('.area-chart:focus-visible')[0]).toMatch(/outline-offset\s*:\s*-3px/);
  });

  it('拡大のとき、狭い列でも質問の例が使える: 例の列を 1 行いっぱいに、「新しい会話」を次の行へ（横に並ぶ幅の @media の中）', () => {
    const [tools, chips] = [bodies('.home--expanded .chat__tools')[0], bodies('.home--expanded .chat__chips')[0]];
    expect(tools).toMatch(/flex-wrap\s*:\s*wrap/);
    expect(chips).toMatch(/flex-basis\s*:\s*100%/);
    const at = css.indexOf('\n  .home--expanded .chat__tools {');
    expect(css.slice(css.lastIndexOf('\n@media', at)).startsWith('\n@media (min-width: 1000px) {')).toBe(true);
  });

  it('サイドパネルを開いて縦に積む 1024〜1256px では、広げた状態が残っていても、その折り返しを打ち消す（チャットは全幅）', () => {
    const at = css.indexOf('@media (min-width: 1024px) and (max-width: 1256px)');
    expect(at).toBeGreaterThan(-1);
    const stacked = css.slice(at);
    expect(stacked).toMatch(/\.app:has\(\.app-sidebar\[data-open='true'\]\) \.home--expanded \.chat__tools\s*\{\s*flex-wrap\s*:\s*nowrap/);
    expect(stacked).toMatch(/\.app:has\(\.app-sidebar\[data-open='true'\]\) \.home--expanded \.chat__chips\s*\{\s*flex-basis\s*:\s*0%/);
  });

  it('拡大のとき、詳細の中身の最大幅は、窓の幅に応じて広がる（clamp。固定の幅ではない）。縦に積む幅（〜1256px）は対象外', () => {
    const at = css.indexOf('.home--expanded .drawer__body > *');
    expect(at).toBeGreaterThan(-1);
    expect(css.slice(css.lastIndexOf('\n@media', at)).startsWith('\n@media (min-width: 1257px) {')).toBe(true);
    const [body] = bodies('.home--expanded .drawer__body > *');
    const m = /max-width\s*:\s*clamp\((\d+)px,\s*(\d+)vw,\s*(\d+)px\)/.exec(body ?? '');
    expect(m, 'max-width: clamp(最小px, vw, 最大px)').not.toBeNull();
    // 通常の上限（880px）より広い下限。窓が広いほど広がる（vw の項があり、最大が下限より大きい）
    expect(Number(m![1])).toBeGreaterThan(880);
    expect(Number(m![3])).toBeGreaterThan(Number(m![1]));
  });

  it('CSS のコメントが、規則と食い違わない: 左右に並べるのは窓の幅 1000px 以上、縦に戻すのは data-open=true のときだけ（細い帯では、窓 1024〜1056px でも左右）', () => {
    expect(css).not.toContain('窓が 1057px 以上で左右に並ぶ');
    expect(css).not.toContain('本文の幅が 1000px に満たなければ縦に積む');
    expect(css).toContain('窓の幅 1000px 以上で決まる');
    expect(css).toContain('窓が 1024〜1056px');
  });
});
