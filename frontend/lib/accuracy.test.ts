import { describe, expect, it } from 'vitest';
import { metricsReal } from '../tests/fixtures';
import {
  PER_AREA_LABEL,
  SWEEP_LABEL,
  chosenVsRunnerUp,
  evalYearOf,
  formatTenths,
  getAbsentStats,
  getEdgeExcluded,
  getYearCompare,
  gridNote,
  matchBasis,
  metricLabel,
  sweepColumns,
} from './accuracy';
import type { MetricsResponse } from './api-types';
import { formatNumber } from './format';

const base: MetricsResponse = { new_building_recall: null };

describe('formatTenths（約 ◯ 割）', () => {
  it.each([
    [0.33, '約 3 割'],
    [0.51, '約 5 割'],
    [0.3556, '約 4 割'],
    [0.05, '約 1 割'],
    [0.049, '1 割未満'],
    [0, '1 割未満'],
    [0.94, '約 9 割'],
    [0.95, 'ほぼ全て'],
    [1, 'ほぼ全て'],
  ])('%s → %s', (share, text) => {
    expect(formatTenths(share)).toBe(text);
  });
});

describe('evalYearOf', () => {
  it('year_compare.selected_on_year → protocol.year → 既定の 2018', () => {
    expect(evalYearOf({ ...base, year_compare: { selected_on_year: 2020 }, protocol: { year: 2019 } })).toBe(2020);
    expect(evalYearOf({ ...base, protocol: { year: 2019 } })).toBe(2019);
    expect(evalYearOf(base)).toBe(2018);
    expect(evalYearOf({ ...base, protocol: { year: 'x' }, year_compare: 7 })).toBe(2018);
  });
});

describe('getYearCompare', () => {
  it('実データの形から、2018 年（トップレベル）と 2023 年（by_year）を読む', () => {
    const yc = getYearCompare(metricsReal)!;
    expect(yc.baseYear).toBe(2018);
    expect(yc.compareYear).toBe(2023);
    expect(yc.setting).toEqual({ scale: 2, threshold: 0.4 });
    expect((yc.base.holdout?.object as { f1: number }).f1).toBe(0.16);
    expect((yc.other.holdout?.object as { f1: number }).f1).toBe(0.1);
    expect(Object.keys(yc.other).sort()).toEqual(['holdout', 'overall', 'tune']);
  });

  it('トップレベルが無ければ by_year の評価年の側で補う', () => {
    const { holdout: _h, ...rest } = metricsReal;
    void _h;
    const yc = getYearCompare(rest as MetricsResponse)!;
    expect((yc.base.holdout?.object as { f1: number }).f1).toBe(0.16);
  });

  it.each([
    ['無い', undefined],
    ['文字列', 'x'],
    ['配列', []],
    ['compare_year が無い', { by_year: {} }],
    ['by_year が無い', { compare_year: 2023 }],
    ['比べる年の値が無い', { compare_year: 2023, by_year: { '2018': {} } }],
    ['比べる年が空', { compare_year: 2023, by_year: { '2023': {} } }],
    ['同じ年', { compare_year: 2018, by_year: { '2018': { holdout: { object: { f1: 1 } } } } }],
    ['compare_year が数でない', { compare_year: '2023', by_year: { '2023': { holdout: {} } } }],
  ])('形が違えば null（%s）', (_name, yc) => {
    expect(getYearCompare({ ...base, year_compare: yc })).toBeNull();
  });
});

describe('getAbsentStats', () => {
  it('実データの形を読む（20 m² 以上は params から）', () => {
    expect(getAbsentStats(metricsReal, 'overall')).toEqual({ n: 200, absent: 66, present: 102, minAreaM2: 20 });
    expect(getAbsentStats(metricsReal, 'holdout')).toEqual({ n: 110, absent: 34, present: 61, minAreaM2: 20 });
  });
  it('棟数が 0・absent が棟数より多い・数でないときは null、present が壊れていれば present だけ捨てる', () => {
    const mk = (s: unknown) => ({ ...base, existing_absent_in_2018: { overall: s } });
    expect(getAbsentStats(mk({ n_buildings: 0, absent: 0 }))).toBeNull();
    expect(getAbsentStats(mk({ n_buildings: 10, absent: 11 }))).toBeNull();
    expect(getAbsentStats(mk({ n_buildings: 10, absent: -1 }))).toBeNull();
    expect(getAbsentStats(mk({ n_buildings: 'x', absent: 1 }))).toBeNull();
    expect(getAbsentStats(mk(null))).toBeNull();
    expect(getAbsentStats(base)).toBeNull();
    expect(getAbsentStats(mk({ n_buildings: 10, absent: 3, present: 99 }))).toEqual({ n: 10, absent: 3, present: undefined, minAreaM2: undefined });
  });
});

