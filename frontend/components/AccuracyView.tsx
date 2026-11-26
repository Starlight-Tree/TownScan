'use client';

import type { ReactNode } from 'react';
import { getAreas, getMetrics } from '../lib/api';
import type { AreaSummary, MetricsResponse, Provenance } from '../lib/api-types';
import {
  DEFAULT_EVAL_YEAR,
  FEW_MATCHES,
  GROUP_LABEL,
  GROUP_SHORT,
  PER_AREA_LABEL,
  SWEEP_LABEL,
  chosenVsRunnerUp,
  evalYearOf,
  formatTenths,
  getAbsentStats,
  getBlock,
  getEdgeExcluded,
  getYearCompare,
  gridNote,
  isNum,
  matchBasis,
  metricLabel,
  metricValue,
  sweepColumns,
  type EdgeCount,
  type EdgeExcluded,
  type SplitKey,
  type YearCompare,
} from '../lib/accuracy';
import { AreasProvider, useAreas } from '../lib/areas-context';
import { formatNumber } from '../lib/format';
import { useAsync } from '../lib/use-api';
import { ProvenanceBox } from './chat/ProvenanceBox';

const loadMetrics = (signal: AbortSignal) => getMetrics(signal);
const loadAreas = (signal: AbortSignal) => getAreas(signal);
const NO_AREAS: AreaSummary[] = [];

function cell(v: unknown): string {
  return isNum(v) ? formatNumber(v) : '—';
}

export function AccuracyView() {
  // 「地区ごとの値」などで、地区の ID（z18-…）を町名で言うために、地区の一覧も読む。読めなくても数字は出す（地区は ID のまま。エラーにはしない）
  const areasQ = useAsync(loadAreas);
  const areas = areasQ.state.status === 'ready' ? areasQ.state.data : NO_AREAS;
  return (
    <AreasProvider areas={areas}>
      <AccuracyContent />
    </AreasProvider>
  );
}

function AccuracyContent() {
  const { state, reload } = useAsync(loadMetrics);

  return (
    <div className="page page--narrow">
      <h1 className="page__title">このアプリの精度</h1>
      {state.status === 'loading' && (
        <p className="empty-note" role="status">
          読み込んでいます…
        </p>
      )}
      {state.status === 'error' && (
        <div className="inline-error" role="alert">
          <p>精度の数字を読み込めませんでした（{state.error.message}）</p>
          <button type="button" className="btn btn--small" onClick={reload}>
            再試行
          </button>
        </div>
      )}
      {state.status === 'ready' && <MetricsSummary m={state.data} />}
      <Limits m={state.status === 'ready' ? state.data : undefined} />
      <Sources />
      {state.status === 'ready' && <MetricsDetails m={state.data} />}
    </div>
  );
}

