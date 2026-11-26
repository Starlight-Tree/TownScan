// 精度ページ（/accuracy）の読み取りと文言の部品。
// /api/metrics の本体は eval.json（pipeline が決める）。任意の項目（year_compare・existing_absent_in_2014 など）は、
// 無い・形が違うときに null を返し、画面はその部分を出さないだけで壊れない（仕様 docs/spec-prototype.md §6）。
import type { MetricBlock, MetricsResponse, SplitMetrics } from './api-types';

export const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 評価に使った写真の年。eval.json に書かれていないときの既定（仕様 §6: 対象は 2014 年の写真 12 枚） */
export const DEFAULT_EVAL_YEAR = 2014;

/** 物体単位 F1 の根拠の一致数がこれ未満なら「少数」と書く。経験則の目安であり、検定の閾値ではない */
export const FEW_MATCHES = 30;

/** 写真 1 画素の一辺（m）。IGN のタイル z18 のパリ近郊で約 0.4 m（256 画素 ≒ 100 m） */
const PHOTO_PIXEL_M = 0.4;

export type SplitKey = 'tune' | 'holdout' | 'overall';
export type SplitMap = Partial<Record<SplitKey, SplitMetrics>>;

// ---- 見出し（生のキーを画面に出さない） ----

/** 「再現率」は、新築の再現率（未測定）と取り違えないよう、建物の抽出の値だと修飾する */
export const METRIC_LABEL: Record<string, string> = {
  iou: 'IoU（重なり）',
  precision: '建物の抽出の適合率（正解の建物データに対して）',
  recall: '建物の抽出の再現率（正解の建物データに対して）',
  f1: 'F1',
  tp: '一致（TP）',
  fp: '余分（FP）',
  fn: '見逃し（FN）',
  n_ref: '参照の物体数（縁を除く）',
  n_pred: '予測の物体数（縁を除く）',
};

export const GROUP_LABEL: Record<string, string> = { pixel: '画素単位', object: '物体単位（IoU 0.5 以上で 1 対 1）' };
export const GROUP_SHORT: Record<string, string> = { pixel: '画素単位', object: '物体単位' };

export function metricLabel(key: string): string {
  return METRIC_LABEL[key] ?? key;
}

/** 倍率・閾値の表の列。並びもこの順（知らない列は最後に、キーのまま） */
export const SWEEP_LABEL: Record<string, string> = {
  scale: '倍率',
  threshold: '閾値',
  tune_object_f1: '物体単位 F1',
  tune_object_precision: '建物の抽出の適合率（物体単位）',
  tune_object_recall: '建物の抽出の再現率（物体単位）',
  tune_pixel_iou: '画素 IoU',
  tune_pixel_f1: '画素 F1',
};

/** 地区ごとの表の列。並びは eval.json のまま */
export const PER_AREA_LABEL: Record<string, string> = {
  area_id: '地区',
  split: '区分',
  pixel_iou: '画素 IoU',
  pixel_f1: '画素 F1',
  pixel_precision: '建物の抽出の適合率（画素単位）',
  pixel_recall: '建物の抽出の再現率（画素単位）',
  object_f1: '物体単位 F1',
  object_precision: '建物の抽出の適合率（物体単位）',
  object_recall: '建物の抽出の再現率（物体単位）',
  n_ref: '参照の物体数（縁を除く）',
  n_pred: '予測の物体数（縁を除く）',
  excluded_ref: '縁で外した参照の数',
  excluded_pred: '縁で外した予測の数',
};

export function sweepColumns(rows: Array<Record<string, unknown>>): string[] {
  const present = new Set(rows.flatMap((r) => Object.keys(r)));
  const known = Object.keys(SWEEP_LABEL).filter((k) => present.has(k));
  return [...known, ...[...present].filter((k) => !(k in SWEEP_LABEL))];
}

// ---- 数の読み取り ----

export function getBlock(split: SplitMetrics | undefined, group: string): MetricBlock | undefined {
  const b = split?.[group];
  return isObj(b) ? (b as MetricBlock) : undefined;
}

export function metricValue(split: SplitMetrics | undefined, group: string, key: string): number | undefined {
  const v = getBlock(split, group)?.[key];
  return isNum(v) ? v : undefined;
}

function asSplit(v: unknown): SplitMetrics | undefined {
  return isObj(v) ? (v as SplitMetrics) : undefined;
}

