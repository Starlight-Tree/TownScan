'use client';

import { useRef } from 'react';
import type { AreaSummary, CandidateClass } from '../../lib/api-types';
import { CLASS_INFO, CLASS_ORDER } from '../../lib/classes';
import { formatNumber } from '../../lib/format';
import { ALL_FILTER, areaScopeIds, isAllFilter, type MapFilter } from '../../lib/result-view';
import { allClassesShown, multiAreaName, sumCounts, sumShown } from '../chart/area-stats';
import { ClassSwatch } from '../ClassBadge';

interface Props {
  areas: AreaSummary[];
  /** 地図・グラフ・チャットと共有する絞り込み。地区があればその地区（複数なら、それらの和）だけの件数を出す */
  filter: MapFilter;
  onFilterChange: (next: MapFilter) => void;
}

/**
 * 地図の上の集計の帯。「対象 | 新規出現 n | 既存の描き漏れ n | 判定保留 n」を、質問しなくても常に見せる。
 * 分類ごとの件数は、そのまま表示の切り替え（チェックボックス）を兼ねる。地図に重ねる凡例をやめ、
 * 同じ内容（分類の印・名前・件数）を 2 か所に出さないため。押すと filter.classes だけを切り替え、地区・複数の地区の条件は保つ。
 * 数字は /api/areas の counts を足したもの（推測しない）。分類の一部だけを表示しているときは、
 * 3 分類の数字は「対象の全体」のまま、表示中の件数との差を別の行で言う（全体と絞り込み後を取り違えないように）。
 */
export function SummaryStrip({ areas, filter, onFilterChange }: Props) {
  const { areaId, classes } = filter;
  const sums = sumCounts(areas, areaScopeIds(filter));
  const area = areaId === '' ? null : areas.find((a) => a.id === areaId);
  // 複数の地区（区など）なら、API の表示用の名前（無ければ「N 地区」）。名前は作らない
  const multiName = multiAreaName(filter);
  // 対象の地区が一覧に無い（一覧が届く前・知らない地区の条件）ときは、数字を作らず「—」を出す
  const target =
    multiName ??
    (areaId === '' ? (areas.length === 0 ? '地区の情報がありません' : `全 ${formatNumber(areas.length)} 地区`) : (area?.name ?? areaId));
  const num = (n: number) => (sums.found ? formatNumber(n) : '—');
  const partial = !allClassesShown(classes);
  // 「条件を解除」を押すと、そのボタン自身が消える。フォーカスが <body> へ落ちないよう、帯の見出し（対象）へ移す
  const targetRef = useRef<HTMLParagraphElement>(null);

  const toggleClass = (c: CandidateClass) => {
    const next = new Set(classes);
    if (next.has(c)) next.delete(c);
    else next.add(c);
    // areaId・areaIds・scope は、いまの条件のまま（分類だけを替える）
    onFilterChange({ ...filter, classes: next });
  };

  return (
    <div className="summary-strip" role="group" aria-label="件数の集計">
      <p className="summary-strip__target" ref={targetRef} tabIndex={-1}>
        <span className="summary-strip__key">対象</span>
        <strong>{target}</strong>
      </p>
      <div role="group" aria-label="表示する分類（色・線・形で区別）">
        <ul className="summary-strip__counts">
          {CLASS_ORDER.map((c) => {
            const on = classes.has(c);
            return (
              <li key={c} data-class={c} data-shown={on}>
                {/* 見た目の名前は短く（全文は title）。選んでいるかは、色だけでなく、チェックの印と枠の太さで見分ける（globals.css）。
                    読み上げの名前は、分類の全文と件数（見えている文字「新規出現」「9」を含む） */}
                <label className="summary-strip__opt" title={CLASS_INFO[c].label}>
                  <input
                    type="checkbox"
                    checked={on}
                    aria-label={`${CLASS_INFO[c].label}、${sums.found ? `${formatNumber(sums.byClass[c])} 件` : '件数不明'}`}
                    onChange={() => toggleClass(c)}
                  />
                  <ClassSwatch cls={c} size={14} />
                  <span className="summary-strip__key">{CLASS_INFO[c].short}</span>
                  <strong>{num(sums.byClass[c])}</strong>
                  {/* チェックが外れていることは、チェックボックスの状態が伝える。読み上げでは重ねない */}
                  {!on && (
                    <span className="summary-strip__off" aria-hidden="true">
                      （非表示）
                    </span>
                  )}
                </label>
              </li>
            );
          })}
        </ul>
      </div>
      {partial && sums.found && (
        <p className="summary-strip__scope">
          全 <strong>{formatNumber(sums.total)}</strong> 件のうち、表示中 <strong>{formatNumber(sumShown(sums.byClass, classes))}</strong> 件
        </p>
      )}
      {!isAllFilter(filter) && (
        <button
          type="button"
          className="btn btn--small summary-strip__reset"
          onClick={() => {
            targetRef.current?.focus();
            onFilterChange(ALL_FILTER);
          }}
        >
          条件を解除
        </button>
      )}
    </div>
  );
}
