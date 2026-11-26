import { describe, expect, it } from 'vitest';
import { CLASS_INFO, CLASS_ORDER } from '../../lib/classes';
import { classOfCell, reasonOfCell } from './cell';

describe('classOfCell（表の分類の列の値から分類を引く）', () => {
  it('キー・表示名・短い名前のどれでも、同じ分類', () => {
    for (const cls of CLASS_ORDER) {
      expect(classOfCell(cls)).toBe(cls);
      expect(classOfCell(CLASS_INFO[cls].label)).toBe(cls);
      expect(classOfCell(CLASS_INFO[cls].short)).toBe(cls);
    }
  });

  it('backend の一覧が返す表示名（CLASS_LABELS）と、画面の表示名が食い違わない', () => {
    expect(classOfCell('2014 年は未検出')).toBe('confirmed_new');
    expect(classOfCell('2014 年も検出')).toBe('existing_omission');
    expect(classOfCell('未判定')).toBe('uncertain');
  });

  it('未判定の理由の呼び名は、未判定として読み、理由も引ける', () => {
    for (const [label, reason] of [['要確認', 'ambiguous'], ['端のため未判定', 'edge']] as const) {
      expect(classOfCell(label)).toBe('uncertain');
      expect(reasonOfCell(label)).toBe(reason);
    }
    expect(reasonOfCell('未判定')).toBeUndefined();
    expect(reasonOfCell('2014 年は未検出')).toBeUndefined();
  });

  it('知らない値・文字列でない値・空は null（呼び出し側が、そのまま出す）', () => {
    for (const v of ['mystery', '', '新規', 12, true, null, undefined] as const) expect(classOfCell(v)).toBeNull();
  });
});