function MetricsSummary({ m }: { m: MetricsResponse }) {
  const holdoutObj = getBlock(m.holdout, 'object');
  const holdoutPix = getBlock(m.holdout, 'pixel');
  const recall = m.new_building_recall;
  const prov = m.provenance as Partial<Provenance> | undefined;
  const year = evalYearOf(m);
  const yc = getYearCompare(m);
  const basis = matchBasis(m.holdout);

  return (
    <>
      <p className="page__lead">
        実測した数字です。ただし <b>熊本の 12 地区・初期値の閾値</b> という限定つきで、ほかの地域や条件には当てはまりません。
      </p>
      {prov?.run_kind === 'synthetic' && (
        <p className="banner banner--synthetic" role="note">
          <strong>合成データ（テスト用）</strong>
          <span>この画面の数字は、動作確認のための合成データです。実際の写真の精度ではありません。</span>
        </p>
      )}

      <p className="page__small" data-testid="eval-year-note">
        建物の抽出の 2 つの数字（物体単位 F1 と画素 IoU）は、<b>{year} 年の写真</b>から建物を抽出して測った値です。
        {yc && (
          <>
            「2018 年は未検出」の候補は {yc.compareYear} 年の写真の抽出にも依るので、<b>{yc.compareYear} 年の写真での値</b>も並べています（同じ参照・同じ設定）。
          </>
        )}
      </p>

      <ul className="metric-grid metric-grid--big">
        <li className="metric-tile">
          <span className="metric-tile__label">建物の抽出（評価用の地区・物体単位 F1）</span>
          <span className="metric-tile__value">{cell(holdoutObj?.f1)}</span>
          <YearLine year={year} yc={yc} value={metricValue(yc?.other.holdout, 'object', 'f1')} />
          <span className="metric-tile__note">基盤地図情報（2018 年 10 月版）を正解にした、評価用の地区での値。</span>
          {basis && (
            <span className="metric-tile__note" data-testid="f1-basis">
              根拠の件数: 評価用の参照 {formatNumber(basis.nRef)} 棟（縁を除く）のうち、一致は {formatNumber(basis.tp)} 棟。
              {basis.tp < FEW_MATCHES && '少数の棟の上の値なので、地区の取り方で大きく動きます。'}
            </span>
          )}
        </li>
        <li className="metric-tile">
          <span className="metric-tile__label">建物の抽出（評価用の地区・画素 IoU）</span>
          <span className="metric-tile__value">{cell(holdoutPix?.iou)}</span>
          <YearLine year={year} yc={yc} value={metricValue(yc?.other.holdout, 'pixel', 'iou')} />
          <span className="metric-tile__note">予測と正解の面積の重なり。</span>
        </li>
        <li className="metric-tile metric-tile--none">
          <span className="metric-tile__label">新築の再現率</span>
          {recall === null || recall === undefined ? (
            <span className="metric-tile__value metric-tile__value--none">未測定</span>
          ) : (
            <span className="metric-tile__value">{formatNumber(recall)}</span>
          )}
          <span className="metric-tile__note">
            手でラベルした「本当の新築」がまだ無いため、測れていません。「2018 年は未検出」の候補が実際に新築かどうかは、確かめていません。
          </span>
          <span className="metric-tile__note">
            「詳しい測定」の表の「建物の抽出の再現率」（基盤地図情報に対する値）とは別の値です。
          </span>
        </li>
      </ul>

      <section className="panel" aria-labelledby="h-thresholds">
        <h2 id="h-thresholds" className="panel__title">3 分類の閾値は、未検証の初期値です</h2>
        <p className="page__p">
          「2018 年は未検出」「2018 年も検出」「未判定」を分ける閾値（旧写真の抽出が覆う割合 0.5・0.10 など）は、手でラベルした正解が無いため、検証できていません。分類の当たり率は、まだ出せません。
        </p>
      </section>
    </>
  );
}

