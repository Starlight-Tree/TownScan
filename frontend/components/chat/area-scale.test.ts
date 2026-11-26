import { describe, expect, it } from 'vitest';
import { TILE_SIDE_TEXT } from './area-scale';

describe('TILE_SIDE_TEXT（1 地区の大きさの言い方）', () => {
  it('地区の大きさの言い方は、1 つだけ（約 130 m 四方）', () => {
    expect(TILE_SIDE_TEXT).toBe('約 130 m 四方');
  });
});
