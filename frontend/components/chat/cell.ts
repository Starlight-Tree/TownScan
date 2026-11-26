import type { CandidateClass, TableCell } from '../../lib/api-types';
import { CLASS_INFO, CLASS_ORDER, HELD_LABELS } from '../../lib/classes';

/** 表の「分類」の列が理由の呼び名（「要確認」など）のとき、その理由 */
export function reasonOfCell(value: TableCell | undefined): string | undefined {
  return Object.entries(HELD_LABELS).find(([, label]) => label === value)?.[0];
}

/**
 * 表の「分類」の列の値から、分類を引く。API の一覧は分類のキー（confirmed_new）でなく、表示名（「2018 年は未検出」。未判定は理由の呼び名）を返す
 * （backend の list_candidates）。どちらでも、同じ分類として扱い、印つきの短い名前で出せるようにする。
 * 知らない値は null（そのまま文字で出す）
 */
export function classOfCell(value: TableCell | undefined): CandidateClass | null {
  if (typeof value !== 'string') return null;
  if (reasonOfCell(value)) return 'uncertain';
  return CLASS_ORDER.find((cls) => cls === value || CLASS_INFO[cls].label === value || CLASS_INFO[cls].short === value) ?? null;
}
