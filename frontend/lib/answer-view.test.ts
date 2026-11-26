import { describe, expect, it } from 'vitest';
import type { AreaSummary, CandidateFeature, ToolResult } from './api-types';
import { ALL_RESULTS, accuracy, areas, compare, count, countWards, detail, detectionImage, mapFocus, refusal, table } from '../tests/fixtures';
import {
  answerKey,
  applyExpandRequest,
  clearSelection,
  comparePhotos,
  detailLoaded,
  figureKinds,
  initialAnswerView,
  NO_IDS,
  openCandidate,
  selectFromMap,
  showDetailOnMap,
  showMapForFilter,
  type AnswerContext,
  type AnswerView,
} from './answer-view';
import { ALL_FILTER, type MapFilter } from './result-view';

const square = (lon: number): CandidateFeature['geometry'] => ({
  type: 'Polygon',
  coordinates: [[[lon, 32.8], [lon + 0.0001, 32.8], [lon + 0.0001, 32.8001], [lon, 32.8001], [lon, 32.8]]],
});
const feature = (id: string, cls: CandidateFeature['properties']['class'], areaId: string, lon: number): CandidateFeature => ({
  type: 'Feature',
  id,
  geometry: square(lon),
  properties: { id, class: cls, area_m2: 100, area_id: areaId },
});
const twoAreas: AreaSummary[] = [
  { ...areas[0]!, id: 'z18-1-2', bbox: [130.7, 32.8, 130.701, 32.801] },
  { ...areas[0]!, id: 'z18-2-2', name: 'テスト地区 02', bbox: [130.8, 32.9, 130.801, 32.901] },
];
const features = [
  feature('c-1-2-1', 'confirmed_new', 'z18-1-2', 130.7),
  feature('c-1-2-2', 'uncertain', 'z18-1-2', 130.701),
  feature('c-3-3-1', 'existing_omission', 'z18-3-3', 130.72),
];
const ctx: AnswerContext = { areas: twoAreas, byId: new Map(features.map((f) => [f.properties.id, f])) };
const noData: AnswerContext = { areas: [], byId: new Map() };

const BOX_1: [number, number, number, number] = [130.7, 32.8, 130.701, 32.801];
const BOX_ALL: [number, number, number, number] = [130.7, 32.8, 130.801, 32.901];

const fresh = (over: Partial<AnswerView> = {}): AnswerView => ({
  view: 'map',
  filter: ALL_FILTER,
  highlightIds: NO_IDS,
  selected: null,
  mapFocus: null,
  pendingFocusId: null,
  ...over,
});

describe('answerKey（拡大の単位は回答 1 件）', () => {
  it('回答ごとに別の鍵。回答を持たない拡大ビュー（最初の画面）は、1 つだけの鍵', () => {
    expect(answerKey({ id: 'm2', results: [] })).not.toBe(answerKey({ id: 'm4', results: [] }));
    expect(answerKey({ id: 'm2', results: [count] })).toBe(answerKey({ id: 'm2', results: [] }));
    expect(answerKey(null)).toBe(answerKey(null));
    expect(answerKey(null)).not.toBe(answerKey({ id: 'welcome', results: [] }));
  });
});

