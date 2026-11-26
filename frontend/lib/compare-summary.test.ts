import { describe, expect, it } from 'vitest';
import type { CompareResult } from './api-types';
import { compareSummary } from './compare-summary';
import { compare } from '../tests/fixtures';

const item = (name: string, counts: Record<string, number>) => ({ area_id: `id-${name}`, name, counts });

// 画面の例（熊本の 12 地区のうち、候補のある 6 地区）: 合計 18 件・新規出現 7・既存の描き漏れ 1・判定保留 10
const SAMPLE: CompareResult = {
  ...compare,
  filter: undefined,
  items: [
    item('薄場一丁目', { total: 6, confirmed_new: 3, existing_omission: 0, uncertain: 3 }),
    item('本荘五丁目', { total: 4, confirmed_new: 2, existing_omission: 1, uncertain: 1 }),
    item('近見三丁目', { total: 3, confirmed_new: 0, existing_omission: 0, uncertain: 3 }),
    item('二本木四丁目', { total: 3, confirmed_new: 1, existing_omission: 0, uncertain: 2 }),
    item('新屋敷一丁目', { total: 1, confirmed_new: 0, existing_omission: 0, uncertain: 1 }),
    item('新土河原一丁目', { total: 1, confirmed_new: 1, existing_omission: 0, uncertain: 0 }),
    ...Array.from({ length: 6 }, (_, i) => item(`ゼロ${i}`, { total: 0, confirmed_new: 0, existing_omission: 0, uncertain: 0 })),
  ],
};

describe('compareSummary', () => {
  it('最も多い地区と、全地区の合計・内訳を、結果の数字だけから言う。判定保留が過半なら、そう言う', () => {
    expect(compareSummary(SAMPLE)).toEqual({
      lead: '候補が最も多いのは薄場一丁目で、6 件です。',
      sub: '全 12 地区の合計は 18 件（新規出現 7・既存の描き漏れ 1・判定保留 10）。判定保留が過半を占めます。目で確かめる候補が多めです。',
    });
  });

  it('判定保留が過半でなければ、過半とは言わない（ちょうど半分も言わない）', () => {
    const half: CompareResult = { ...SAMPLE, items: [item('A', { total: 4, confirmed_new: 2, existing_omission: 0, uncertain: 2 })] };
    expect(compareSummary(half)?.sub).toBe('全 1 地区の合計は 4 件（新規出現 2・既存の描き漏れ 0・判定保留 2）。');
  });

  it('同数のいちばん多い地区は、3 つまで並べ、それより多ければ「ほか N 地区」', () => {
    const two: CompareResult = { ...SAMPLE, items: [item('A', { total: 2 }), item('B', { total: 2 }), item('C', { total: 1 })] };
    expect(compareSummary(two)?.lead).toBe('候補が最も多いのはA・Bで、2 件です。');
    const four: CompareResult = { ...SAMPLE, items: ['A', 'B', 'C', 'D'].map((n) => item(n, { total: 2 })) };
    expect(compareSummary(four)?.lead).toBe('候補が最も多いのはA・Bほか 2 地区で、2 件です。');
  });

  it('並びの基準の分類（filter.cls）があれば、その分類で最多を言う', () => {
    const byNew: CompareResult = { ...SAMPLE, filter: { cls: 'confirmed_new' } };
    expect(compareSummary(byNew)?.lead).toBe('新規出現の候補が最も多いのは薄場一丁目で、3 件です。');
  });

  it('候補が 0 件なら、そう言う。内訳の文は無い', () => {
    const none: CompareResult = { ...SAMPLE, items: [item('A', { total: 0 }), item('B', { total: 0 })] };
    expect(compareSummary(none)).toEqual({ lead: 'どの地区にも、候補はありません。', sub: null });
    expect(compareSummary({ ...none, filter: { cls: 'uncertain' } })?.lead).toBe('どの地区にも、判定保留の候補はありません。');
  });

  it('合計が結果に無ければ、3 分類の和を使う。分類の和と合計が合わないときは、内訳を言わない', () => {
    const noTotal: CompareResult = { ...SAMPLE, items: [item('A', { confirmed_new: 2, existing_omission: 1, uncertain: 1 })] };
    expect(compareSummary(noTotal)?.sub).toBe('全 1 地区の合計は 4 件（新規出現 2・既存の描き漏れ 1・判定保留 1）。');
    const mismatch: CompareResult = { ...SAMPLE, items: [item('A', { total: 5, confirmed_new: 2, existing_omission: 1, uncertain: 1 })] };
    expect(compareSummary(mismatch)?.sub).toBe('全 1 地区の合計は 5 件。');
  });

  it('地区が無い・壊れた結果は、null（落ちない）', () => {
    expect(compareSummary({ ...SAMPLE, items: [] })).toBeNull();
    expect(compareSummary({ ...SAMPLE, items: 'なし' } as unknown as CompareResult)).toBeNull();
    const odd = { ...SAMPLE, items: [{ area_id: 'x', name: '', counts: null }] } as unknown as CompareResult;
    expect(compareSummary(odd)?.lead).toBe('どの地区にも、候補はありません。');
  });
});
