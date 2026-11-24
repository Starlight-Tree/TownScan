import { describe, expect, it } from 'vitest';
import { compare, count, countWards, mapFocus, table } from '../tests/fixtures';
import {
  ALL_FILTER,
  RESULT_VIEW_LABELS,
  RESULT_VIEW_ORDER,
  areaLabel,
  areaScopeIds,
  filterFromResults,
  isAllFilter,
  isWellFormedResult,
  viewForResults,
  widenFilterFor,
  type MapFilter,
} from './result-view';

describe('viewForResults', () => {
  it('件数・比較はグラフ、地図の表示は地図、検出画像は写真の比較', () => {
    expect(viewForResults(['count'])).toBe('chart');
    expect(viewForResults(['compare'])).toBe('chart');
    expect(viewForResults(['map_focus'])).toBe('map');
    expect(viewForResults(['detection_image'])).toBe('photos');
  });
  it('表・精度・お断りだけなら、切り替えない（null）', () => {
    expect(viewForResults(['table'])).toBeNull();
    expect(viewForResults(['accuracy'])).toBeNull();
    expect(viewForResults(['refusal'])).toBeNull();
    expect(viewForResults([])).toBeNull();
  });
  it('当たる型が複数なら、あとのものを採る。当たらない型は飛ばす', () => {
    expect(viewForResults(['count', 'map_focus'])).toBe('map');
    expect(viewForResults(['map_focus', 'table'])).toBe('map');
  });
  it('すべての画面に名前がある', () => {
    for (const v of RESULT_VIEW_ORDER) expect(RESULT_VIEW_LABELS[v]).not.toBe('');
  });
});

describe('filterFromResults', () => {
  it('件数の結果が無ければ null', () => {
    expect(filterFromResults([])).toBeNull();
    expect(filterFromResults([table, mapFocus])).toBeNull();
  });
  it('件数の絞り込み条件を、地図の絞り込みに直す（最後の件数を採る）', () => {
    const f = filterFromResults([{ ...count, filter: { area_id: 'a1', cls: 'uncertain' } }]);
    expect(f?.areaId).toBe('a1');
    expect([...(f?.classes ?? [])]).toEqual(['uncertain']);
  });
  it('条件が空の件数は「すべて」に戻す', () => {
    const f = filterFromResults([{ ...count, filter: { area_id: null, cls: null } }]);
    expect(f && isAllFilter(f)).toBe(true);
    expect(isAllFilter(ALL_FILTER)).toBe(true);
  });
});

