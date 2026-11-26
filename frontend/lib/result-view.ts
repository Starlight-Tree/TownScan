import type { CandidateClass, ResultFilter, ToolResult } from './api-types';
import { CLASS_ORDER, isCandidateClass } from './classes';

/** `/` の拡大ビュー（結果領域。地図・グラフ・写真の比較）の画面 */
export type ResultView = 'map' | 'chart' | 'photos';

export const RESULT_VIEW_ORDER: readonly ResultView[] = ['map', 'chart', 'photos'];

export const RESULT_VIEW_LABELS: Record<ResultView, string> = {
  map: '地図',
  chart: 'グラフ',
  photos: '画像',
};

/** 地図・グラフ・一覧に共通の絞り込み。areaId が空なら全地区、classes は表示する分類 */
export interface MapFilter {
  areaId: string;
  classes: ReadonlySet<CandidateClass>;
  /**
   * 複数の地区（区など）にまたがる回答の条件。あるときは areaId より優先し、areaId は ''。
   * scope は API が付けた表示用の名前（「中央区」）。地区を 1 つ選ぶ操作（選択ボックス・グラフの行）はこの 2 つを消す
   */
  areaIds?: readonly string[];
  scope?: string;
}

export const ALL_FILTER: MapFilter = { areaId: '', classes: new Set(CLASS_ORDER) };

export function isAllFilter(f: MapFilter): boolean {
  return f.areaId === '' && !(f.areaIds && f.areaIds.length > 0) && f.classes.size === CLASS_ORDER.length;
}

/** 絞り込みの対象の地区の id。全地区なら null（areaIds があればそれ、なければ areaId） */
export function areaScopeIds(f: MapFilter): ReadonlySet<string> | null {
  if (f.areaIds && f.areaIds.length > 0) return new Set(f.areaIds);
  if (f.areaId !== '') return new Set([f.areaId]);
  return null;
}

/** 絞り込みの地区の表示名。全地区なら null。複数の地区は API が付けた scope（「中央区」）をそのまま、無ければ「N 地区」。1 つなら nameOf で引いた名前 */
export function areaLabel(f: MapFilter, nameOf: (areaId: string) => string): string | null {
  if (f.areaIds && f.areaIds.length > 0) return f.scope ? f.scope : `${f.areaIds.length} 地区`;
  return f.areaId !== '' ? nameOf(f.areaId) : null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/**
 * 道具の結果として読める形か。画面は、API の形が少し違っても壊れない作りにしている。
 * count は filterFromResults が filter を直接読む（契約では必須）ので、filter がオブジェクトでないものは、壊れた結果として外す。
 * 回答の「対象・条件」の行（AnswerScope）も、拡大ビューの地図・グラフの絞り込み（lib/answer-view.ts）も、filterFromResults に渡す前にこれで外す。
 * 外さずに渡すと、壊れた count が「条件なし（全地区・全分類）」と読まれ、条件の行（その前の結果の条件）と食い違う
 */
export function isWellFormedResult(r: unknown): r is ToolResult {
  if (!isRecord(r) || typeof r.type !== 'string') return false;
  return r.type !== 'count' || isRecord(r.filter);
}

/**
 * 結果の絞り込み条件（backend の _filter_info）の地区の部分。area_ids（2 つ以上）があればそれ、なければ area_id、どちらも無ければ全地区。
 * area_ids があるときは areaId を '' にする（MapFilter の約束）
 */
function areaPart(filter: ResultFilter | null | undefined): Pick<MapFilter, 'areaId' | 'areaIds' | 'scope'> {
  const f = isRecord(filter) ? filter : undefined;
  const ids = Array.isArray(f?.area_ids) ? f.area_ids.filter((id): id is string => typeof id === 'string' && id !== '') : [];
  if (ids.length > 0) return { areaId: '', areaIds: ids, ...(typeof f?.scope === 'string' && f.scope !== '' ? { scope: f.scope } : {}) };
  return { areaId: typeof f?.area_id === 'string' ? f.area_id : '' };
}

/**
 * 回答の件数（count）・比較（compare）の結果が持つ絞り込み条件を、地図・グラフの絞り込みに直す。
 * - 地区は、area_ids（複数。区など）・area_id（1 つ）・どちらも無ければ全地区。
 * - 分類は、count は filter.cls（未知の文字列は「すべて」）。compare は常にすべて: 比較のカードは 3 分類と合計を出し、filter.cls は並べ替えの分類にすぎない。
 * - 複数あれば、あとのものを採る。count も compare も無ければ null（いまの絞り込みのまま）。
 * - 表（table）は条件を写さない: 表は絞り込みの条件（filter）を持たないので、地図・グラフの絞り込みの元にならない（表の「詳細」は、候補を選んで開く）。
 * 数字は結果の値をそのまま使い、ここでは数えない。
 */
export function filterFromResults(results: readonly ToolResult[]): MapFilter | null {
  let found: MapFilter | null = null;
  for (const r of results) {
    if (r.type === 'count') {
      const cls = r.filter?.cls;
      found = { ...areaPart(r.filter), classes: isCandidateClass(cls) ? new Set<CandidateClass>([cls]) : new Set(CLASS_ORDER) };
    } else if (r.type === 'compare') {
      found = { ...areaPart(r.filter), classes: new Set(CLASS_ORDER) };
    }
  }
  return found;
}

/**
 * 候補（分類・地区）が絞り込みの外にあるとき、その候補が入るように広げた絞り込みを返す。すでに入っていれば、同じものをそのまま返す。
 * 分類が無ければ足す。地区が対象の地区に無ければ、地区の絞り込みを全地区に戻す（areaId・areaIds・scope を消す）。
 * 強調・選択した候補が、絞り込みで隠れて描かれないのを防ぐ
 */
export function widenFilterFor(f: MapFilter, candidate: { class: string; area_id: string }): MapFilter {
  let next = f;
  if (isCandidateClass(candidate.class) && !next.classes.has(candidate.class)) {
    next = { ...next, classes: new Set<CandidateClass>([...next.classes, candidate.class]) };
  }
  const scope = areaScopeIds(next);
  if (scope && !scope.has(candidate.area_id)) next = { areaId: '', classes: next.classes };
  return next;
}
