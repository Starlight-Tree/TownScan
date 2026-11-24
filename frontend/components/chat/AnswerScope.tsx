'use client';

import type { CandidateClass, ToolResult } from '../../lib/api-types';
import { useAreas } from '../../lib/areas-context';
import { CLASS_INFO, isCandidateClass } from '../../lib/classes';
import { areaLabel, filterFromResults, isWellFormedResult } from '../../lib/result-view';
import { ClassBadge } from '../ClassBadge';
import { areaScopeHint } from './area-scale';

/** 「対象・条件」の行の 1 項目。text は値、cls があれば分類の印つきで出す */
export interface ScopeItem {
  key: 'area' | 'class' | 'compare' | 'years';
  label: string;
  text: string;
  cls?: CandidateClass;
}

/** 比べる地区が多いとき、行に並べる名前の数。残りは「ほか N 地区」にまとめる（全部は、すぐ下の比較の表にある） */
const MAX_COMPARE_NAMES = 4;
const SHOWN_WHEN_TRUNCATED = 3;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

// 画面は、API の形が少し違っても壊れない作りにしている（ResultCard と同じ）。この行は添え物なので、壊れた結果（isWellFormedResult）は黙って飛ばす。
// 右の絞り込み（HomeClient）も同じ前処理で飛ばす。そうしないと、壊れた count を、こちらは飛ばし、右は「全地区・全分類」と読んで、食い違う

function finiteYears(v: unknown): number[] {
  return Array.isArray(v) ? v.filter((y): y is number => typeof y === 'number' && Number.isFinite(y)) : [];
}

function classText(cls: string): string {
  return isCandidateClass(cls) ? CLASS_INFO[cls].label : cls;
}

/**
 * 回答の道具の結果に入っている値だけから、対象・条件の項目を作る。LLM の文章や推測は使わない。
 * - 地区・分類の行は、右の地図・グラフに反映する条件（filterFromResults）と同じ「最後の件数（count）か比較（compare）」から作る。
 *   1 回答に両方あっても、右の絞り込みと食い違わない（先に件数、あとに比較なら、比較の条件）。
 *   - 地区: その結果の filter から、filterFromResults をそのまま使う（複数の地区は、API の scope をそのまま。scope が無ければ「N 地区」。地区の条件が無ければ「すべて」）
 *   - 分類: 最後が count のときだけ。結果の値のまま（未知の分類もそのまま出す）。compare には出さない: 比較のカードは 3 分類と合計を並べ、filter.cls は並べ替えの分類にすぎない
 * - compare: 比べる地区の名前（結果の items の name）も、別の行に出す
 * - 写真の年: count・compare は provenance.photo_years、detection_image は images の year
 * 表・地図の表示・精度・お断りは、条件を持たない（結果に値が無い）ので、項目を出さない。
 */
export function answerScope(results: readonly unknown[], nameOf: (areaId: string) => string): ScopeItem[] {
  const valid = results.filter(isWellFormedResult);
  const items: ScopeItem[] = [];

  // 地区・分類の行は、右の絞り込みと同じ「最後の件数・比較」から作る（先の件数の条件を、あとの比較が置き換えたなら、比較の条件）
  const last = [...valid].reverse().find((r) => r.type === 'count' || r.type === 'compare');
  const filter = filterFromResults(valid);
  if (filter && last) {
    items.push({ key: 'area', label: '地区', text: areaLabel(filter, nameOf) ?? 'すべて' });
    // 分類は、件数のときだけ。条件が空の件数は、全分類。結果の値をそのまま見る（filterFromResults は未知の分類を「すべて」に直すので、ここでは使わない）
    if (last.type === 'count') {
      // API の値は型より緩い（未知の文字列）ので unknown で受ける
      const cls: unknown = last.filter?.cls;
      if (typeof cls === 'string' && cls !== '') {
        items.push({ key: 'class', label: '分類', text: classText(cls), cls: isCandidateClass(cls) ? cls : undefined });
      } else {
        items.push({ key: 'class', label: '分類', text: 'すべて' });
      }
    }
  }

  const names: string[] = [];
  for (const r of valid) {
    if (r.type !== 'compare' || !Array.isArray(r.items)) continue;
    for (const item of r.items) {
      if (!isRecord(item)) continue;
      const name = typeof item.name === 'string' && item.name !== '' ? item.name : typeof item.area_id === 'string' ? nameOf(item.area_id) : '';
      if (name && !names.includes(name)) names.push(name);
    }
  }
  if (names.length > 0) {
    const text =
      names.length <= MAX_COMPARE_NAMES
        ? names.join('、')
        : `${names.slice(0, SHOWN_WHEN_TRUNCATED).join('、')} ほか ${names.length - SHOWN_WHEN_TRUNCATED} 地区`;
    items.push({ key: 'compare', label: '比べる地区', text });
  }

  const years = new Set<number>();
  for (const r of valid) {
    if (r.type === 'count' || r.type === 'compare') {
      for (const y of finiteYears(isRecord(r.provenance) ? r.provenance.photo_years : undefined)) years.add(y);
    } else if (r.type === 'detection_image' && Array.isArray(r.images)) {
      for (const img of r.images) if (isRecord(img)) for (const y of finiteYears([img.year])) years.add(y);
    }
  }
  if (years.size > 0) {
    items.push({ key: 'years', label: '写真の年', text: `${[...years].sort((a, b) => a - b).join('・')} 年` });
  }

  return items;
}

/**
 * 「地区」の値に添える、範囲の説明（「解析した 3 地区・各約 130 m 四方」など）。地区が、丁目や区の全体ではなく、小さなタイル 1 枚であることを示す。
 * 地区の行と同じ条件（最後の count・compare。answerScope と同じ）から作る。地区の行が無い回答には null。
 * totalAreas は、解析した地区の総数（地区の一覧から。分からなければ 0。条件が「すべて」のときに使う）
 */
export function answerAreaHint(results: readonly unknown[], totalAreas: number): string | null {
  const filter = filterFromResults(results.filter(isWellFormedResult));
  return filter ? areaScopeHint(filter, totalAreas) : null;
}

/** 回答の「対象・条件」の行。出せる値が無い回答（表・精度・お断りなど）には何も出さない */
export function AnswerScope({ results }: { results: readonly ToolResult[] }) {
  const { nameOf, areas } = useAreas();
  const items = answerScope(results, nameOf);
  const areaHint = answerAreaHint(results, areas.length);
  if (items.length === 0) return null;
  return (
    <div className="answer-scope" role="group" aria-label="この回答の対象・条件">
      <dl className="answer-scope__list">
        {items.map((item) => (
          <div key={item.key} className="answer-scope__item" data-scope={item.key}>
            <dt className="answer-scope__label">{item.label}</dt>
            <dd className="answer-scope__value">
              {item.cls ? <ClassBadge cls={item.cls} /> : item.text}
              {item.key === 'area' && areaHint && <span className="answer-scope__hint">（{areaHint}）</span>}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
