import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
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

describe('帯の右端の部品（trailing。拡大ビューの「閉じる」ボタンが入る）', () => {
  it('trailing が無ければ、帯にはタブの列だけ。「拡大」のボタンは無い（拡大ビューは、結果カードのボタンで開く）', () => {
    render(<Harness />);
    const list = screen.getByRole('tablist');
    expect(list.parentElement!.children).toHaveLength(1);
    expect(screen.queryByRole('button', { name: '拡大' })).not.toBeInTheDocument();
  });

  it('タブの帯の右端に出る。tablist の外にあり、tablist にはタブだけが入る', () => {
    render(<ResultArea view="map" onViewChange={() => {}} panels={panels} trailing={<button type="button">閉じる</button>} />);
    const list = screen.getByRole('tablist');
    const trailing = screen.getByRole('button', { name: '閉じる' });
    expect(list).not.toContainElement(trailing);
    expect([...list.children].every((c) => c.getAttribute('role') === 'tab')).toBe(true);
    // 帯（タブの列と右端の部品を並べる親）の中で、部品はタブの列のあとにある
    expect(list.nextElementSibling).toBe(trailing);
    expect(list.parentElement).toBe(trailing.parentElement);
  });

  it('右端の部品を押しても、タブは切り替わらず、親へも伝わらない。画面が替わるとき、右端の部品にあるフォーカスは動かさない', async () => {
    const onViewChange = vi.fn();
    const closeButton = <button type="button">閉じる</button>;
    const { rerender } = render(<ResultArea view="map" onViewChange={onViewChange} panels={panels} trailing={closeButton} />);
    await userEvent.click(screen.getByRole('button', { name: '閉じる' }));
    expect(onViewChange).not.toHaveBeenCalled();
    expect(tab('地図')).toHaveAttribute('aria-selected', 'true');
    screen.getByRole('button', { name: '閉じる' }).focus();
    rerender(<ResultArea view="chart" onViewChange={onViewChange} panels={panels} trailing={closeButton} />);
    expect(screen.getByRole('button', { name: '閉じる' })).toHaveFocus();
  });
});

// CSS はテストでは読み込まれないので、規則そのものを確かめる
describe('結果領域まわりの CSS（空の状態のフォーカスの輪・詳細の最大幅）', () => {
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

  it('拡大ビュー（横パネル・タブの画面）の中の詳細は、その幅いっぱい。窓の幅（1257px 以上）で最大幅を決める規則は無い（ADR 0007。横パネルは約 32rem）', () => {
    expect(css).not.toContain('.expanded-view .drawer__body > *');
    expect(css).not.toMatch(/max-width\s*:\s*clamp\(\d+px,\s*\d+vw,\s*\d+px\)/);
    const [base] = bodies('.drawer__body > *');
    expect(base).toMatch(/width\s*:\s*100%/);
    expect(base).not.toMatch(/max-width/);
  });
});

describe('1 つの画面の描画が壊れても、アプリ全体を巻き込まない（白地・英語の既定のエラー画面にしない）', () => {
  /** 描画で例外を出す部品。`broken.on` が true のあいだ出す */
  const broken = { on: true };
  function Bomb(): ReactNode {
    if (broken.on) throw new Error('地図が壊れた');
    return <p>直った地図</p>;
  }
  const withBomb = { ...panels, map: <Bomb /> };

  function Frame({ initial = 'map' as ResultView }: { initial?: ResultView }) {
    const [view, setView] = useState<ResultView>(initial);
    return (
      <>
        <nav aria-label="アプリの枠">サイドバー</nav>
        <ResultArea view={view} onViewChange={setView} panels={withBomb} />
      </>
    );
  }

  it('壊れた画面の中に、日本語で知らせる（role=alert）。タブ・ほかの画面・アプリの枠は残る', () => {
    broken.on = true;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<Frame />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('「地図」を表示できませんでした');
    expect(alert).toHaveTextContent('チャットと、ほかの画面は、そのまま使えます');
    expect(screen.getByRole('tabpanel', { name: '地図' })).toContainElement(alert);
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    expect(screen.getByRole('navigation', { name: 'アプリの枠' })).toBeInTheDocument();
    expect(log.mock.calls.some((c) => String(c[0]).includes('結果領域の「地図」の描画に失敗しました'))).toBe(true);
  });

  it('壊れていない画面は、そのまま使える。タブで移っても、壊れた画面だけが知らせを出す', async () => {
    broken.on = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<Frame />);
    await userEvent.click(tab('グラフ'));
    expect(screen.getByText('グラフの中身')).toBeVisible();
    // 壊れた地図の知らせは、隠れた地図のパネルの中にあり、見えている画面では読み上げない
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    const mapPanel = document.getElementById(tab('地図').getAttribute('aria-controls')!)!;
    expect(mapPanel).toContainElement(screen.getByRole('alert', { hidden: true }));
  });

  it('「もう一度表示する」で、画面の中身を作り直す。直っていれば元に戻る', async () => {
    broken.on = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<Frame />);
    broken.on = false;
    await userEvent.click(screen.getByRole('button', { name: 'もう一度表示する' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('直った地図')).toBeVisible();
  });

  it('直っていなければ、知らせのまま（無限に描き直さない）。「ページを再読み込み」も出す', async () => {
    broken.on = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<Frame />);
    await userEvent.click(screen.getByRole('button', { name: 'もう一度表示する' }));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ページを再読み込み' })).toBeInTheDocument();
  });
});