describe('initialAnswerView（その回答をはじめて開くとき。回答の結果から決める）', () => {
  it('結果が無い・条件を持たない結果（表）だけなら、すべての絞り込みで、全地区が収まる範囲へ寄せる。強調も選択も無い', () => {
    for (const results of [[], [table]] as ToolResult[][]) {
      const s = initialAnswerView(results, ctx);
      expect(s.filter).toBe(ALL_FILTER);
      expect(s.mapFocus).toMatchObject({ bbox: BOX_ALL, ids: [] });
      expect(s.highlightIds.size).toBe(0);
      expect(s.selected).toBeNull();
      expect(s.pendingFocusId).toBeNull();
    }
  });

  it('地区の一覧がまだ読み込まれていなければ、寄せ先は無い（地図が、地区の枠が収まる範囲を見せる）', () => {
    expect(initialAnswerView([], noData).mapFocus).toBeNull();
  });

  it('件数の条件（分類・地区）を絞り込みに写し、条件の地区が収まる範囲へ寄せる', () => {
    const s = initialAnswerView([{ ...count, filter: { area_id: 'z18-1-2', cls: 'uncertain' } }], ctx);
    expect(s.filter).toEqual({ areaId: 'z18-1-2', classes: new Set(['uncertain']) });
    expect(s.mapFocus).toMatchObject({ bbox: BOX_1, ids: [] });
  });

  it('複数の地区（区）の件数は、areaIds と scope のまま。areaId は空', () => {
    const s = initialAnswerView([countWards], ctx);
    expect(s.filter).toEqual({
      areaId: '',
      areaIds: ['z18-1-2', 'z18-2-2'],
      scope: '中央区',
      classes: new Set(['confirmed_new', 'existing_omission', 'uncertain']),
    });
    expect(s.mapFocus?.bbox).toEqual(BOX_ALL);
  });

  it('比較の回答は、地区は比較の条件、分類は常にすべて（filter.cls は並べ替えの分類）。件数のあとの比較は、比較の条件', () => {
    const s = initialAnswerView([{ ...count, filter: { area_id: 'z18-1-2', cls: 'uncertain' } }, { ...compare, filter: { area_id: null, cls: 'uncertain' } }], ctx);
    expect(s.filter).toEqual({ areaId: '', classes: new Set(['confirmed_new', 'existing_omission', 'uncertain']) });
  });

  it('壊れた件数（filter が無い）は飛ばす。前の結果の条件を、全地区・全分類にしない', () => {
    const noFilter = { type: 'count', title: '壊れた件数', total: 1, provenance: compare.provenance } as unknown as ToolResult;
    const byWard = { ...compare, filter: { area_ids: ['z18-1-2', 'z18-2-2'], scope: '中央区', cls: null } };
    const s = initialAnswerView([byWard, noFilter], ctx);
    expect(s.filter.areaIds).toEqual(['z18-1-2', 'z18-2-2']);
    expect(s.filter.scope).toBe('中央区');
  });

  it('地図の表示（最後のもの）: 候補を強調し、その範囲へ寄せる。強調する候補が絞り込みで隠れないように広げる', () => {
    const narrow = { ...count, filter: { area_id: 'z18-1-2', cls: 'uncertain' as const } };
    const s = initialAnswerView([narrow, { ...mapFocus, candidate_ids: ['c-1-2-1', 'c-3-3-1'] }], ctx);
    expect([...s.highlightIds]).toEqual(['c-1-2-1', 'c-3-3-1']);
    expect(s.mapFocus).toMatchObject({ bbox: mapFocus.bbox, ids: ['c-1-2-1', 'c-3-3-1'] });
    // 新規出現・描き漏れが足され、地区 z18-3-3 は対象の外なので全地区へ戻る
    expect(s.filter.areaId).toBe('');
    expect(s.filter.classes).toEqual(new Set(['uncertain', 'confirmed_new', 'existing_omission']));
    // 複数あれば最後のもの
    const last = initialAnswerView([{ ...mapFocus, candidate_ids: ['c-1-2-1'] }, { ...mapFocus, candidate_ids: ['c-1-2-2'] }], ctx);
    expect([...last.highlightIds]).toEqual(['c-1-2-2']);
  });

  it('検出画像（最後のもの）: その候補を、見出しへフォーカスを移さずに選び、地図もその候補へ寄せる', () => {
    const s = initialAnswerView([{ ...detectionImage, candidate_id: 'c-1-2-1' }, table, { ...detectionImage, candidate_id: 'c-1-2-2' }], ctx);
    expect(s.selected).toEqual({ id: 'c-1-2-2', focus: false });
    expect(s.mapFocus).toMatchObject({ ids: ['c-1-2-2'] });
    expect(s.pendingFocusId).toBeNull();
  });

  it('検出画像の候補が、地図の候補データにまだ無いときは、詳細が届いてから寄せる（予約）。寄せ先は、条件の地区のまま', () => {
    const s = initialAnswerView([detectionImage], { areas: twoAreas, byId: new Map() });
    expect(s.selected).toEqual({ id: detectionImage.candidate_id, focus: false });
    expect(s.pendingFocusId).toBe(detectionImage.candidate_id);
    expect(s.mapFocus).toMatchObject({ bbox: BOX_ALL, ids: [] });
  });

  it('初期の画面は地図（開くボタンが、そのあと画面を決める）', () => {
    expect(initialAnswerView([count], ctx).view).toBe('map');
  });
});