describe('getEdgeExcluded', () => {
  it('実データ: 評価用・調整用・合計と、内訳（縁に接する数・重なりで外した数）', () => {
    const e = getEdgeExcluded(metricsReal);
    expect(e.holdout).toEqual({ reference: 47, prediction: 31, detail: { refTouch: 39, refOverlap: 8, predTouch: 30, predOverlap: 1 } });
    expect(e.tune?.reference).toBe(60);
    expect(e.total).toMatchObject({ reference: 107, prediction: 59 });
    expect(e.overlapMin).toBe(0.5);
  });
  it('区分別が無ければ合計だけ。規則（重なり）の記載が無ければ overlapMin も無い', () => {
    const e = getEdgeExcluded({ ...base, excluded_edge_objects: { reference: 41, prediction: 38 } });
    expect(e).toEqual({ total: { reference: 41, prediction: 38 }, totalNumber: undefined, tune: undefined, holdout: undefined, overlapMin: undefined });
  });
  it('数 1 つの古い形・壊れた形でも落ちない', () => {
    expect(getEdgeExcluded({ ...base, excluded_edge_objects: 12 }).totalNumber).toBe(12);
    expect(getEdgeExcluded({ ...base, excluded_edge_objects: { reference: 'x' } as unknown as Record<string, number>, excluded_edge_by_split: 5 }).total).toBeUndefined();
    expect(getEdgeExcluded({ ...base, excluded_edge_by_split: { holdout: { reference: 1 } } }).holdout).toBeUndefined();
  });
});

describe('matchBasis / chosenVsRunnerUp', () => {
  it('一致（tp）と参照の数（n_ref）が揃っているときだけ', () => {
    expect(matchBasis(metricsReal.holdout)).toEqual({ tp: 14, nRef: 115, nPred: 60 });
    expect(matchBasis({ object: { tp: 3 } })).toBeNull();
    expect(matchBasis(undefined)).toBeNull();
  });
  it('選んだ組と次に高い組の調整用 F1', () => {
    const r = chosenVsRunnerUp(metricsReal)!;
    expect(r.chosen).toBe(0.2273);
    expect(r.runnerUp).toBe(0.2121);
    expect(chosenVsRunnerUp(base)).toBeNull();
    expect(chosenVsRunnerUp({ ...base, chosen: { scale: 9, threshold: 9 }, sweep: [{ scale: 1, threshold: 1, tune_object_f1: 0.1 }] })).toBeNull();
  });
});

describe('見出しの対応表', () => {
  it('倍率・閾値の表と地区別の表に出る実データのキーは、すべて日本語の見出しを持つ', () => {
    for (const k of sweepColumns(metricsReal.sweep!)) expect(SWEEP_LABEL[k], k).toBeTruthy();
    for (const k of Object.keys(metricsReal.per_area![0]!)) expect(PER_AREA_LABEL[k], k).toBeTruthy();
    for (const k of Object.values({ ...SWEEP_LABEL, ...PER_AREA_LABEL })) expect(k).not.toMatch(/[a-z]+_[a-z]+/);
  });
  it('「再現率」は必ず修飾され、「新築の再現率」と取り違えない', () => {
    const labels = [metricLabel('recall'), ...Object.values(SWEEP_LABEL), ...Object.values(PER_AREA_LABEL)].filter((l) => l.includes('再現率'));
    expect(labels.length).toBe(4);
    for (const l of labels) expect(l).toContain('建物の抽出の再現率');
  });
  it('物体数には「縁を除く」の断りがある', () => {
    expect(metricLabel('n_ref')).toContain('縁を除く');
    expect(metricLabel('n_pred')).toContain('縁を除く');
    expect(PER_AREA_LABEL.n_ref).toContain('縁を除く');
  });
  it('倍率・閾値の表の列は、既知の列を決めた順に、知らない列を最後に並べる', () => {
    expect(sweepColumns([{ tune_pixel_f1: 1, extra: 2, threshold: 0.3, scale: 1 }])).toEqual(['scale', 'threshold', 'tune_pixel_f1', 'extra']);
  });
});

describe('gridNote（画素単位の升目）', () => {
  it('倍率 2 → 一辺 約 0.25 m・写真 1 画素の 4 分の 1', () => {
    const t = gridNote(2, formatNumber);
    expect(t).toContain('倍率 2 の格子の升目');
    expect(t).toContain('一辺が約 0.25 m');
    expect(t).toContain('4 分の 1');
  });
  it('倍率 1.5 → 約 0.333 m・2.25 分の 1。倍率が無ければ数を書かない', () => {
    const t = gridNote(1.5, formatNumber);
    expect(t).toContain('約 0.333 m');
    expect(t).toContain('2.25 分の 1');
    expect(gridNote(undefined, formatNumber)).not.toMatch(/\d/);
    expect(gridNote(0, formatNumber)).not.toMatch(/\d/);
  });
});
