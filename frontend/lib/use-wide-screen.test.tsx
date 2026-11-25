import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useWideScreen } from './use-wide-screen';

type Listener = () => void;

function stubMatchMedia(initial: boolean) {
  const state = { matches: initial };
  const listeners = new Set<Listener>();
  const query = {
    get matches() {
      return state.matches;
    },
    addEventListener: (_: string, cb: Listener) => listeners.add(cb),
    removeEventListener: (_: string, cb: Listener) => listeners.delete(cb),
  };
  vi.stubGlobal('matchMedia', vi.fn(() => query));
  return {
    set(next: boolean) {
      state.matches = next;
      listeners.forEach((cb) => cb());
    },
    listeners,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('useWideScreen', () => {
  it('matchMedia が無い環境（単体テスト）では、PC 幅として扱う', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(renderHook(() => useWideScreen()).result.current).toBe(true);
  });

  it('境目（1024px）の query を見て、狭い幅では false。幅が変わると追従し、外すと購読をやめる', () => {
    const media = stubMatchMedia(false);
    const { result, unmount } = renderHook(() => useWideScreen());
    expect(window.matchMedia).toHaveBeenCalledWith('(min-width: 1024px)');
    expect(result.current).toBe(false);
    act(() => media.set(true));
    expect(result.current).toBe(true);
    unmount();
    expect(media.listeners.size).toBe(0);
  });
});
