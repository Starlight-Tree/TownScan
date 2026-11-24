import { describe, expect, it } from 'vitest';
import type { AreaSummary, CandidateClass } from '../../lib/api-types';
import { ALL_FILTER } from '../../lib/result-view';
import { allClassesShown, buildRows, multiAreaName, sumCounts, sumShown } from './area-stats';

function area(id: string, name: string, counts: [number, number, number], total?: number): AreaSummary {
  const [confirmed_new, existing_omission, uncertain] = counts;
  return {
    id,
    name,
    ward: '中央区',
    bbox: [130.7, 32.8, 130.701, 32.801],
    centroid: [130.7005, 32.8005],
    counts: { confirmed_new, existing_omission, uncertain, total: total ?? confirmed_new + existing_omission + uncertain },
  };
}

const ALL = new Set<CandidateClass>(['confirmed_new', 'existing_omission', 'uncertain']);
const areas = [area('a', 'イースト地区', [2, 6, 2]), area('b', 'アサヒ地区', [4, 4, 2]), area('c', 'ノース地区', [5, 3, 1]), area('d', 'ゼロ地区', [0, 0, 0])];

describe('地区の集計の補助', () => {
  it('sumCounts: 全地区、または 1 地区だけの件数を、API の値のまま足す', () => {
    const all = sumCounts(areas, '');
    expect(all.found).toBe(true);
    expect(all.byClass).toEqual({ confirmed_new: 11, existing_omission: 13, uncertain: 5 });
    expect(all.total).toBe(29);
    const one = sumCounts(areas, 'c');
    expect(one.byClass).toEqual({ confirmed_new: 5, existing_omission: 3, uncertain: 1 });
    expect(one.total).toBe(9);
  });

  it('sumCounts: 一覧に無い地区・地区が 0 件のときは、found が false（数字を作らない）', () => {
    expect(sumCounts(areas, 'zzz').found).toBe(false);
    expect(sumCounts(areas, 'zzz').total).toBe(0);
    expect(sumCounts([], '').found).toBe(false);
  });

  it('allClassesShown / sumShown', () => {
    expect(allClassesShown(ALL)).toBe(true);
    expect(allClassesShown(new Set<CandidateClass>(['uncertain']))).toBe(false);
    expect(allClassesShown(new Set())).toBe(false);
    const by = { confirmed_new: 5, existing_omission: 3, uncertain: 1 };
    expect(sumShown(by, ALL)).toBe(9);
    expect(sumShown(by, new Set<CandidateClass>(['confirmed_new', 'uncertain']))).toBe(6);
    expect(sumShown(by, new Set())).toBe(0);
  });

  it('buildRows: 合計の多い順。同数は地区名の順（かな）。0 件の地区も残す', () => {
    expect(buildRows(areas, ALL).map((r) => [r.area.name, r.total])).toEqual([
      ['アサヒ地区', 10],
      ['イースト地区', 10],
      ['ノース地区', 9],
      ['ゼロ地区', 0],
    ]);
  });

  it('buildRows: 分類の一部だけのときは、その分類の件数で並べ、合計もその和', () => {
    const rows = buildRows(areas, new Set<CandidateClass>(['existing_omission']));
    expect(rows.map((r) => [r.area.name, r.total])).toEqual([
      ['イースト地区', 6],
      ['アサヒ地区', 4],
      ['ノース地区', 3],
      ['ゼロ地区', 0],
    ]);
  });

  it('buildRows: 全分類を表示しているとき、合計は API の total をそのまま使う（分類の和と違っても作り替えない）', () => {
    const odd = [area('x', 'ずれ地区', [1, 1, 1], 7)];
    expect(buildRows(odd, ALL)[0]!.total).toBe(7);
    expect(buildRows(odd, ALL)[0]!.stack).toBe(3);
    expect(buildRows(odd, new Set<CandidateClass>(['uncertain']))[0]!.total).toBe(1);
  });
});

describe('複数の地区（区など）の件数', () => {
  it('sumCounts: 地区の集合を渡すと、その地区だけを足す（API の値のまま）。全地区・1 地区の足し方と食い違わない', () => {
    const two = sumCounts(areas, new Set(['a', 'c']));
    expect(two.found).toBe(true);
    expect(two.byClass).toEqual({ confirmed_new: 7, existing_omission: 9, uncertain: 3 });
    expect(two.total).toBe(19);
    // 1 要素の集合・文字列・null / ''（全地区）は、これまでと同じ答え
    expect(sumCounts(areas, new Set(['c']))).toEqual(sumCounts(areas, 'c'));
    expect(sumCounts(areas, null)).toEqual(sumCounts(areas, ''));
    expect(sumCounts(areas, new Set(['a', 'b', 'c', 'd'])).total).toBe(sumCounts(areas, '').total);
  });

  it('sumCounts: 集合の地区が 1 つでも一覧に無ければ found は false（足りない和を、その区の件数として見せない）', () => {
    expect(sumCounts(areas, new Set(['a', 'zzz'])).found).toBe(false);
    expect(sumCounts(areas, new Set(['zzz', 'yyy'])).found).toBe(false);
    expect(sumCounts(areas, new Set<string>()).found).toBe(false);
    expect(sumCounts([], new Set(['a'])).found).toBe(false);
  });

  it('multiAreaName: 複数の地区の条件なら、API の表示用の名前（scope）。無ければ「N 地区」。複数の地区の条件でなければ null', () => {
    expect(multiAreaName({ ...ALL_FILTER, areaIds: ['a', 'b'], scope: '中央区' })).toBe('中央区');
    expect(multiAreaName({ ...ALL_FILTER, areaIds: ['a', 'b', 'c'] })).toBe('3 地区');
    expect(multiAreaName({ ...ALL_FILTER, areaIds: [], scope: '中央区' })).toBeNull();
    expect(multiAreaName({ ...ALL_FILTER, areaId: 'a', scope: '中央区' })).toBeNull();
    expect(multiAreaName(ALL_FILTER)).toBeNull();
  });
});
