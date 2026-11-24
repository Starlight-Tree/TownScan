import { afterEach, describe, expect, it, vi } from 'vitest';
import { readCssColor, watchTheme } from './theme-colors';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.style.removeProperty('--probe');
  delete document.documentElement.dataset.theme;
});

describe('readCssColor', () => {
  it('<html> に効いている CSS の変数の値を、前後の空白を取って返す', () => {
    document.documentElement.style.setProperty('--probe', '  #123456 ');
    expect(readCssColor('--probe')).toBe('#123456');
  });

  it('変数が読めない（CSS が無い・未定義）ときは、var(--名前) をそのまま返す', () => {
    expect(readCssColor('--no-such-variable')).toBe('var(--no-such-variable)');
  });
});

describe('watchTheme', () => {
  it('data-theme の付与・変更・削除のたびに呼ぶ。購読を外すと呼ばない', async () => {
    const onChange = vi.fn();
    const stop = watchTheme(onChange);
    document.documentElement.dataset.theme = 'dark';
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    document.documentElement.dataset.theme = 'light';
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(2));
    delete document.documentElement.dataset.theme;
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(3));

    stop();
    document.documentElement.dataset.theme = 'dark';
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it('OS の配色の変更も見る（システムのまま追従しているとき）。購読を外すと解除する', () => {
    const add = vi.fn();
    const remove = vi.fn();
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener: add, removeEventListener: remove }));
    const onChange = vi.fn();
    const stop = watchTheme(onChange);
    expect(add).toHaveBeenCalledWith('change', onChange);
    stop();
    expect(remove).toHaveBeenCalledWith('change', onChange);
  });

  it('matchMedia が無い環境でも落ちない', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(() => watchTheme(() => {})()).not.toThrow();
  });
});
