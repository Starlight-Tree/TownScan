import { describe, expect, it } from 'vitest';
import { layoutModeFor, WIDE_MIN_REM } from './layout-mode';

describe('layoutModeFor（広い・狭いの判定。本文の幅 = サイドパネルを除いた幅）', () => {
  it('約 78rem（初期値）以上で広い。それ未満は狭い。1rem の大きさに従う（文字を大きくすると、広くなる幅も大きくなる）', () => {
    expect(WIDE_MIN_REM).toBe(78);
    expect(layoutModeFor(78 * 16, 16)).toBe('wide');
    expect(layoutModeFor(78 * 16 - 1, 16)).toBe('narrow');
    expect(layoutModeFor(78 * 20, 20)).toBe('wide');
    expect(layoutModeFor(78 * 16, 20)).toBe('narrow');
  });

  it('幅 0（測れない・描画前）や、1rem の大きさが 0 のときは、狭い', () => {
    expect(layoutModeFor(0, 16)).toBe('narrow');
    expect(layoutModeFor(2000, 0)).toBe('narrow');
  });
});