/** 詳しい測定（開発者向け）。畳んでおく。見出しの数字・限界・出典は、これより上に出す */
function MetricsDetails({ m }: { m: MetricsResponse }) {
  const { nameOf } = useAreas();
  const groups = ['pixel', 'object'].filter((g) => getBlock(m.tune, g) || getBlock(m.holdout, g));
  const prov = m.provenance as Partial<Provenance> | undefined;
  const fullProv = prov && prov.source && prov.model && prov.run_id && prov.run_kind && Array.isArray(prov.photo_years);
  const year = evalYearOf(m);
  const yc = getYearCompare(m);
  const stability = chosenVsRunnerUp(m);
  const tuneBasis = matchBasis(m.tune);

  return (
    <details className="provenance accuracy-more" data-testid="accuracy-more">
      <summary>詳しい測定を見る（開発者向け）</summary>
      <div className="accuracy-more__body">
          {m.reference && <ReferenceNote reference={m.reference} edge={getEdgeExcluded(m)} />}

          {groups.length > 0 && (
            <section className="panel" aria-labelledby="h-split">
              <h2 id="h-split" className="panel__title">調整用と評価用（地区を 2 つに分けて測っています）</h2>
              <p className="page__small">
                倍率と閾値は<b>調整用の地区だけ</b>で選び、評価用の地区には使っていません。評価用の値が、初めて見る地区での目安です。表の数字はすべて、{year} 年の写真での値です。
              </p>
              {m.split && (
                <p className="page__small">
                  調整用: {(m.split.tune ?? []).map(nameOf).join('、') || '—'}
                  <br />
                  評価用: {(m.split.holdout ?? []).map(nameOf).join('、') || '—'}
                </p>
              )}
              {groups.map((g) => {
                const keys = [...new Set([...Object.keys(getBlock(m.tune, g) ?? {}), ...Object.keys(getBlock(m.holdout, g) ?? {})])];
                return (
                  <div key={g} className="table-block">
                    <div className="table-scroll" role="region" aria-label={`${GROUP_LABEL[g] ?? g}（横にスクロールできます）`} tabIndex={0}>
                      <table className="data-table">
                        <caption>{GROUP_LABEL[g] ?? g}</caption>
                        <thead>
                          <tr>
                            <th scope="col">指標</th>
                            <th scope="col">調整用</th>
                            <th scope="col">評価用</th>
                          </tr>
                        </thead>
                        <tbody>
                          {keys.map((k) => (
                            <tr key={k}>
                              <th scope="row">{metricLabel(k)}</th>
                              <td>{cell(getBlock(m.tune, g)?.[k])}</td>
                              <td>{cell(getBlock(m.holdout, g)?.[k])}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="page__small" data-testid={`note-${g}`}>
                      {g === 'pixel'
                        ? gridNote(m.chosen?.scale, formatNumber)
                        : '参照・予測の物体数は、縁で外した物体を除いた数です。'}
                    </p>
                  </div>
                );
              })}
            </section>
          )}

          {yc && <YearComparePanel yc={yc} />}

          {(m.chosen || (m.sweep && m.sweep.length > 0)) && (
            <section className="panel" aria-labelledby="h-chosen">
              <h2 id="h-chosen" className="panel__title">選んだ設定</h2>
              {m.chosen && (
                <p className="page__p">
                  推論の倍率 <b>{cell(m.chosen.scale)}</b>・建物とみなす確率の閾値 <b>{cell(m.chosen.threshold)}</b>
                  （調整用の地区の物体単位 F1 がいちばん高かった組）。
                </p>
              )}
              {(stability || tuneBasis) && (
                <p className="page__small" data-testid="choice-stability">
                  {tuneBasis && <>調整用の地区で一致した棟は {formatNumber(tuneBasis.tp)} 棟（縁を除く参照 {formatNumber(tuneBasis.nRef)} 棟中）。</>}
                  {stability && (
                    <>
                      選んだ組の F1 は {formatNumber(stability.chosen)}、次に高い組は {formatNumber(stability.runnerUp)}（差 {formatNumber(stability.chosen - stability.runnerUp)}）。
                    </>
                  )}
                  {tuneBasis && tuneBasis.tp < FEW_MATCHES && '一致が少ないので、この差で選んだ設定の優位は確かではありません。'}
                </p>
              )}
              {m.sweep && m.sweep.length > 0 && <SweepTable sweep={m.sweep} chosen={m.chosen} year={year} />}
            </section>
          )}

          {m.per_area && m.per_area.length > 0 && <PerAreaTable rows={m.per_area} year={year} />}

          {m.notes && m.notes.length > 0 && (
            <section className="panel" aria-labelledby="h-notes">
              <h2 id="h-notes" className="panel__title">評価の注記</h2>
              {/* 評価の元データ（eval.json）に付いた注記は、項目名・ファイル名・条件式がそのまま書いてある開発者向けの文。ふだんは畳み、この画面の説明は、上の文と「既知の限界」に書く */}
              <p className="page__small">評価の元データに付いている注記です。項目名やファイル名がそのまま書いてあるので、開発者向けです。この画面の説明は、上の文と「既知の限界」にあります。</p>
              <details className="provenance" data-testid="eval-notes">
                <summary>注記をすべて見る（開発者向け）</summary>
                <ul className="plain-list">
                  {m.notes.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              </details>
            </section>
          )}

          {fullProv && <ProvenanceBox provenance={prov as Provenance} />}
      </div>
    </details>
  );
}

/** 見出しの数字の、どの年の写真での値か。year_compare があれば、もう一方の年の値も並べる */
function YearLine({ year, yc, value }: { year: number; yc: YearCompare | null; value: number | undefined }) {
  return (
    <span className="metric-tile__years">
      <span className="pill pill--year">{year} 年の写真での値</span>
      {yc && value !== undefined && (
        <span className="metric-tile__other">
          {yc.compareYear} 年の写真での値: <b>{formatNumber(value)}</b>
        </span>
      )}
    </span>
  );
}

function countText(c: EdgeCount): string {
  const d = c.detail;
  return d
    ? `参照 ${formatNumber(c.reference)}（縁に接する ${formatNumber(d.refTouch)}・重なりで外した ${formatNumber(d.refOverlap)}）・予測 ${formatNumber(c.prediction)}（縁に接する ${formatNumber(d.predTouch)}・重なりで外した ${formatNumber(d.predOverlap)}）`
    : `参照 ${formatNumber(c.reference)}・予測 ${formatNumber(c.prediction)}`;
}

function ReferenceNote({ reference, edge }: { reference: string; edge: EdgeExcluded }) {
  const { holdout, tune, total, totalNumber, overlapMin } = edge;
  return (
    <p className="page__small" data-testid="reference-note">
      正解（参照）: {reference}。タイルの縁に接する物体は、参照・予測の両方から外しています。
      {overlapMin !== undefined && <>さらに、外した物体と面積の {formatNumber(overlapMin * 100)} % 以上が重なる反対側の物体も外しています。</>}
      {holdout ? (
        <>
          外した数は、評価用の地区で {countText(holdout)}
          {tune && <>、調整用の地区で {countText(tune)}</>}
          {total && <>（12 地区の合計は 参照 {formatNumber(total.reference)}・予測 {formatNumber(total.prediction)}）</>}。
        </>
      ) : total ? (
        <>外した数は、12 地区の合計で {countText(total)}です（評価用の地区だけの数は、評価ファイルにありません）。</>
      ) : totalNumber !== undefined ? (
        <>外した数は、12 地区の合計で {formatNumber(totalNumber)} です。</>
      ) : null}
    </p>
  );
}

const YEAR_ROWS: Array<{ group: 'object' | 'pixel'; key: string }> = [
  { group: 'object', key: 'f1' },
  { group: 'object', key: 'precision' },
  { group: 'object', key: 'recall' },
  { group: 'object', key: 'tp' },
  { group: 'pixel', key: 'iou' },
  { group: 'pixel', key: 'precision' },
  { group: 'pixel', key: 'recall' },
];

const YEAR_SPLITS: Array<{ key: SplitKey; label: string }> = [
  { key: 'holdout', label: '評価用' },
  { key: 'overall', label: '12 地区全体' },
];

/** 同じ参照・同じ設定で、評価した年と比べる年の写真の抽出を並べる（year_compare があるときだけ） */
function YearComparePanel({ yc }: { yc: YearCompare }) {
  const splits = YEAR_SPLITS.filter((s) => yc.base[s.key] || yc.other[s.key]);
  const rows = YEAR_ROWS.filter((r) => splits.some((s) => metricValue(yc.base[s.key], r.group, r.key) !== undefined || metricValue(yc.other[s.key], r.group, r.key) !== undefined));
  if (splits.length === 0 || rows.length === 0) return null;
  const { scale, threshold } = yc.setting;
  return (
    <section className="panel" aria-labelledby="h-year-compare">
      <h2 id="h-year-compare" className="panel__title">写真の年で比べる（{yc.baseYear} 年と {yc.compareYear} 年）</h2>
      <p className="page__small">
        {yc.baseYear} 年の調整用の地区で選んだ設定{isNum(scale) && isNum(threshold) ? `（倍率 ${formatNumber(scale)}・閾値 ${formatNumber(threshold)}）` : ''}のまま、{yc.compareYear} 年の写真でも建物を抽出し、同じ基盤地図情報（{yc.baseYear} 年 10 月版）と比べた値です。設定の選択には使っていません。
      </p>
      <p className="page__small">
        「2018 年は未検出」の候補は {yc.compareYear} 年の抽出にも依るので、こちらも見てください。参照は古いままなので、{yc.compareYear} 年の写真にだけ写る新しい建物は「余分（FP）」に数えられ、値が低く出る一因になりえます。写真の撮影条件・季節・モデルの得意不得意も混ざり、原因は分けられません。
      </p>
      <div className="table-scroll" role="region" aria-label="写真の年ごとの指標（横にスクロールできます）" tabIndex={0}>
        <table className="data-table data-table--dense">
          <caption>写真の年ごとの、建物の抽出の指標（基盤地図情報に対して）</caption>
          <thead>
            <tr>
              <th scope="col">指標</th>
              {splits.flatMap((s) => [
                <th key={`${s.key}-a`} scope="col">{s.label}・{yc.baseYear} 年の写真</th>,
                <th key={`${s.key}-b`} scope="col">{s.label}・{yc.compareYear} 年の写真</th>,
              ])}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.group}-${r.key}`}>
                <th scope="row">{GROUP_SHORT[r.group]}・{metricLabel(r.key)}</th>
                {splits.flatMap((s) => [
                  <td key={`${s.key}-a`}>{cell(metricValue(yc.base[s.key], r.group, r.key))}</td>,
                  <td key={`${s.key}-b`}>{cell(metricValue(yc.other[s.key], r.group, r.key))}</td>,
                ])}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SweepTable({ sweep, chosen, year }: { sweep: Array<Record<string, number | null | undefined>>; chosen: MetricsResponse['chosen']; year: number }) {
  const keys = sweepColumns(sweep);
  const label = (k: string) => SWEEP_LABEL[k] ?? k;
  return (
    <div className="table-scroll" role="region" aria-label="倍率と閾値ごとの調整用の指標（横にスクロールできます）" tabIndex={0}>
      <table className="data-table data-table--dense">
        <caption>倍率と閾値ごとの、調整用の地区での指標（{year} 年の写真。「選択」の印の行が、選んだ設定）</caption>
        <thead>
          <tr>
            <th scope="col">
              <span className="visually-hidden">選んだ組</span>
            </th>
            {keys.map((k) => (
              <th key={k} scope="col">
                {label(k)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sweep.map((r, i) => {
            const isChosen = chosen && r.scale === chosen.scale && r.threshold === chosen.threshold;
            return (
              <tr key={i} className={isChosen ? 'is-chosen' : undefined} aria-current={isChosen ? 'true' : undefined}>
                {/* 印は倍率の数字と別のセルに置く（数字に「選択」が貼り付いて読まれないように） */}
                <td className="cell-mark">{isChosen && <span className="pill pill--mark">選択</span>}</td>
                {keys.map((k) => (
                  <td key={k}>{cell(r[k])}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PerAreaTable({ rows, year }: { rows: Array<Record<string, unknown>>; year: number }) {
  const { nameOf } = useAreas();
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const label = (k: string) => PER_AREA_LABEL[k] ?? k.replace(/_/g, ' ');
  const show = (k: string, v: unknown): ReactNode => {
    if (k === 'area_id' && typeof v === 'string') {
      const name = nameOf(v);
      // 町名が分かるときは、町名を主にして、タイル ID を下に小さく添える（地図・チャットの地区の呼び方と、評価ファイルの ID を突き合わせられる）
      return name === v ? v : (
        <>
          {name}
          <span className="data-table__sub">{v}</span>
        </>
      );
    }
    if (k === 'split') return v === 'tune' ? '調整用' : v === 'holdout' ? '評価用' : String(v ?? '—');
    return isNum(v) ? formatNumber(v) : v === null || v === undefined ? '—' : String(v);
  };
  return (
    <section className="panel" aria-labelledby="h-per-area">
      <h2 id="h-per-area" className="panel__title">地区ごとの値</h2>
      <p className="page__small">
        {year} 年の写真での値です。物体の数は、縁に接する物体（と、それと重なる反対側の物体）を除いた数です。{keys.includes('excluded_ref') && '外した数は「縁で外した…」の列にあります。'}「—」は、値が定義できないこと（縁を除いた参照の建物が無い、など）を表します。
      </p>
      <div className="table-scroll" role="region" aria-label="地区ごとの指標（横にスクロールできます）" tabIndex={0}>
        <table className="data-table data-table--dense">
          <thead>
            <tr>
              {keys.map((k) => (
                <th key={k} scope="col">
                  {label(k)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {keys.map((k) => (
                  <td key={k}>{show(k, r[k])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** 出典と規約（このアプリのデータの出どころ。地図の出典表示とあわせて、ここにまとめる） */
function Sources() {
  return (
    <section className="panel" aria-labelledby="h-sources">
      <h2 id="h-sources" className="panel__title">出典と規約</h2>
      <ul className="plain-list">
        <li><b>地図・写真</b>: 国土地理院「地理院タイル」（標準地図、年度別の写真 <code>nendophoto2018</code>・<code>nendophoto2023</code>）。出典を地図に表示しています。</li>
        <li><b>建物データ（評価の正解）</b>: 国土地理院「基盤地図情報」の建築物の外周（2018 年 10 月版）。</li>
        <li>
          <b>建物抽出モデル</b>: <code>giswqs/whu-building-unetplusplus-efficientnet-b4</code>（Apache-2.0）。学習に使われたデータセット（WHU）の利用条件は、確認できていません。
        </li>
        <li>地理院タイルを機械学習などに大量に使うことの扱いは未確認です。公開する前に、規約を確かめます。</li>
      </ul>
    </section>
  );
}

function Limits({ m }: { m?: MetricsResponse }) {
  return (
    <section className="panel" aria-labelledby="h-limits">
      <h2 id="h-limits" className="panel__title">既知の限界</h2>
      <div className="limits-grid">
        <div>
          <b>写真が無い期間</b>
          <br />
          使える年は 2018 年と 2023 年です。2024 年以降に建った建物は、写真が無いので確かめられません。
        </div>
        <div>
          <b>撮影月が不明</b>
          <br />
          写真は年度単位。「いつ建ったか」は年の幅でしか言えません。
        </div>
        <div>
          <b>2018 年は帯状の範囲だけ</b>
          <br />
          2018 年の写真は斜めの帯状の断片で、範囲の外では比べられません。
        </div>
        <div>
          <b>タイルの縁</b>
          <br />
          地区の縁で切れた建物は、分類しない（端のため未判定）か、評価から外しています。
        </div>
        <div>
          <b>誤検出の可能性</b>
          <br />
          モデルが 2 つの年で同じ誤検出をすると、「2018 年も検出」に入ります。駐車場の屋根や仮設の建物も混ざります。
        </div>
        <div>
          <b>正解が無い</b>
          <br />
          新築の再現率は、手ラベルが無いので未測定です。
        </div>
        <div>
          <b>対象範囲</b>
          <br />
          熊本市中心部の 12 地区と、2018・2023 年の写真だけです。
        </div>
        <div>
          <b>未実装のもの</b>
          <br />
          衛星の「変化の当たり」（Google Earth Engine）、屋根の太陽光パネル、人による確認・確定、公開は、まだありません。
        </div>
        <AbsentLimit m={m} />
        <ReferenceLimit />
        <HazeLimit m={m} />
      </div>
    </section>
  );
}

/** (a) 2018 年の抽出の見落としは、既存の建物が「2018 年は未検出」に入る向きの誤り。実測の割合はデータから描く */
function AbsentLimit({ m }: { m?: MetricsResponse }) {
  const year = m ? evalYearOf(m) : DEFAULT_EVAL_YEAR;
  const all = m ? getAbsentStats(m, 'overall') : null;
  const holdout = m ? getAbsentStats(m, 'holdout') : null;
  return (
    <div data-testid="limit-absent">
      <b>{year} 年の写真での見落とし（既存の建物が「2018 年は未検出」に入る）</b>
      <br />
      {year} 年の抽出が既存の建物を見落とすと、その建物は旧写真に無いものとして「2018 年は未検出」に入ります。
      {all ? (
        <>
          実測では、基盤地図情報にある既存の建物{all.minAreaM2 !== undefined ? `（${formatNumber(all.minAreaM2)} m² 以上・縁に接しない）` : ' '}{formatNumber(all.n)} 棟のうち、
          <b>{formatTenths(all.absent / all.n)}（{formatNumber(all.absent)} 棟）</b>で、{year} 年の抽出が何も見ていません。
          {all.present !== undefined && <>半分以上を覆っているのは {formatTenths(all.present / all.n)}（{formatNumber(all.present)} 棟）です。</>}
          {holdout && <>評価用の地区だけでは {formatNumber(holdout.n)} 棟のうち {formatNumber(holdout.absent)} 棟（{formatTenths(holdout.absent / holdout.n)}）です。</>}
          これは手ラベルの代わりにはなりません。「何も見ていない」には、モデルの見落としと、写真の時点で既に取り壊されていた参照の建物が混ざり、分けられないためです。
        </>
      ) : m ? (
        <>この割合は、評価ファイルに無く、測れていません。</>
      ) : (
        <>この割合は、評価の数字を読み込めていないため、出していません。</>
      )}
    </div>
  );
}

/** (b) 参照は写真より古い可能性がある。物体単位の適合率は、参照の完全性との合成値 */
function ReferenceLimit() {
  return (
    <div data-testid="limit-reference">
      <b>参照（基盤地図情報）が写真より古い可能性</b>
      <br />
      参照は、写真より古い可能性があります（推定）。配布の版の日付は 2018-10 ですが、建物ごとの測量の時期は分かりません。この地域のデータは 2017 年 10 月の更新のあと実質止まっていた、と開発時の調査記録にありますが、独立の確認はしていません。写真にあって参照に無い建物は「余分（FP）」に、参照に残る取り壊し済みの建物は「見逃し（FN）」に数えられます。このため、<b>物体単位の適合率は、モデルの適合率ではなく、モデルの精度と参照の完全性が混ざった値</b>です。
    </div>
  );
}

/** (c) 写真の年で、建物の抽出の出来が違う（数字だけを書く）。year_compare が無いときは、何も出さない。暗さなど原因は書かない（確かめていない） */
function HazeLimit({ m }: { m?: MetricsResponse }) {
  const yc = m ? getYearCompare(m) : null;
  const split: SplitKey | undefined = yc ? (['overall', 'holdout'] as const).find((k) => metricValue(yc.base[k], 'pixel', 'recall') !== undefined && metricValue(yc.other[k], 'pixel', 'recall') !== undefined) : undefined;
  const base = yc && split ? metricValue(yc.base[split], 'pixel', 'recall') : undefined;
  const other = yc && split ? metricValue(yc.other[split], 'pixel', 'recall') : undefined;
  if (!yc || !split || base === undefined || other === undefined) return null;
  return (
    <div data-testid="limit-haze">
      <b>写真の年で、建物の抽出の出来が違う</b>
      <br />
      建物の抽出の画素の再現率（基盤地図情報に対して。{split === 'overall' ? '12 地区全体' : '評価用の地区'}・同じ設定）は、{yc.baseYear} 年の写真で {formatNumber(base)}、{yc.compareYear} 年の写真で {formatNumber(other)} です。
      年によって抽出の出来が違うので、2 つの年の差分には、モデルの見落としが「2018 年は未検出」として混ざります。違いの原因（写真の暗さ・撮影条件など）は確かめていません。
    </div>
  );
}
