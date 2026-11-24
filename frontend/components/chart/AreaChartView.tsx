'use client';

import { useId, type CSSProperties } from 'react';
import type { AreaSummary, CandidateClass } from '../../lib/api-types';
import { CLASS_INFO, CLASS_ORDER } from '../../lib/classes';
import { formatNumber } from '../../lib/format';
import { areaScopeIds, type MapFilter } from '../../lib/result-view';
import { ClassSwatch } from '../ClassBadge';
import { buildRows, multiAreaName, type AreaRow } from './area-stats';

interface Props {
  areas: AreaSummary[];
  /**
   * 地図・チャットと共有する絞り込み（地区・分類）。行を選ぶと地区の絞り込みを、凡例を押すと分類の絞り込みを変える。
   * 複数の地区（区など。areaIds）の条件のときは、その地区の行だけを出し、行を押すと 1 つの地区に絞り直す
   */
  filter: MapFilter;
  onFilterChange: (next: MapFilter) => void;
}

/** 行を読み上げる文。色や棒の長さを見られない人にも、地区名と 3 分類の件数が伝わるようにする */
function rowLabel(row: AreaRow, classes: ReadonlySet<CandidateClass>): string {
  const parts = CLASS_ORDER.map(
    (c) => `${CLASS_INFO[c].short} ${formatNumber(row.byClass[c])} 件${classes.has(c) ? '' : '（グラフには出していません）'}`,
  );
  return `${row.area.name}（${row.area.ward}）、${parts.join('、')}、合計 ${formatNumber(row.total)} 件`;
}

/**
 * 右の結果領域の「グラフ」画面。地区ごとの件数を、分類で積み上げた横棒で見せる。
 * 棒は HTML と CSS だけで描く（幅は、表示している行のうち最大の合計に対する割合）。
 * 分類は色だけでなく、棒の縁の線（実線・破線・点線）と塗りの模様でも区別する（lib/classes.ts の方針）。
 */
export function AreaChartView({ areas, filter, onFilterChange }: Props) {
  const { classes, areaId } = filter;
  const titleId = useId();
  const shown = CLASS_ORDER.filter((c) => classes.has(c));
  // 複数の地区（区など）の条件のときだけ、行をその地区に限る。単一の地区は、全行を出して、選んだ行を目立たせる（押し直すと戻せる）
  const multiName = multiAreaName(filter);
  const multiIds = multiName === null ? null : areaScopeIds(filter);
  const rows = buildRows(areas, classes).filter((r) => multiIds === null || multiIds.has(r.area.id));
  const scale = Math.max(1, ...rows.map((r) => Math.max(r.total, r.stack)));
  const empty = areas.length === 0;

  // 複数の地区の条件（areaIds・scope）は、1 つの地区を選んだ時点で消す（フィルターを丸ごと写さない）
  const selectArea = (id: string) => onFilterChange({ areaId: areaId === id ? '' : id, classes });
  const toggleClass = (c: CandidateClass) => {
    const next = new Set(classes);
    if (next.has(c)) next.delete(c);
    else next.add(c);
    onFilterChange({ ...filter, classes: next });
  };

  return (
    // 外側の tabpanel は「グラフ」。ここは見出しの名前（「地区ごとの件数」）で、重ならない名前にする。
    // 地区が 0 件のときは、パネルにフォーカスできる中身が無いので、枠自身をフォーカスできるようにする（キーボードで、読み上げの対象にたどり着ける）
    <section
      className="chart-view area-chart"
      data-areas={areas.length}
      aria-labelledby={titleId}
      tabIndex={empty ? 0 : undefined}
    >
      <header className="area-chart__head">
        <h2 id={titleId} className="area-chart__title">
          地区ごとの件数
        </h2>
        {multiName !== null && (
          <p className="area-chart__scope">
            <span className="area-chart__scope-key">対象:</span> <strong>{multiName}</strong>
          </p>
        )}
        <p className="area-chart__hint">合計の多い順です。行を押すとその地区に絞り込み、もう一度押すと全地区に戻ります。</p>
      </header>

      {empty ? (
        <p className="empty-note" role="status">
          表示できる地区がありません
        </p>
      ) : (
        <>
          <div className="area-chart__legend" role="group" aria-label="グラフに出す分類（押すと切り替え。地図・集計の帯にも、同じ分類が効きます）">
            {CLASS_ORDER.map((c) => (
              <button key={c} type="button" className="area-chart__legend-btn" aria-pressed={classes.has(c)} onClick={() => toggleClass(c)}>
                <ClassSwatch cls={c} size={16} />
                <span>{CLASS_INFO[c].short}</span>
              </button>
            ))}
          </div>

          {shown.length === 0 ? (
            <p className="empty-note" role="status">
              表示する分類がありません
            </p>
          ) : (
            <>
              <ol className="area-chart__rows">
                {rows.map((row) => {
                  const selected = row.area.id === areaId;
                  return (
                    <li key={row.area.id}>
                      <button
                        type="button"
                        className="area-chart__row"
                        aria-pressed={selected}
                        aria-label={rowLabel(row, classes)}
                        onClick={() => selectArea(row.area.id)}
                      >
                        <span className="area-chart__name">
                          {row.area.name}
                          <span className="area-chart__ward">（{row.area.ward}）</span>
                        </span>
                        <span className="area-chart__bar" aria-hidden="true">
                          {shown.map((c) =>
                            row.byClass[c] > 0 ? (
                              <span
                                key={c}
                                className="area-chart__seg"
                                data-class={c}
                                style={{ width: `${(row.byClass[c] * 100) / scale}%`, '--c': CLASS_INFO[c].color } as CSSProperties}
                              />
                            ) : null,
                          )}
                        </span>
                        <span className="area-chart__total">
                          <strong>{formatNumber(row.total)}</strong> 件
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>

              <details className="area-chart__details">
                <summary>表で見る</summary>
                <div className="table-scroll" role="region" aria-label="地区ごとの件数の表（横にスクロールできます）" tabIndex={0}>
                  <table className="data-table">
                    <caption>地区ごとの件数（合計の多い順）</caption>
                    <thead>
                      <tr>
                        <th scope="col">地区</th>
                        <th scope="col">区</th>
                        {shown.map((c) => (
                          <th key={c} scope="col" className="is-num">
                            {CLASS_INFO[c].short}
                          </th>
                        ))}
                        <th scope="col" className="is-num">
                          合計
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr key={row.area.id} className={row.area.id === areaId ? 'is-chosen' : undefined}>
                          <th scope="row">{row.area.name}</th>
                          <td>{row.area.ward}</td>
                          {shown.map((c) => (
                            <td key={c} className="is-num">
                              {formatNumber(row.byClass[c])}
                            </td>
                          ))}
                          <td className="is-num">{formatNumber(row.total)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </>
          )}
        </>
      )}
    </section>
  );
}
