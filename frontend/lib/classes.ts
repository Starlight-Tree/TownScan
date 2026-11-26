import type { CandidateClass, CandidateReason, RefusalReason } from './api-types';

// 名前に「確定」を使わない（仕様 §5）。色だけに頼らず、線種（dash）と形（shape）でも区別する。
export interface ClassInfo {
  label: string;
  short: string;
  /** 色の CSS 変数の名前。値は app/globals.css にだけある（ライト・ダークで違う。TS には色を書かない） */
  cssVar: string;
  /** CSS・SVG の style に渡す参照（`var(--class-new)`）。地図の線は、lib/theme-colors.ts の readCssColor(cssVar) で実際の値を読む */
  color: string;
  /** SVG の stroke-dasharray。undefined は実線 */
  dash: string | undefined;
  shape: 'circle' | 'square' | 'triangle';
  fillOpacity: number;
  summary: string;
  description: string;
}

export const CLASS_INFO: Record<CandidateClass, ClassInfo> = {
  confirmed_new: {
    label: '2014 年は未検出',
    short: '2014 年は未検出',
    cssVar: '--class-new',
    color: 'var(--class-new)',
    dash: undefined,
    shape: 'circle',
    fillOpacity: 0.38,
    summary: '2024 年の写真で建物を検出し、2014 年の写真では検出していません。',
    description:
      '2024 年の写真から建物らしい塊が見つかり、2014 年の写真のモデルの結果では、同じ場所に建物が見つかっていません。新しく建った可能性もありますが、2014 年の写真の見落としで、前からある建物も混ざります。写真で確かめてください。',
  },
  existing_omission: {
    label: '2014 年も検出',
    short: '2014 年も検出',
    cssVar: '--class-omit',
    color: 'var(--class-omit)',
    dash: '7 5',
    shape: 'square',
    fillOpacity: 0.2,
    summary: '2014 年の写真でも、建物を検出しています。',
    description:
      '2014 年の写真でも同じ場所に建物を検出しています。この解析では、もとからある建物として候補にしていません。',
  },
  uncertain: {
    label: '未判定',
    short: '未判定',
    cssVar: '--class-unc',
    color: 'var(--class-unc)',
    dash: '1.5 5',
    shape: 'triangle',
    fillOpacity: 0.1,
    summary: '写真の端で切れているもの（端のため未判定）と、どちらとも言えないもの（要確認）です。',
    description:
      '2024 年の写真で建物らしい塊が見つかりましたが、2014 年の写真で検出したかどうかを分けていない候補です。目で確かめてください。',
  },
};

// 画面に出す分類。「2014 年も検出」（existing_omission）は、この解析では候補にしていないので出さない（ADR 0015）
export const CLASS_ORDER: CandidateClass[] = ['confirmed_new', 'uncertain'];

/** 未判定の候補は、理由で呼び分ける（API の chat/results.go の heldLabels と同じ） */
export const HELD_LABELS: Partial<Record<CandidateReason, string>> = {
  ambiguous: '要確認',
  edge: '端のため未判定',
};

/** 候補 1 件の呼び名。未判定で理由が分かるときは、理由の呼び名。分からないときは分類の短い名前 */
export function classText(cls: CandidateClass, reason?: string): string {
  const held = cls === 'uncertain' && reason ? HELD_LABELS[reason as CandidateReason] : undefined;
  return held ?? CLASS_INFO[cls].short;
}

export function isCandidateClass(value: unknown): value is CandidateClass {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CLASS_INFO, value);
}

export const REASON_TEXT: Record<CandidateReason, string> = {
  new_absent_2014: '2014 年の写真のモデルが、この範囲に建物をほとんど見ていません。',
  present_2014: '2014 年の写真のモデルが、この範囲の半分以上を建物として見ています。',
  ambiguous: '2014 年の写真の結果が中間で、検出したともしていないとも言えません。',
  edge: '写真（タイル）の端に接していて建物が切れている可能性があるため、分けていません。面積は実際より小さい場合があります。',
  small: '面積が小さい（20 m² 未満）ため、判定の対象から外す基準に近い候補です。',
};

export function reasonText(reason: string | undefined): string | null {
  if (!reason) return null;
  return Object.prototype.hasOwnProperty.call(REASON_TEXT, reason) ? REASON_TEXT[reason as CandidateReason] : null;
}

// 根拠の数字（evidence）の表示名と読み方。ratio は 0〜1 を % で、prob は確率として出す
export const EVIDENCE_FIELDS = [
  { key: 'prob_2024_mean', label: '2024 年の建物らしさ（平均）', kind: 'prob', hint: '高いほど、2024 年の写真で建物らしい' },
  { key: 'ov_2014', label: '2014 年の抽出が覆う割合', kind: 'ratio', hint: '0.5 以上なら、2014 年の写真にもある建物（候補にしない）' },
  { key: 'prob_2014_p90', label: '2014 年の建物らしさ（上位 10% の値）', kind: 'prob', hint: '低いほど、2014 年の写真で何も見えていない' },
  { key: 'edge_touch', label: 'タイルの縁に接する', kind: 'bool', hint: '切れた建物の可能性' },
] as const;

export const REFUSAL_TITLE: Record<RefusalReason, string> = {
  out_of_scope: 'この質問は範囲外です',
  no_photo_period: 'この期間の写真がありません',
  not_implemented: 'まだ実装していない機能です',
  no_data: '該当するデータがありません',
};

export function refusalTitle(reason: string): string {
  return Object.prototype.hasOwnProperty.call(REFUSAL_TITLE, reason) ? REFUSAL_TITLE[reason as RefusalReason] : 'お答えできません';
}