/** 評価に使った写真の年（year_compare.selected_on_year → protocol.year → 既定の 2014） */
export function evalYearOf(m: MetricsResponse): number {
  const yc = m.year_compare;
  if (isObj(yc) && isNum(yc.selected_on_year)) return yc.selected_on_year;
  const protocol = m.protocol;
  if (isObj(protocol) && isNum(protocol.year)) return protocol.year;
  return DEFAULT_EVAL_YEAR;
}

export interface YearCompare {
  baseYear: number;
  compareYear: number;
  /** 選んだ設定（倍率・閾値）。両方の年で同じ */
  setting: { scale?: number; threshold?: number };
  base: SplitMap;
  other: SplitMap;
}

const SPLIT_KEYS: SplitKey[] = ['tune', 'holdout', 'overall'];

function splitMapOf(v: unknown): SplitMap {
  const out: SplitMap = {};
  if (!isObj(v)) return out;
  for (const k of SPLIT_KEYS) {
    const s = asSplit(v[k]);
    if (s) out[k] = s;
  }
  return out;
}

/** year_compare（もう一方の年の写真の抽出を、同じ参照・同じ設定で測った値）。無い・形が違う・同じ年なら null */
export function getYearCompare(m: MetricsResponse): YearCompare | null {
  const yc = m.year_compare;
  if (!isObj(yc) || !isNum(yc.compare_year) || !isObj(yc.by_year)) return null;
  const baseYear = evalYearOf(m);
  const compareYear = yc.compare_year;
  if (compareYear === baseYear) return null;
  const otherRaw = yc.by_year[String(compareYear)];
  if (!isObj(otherRaw)) return null;
  const other = splitMapOf(otherRaw);
  if (Object.keys(other).length === 0) return null;
  // 評価した年の側は、トップレベルの tune・holdout・overall と同じ値（無ければ by_year から）
  const baseFromYear = splitMapOf(yc.by_year[String(baseYear)]);
  const base: SplitMap = {};
  for (const k of SPLIT_KEYS) {
    const s = asSplit(m[k]) ?? baseFromYear[k];
    if (s) base[k] = s;
  }
  const setting = isObj(yc.setting) ? yc.setting : {};
  return {
    baseYear,
    compareYear,
    setting: { scale: isNum(setting.scale) ? setting.scale : undefined, threshold: isNum(setting.threshold) ? setting.threshold : undefined },
    base,
    other,
  };
}

// ---- 縁で外した数 ----

export interface EdgeCount {
  reference: number;
  prediction: number;
  /** 内訳（縁に接する数・重なりで外した数）。eval.json の excluded_edge_detail があるときだけ */
  detail?: { refTouch: number; refOverlap: number; predTouch: number; predOverlap: number };
}

function edgeCountOf(v: unknown): EdgeCount | undefined {
  if (!isObj(v) || !isNum(v.reference) || !isNum(v.prediction)) return undefined;
  return { reference: v.reference, prediction: v.prediction };
}

function edgeDetailOf(v: unknown): EdgeCount['detail'] {
  if (!isObj(v) || !isObj(v.reference) || !isObj(v.prediction)) return undefined;
  const { touching_edge: refTouch, overlapping_excluded_prediction: refOverlap } = v.reference;
  const { touching_edge: predTouch, overlapping_excluded_reference: predOverlap } = v.prediction;
  if (!isNum(refTouch) || !isNum(refOverlap) || !isNum(predTouch) || !isNum(predOverlap)) return undefined;
  return { refTouch, refOverlap, predTouch, predOverlap };
}

export interface EdgeExcluded {
  /** 12 地区の合計（excluded_edge_objects） */
  total?: EdgeCount;
  /** excluded_edge_objects が数 1 つのとき（参照・予測の区別が無い古い形） */
  totalNumber?: number;
  tune?: EdgeCount;
  holdout?: EdgeCount;
  /** 縁の除外の重なりの下限（0〜1）。新しい規則（反対側の物体も外す）が使われているときだけ */
  overlapMin?: number;
}

