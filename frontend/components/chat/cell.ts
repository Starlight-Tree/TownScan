import type { CandidateClass, TableCell } from '../../lib/api-types';
import { CLASS_INFO, CLASS_ORDER } from '../../lib/classes';

/**
 * 表の「分類」の列の値から、分類を引く。API の一覧は分類のキー（confirmed_new）でなく、表示名（「新規出現（旧写真に無い）」）を返す
 * （backend の list_candidates）。どちらでも、短い名前（「新規出現」）でも同じ分類として扱い、印つきの短い名前で出せるようにする。
 * 知らない値は null（そのまま文字で出す）
 */
export function classOfCell(value: TableCell | undefined): CandidateClass | null {
  if (typeof value !== 'string') return null;
  return CLASS_ORDER.find((cls) => cls === value || CLASS_INFO[cls].label === value || CLASS_INFO[cls].short === value) ?? null;
}