describe('applyExpandRequest（押したボタンの画面で開く）', () => {
  it('view: 押したボタンの画面を選ぶ。利用者が変えた絞り込み・強調・選択は、そのまま残す', () => {
    const changed: MapFilter = { areaId: 'z18-1-2', classes: new Set(['uncertain']) };
    const before = fresh({ view: 'photos', filter: changed, highlightIds: new Set(['c-1-2-1']), selected: { id: 'c-1-2-2', focus: false } });
    const after = applyExpandRequest(before, { type: 'view', view: 'chart' }, ctx);
    expect(after.view).toBe('chart');
    expect(after.filter).toBe(changed);
    expect(after.highlightIds).toBe(before.highlightIds);
    expect(after.selected).toEqual({ id: 'c-1-2-2', focus: false });
  });

  it('view: 前の「詳細を開く」の、見出しへフォーカスを移す指定は引き継がない（開き直したあと、タブで見える詳細が、フォーカスを奪わない）', () => {
    const after = applyExpandRequest(fresh({ selected: { id: 'c-1-2-2', focus: true } }), { type: 'view', view: 'photos' }, ctx);
    expect(after.selected).toEqual({ id: 'c-1-2-2', focus: false });
  });

  it('view: 寄せ先がまだ無ければ、いまの絞り込みの地区へ。あれば、そのまま（押しても動かさない）', () => {
    const scoped = fresh({ filter: { areaId: 'z18-1-2', classes: ALL_FILTER.classes } });
    expect(applyExpandRequest(scoped, { type: 'view', view: 'map' }, ctx).mapFocus).toMatchObject({ bbox: BOX_1 });
    const kept = fresh({ mapFocus: { bbox: BOX_ALL, ids: ['x'], nonce: 7 } });
    expect(applyExpandRequest(kept, { type: 'view', view: 'chart' }, ctx).mapFocus).toBe(kept.mapFocus);
  });

  it('view: 条件の地区から決めた寄せ先（ids が空）は、開き直すたびに、いまの絞り込みの地区へ決め直す（地区を替えたあとも、その地区が見える）', () => {
    // はじめて開いたときは全地区へ寄せた。そのあと、利用者が地区を 1 つに絞った
    const opened = fresh({ mapFocus: { bbox: BOX_ALL, ids: [], nonce: 3 } });
    const narrowed = { ...opened, filter: { areaId: 'z18-1-2', classes: ALL_FILTER.classes } };
    const reopened = applyExpandRequest(narrowed, { type: 'view', view: 'map' }, ctx);
    expect(reopened.mapFocus).toMatchObject({ bbox: BOX_1, ids: [] });
    // 地区の一覧が無ければ、いまの寄せ先のまま
    expect(applyExpandRequest(narrowed, { type: 'view', view: 'map' }, noData).mapFocus).toBe(opened.mapFocus);
  });

  it('focus（地図の表示の「地図で見る」）: 地図で、候補を強調して範囲へ寄せる。押すたびに、強調と寄せ先を当て直す', () => {
    const before = fresh({ view: 'chart', highlightIds: new Set(['z']), mapFocus: { bbox: BOX_1, ids: [], nonce: 1 } });
    const after = applyExpandRequest(before, { type: 'focus', bbox: mapFocus.bbox, candidateIds: ['c-1-2-2'] }, ctx);
    expect(after.view).toBe('map');
    expect([...after.highlightIds]).toEqual(['c-1-2-2']);
    expect(after.mapFocus).toMatchObject({ bbox: mapFocus.bbox, ids: ['c-1-2-2'] });
    expect(after.mapFocus!.nonce).toBeGreaterThan(1);
  });

  it('focus: 強調する候補の分類が絞り込みに無ければ足す。まだ読み込まれていない候補では、絞り込みを動かさない', () => {
    const only: MapFilter = { areaId: '', classes: new Set(['confirmed_new']) };
    const widened = applyExpandRequest(fresh({ filter: only }), { type: 'focus', bbox: mapFocus.bbox, candidateIds: ['c-1-2-2'] }, ctx);
    expect(widened.filter.classes).toEqual(new Set(['confirmed_new', 'uncertain']));
    const unknown = applyExpandRequest(fresh({ filter: only }), { type: 'focus', bbox: mapFocus.bbox, candidateIds: ['c-9-9-9'] }, ctx);
    expect(unknown.filter).toBe(only);
  });

  it('candidate（「詳細」「詳細を開く」）: 写真の比較で、その候補を、見出しへフォーカスを移す指定で選び、地図もその候補へ寄せる', () => {
    const after = applyExpandRequest(fresh(), { type: 'candidate', id: 'c-1-2-2' }, ctx);
    expect(after.view).toBe('photos');
    expect(after.selected).toEqual({ id: 'c-1-2-2', focus: true });
    expect(after.mapFocus).toMatchObject({ ids: ['c-1-2-2'] });
    expect(after.pendingFocusId).toBeNull();
  });

  it('compare（図の地図の「写真を比べる」）: 地図で選んだ候補を、写真の比較で開く（見出しへフォーカスを移す）。地図の寄せ先と絞り込みは動かさない', () => {
    const focus = { bbox: BOX_ALL, ids: [], nonce: 4 };
    const before = fresh({ mapFocus: focus, selected: { id: 'c-1-2-2', focus: false } });
    const after = applyExpandRequest(before, { type: 'compare', id: 'c-1-2-2' }, ctx);
    expect(after.view).toBe('photos');
    expect(after.selected).toEqual({ id: 'c-1-2-2', focus: true });
    expect(after.mapFocus).toBe(focus);
    expect(after.filter).toBe(before.filter);
  });

  it('candidate: 地図の候補データに形が無ければ、詳細が届いてから寄せる。分類・地区が絞り込みの外なら広げる（地区は全地区へ戻す）', () => {
    const lazy = applyExpandRequest(fresh(), { type: 'candidate', id: 'c-9-9-9' }, ctx);
    expect(lazy.pendingFocusId).toBe('c-9-9-9');
    expect(lazy.filter).toBe(ALL_FILTER);
    const narrow: MapFilter = { areaId: 'z18-1-2', classes: new Set(['uncertain']) };
    const wide = applyExpandRequest(fresh({ filter: narrow }), { type: 'candidate', id: 'c-3-3-1' }, ctx);
    expect(wide.filter.areaId).toBe('');
    expect(wide.filter.classes).toEqual(new Set(['uncertain', 'existing_omission']));
  });
});

