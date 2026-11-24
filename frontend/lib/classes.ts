import type { CandidateClass, CandidateReason, RefusalReason } from './api-types';

// 名前に「確定」を使わない（仕様 §5）。色だけに頼らず、線種（dash）と形（shape）でも区別する。
export interface ClassInfo {
  label: string;
  short: string;
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
    label: '新規出現（旧写真に無い）',
    short: '新規出現',
    color: '#C2410C',
    dash: undefined,
    shape: 'circle',
    fillOpacity: 0.38,
    summary: '2023 年の写真に建物があり、2018 年の写真には見当たりません。',
    description:
      '2023 年の写真から建物らしい塊が見つかり、建物データ（基盤地図情報 2018 年 10 月版）には載っていません。2018 年の写真のモデルの結果でも、同じ場所に何も見つかっていません。新築の可能性がありますが、写真だけでは断定できないため「候補」と呼びます。',
  },
  existing_omission: {
    label: '既存の描き漏れ（旧写真に既にある）',
    short: '既存の描き漏れ',
    color: '#1D5FD1',
    dash: '7 5',
    shape: 'square',
    fillOpacity: 0.2,
    summary: '2018 年の写真にも既に写っています。',
    description:
      '建物データには載っていませんが、2018 年の写真にも既に同じ建物が写っています。新築ではなく、建物データの描き漏れの可能性が高い候補です。モデルが両方の年で同じ誤検出をしている場合も、ここに入ります。',
  },
  uncertain: {
    label: '判定保留',
    short: '判定保留',
    color: '#7C3AED',
    dash: '1.5 5',
    shape: 'triangle',
    fillOpacity: 0.1,
    summary: '新規か既存かを、写真から判断できませんでした。',
    description:
      '2018 年の写真に一部だけ重なっている、またはタイルの縁に接していて切れた建物かもしれない、などの理由で、新規か既存かを決められなかった候補です。目で確かめてください。',
  },
};

export const CLASS_ORDER: CandidateClass[] = ['confirmed_new', 'existing_omission', 'uncertain'];

export function isCandidateClass(value: unknown): value is CandidateClass {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CLASS_INFO, value);
}

export const REASON_TEXT: Record<CandidateReason, string> = {
  new_absent_2018: '2018 年の写真のモデルが、この範囲に建物をほとんど見ていません（旧写真に無い）。',
  present_2018: '2018 年の写真のモデルが、この範囲の半分以上を建物として見ています（旧写真に既にある）。',
  ambiguous: '2018 年の写真の結果が、新規とも既存とも言い切れない中間でした。',
  edge: 'タイルの縁に接しているため、切れた建物の可能性があり、判定を保留しました。',
  small: '面積が小さい（20 m² 未満）ため、判定の対象から外す基準に近い候補です。',
};

export function reasonText(reason: string | undefined): string | null {
  if (!reason) return null;
  return Object.prototype.hasOwnProperty.call(REASON_TEXT, reason) ? REASON_TEXT[reason as CandidateReason] : null;
}

// 根拠の数字（evidence）の表示名と読み方。ratio は 0〜1 を % で、prob は確率として出す
export const EVIDENCE_FIELDS = [
  { key: 'prob_2023_mean', label: '2023 年の建物らしさ（平均）', kind: 'prob', hint: '高いほど、2023 年の写真で建物らしい' },
  { key: 'ov_2018', label: '2018 年の抽出が覆う割合', kind: 'ratio', hint: '0.5 以上なら「旧写真に既にある」側' },
  { key: 'prob_2018_p90', label: '2018 年の建物らしさ（上位 10% の値）', kind: 'prob', hint: '低いほど、2018 年の写真で何も見えていない' },
  { key: 'ov_kiban', label: '建物データが覆う割合', kind: 'ratio', hint: '基盤地図情報（2018 年 10 月版）に載っている割合' },
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
