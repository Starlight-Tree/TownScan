import { describe, expect, it } from 'vitest';
import { areaScopeHint, TILE_SIDE_TEXT } from './area-scale';

describe('areaScopeHint（地区の値に添える範囲の説明）', () => {
  it('地区の大きさの言い方は、1 つだけ（約 130 m 四方）', () => {
    expect(TILE_SIDE_TEXT).toBe('約 130 m 四方');
  });

  it('複数の地区（区など）: 解析した地区の数と、各地区の大きさ', () => {
    expect(areaScopeHint({ areaId: '', areaIds: ['a', 'b', 'c'] }, 12)).toBe('解析した 3 地区・各約 130 m 四方');
  });

  it('1 つの地区: 1 地区で、タイル 1 枚の大きさ（丁目や区の全体ではない）', () => {
    expect(areaScopeHint({ areaId: 'a' }, 12)).toBe('1 地区・約 130 m 四方');
  });

  it('全地区: 解析した全地区の数。地区の一覧が読めていない（0 件）ときは出さない', () => {
    expect(areaScopeHint({ areaId: '' }, 12)).toBe('解析した全 12 地区・各約 130 m 四方');
    expect(areaScopeHint({ areaId: '' }, 0)).toBeNull();
  });

  it('areaIds が空の配列なら、全地区として扱う', () => {
    expect(areaScopeHint({ areaId: '', areaIds: [] }, 12)).toBe('解析した全 12 地区・各約 130 m 四方');
  });
});
