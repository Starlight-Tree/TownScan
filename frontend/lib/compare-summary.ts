import type { CandidateClass, CompareResult } from './api-types';
import { CLASS_INFO, isCandidateClass } from './classes';
import { formatNumber } from './format';

/**
 * 比較（compare）の結果の要点。画面が、結果の数字だけから作る。ふだん出すのは全体の合計（sub。回答の中のグラフに無い数字）で、
 * 最も多い地区（lead）は、合計が 0 のときと、グラフが出ない回答（別の解析結果）で出す。数字は結果の値を足すだけで、推測しない。
 */
export interface CompareSummary {
  /** 最も多い地区。並びの基準の分類があれば、その分類で */
  lead: string;
  /** 全地区の合計。合計が 0 のときは無し */
  sub: string | null;
}

const finite = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** 最も多い地区の名前（同数が複数なら、3 つまで並べ、それより多ければ「ほか N 地区」） */
function topNames(names: string[]): string {
  if (names.length <= 3) return names.join('・');
  return `${names.slice(0, 2).join('・')}ほか ${names.length - 2} 地区`;
}

export function compareSummary(result: CompareResult): CompareSummary | null {
  const items = Array.isArray(result.items) ? result.items : [];
  if (items.length === 0) return null;

  // 並びの基準の分類（backend は、分類を指定したときはその分類の件数で並べる。filter.cls）
  const sortCls: CandidateClass | null = isCandidateClass(result.filter?.cls) ? result.filter.cls : null;
  const perItem = items.map((item) => {
    const counts = item.counts && typeof item.counts === 'object' ? item.counts : {};
    const byClass = {
      confirmed_new: finite(counts.confirmed_new),
      existing_omission: finite(counts.existing_omission),
      uncertain: finite(counts.uncertain),
    } satisfies Record<CandidateClass, number>;
    const classSum = byClass.confirmed_new + byClass.existing_omission + byClass.uncertain;
    // 合計が結果にあればそれを使う。無ければ 3 分類の和
    const total = typeof counts.total === 'number' && Number.isFinite(counts.total) ? counts.total : classSum;
    const name = typeof item.name === 'string' && item.name !== '' ? item.name : String(item.area_id);
    return { name, byClass, total };
  });

  const basis = (p: (typeof perItem)[number]) => (sortCls ? p.byClass[sortCls] : p.total);
  const max = Math.max(...perItem.map(basis));
  const subject = sortCls ? `${CLASS_INFO[sortCls].short}の候補` : '候補';

  if (max <= 0) {
    return { lead: `どの地区にも、${subject}はありません。`, sub: null };
  }

  const names = topNames(perItem.filter((p) => basis(p) === max).map((p) => p.name));
  const lead = `${subject}が最も多いのは${names}で、${formatNumber(max)} 件です。`;

  const sum = perItem.reduce((acc, p) => acc + p.total, 0);
  if (sum <= 0) return { lead, sub: null };
  const sub = `全 ${formatNumber(items.length)} 地区の合計は ${formatNumber(sum)} 件。`;
  return { lead, sub };
}