describe('filterFromResults: 地区（1 つ・複数・全地区）と分類', () => {
  const ALL_CLASSES = ['confirmed_new', 'existing_omission', 'uncertain'];
  const classesOf = (f: MapFilter | null) => [...(f?.classes ?? [])].sort();

  it('複数の地区（area_ids）は、areaIds と scope を持つ。areaId は空（「すべて」に見せない）', () => {
    const f = filterFromResults([countWards]);
    expect(f).toEqual({ areaId: '', areaIds: ['z18-1-2', 'z18-2-2'], scope: '中央区', classes: new Set(ALL_CLASSES) });
    expect(f && isAllFilter(f)).toBe(false);
    expect([...(f ? (areaScopeIds(f) ?? []) : [])]).toEqual(['z18-1-2', 'z18-2-2']);
  });

  it('area_ids があれば area_id より優先する。scope が無ければ scope を持たない。area_ids が空なら area_id を読む', () => {
    const both = filterFromResults([{ ...count, filter: { area_id: 'a1', area_ids: ['b1', 'b2'], cls: 'uncertain' } }]);
    expect(both).toEqual({ areaId: '', areaIds: ['b1', 'b2'], classes: new Set(['uncertain']) });
    expect(both && 'scope' in both).toBe(false);
    const empty = filterFromResults([{ ...count, filter: { area_id: 'a1', area_ids: [], cls: null } }]);
    expect(empty?.areaId).toBe('a1');
    expect(empty && 'areaIds' in empty).toBe(false);
  });

  it('area_ids に、空文字・文字列でない値が混じっていても、それらを除いて読む。残りが無ければ area_id を読む', () => {
    const mixed = ['a1', '', 5, null, undefined, { id: 'x' }, ['a9'], 'a2'] as unknown as string[];
    const f = filterFromResults([{ ...count, filter: { area_ids: mixed, scope: '中央区', cls: null } }]);
    expect(f).toEqual({ areaId: '', areaIds: ['a1', 'a2'], scope: '中央区', classes: new Set(ALL_CLASSES) });
    expect([...(f ? (areaScopeIds(f) ?? []) : [])]).toEqual(['a1', 'a2']);

    // 1 つでも文字列が残れば、複数の地区の条件（areaIds）。1 つだけでも area_id には落とさない
    expect(filterFromResults([{ ...count, filter: { area_ids: ['', 'a3', 0] as unknown as string[], cls: null } }])).toEqual({
      areaId: '',
      areaIds: ['a3'],
      classes: new Set(ALL_CLASSES),
    });

    // 使えるものが 1 つも無ければ、area_id（あれば）。それも無ければ全地区
    const none = ['', 7, null] as unknown as string[];
    expect(filterFromResults([{ ...count, filter: { area_id: 'a1', area_ids: none, cls: null } }])).toEqual({ areaId: 'a1', classes: new Set(ALL_CLASSES) });
    const all = filterFromResults([{ ...count, filter: { area_ids: none, scope: '中央区', cls: null } }]);
    expect(all && isAllFilter(all)).toBe(true);
    expect(all && 'scope' in all).toBe(false);
  });

  it('scope が文字列でない・空なら、持たない', () => {
    const odd = filterFromResults([{ ...count, filter: { area_ids: ['a1', 'a2'], scope: 3 as unknown as string, cls: null } }]);
    expect(odd && 'scope' in odd).toBe(false);
    const empty = filterFromResults([{ ...count, filter: { area_ids: ['a1', 'a2'], scope: '', cls: null } }]);
    expect(empty && 'scope' in empty).toBe(false);
  });

  it('area_id が 1 つなら areaId に入れる。どちらも無ければ全地区', () => {
    expect(filterFromResults([{ ...count, filter: { area_id: 'a1', cls: null } }])).toEqual({ areaId: 'a1', classes: new Set(ALL_CLASSES) });
    const none = filterFromResults([{ ...count, filter: { cls: null } }]);
    expect(none && isAllFilter(none)).toBe(true);
  });

  it('未知の分類（cls）は「すべて」にする（存在しない分類の集合で、地図を空にしない）', () => {
    const f = filterFromResults([{ ...count, filter: { area_id: null, cls: 'mystery' as never } }]);
    expect(classesOf(f)).toEqual(ALL_CLASSES);
    expect(f && isAllFilter(f)).toBe(true);
  });

  it('件数が複数なら、最後のものを採る（最初ではない）', () => {
    const first = { ...count, filter: { area_id: 'a1', cls: 'uncertain' as const } };
    const last = { ...count, filter: { area_id: 'a2', cls: 'existing_omission' as const } };
    const f = filterFromResults([first, table, last, mapFocus]);
    expect(f?.areaId).toBe('a2');
    expect(classesOf(f)).toEqual(['existing_omission']);
  });

  it('compare も読む: 地区は count と同じ読み方で、分類は常にすべて（filter.cls は並べ替えの分類にすぎない）', () => {
    expect(filterFromResults([compare])).toEqual({ areaId: '', classes: new Set(ALL_CLASSES) });
    const byArea = filterFromResults([{ ...compare, filter: { area_id: 'a1', cls: 'uncertain' } }]);
    expect(byArea).toEqual({ areaId: 'a1', classes: new Set(ALL_CLASSES) });
    const byWard = filterFromResults([{ ...compare, filter: { area_ids: ['a1', 'a2'], scope: '中央区', cls: 'confirmed_new' } }]);
    expect(byWard).toEqual({ areaId: '', areaIds: ['a1', 'a2'], scope: '中央区', classes: new Set(ALL_CLASSES) });
  });

  it('count と compare が両方あれば、あとのものを採る（直前の count の絞り込みを残さない）', () => {
    const narrow = { ...count, filter: { area_id: 'a1', cls: 'uncertain' as const } };
    expect(classesOf(filterFromResults([narrow, compare]))).toEqual(ALL_CLASSES);
    expect(filterFromResults([narrow, compare])?.areaId).toBe('');
    // 逆の順なら count の条件
    expect(classesOf(filterFromResults([compare, narrow]))).toEqual(['uncertain']);
  });

  it('table は絞り込みを写さない（filter を持っていても null）', () => {
    expect(filterFromResults([{ ...table, filter: { area_id: 'a1', cls: 'uncertain' } }])).toBeNull();
    // 件数のあとに表が来ても、件数の条件のまま
    const f = filterFromResults([{ ...count, filter: { area_id: 'a1', cls: null } }, { ...table, filter: { area_id: 'a9', cls: null } }]);
    expect(f?.areaId).toBe('a1');
  });

  it('壊れた filter（欠けている・オブジェクトでない）でも落ちず、全地区・全分類として読む', () => {
    const noFilter = { ...count, filter: undefined } as unknown as typeof count;
    const odd = { ...compare, filter: 'x' } as unknown as typeof compare;
    expect(() => filterFromResults([noFilter, odd])).not.toThrow();
    const f = filterFromResults([noFilter]);
    expect(f && isAllFilter(f)).toBe(true);
    expect(filterFromResults([odd]) && isAllFilter(filterFromResults([odd])!)).toBe(true);
  });
});

