import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScrollHint } from './ScrollHint';

/** jsdom にはレイアウトが無い。横スクロールの枠の中身の幅（scrollWidth）と枠の幅（clientWidth）を決める */
function mockWidths(scrollWidth: number, clientWidth: number) {
  vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockReturnValue(scrollWidth);
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(clientWidth);
}

const wrap = () => screen.getByRole('region').parentElement as HTMLElement;

function renderHint() {
  return render(
    <ScrollHint label="表（横にスクロールできます）">
      <table>
        <tbody>
          <tr>
            <td>中身</td>
          </tr>
        </tbody>
      </table>
    </ScrollHint>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ScrollHint（横にはみ出す表の縁の影）', () => {
  it('中身が枠に収まっているときは、どちらの縁にも影を出さない', () => {
    mockWidths(300, 300);
    renderHint();
    expect(wrap()).not.toHaveAttribute('data-overflow-start');
    expect(wrap()).not.toHaveAttribute('data-overflow-end');
  });

  it('はみ出しているとき、いちばん左では右の縁だけに影を出す。右へ動かすと左にも、いちばん右では左だけ', () => {
    mockWidths(600, 300);
    renderHint();
    const region = screen.getByRole('region');
    expect(wrap()).toHaveAttribute('data-overflow-end');
    expect(wrap()).not.toHaveAttribute('data-overflow-start');

    region.scrollLeft = 120;
    fireEvent.scroll(region);
    expect(wrap()).toHaveAttribute('data-overflow-start');
    expect(wrap()).toHaveAttribute('data-overflow-end');

    region.scrollLeft = 300;
    fireEvent.scroll(region);
    expect(wrap()).toHaveAttribute('data-overflow-start');
    expect(wrap()).not.toHaveAttribute('data-overflow-end');

    region.scrollLeft = 0;
    fireEvent.scroll(region);
    expect(wrap()).not.toHaveAttribute('data-overflow-start');
    expect(wrap()).toHaveAttribute('data-overflow-end');
  });

  it('1〜2px の誤差（小数の丸め）では、端にいるのに「続きがある」と出さない', () => {
    mockWidths(301, 300);
    renderHint();
    expect(wrap()).not.toHaveAttribute('data-overflow-end');
  });

  it('枠の大きさが変わったら（ResizeObserver）、測り直す。外すとき observer も止める', () => {
    let notify: () => void = () => {};
    const disconnect = vi.fn();
    class FakeObserver {
      constructor(cb: () => void) {
        notify = cb;
      }
      observe() {}
      disconnect = disconnect;
    }
    vi.stubGlobal('ResizeObserver', FakeObserver);
    mockWidths(300, 300);
    const { unmount } = renderHint();
    expect(wrap()).not.toHaveAttribute('data-overflow-end');

    mockWidths(600, 300);
    // act の外で state が変わる警告を避けるため、通知は event と同じく act に包む
    fireEvent.scroll(screen.getByRole('region'));
    notify();
    expect(wrap()).toHaveAttribute('data-overflow-end');

    unmount();
    expect(disconnect).toHaveBeenCalled();
  });

  it('枠はフォーカスでき（矢印キーで動かせる）、名前を持つ領域。影は見た目だけで、読み上げには出ない（要素を足さない）', () => {
    mockWidths(600, 300);
    renderHint();
    const region = screen.getByRole('region', { name: '表（横にスクロールできます）' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(wrap().children).toHaveLength(1);
  });
});
