'use client';

import { useId, type CSSProperties } from 'react';
import type { AreaSummary, CandidateClass } from '../../lib/api-types';
import { CLASS_INFO, CLASS_ORDER } from '../../lib/classes';
import { formatNumber } from '../../lib/format';
import { areaScopeIds, isAllFilter, type MapFilter } from '../../lib/result-view';
import { ClassSwatch } from '../ClassBadge';
import { allClassesShown, buildRows, multiAreaName, type AreaRow } from './area-stats';

interface Props {
  areas: AreaSummary[];
  /**
   * 地図・チャットと共有する絞り込み（地区・分類）。行を選ぶと地区の絞り込みを、凡例を押すと分類の絞り込みを変える。
   * 複数の地区（区など。areaIds）の条件のときは、その地区の行だけを出し、行を押すと 1 つの地区に絞り直す
   */
  filter: MapFilter;
  onFilterChange: (next: MapFilter) => void;
  /** 地図の画面へ切り替える。渡されたときだけ、絞り込み中に「地図で見る」を出す（グラフの操作は、地図の絞り込みと同じものを替えるため） */
  onShowMap?: () => void;
  /** 回答の中の図として出すとき。分類で分けず 1 色の棒にして、分類の切り替えと「表で見る」を出さない（操作の説明も短くする） */
  inline?: boolean;
}

/**
 * 棒の区間の中に件数を書くか。区間が狭いと数字が欠けるので、棒の長さに対する割合が十分あるときだけ書く
 * （狭いチャットの棒は 140px ほど。1 桁は 10% 以上、2 桁は 18% 以上。書かない区間の数字は、行の右の合計・「表で見る」・ホバーで読める）
 */
export function showSegmentCount(count: number, scale: number): boolean {
  if (count <= 0 || scale <= 0) return false;
  const digits = formatNumber(count).length;
  return count / scale >= 0.1 + 0.08 * (digits - 1);
}

/** 行を読み上げる文。色や棒の長さを見られない人にも、地区名と 3 分類の件数が伝わるようにする */
function rowLabel(row: AreaRow, classes: ReadonlySet<CandidateClass>): string {
  const parts = CLASS_ORDER.map(
    (c) => `${CLASS_INFO[c].short} ${formatNumber(row.byClass[c])} 件${classes.has(c) ? '' : '（グラフには出していません）'}`,
  );
  return `${row.area.name}（${row.area.ward}）、${parts.join('、')}、合計 ${formatNumber(row.total)} 件`;
}

/**
 * 拡大ビューの「グラフ」画面。地区ごとの件数を、分類で積み上げた横棒で見せる。
 * 棒は HTML と CSS だけで描く（幅は、表示している行のうち最大の合計に対する割合）。
 * 分類は色だけでなく、棒の縁の線（実線・破線・点線）と塗りの模様でも区別する（lib/classes.ts の方針）。
 */