describe('isWellFormedResult（filterFromResults に渡す前の前処理）', () => {
  it('type が文字列のオブジェクトは読める。count は、filter がオブジェクトのときだけ（契約では必須）', () => {
    expect(isWellFormedResult(count)).toBe(true);
    expect(isWellFormedResult(compare)).toBe(true);
    expect(isWellFormedResult(table)).toBe(true);
    const noFilter = { ...count, filter: undefined };
    expect(isWellFormedResult(noFilter)).toBe(false);
    expect(isWellFormedResult({ ...count, filter: 'x' })).toBe(false);
    expect(isWellFormedResult({ ...count, filter: null })).toBe(false);
  });

  it('count 以外は、filter が無くても読める（compare の filter は、無ければ全地区として読む）', () => {
    expect(isWellFormedResult({ ...compare, filter: undefined })).toBe(true);
    expect(isWellFormedResult({ ...mapFocus })).toBe(true);
  });

  it('オブジェクトでない・type が文字列でないものは読めない', () => {
    for (const v of [null, undefined, 'text', 42, {}, { type: 3 }, []]) expect(isWellFormedResult(v)).toBe(false);
  });

  it('壊れた count を外してから渡すと、その前の条件を採る（外さずに渡すと、全地区・全分類と読まれる）', () => {
    const noFilter = { ...count, filter: undefined } as unknown as typeof count;
    const byWard = { ...compare, filter: { area_ids: ['z18-1-2', 'z18-2-2'], scope: '中央区', cls: null } };
    expect(filterFromResults([byWard, noFilter].filter(isWellFormedResult))).toMatchObject({ areaIds: ['z18-1-2', 'z18-2-2'], scope: '中央区' });
    const raw = filterFromResults([byWard, noFilter]);
    expect(raw && isAllFilter(raw)).toBe(true);
  });
});

describe('areaLabel（絞り込みの地区の表示名）', () => {
  const nameOf = (id: string) => (id === 'a1' ? '地区 1' : id);
  it('全地区は null。1 つは名前、複数は API の scope、scope が無ければ「N 地区」', () => {
    expect(areaLabel(ALL_FILTER, nameOf)).toBeNull();
    expect(areaLabel({ areaId: 'a1', classes: ALL_FILTER.classes }, nameOf)).toBe('地区 1');
    expect(areaLabel({ areaId: '', areaIds: ['a1', 'a2'], scope: '中央区', classes: ALL_FILTER.classes }, nameOf)).toBe('中央区');
    expect(areaLabel({ areaId: '', areaIds: ['a1', 'a2', 'a3'], classes: ALL_FILTER.classes }, nameOf)).toBe('3 地区');
  });
});

describe('widenFilterFor（強調・選択する候補が、絞り込みで隠れないように広げる）', () => {
  const only = (cls: 'confirmed_new' | 'existing_omission' | 'uncertain', areaId = ''): MapFilter => ({ areaId, classes: new Set([cls]) });

  it('すでに入っていれば、同じ絞り込みをそのまま返す（無駄な再描画をしない）', () => {
    const f = only('uncertain', 'a1');
    expect(widenFilterFor(f, { class: 'uncertain', area_id: 'a1' })).toBe(f);
    expect(widenFilterFor(ALL_FILTER, { class: 'confirmed_new', area_id: 'zz' })).toBe(ALL_FILTER);
  });

  it('分類が無ければ足す（ほかの分類は残す）', () => {
    const f = widenFilterFor(only('uncertain'), { class: 'confirmed_new', area_id: 'a1' });
    expect([...f.classes].sort()).toEqual(['confirmed_new', 'uncertain']);
    expect(f.areaId).toBe('');
  });

  it('地区が対象に無ければ、全地区に戻す（areaId・areaIds・scope を消す）。分類は残す', () => {
    const one = widenFilterFor(only('uncertain', 'a1'), { class: 'uncertain', area_id: 'a2' });
    expect(one).toEqual({ areaId: '', classes: new Set(['uncertain']) });
    const wards: MapFilter = { areaId: '', areaIds: ['a1', 'a2'], scope: '中央区', classes: new Set(['uncertain']) };
    const widened = widenFilterFor(wards, { class: 'uncertain', area_id: 'a3' });
    expect(widened).toEqual({ areaId: '', classes: new Set(['uncertain']) });
    expect('areaIds' in widened || 'scope' in widened).toBe(false);
    // 対象の地区の中なら、複数の地区のまま
    expect(widenFilterFor(wards, { class: 'uncertain', area_id: 'a2' })).toBe(wards);
  });

  it('分類と地区の両方が外なら、両方を広げる。未知の分類は足さない', () => {
    expect(widenFilterFor(only('uncertain', 'a1'), { class: 'confirmed_new', area_id: 'a2' })).toEqual({
      areaId: '',
      classes: new Set(['uncertain', 'confirmed_new']),
    });
    const f = only('uncertain');
    expect(widenFilterFor(f, { class: 'mystery', area_id: 'a1' })).toBe(f);
  });
});
