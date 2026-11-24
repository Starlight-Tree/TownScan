import { describe, expect, it } from 'vitest';
import { CLASS_INFO, CLASS_ORDER } from '../../lib/classes';
import { classOfCell } from './cell';

describe('classOfCell（表の分類の列の値から分類を引く）', () => {
  it('キー・表示名・短い名前のどれでも、同じ分類', () => {
    for (const cls of CLASS_ORDER) {
      expect(classOfCell(cls)).toBe(cls);
      expect(classOfCell(CLASS_INFO[cls].label)).toBe(cls);
      expect(classOfCell(CLASS_INFO[cls].short)).toBe(cls);
    }
  });

  it('backend の一覧が返す表示名（CLASS_LABELS）と、画面の表示名が食い違わない', () => {
    expect(classOfCell('新規出現（旧写真に無い）')).toBe('confirmed_new');
    expect(classOfCell('既存の描き漏れ（旧写真に既にある）')).toBe('existing_omission');
    expect(classOfCell('判定保留')).toBe('uncertain');
  });

  it('知らない値・文字列でない値・空は null（呼び出し側が、そのまま出す）', () => {
    for (const v of ['mystery', '', '新規', 12, true, null, undefined] as const) expect(classOfCell(v)).toBeNull();
  });
});
