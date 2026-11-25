import { act, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useNearViewport } from './use-near-viewport';

class FakeObserver {
  static instances: FakeObserver[] = [];
  target: Element | null = null;
  disconnected = false;
  constructor(
    private readonly callback: IntersectionObserverCallback,
    readonly options?: IntersectionObserverInit,
  ) {
    FakeObserver.instances.push(this);
  }
  observe(el: Element) {
    this.target = el;
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
  takeRecords() {
    return [];
  }
  fire(isIntersecting: boolean) {
    this.callback([{ isIntersecting, target: this.target! } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

function Probe({ rootSelector, rootMargin, enabled }: { rootSelector?: string; rootMargin?: string; enabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const near = useNearViewport(ref, { rootSelector, rootMargin, enabled });
  return (
    <div className="scroller" data-testid="scroller">
      <div ref={ref} data-testid="target" data-near={String(near)} />
    </div>
  );
}

beforeEach(() => {
  FakeObserver.instances = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useNearViewport（重い部品を、画面に近づくまでマウントしないための判定）', () => {
  it('IntersectionObserver が無い環境（jsdom・古いブラウザー）では、すぐ true（マウントを止めたままにしない）', () => {
    expect(typeof IntersectionObserver).toBe('undefined');
    render(<Probe />);
    expect(screen.getByTestId('target')).toHaveAttribute('data-near', 'true');
  });

  it('近づくまで false。画面の外（isIntersecting: false）では変わらず、近づいたら true にして、観測をやめる', () => {
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    render(<Probe />);
    expect(screen.getByTestId('target')).toHaveAttribute('data-near', 'false');
    const [observer] = FakeObserver.instances;
    expect(observer!.target).toBe(screen.getByTestId('target'));
    act(() => observer!.fire(false));
    expect(screen.getByTestId('target')).toHaveAttribute('data-near', 'false');
    expect(observer!.disconnected).toBe(false);
    act(() => observer!.fire(true));
    expect(screen.getByTestId('target')).toHaveAttribute('data-near', 'true');
    expect(observer!.disconnected).toBe(true);
  });

  it('一度 true になったら、保つ（再描画しても、観測を作り直さず、false に戻さない）', () => {
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    const { rerender } = render(<Probe />);
    act(() => FakeObserver.instances[0]!.fire(true));
    rerender(<Probe />);
    expect(screen.getByTestId('target')).toHaveAttribute('data-near', 'true');
    expect(FakeObserver.instances).toHaveLength(1);
  });

  it('余白の既定は 200px。rootSelector があれば、その祖先（スクロールする親）を枠にする。無ければ窓（null）', () => {
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    const { unmount } = render(<Probe />);
    expect(FakeObserver.instances[0]!.options).toMatchObject({ rootMargin: '200px', root: null });
    unmount();
    render(<Probe rootSelector=".scroller" rootMargin="50px" />);
    const observer = FakeObserver.instances[1]!;
    expect(observer.options?.rootMargin).toBe('50px');
    expect(observer.options?.root).toBe(screen.getByTestId('scroller'));
  });

  it('enabled: false なら、観測せず、いつも true（遅らせる必要が無い部品）', () => {
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    render(<Probe enabled={false} />);
    expect(screen.getByTestId('target')).toHaveAttribute('data-near', 'true');
    expect(FakeObserver.instances).toHaveLength(0);
  });

  it('アンマウントで、観測をやめる', () => {
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    const { unmount } = render(<Probe />);
    unmount();
    expect(FakeObserver.instances[0]!.disconnected).toBe(true);
  });
});