describe('拡大ビューの中の操作', () => {
  it('selectFromMap: 地図の印を選ぶ。画面は替えず、フォーカスを移す指定にしない。絞り込みの外なら広げ、予約は取り消す', () => {
    const before = fresh({ view: 'map', pendingFocusId: 'c-9-9-9', filter: { areaId: '', classes: new Set(['confirmed_new']) } });
    const after = selectFromMap(before, 'c-1-2-2', ctx);
    expect(after.view).toBe('map');
    expect(after.selected).toEqual({ id: 'c-1-2-2', focus: false });
    expect(after.pendingFocusId).toBeNull();
    expect(after.filter.classes).toEqual(new Set(['confirmed_new', 'uncertain']));
    expect(after.mapFocus).toBeNull();
  });

  it('comparePhotos: 写真の比較へ。見出しへフォーカスを移す指定で選ぶ', () => {
    const after = comparePhotos(fresh(), 'c-1-2-2');
    expect(after.view).toBe('photos');
    expect(after.selected).toEqual({ id: 'c-1-2-2', focus: true });
  });

  it('openCandidate（一覧から）: 写真の比較へ切り替えて、地図もその候補へ寄せる', () => {
    const after = openCandidate(fresh(), 'c-1-2-1', ctx);
    expect(after.view).toBe('photos');
    expect(after.selected).toEqual({ id: 'c-1-2-1', focus: true });
    expect(after.mapFocus).toMatchObject({ ids: ['c-1-2-1'] });
  });

  it('clearSelection: 選択と予約を外す。外すものが無ければ、同じ状態のまま（無駄な更新をしない）', () => {
    const selected = fresh({ selected: { id: 'c-1-2-1', focus: false }, pendingFocusId: 'c-1-2-1' });
    expect(clearSelection(selected)).toMatchObject({ selected: null, pendingFocusId: null });
    const idle = fresh();
    expect(clearSelection(idle)).toBe(idle);
  });

  it('detailLoaded: 予約した候補の詳細が届いたときだけ、その位置へ寄せて予約を外す。ほかの候補・形の無い詳細では、動かさない', () => {
    const waiting = fresh({ pendingFocusId: 'c-1-2-1' });
    const done = detailLoaded(waiting, detail);
    expect(done.pendingFocusId).toBeNull();
    expect(done.mapFocus).toMatchObject({ bbox: detail.bbox, ids: ['c-1-2-1'] });
    expect(detailLoaded(waiting, { ...detail, id: 'c-1-2-2' })).toBe(waiting);
    expect(detailLoaded(fresh(), detail).mapFocus).toBeNull();
  });

  it('showDetailOnMap: 詳細の分類で広げ、その候補へ寄せて、地図へ', () => {
    const before = fresh({ view: 'photos', filter: { areaId: '', classes: new Set(['uncertain']) } });
    const after = showDetailOnMap(before, detail);
    expect(after.view).toBe('map');
    expect(after.filter.classes).toEqual(new Set(['uncertain', 'confirmed_new']));
    expect(after.mapFocus).toMatchObject({ bbox: detail.bbox, ids: [detail.id] });
  });

  it('showMapForFilter（グラフの「地図で見る」）: 地図へ。条件の地区へ寄せる。地区の一覧が無ければ、いまの寄せ先のまま', () => {
    const scoped = fresh({ view: 'chart', filter: { areaId: 'z18-1-2', classes: ALL_FILTER.classes } });
    const after = showMapForFilter(scoped, ctx);
    expect(after.view).toBe('map');
    expect(after.mapFocus).toMatchObject({ bbox: BOX_1 });
    const kept = fresh({ mapFocus: { bbox: BOX_1, ids: [], nonce: 3 } });
    expect(showMapForFilter(kept, noData).mapFocus).toBe(kept.mapFocus);
  });
});

