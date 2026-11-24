import type { AreaSummary, CandidateClass } from '../../lib/api-types';
import { CLASS_ORDER } from '../../lib/classes';
import { formatNumber } from '../../lib/format';
import type { MapFilter } from '../../lib/result-view';

// 地区の集計（API の /api/areas の counts）を、グラフ・集計の帯（分類のチェックボックスを含む）で同じ式で足すための補助。
// 数字は API の値を足すだけで、ここでは推測も補完もしない。

export type ClassSums = Record<CandidateClass, number>;

/** 3 分類のすべてが表示対象か（絞り込みが「分類については全部」か） */
export function allClassesShown(classes: ReadonlySet<CandidateClass>): boolean {
  return CLASS_ORDER.every((c) => classes.has(c));
}

/** 表示対象の分類の件数だけを足す */
export function sumShown(byClass: ClassSums, classes: ReadonlySet<CandidateClass>): number {
  let sum = 0;
  for (const c of CLASS_ORDER) if (classes.has(c)) sum += byClass[c];
  return sum;
}

export interface ScopeSums {
  /**
   * 対象の地区がすべて見つかったか。見つからないとき（地区の一覧が未着・条件が一覧に無い地区）は、数字を出さない。
   * 複数の地区（区など）の条件では、一部だけ見つかった和を「その区の件数」と見せないよう、すべて見つかったときだけ true にする
   */
  found: boolean;
  byClass: ClassSums;
  /** API の total を足した値（全分類） */
  total: number;
}

/** 件数を足す地区の範囲。'' か null なら全地区、文字列ならその 1 地区、集合ならそれらの地区（区など、複数の地区） */
export type AreaScope = string | ReadonlySet<string> | null;

/** areaScope が空（'' か null）なら全地区、そうでなければ、その地区（の集合）だけの件数を足す */
export function sumCounts(areas: readonly AreaSummary[], areaScope: AreaScope): ScopeSums {
  const wanted: ReadonlySet<string> | null =
    areaScope === null || areaScope === '' ? null : typeof areaScope === 'string' ? new Set([areaScope]) : areaScope;
  const byClass: ClassSums = { confirmed_new: 0, existing_omission: 0, uncertain: 0 };
  let total = 0;
  const seen = new Set<string>();
  for (const a of areas) {
    if (wanted && !wanted.has(a.id)) continue;
    seen.add(a.id);
    for (const c of CLASS_ORDER) byClass[c] += a.counts[c] ?? 0;
    total += a.counts.total ?? 0;
  }
  const found = wanted ? wanted.size > 0 && seen.size === wanted.size : seen.size > 0;
  return { found, byClass, total };
}

/**
 * 絞り込みの対象の表示名。複数の地区（areaIds）なら、API が付けた表示用の名前（scope。「中央区」）。
 * scope が無ければ、数だけ言う（「3 地区」）。名前を作らない。複数の地区の条件でなければ null
 */
export function multiAreaName(filter: MapFilter): string | null {
  const ids = filter.areaIds;
  if (!ids || ids.length === 0) return null;
  return filter.scope ?? `${formatNumber(ids.length)} 地区`;
}

export interface AreaRow {
  area: AreaSummary;
  byClass: ClassSums;
  /** 行の合計。全分類を表示しているときは API の total、一部だけのときは、表示する分類の件数の和 */
  total: number;
  /** 棒の長さの基になる、表示する分類の件数の和 */
  stack: number;
}

/** 地区ごとの行。合計の多い順（同数は地区名、それも同じなら id） */
export function buildRows(areas: readonly AreaSummary[], classes: ReadonlySet<CandidateClass>): AreaRow[] {
  const whole = allClassesShown(classes);
  return areas
    .map((area) => {
      const byClass: ClassSums = {
        confirmed_new: area.counts.confirmed_new ?? 0,
        existing_omission: area.counts.existing_omission ?? 0,
        uncertain: area.counts.uncertain ?? 0,
      };
      const stack = sumShown(byClass, classes);
      return { area, byClass, total: whole ? (area.counts.total ?? stack) : stack, stack };
    })
    .sort((a, b) => b.total - a.total || a.area.name.localeCompare(b.area.name, 'ja') || a.area.id.localeCompare(b.area.id));
}
