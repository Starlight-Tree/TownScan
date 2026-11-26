import { describe, expect, it } from 'vitest';
import { HELD_LABELS, classText } from './classes';
import { countRank } from './count-order';

describe('件数の表の並びと、未判定の呼び分け', () => {
  it('2018 年は未検出 → 要確認など → 端のため未判定 → 2018 年も検出', () => {
    const rows = [
      { class: 'existing_omission', reason: 'present_2018' },
      { class: 'uncertain', reason: 'edge' },
      { class: 'uncertain', reason: 'ambiguous' },
      { class: 'confirmed_new', reason: 'new_absent_2018' },
    ];
    expect([...rows].sort((a, b) => countRank(a) - countRank(b)).map((r) => r.reason)).toEqual(['new_absent_2018', 'ambiguous', 'edge', 'present_2018']);
    // 理由の無い未判定（古いデータ）は、端より前
    expect(countRank({ class: 'uncertain' })).toBeLessThan(countRank({ class: 'uncertain', reason: 'edge' }));
  });

  it('未判定は理由の呼び名。理由が無い・知らないときと、ほかの分類は、分類の短い名前', () => {
    expect(classText('uncertain', 'edge')).toBe(HELD_LABELS.edge);
    expect(classText('uncertain', 'ambiguous')).toBe('要確認');
    expect(classText('uncertain')).toBe('未判定');
    expect(classText('uncertain', 'something_new')).toBe('未判定');
    expect(classText('confirmed_new', 'edge')).toBe('2018 年は未検出');
  });
});