export function getEdgeExcluded(m: MetricsResponse): EdgeExcluded {
  const bySplit = isObj(m.excluded_edge_by_split) ? m.excluded_edge_by_split : {};
  const detail = isObj(m.excluded_edge_detail) ? m.excluded_edge_detail : {};
  const withDetail = (key: SplitKey, count: EdgeCount | undefined): EdgeCount | undefined => {
    if (!count) return undefined;
    const d = edgeDetailOf(detail[key]);
    return d ? { ...count, detail: d } : count;
  };
  const total = edgeCountOf(m.excluded_edge_objects);
  const protocol = isObj(m.protocol) ? m.protocol : {};
  const hasRule = isNum(protocol.edge_overlap_min) || isObj(m.excluded_edge_detail);
  return {
    total: withDetail('overall', total),
    totalNumber: isNum(m.excluded_edge_objects) ? m.excluded_edge_objects : undefined,
    tune: withDetail('tune', edgeCountOf(bySplit.tune)),
    holdout: withDetail('holdout', edgeCountOf(bySplit.holdout)),
    overlapMin: hasRule ? (isNum(protocol.edge_overlap_min) ? protocol.edge_overlap_min : 0.5) : undefined,
  };
}

// ---- 2014 年の抽出が何も見ていない既存の建物（existing_absent_in_2014） ----

export interface AbsentStats {
  n: number;
  absent: number;
  present?: number;
  /** 判定に使った面積の下限（m²）。params.min_area_m2 */
  minAreaM2?: number;
}

export function getAbsentStats(m: MetricsResponse, split: SplitKey = 'overall'): AbsentStats | null {
  const e = m.existing_absent_in_2014;
  if (!isObj(e)) return null;
  const s = e[split];
  if (!isObj(s) || !isNum(s.n_buildings) || !isNum(s.absent)) return null;
  if (s.n_buildings <= 0 || s.absent < 0 || s.absent > s.n_buildings) return null;
  const present = isNum(s.present) && s.present >= 0 && s.present <= s.n_buildings ? s.present : undefined;
  const params = isObj(e.params) ? e.params : {};
  return { n: s.n_buildings, absent: s.absent, present, minAreaM2: isNum(params.min_area_m2) ? params.min_area_m2 : undefined };
}

/** 0〜1 の割合を「約 ◯ 割」で言う。1 割に満たなければ「1 割未満」、9.5 割以上は「ほぼ全て」 */
export function formatTenths(share: number): string {
  const tenths = Math.round(share * 10);
  if (tenths <= 0) return '1 割未満';
  if (tenths >= 10) return 'ほぼ全て';
  return `約 ${tenths} 割`;
}

// ---- 倍率・閾値の選択の根拠 ----

export interface MatchBasis {
  tp: number;
  nRef: number;
  nPred?: number;
}

/** 物体単位 F1 の根拠の件数（一致 tp・縁を除く参照の数 n_ref）。無ければ null */
export function matchBasis(split: SplitMetrics | undefined): MatchBasis | null {
  const tp = metricValue(split, 'object', 'tp');
  const nRef = metricValue(split, 'object', 'n_ref');
  if (tp === undefined || nRef === undefined) return null;
  return { tp, nRef, nPred: metricValue(split, 'object', 'n_pred') };
}

/** 選んだ組の調整用 F1 と、次に高い組の F1。比べる組が無い・値が無ければ null */
export function chosenVsRunnerUp(m: MetricsResponse): { chosen: number; runnerUp: number } | null {
  const sweep = m.sweep;
  const chosen = m.chosen;
  if (!Array.isArray(sweep) || !chosen) return null;
  let chosenF1: number | undefined;
  let runnerUp: number | undefined;
  for (const r of sweep) {
    if (!isObj(r) || !isNum(r.tune_object_f1)) continue;
    if (r.scale === chosen.scale && r.threshold === chosen.threshold) chosenF1 = r.tune_object_f1;
    else runnerUp = runnerUp === undefined ? r.tune_object_f1 : Math.max(runnerUp, r.tune_object_f1);
  }
  return chosenF1 === undefined || runnerUp === undefined ? null : { chosen: chosenF1, runnerUp };
}

// ---- 画素単位の「升目」 ----

/** 画素単位の TP・FP・FN の数え方。倍率 s の格子は、写真の 1 画素を s×s に分けた升目 */
export function gridNote(scale: number | undefined, fmt: (n: number) => string): string {
  if (!isNum(scale) || scale <= 0) {
    return '画素単位の一致・余分・見逃しは、選んだ倍率の格子の升目の数です（物体の数ではありません）。';
  }
  return `画素単位の一致・余分・見逃しは、倍率 ${fmt(scale)} の格子の升目の数です（物体の数ではありません）。1 升は一辺が約 ${fmt(PHOTO_PIXEL_M / scale)} m で、写真の 1 画素の ${fmt(scale * scale)} 分の 1 の面積です。`;
}