export function AreaChartView({ areas, filter, onFilterChange, onShowMap, inline = false }: Props) {
  const { classes, areaId } = filter;
  const titleId = useId();
  const shown = CLASS_ORDER.filter((c) => classes.has(c));
  // 複数の地区（区など）の条件のときだけ、行をその地区に限る。単一の地区は、全行を出して、選んだ行を目立たせる（押し直すと戻せる）
  const multiName = multiAreaName(filter);
  const multiIds = multiName === null ? null : areaScopeIds(filter);
  const rows = buildRows(areas, classes).filter((r) => multiIds === null || multiIds.has(r.area.id));
  const scale = Math.max(1, ...rows.map((r) => Math.max(r.total, r.stack)));
  // 0 件の地区は、棒が空の行を並べず、1 行にまとめる（縦に長くなり、件数のある地区が埋もれる）。選んでいる地区は、押し直して戻せるよう、0 件でも行に残す
  const barRows = rows.filter((r) => r.total > 0 || r.area.id === areaId);
  const zeroRows = rows.filter((r) => r.total <= 0 && r.area.id !== areaId);
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
        {/* 右の数字・並び順は、表示している分類だけの合計（分類のチップを替えると、数字も並びも変わる）。分類・行の操作が地図にも効くことも、ここで 1 回だけ言う */}
        <p className="area-chart__hint">
          {inline
            ? '多い順です。行を押すと地区を絞り込めます（もう一度押すと戻ります）。'
            : '表示中の分類の合計が多い順です。行を押すとその地区に絞り込み、もう一度押すと全地区に戻ります。分類・地区の絞り込みは、地図と集計の帯にも反映されます。'}
        </p>
      </header>

      {empty ? (
        <p className="empty-note" role="status">
          表示できる地区がありません
        </p>
      ) : (
        <>
          {!inline && (
            <>
              <div className="area-chart__legend" role="group" aria-label="グラフに出す分類（押すと切り替え。地図・集計の帯にも、同じ分類が効きます）">
                {CLASS_ORDER.map((c) => (
                  <button key={c} type="button" className="area-chart__legend-btn" aria-pressed={classes.has(c)} onClick={() => toggleClass(c)}>
                    <ClassSwatch cls={c} size={16} />
                    <span>{CLASS_INFO[c].short}</span>
                  </button>
                ))}
              </div>
              {classes.has('uncertain') && (
                <p className="area-chart__gloss">
                  <strong>{CLASS_INFO.uncertain.short}</strong>は、{CLASS_INFO.uncertain.summary}目で確かめる候補です。
                </p>
              )}
            </>
          )}
          {/* 回答の中の図は凡例が無いので、絞り込んでいるときは、そのことを言う */}
          {inline && !allClassesShown(classes) && <p className="area-chart__gloss">一部の候補に絞って表示しています。</p>}
          {onShowMap && !isAllFilter(filter) && (
            <div className="area-chart__linked">
              <span>いまの絞り込み{inline ? '' : '（地区・分類）'}は、地図にも反映されています。</span>
              <button type="button" className="btn btn--small" onClick={onShowMap}>
                地図で見る
              </button>
            </div>
          )}

          {shown.length === 0 ? (
            <p className="empty-note" role="status">
              表示する分類がありません
            </p>
          ) : (
            <>
              {barRows.length > 0 && (
              <ol className="area-chart__rows">
                {barRows.map((row) => {
                  const selected = row.area.id === areaId;
                  return (
                    <li key={row.area.id}>
                      <button
                        type="button"
                        className="area-chart__row"
                        aria-pressed={selected}
                        aria-label={inline ? `${row.area.name}（${row.area.ward}）、${formatNumber(row.total)} 件` : rowLabel(row, classes)}
                        onClick={() => selectArea(row.area.id)}
                      >
                        <span className="area-chart__name">
                          {row.area.name}
                          <span className="area-chart__ward">（{row.area.ward}）</span>
                        </span>
                        <span className="area-chart__bar" aria-hidden="true">
                          {inline ? (
                            row.total > 0 && <span className="area-chart__seg area-chart__seg--plain" style={{ width: `${(row.total * 100) / scale}%` }} />
                          ) : (
                            shown.map((c) =>
                              row.byClass[c] > 0 ? (
                              <span
                                key={c}
                                className="area-chart__seg"
                                data-class={c}
                                title={`${CLASS_INFO[c].short} ${formatNumber(row.byClass[c])} 件`}
                                style={{ width: `${(row.byClass[c] * 100) / scale}%`, '--c': CLASS_INFO[c].color } as CSSProperties}
                              >
                                {showSegmentCount(row.byClass[c], scale) && <span className="area-chart__seg-n">{formatNumber(row.byClass[c])}</span>}
                              </span>
                              ) : null,
                            )
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
              )}
              {barRows.length === 0 && (
                <p className="empty-note" role="status">
                  {inline ? '条件に合う候補は、どの地区にもありません。' : '表示中の分類の候補は、どの地区にもありません。'}
                </p>
              )}
              {zeroRows.length > 0 && (
                <p className="area-chart__zero">
                  <strong>0 件の地区（{formatNumber(zeroRows.length)}）</strong>{' '}
                  {zeroRows.map((r) => r.area.name).join('、')}
                </p>
              )}

              {/* 回答の中の図は、グラフだけを出す（同じ数字を表でも出さない）。表は拡大ビューで読める */}
              {!inline && (
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
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