describe('figureKinds（回答の中に出す図。結果カードにあった「グラフで見る」「地図で見る」の出し方を写す）', () => {
  it('件数: 地図だけ（内訳はカードが文字で出す。グラフは「グラフ」のタブ）。複数の地区の件数も同じ。比較と組なら、地図・グラフの順', () => {
    expect(figureKinds([count])).toEqual(['map']);
    expect(figureKinds([countWards])).toEqual(['map']);
    expect(figureKinds([compare, count])).toEqual(['map', 'chart']);
  });

  it('比較: グラフだけ。比べる地区が 1 つも無いときは出さない', () => {
    expect(figureKinds([compare])).toEqual(['chart']);
    expect(figureKinds([{ ...compare, items: [] }])).toEqual([]);
  });

  it('地図の表示（map_focus）: 地図だけ。範囲（bbox）か候補の並びが壊れているときは出さない', () => {
    expect(figureKinds([mapFocus])).toEqual(['map']);
    expect(figureKinds([{ ...mapFocus, candidate_ids: [] }])).toEqual(['map']);
    expect(figureKinds([{ ...mapFocus, bbox: undefined } as unknown as ToolResult])).toEqual([]);
    expect(figureKinds([{ ...mapFocus, candidate_ids: undefined } as unknown as ToolResult])).toEqual([]);
  });

  it('表・検出画像・精度・お断りは、図を出さない（写真の比較は図に入れない）', () => {
    for (const r of [table, detectionImage, accuracy, refusal]) expect(figureKinds([r]), r.type).toEqual([]);
    expect(figureKinds([])).toEqual([]);
  });

  it('1 つの回答に複数の結果があるときは、種類ごとに 1 つだけ（地図・グラフの順）。比較と地図の表示が並んでも、重ならない', () => {
    expect(figureKinds([mapFocus, compare])).toEqual(['map', 'chart']);
    expect(figureKinds([count, compare, mapFocus])).toEqual(['map', 'chart']);
    expect(figureKinds([table, mapFocus, detectionImage])).toEqual(['map']);
    expect(figureKinds(ALL_RESULTS)).toEqual(['map', 'chart']);
  });

  it('壊れた結果（型が無い・null・filter の無い件数）は、図の元にしない。拡大ビューの絞り込みと同じ前処理で、飛ばす', () => {
    const broken = [null, 3, {}, { type: 5 }, { ...count, filter: undefined }] as unknown as ToolResult[];
    expect(figureKinds(broken)).toEqual([]);
    expect(figureKinds([...broken, compare])).toEqual(['chart']);
    // 知らない型（API の版がずれている）も、出さない
    expect(figureKinds([{ type: 'heatmap' } as unknown as ToolResult])).toEqual([]);
  });
});
