'use client';

import Link from 'next/link';
import { useAreas } from '../../lib/areas-context';
import type {
  AccuracyResult,
  CompareResult,
  CountResult,
  DetectionImageResult,
  MapFocusResult,
  RefusalResult,
  TableCell,
  TableResult,
} from '../../lib/api-types';
import { CLASS_INFO, CLASS_ORDER, isCandidateClass, refusalTitle } from '../../lib/classes';
import { candidateImageUrl } from '../../lib/api';
import { formatNumber } from '../../lib/format';
import { ALL_FILTER, areaLabel, filterFromResults } from '../../lib/result-view';
import { CandidateImage } from '../CandidateImage';
import { ClassBadge } from '../ClassBadge';
import { classOfCell } from './cell';
import { ClassGuide } from './ClassGuide';
import { ProvenanceBox } from './ProvenanceBox';
import { ScrollHint } from './ScrollHint';
import type { ResultActions } from './types';

const CANDIDATE_ID = /^c-\d+-\d+-\d+$/;

/**
 * 回答の本文（answerText）が、カードの中の文をすでに含んでいるか。含んでいれば、カードのほうは同じ文を出さない
 * （同じ文が本文とカードで 2 回出ないように。API の返答文は、お断りの理由や写真の説明を、そのまま本文にも入れる）
 */
function saidInAnswer(answerText: string | undefined, text: string): boolean {
  const t = text.trim();
  return t !== '' && typeof answerText === 'string' && answerText.includes(t);
}

function SyntheticChip({ kind }: { kind: string }) {
  return kind === 'synthetic' ? <span className="pill pill--warn pill--inline">合成データ</span> : null;
}

function barColor(key: string): string {
  return isCandidateClass(key) ? CLASS_INFO[key].color : 'var(--primary)';
}

/** 比較のカードに出す地区の数。これを超える分は、回答の中のグラフ（「表で見る」で表も）で読む */
const COMPARE_ROWS = 5;

// ---- 件数 ----

// グラフ・地図は、回答の中の図（ChatPanel の renderFigure）に出る。件数のカードに、拡大ビューを開くボタンは無い
export function CountCard({ result }: { result: CountResult }) {
  const { nameOf } = useAreas();
  const max = Math.max(1, ...result.breakdown.map((b) => b.value));
  const cls = isCandidateClass(result.filter?.cls) ? result.filter.cls : null;
  // 複数の地区（区など）は API の scope をそのまま出す。拡大ビューの地図・グラフに写す条件と同じ読み方
  const areaText = areaLabel(filterFromResults([result]) ?? ALL_FILTER, nameOf);
  return (
    <section className="result-card" aria-label={result.title}>
      <header className="result-card__head">
        <h3 className="result-card__title">{result.title}</h3>
        <SyntheticChip kind={result.provenance.run_kind} />
      </header>
      <p className="count-hero">
        <span className="count-hero__value" style={{ color: cls ? CLASS_INFO[cls].color : undefined }}>
          {formatNumber(result.total)}
        </span>
        <span className="count-hero__unit">件</span>
      </p>
      {(cls || areaText) && (
        <p className="chip-row" aria-label="絞り込み条件">
          {areaText && <span className="pill">地区: {areaText}</span>}
          {cls && <ClassBadge cls={cls} short />}
        </p>
      )}
      {result.breakdown.length > 0 && (
        <ul className="breakdown" aria-label="内訳">
          {result.breakdown.map((b) => (
            <li key={b.key} className="breakdown__row">
              <span className="breakdown__label">{b.label}</span>
              <span className="bar" aria-hidden="true">
                <span className="bar__fill" style={{ width: `${(b.value / max) * 100}%`, background: barColor(b.key) }} />
              </span>
              <span className="breakdown__value">{formatNumber(b.value)}</span>
            </li>
          ))}
        </ul>
      )}
      <ClassGuide />
      <ProvenanceBox provenance={result.provenance} />
    </section>
  );
}

// ---- 一覧 ----

function renderCell(colKey: string, value: TableCell | undefined, nameOf: (id: string) => string) {
  if (value === null || value === undefined) return '—';
  // 分類は、キーでも表示名でも、印つきの短い名前で出す（長い名前は、狭いチャットで切れる）
  const cls = colKey === 'class' ? classOfCell(value) : null;
  if (cls) return <ClassBadge cls={cls} short />;
  if (colKey === 'area_id' && typeof value === 'string') return nameOf(value);
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'boolean') return value ? 'はい' : 'いいえ';
  return value;
}

export function TableCard({ result, actions }: { result: TableResult; actions: ResultActions }) {
  const { nameOf } = useAreas();
  const hasDetail = result.rows.some((r) => typeof r.id === 'string' && CANDIDATE_ID.test(r.id));
  // 詳細のボタンがある表は、候補 ID の列を、最初の列の名前の下に小さく添える。チャットの幅（340px 前後）では、
  // ID・地区・分類の 3 列で幅を使い切り、並びの基準の面積と「詳細」が横スクロールの先に隠れていた
  const idColumn = hasDetail && result.columns.length > 1 ? result.columns.find((c) => c.key === 'id') : undefined;
  const columns = idColumn ? result.columns.filter((c) => c !== idColumn) : result.columns;
  const hasClassColumn = columns.some((c) => c.key === 'class');
  return (
    <section className="result-card" aria-label={result.title}>
      <header className="result-card__head">
        <h3 className="result-card__title">{result.title}</h3>
        <SyntheticChip kind={result.provenance.run_kind} />
      </header>
      {result.rows.length === 0 ? (
        <p className="empty-note">該当する行はありません。</p>
      ) : (
        <ScrollHint label={`${result.title}（横にスクロールできます）`}>
          <table className="data-table data-table--chat">
            <thead>
              <tr>
                {columns.map((c, i) => (
                  <th key={c.key} scope="col">
                    {c.label}
                    {idColumn && i === 0 && <span className="visually-hidden">と{idColumn.label}</span>}
                  </th>
                ))}
                {hasDetail && (
                  <th scope="col">
                    <span className="visually-hidden">操作</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, i) => (
                <tr key={row.id ?? i}>
                  {columns.map((c, ci) => (
                    <td key={c.key}>
                      {renderCell(c.key, row[c.key], nameOf)}
                      {idColumn && ci === 0 && typeof row.id === 'string' && (
                        <span className="data-table__sub">
                          <span className="visually-hidden">{idColumn.label}: </span>
                          {row.id}
                        </span>
                      )}
                    </td>
                  ))}
                  {hasDetail && (
                    <td>
                      {typeof row.id === 'string' && CANDIDATE_ID.test(row.id) && (
                        <button type="button" className="btn btn--small" onClick={() => actions.openCandidate(row.id as string)}>
                          詳細<span className="visually-hidden">（{row.id}）</span>
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollHint>
      )}
      <p className="result-card__note">
        全 {formatNumber(result.total)} 件中 {formatNumber(result.shown)} 件を表示
      </p>
      {hasClassColumn && result.rows.length > 0 && <ClassGuide />}
      <ProvenanceBox provenance={result.provenance} />
    </section>
  );
}

// ---- 比較 ----

export function CompareCard({ result }: { result: CompareResult }) {
  // 会話の中で読み切れる大きさにするため、API の並びの先頭から上位 5 地区まで。全地区は、回答の中のグラフ（「表で見る」で表も）で読める
  const items = result.items.slice(0, COMPARE_ROWS);
  const known: string[] = [...CLASS_ORDER];
  const extraKeys = new Set<string>();
  for (const item of items) {
    for (const key of Object.keys(item.counts)) {
      if (!known.includes(key) && key !== 'total') extraKeys.add(key);
    }
  }
  const hasTotal = items.some((i) => typeof i.counts.total === 'number');
  const max = Math.max(1, ...items.flatMap((i) => Object.entries(i.counts).filter(([k]) => k !== 'total').map(([, v]) => v)));
  const classColumns = [
    ...CLASS_ORDER.map((k) => ({ key: k as string, label: CLASS_INFO[k].short, color: CLASS_INFO[k].color })),
    ...[...extraKeys].map((k) => ({ key: k, label: k, color: 'var(--primary)' })),
  ];
  // 並びの基準の列（backend は、分類を指定したときはその分類の件数、なければ合計の多い順に並べる。filter.cls が、その分類）を、地区の次（先頭側）に置く。
  // 狭いチャットでは、右の列が横スクロールの先に隠れる。並びの基準が見えないと、数字（3, 2, 1, 0…）が乱れて見える
  const sortCls = isCandidateClass(result.filter?.cls) ? result.filter.cls : null;
  const sortKey = sortCls ?? (hasTotal ? 'total' : null);
  const ordered = sortCls
    ? [...classColumns.filter((c) => c.key === sortCls), ...classColumns.filter((c) => c.key !== sortCls)]
    : classColumns;
  return (
    <section className="result-card" aria-label={result.title}>
      <header className="result-card__head">
        <h3 className="result-card__title">{result.title}</h3>
        <SyntheticChip kind={result.provenance.run_kind} />
      </header>
      {result.items.length === 0 ? (
        <p className="empty-note">比べる地区がありません。</p>
      ) : (
        <ScrollHint label={`${result.title}（横にスクロールできます）`}>
          <table className="data-table data-table--chat compare-table">
            <thead>
              <tr>
                <th scope="col">地区</th>
                {/* 合計で並べるときは、合計を最初に。分類で並べるときは、その分類を最初にして、合計は最後 */}
                {hasTotal && !sortCls && (
                  <th scope="col" aria-sort="descending">
                    合計
                  </th>
                )}
                {ordered.map((c) => (
                  <th key={c.key} scope="col" aria-sort={sortKey === c.key ? 'descending' : undefined}>
                    {c.label}
                  </th>
                ))}
                {hasTotal && sortCls && <th scope="col">合計</th>}
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.area_id}>
                  <th scope="row">{item.name}</th>
                  {hasTotal && !sortCls && <td className="mini-cell__value">{formatNumber(item.counts.total ?? 0)}</td>}
                  {ordered.map((c) => {
                    const v = item.counts[c.key] ?? 0;
                    return (
                      <td key={c.key}>
                        <span className="mini-cell">
                          <span className="bar bar--mini" aria-hidden="true">
                            <span className="bar__fill" style={{ width: `${(v / max) * 100}%`, background: c.color }} />
                          </span>
                          <span className="mini-cell__value">{formatNumber(v)}</span>
                        </span>
                      </td>
                    );
                  })}
                  {hasTotal && sortCls && <td className="mini-cell__value">{formatNumber(item.counts.total ?? 0)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollHint>
      )}
      {result.items.length > COMPARE_ROWS && (
        <p className="result-card__note">
          全 {formatNumber(result.items.length)} 地区中 {formatNumber(COMPARE_ROWS)} 地区を表示
        </p>
      )}
      {result.items.length > 0 && <ClassGuide />}
      <ProvenanceBox provenance={result.provenance} />
    </section>
  );
}

// ---- 地図の表示 ----

export function MapFocusCard({ result, actions }: { result: MapFocusResult; actions: ResultActions }) {
  return (
    <section className="result-card" aria-label={result.title}>
      <header className="result-card__head">
        <h3 className="result-card__title">{result.title}</h3>
        <SyntheticChip kind={result.provenance.run_kind} />
      </header>
      <p className="result-card__text">
        地図で、{result.candidate_ids.length > 0 ? `候補 ${formatNumber(result.candidate_ids.length)} 件を目立たせて` : 'この範囲を'}表示します。
      </p>
      <div className="button-row">
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => actions.focusMap({ bbox: result.bbox, candidateIds: result.candidate_ids })}
        >
          地図で見る
        </button>
      </div>
      <ProvenanceBox provenance={result.provenance} />
    </section>
  );
}

// ---- 検出画像 ----

export function DetectionImageCard({
  result,
  actions,
  answerText,
}: {
  result: DetectionImageResult;
  actions: ResultActions;
  /** 回答の本文。写真の説明（caption）がすでに本文にあれば、カードでは出さない */
  answerText?: string;
}) {
  const cls = isCandidateClass(result.class) ? result.class : null;
  const images =
    result.images.length > 0
      ? result.images
      : [2018, 2023].map((year) => ({ year, url: candidateImageUrl(result.candidate_id, year) }));
  return (
    <section className="result-card" aria-label={result.title}>
      <header className="result-card__head">
        <h3 className="result-card__title">{result.title}</h3>
        <SyntheticChip kind={result.provenance.run_kind} />
      </header>
      <div className="image-pair">
        {images.map((img) => (
          <CandidateImage key={img.year} src={img.url} year={img.year} candidateId={result.candidate_id} />
        ))}
      </div>
      <p className="chip-row">
        {cls && <ClassBadge cls={cls} short />}
        {!saidInAnswer(answerText, result.caption) && <span className="result-card__text">{result.caption}</span>}
      </p>
      <div className="button-row">
        <button type="button" className="btn btn--primary" onClick={() => actions.openCandidate(result.candidate_id)}>
          詳細を開く
        </button>
      </div>
      <ProvenanceBox provenance={result.provenance} />
    </section>
  );
}

// ---- 精度 ----

/** 指標の値（数のときだけ。null・数でない値は null） */
function metricValue(result: AccuracyResult, key: string): number | null {
  const v = result.metrics.find((m) => m.key === key)?.value;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 0〜1 の割合を、整数の % の文字にする（四捨五入。値の読み替えだけで、解釈は足さない） */
const percent = (ratio: number) => `${Math.round(Math.min(Math.max(ratio, 0), 1) * 100)} %`;

export function AccuracyCard({ result }: { result: AccuracyResult }) {
  // 専門の数字（F1・IoU など）の前に、適合率と再現率を、平易な言葉で 1 文にして出す。値は結果のものをそのまま（% に直すだけ）。
  // どちらかが無いとき（古い評価ファイル）は、これまでどおり、指標をそのまま並べる
  const precision = metricValue(result, 'holdout_object_precision');
  const recall = metricValue(result, 'holdout_object_recall');
  const plain = precision !== null && recall !== null;
  const tiles = (
    <ul className="metric-grid">
      {result.metrics.map((m) => (
        <li key={m.key} className="metric-tile">
          <span className="metric-tile__label">{m.label}</span>
          {m.value === null ? (
            <span className="metric-tile__value metric-tile__value--none">未測定</span>
          ) : (
            <span className="metric-tile__value">{formatNumber(m.value)}</span>
          )}
          <span className="metric-tile__note">{m.note}</span>
        </li>
      ))}
    </ul>
  );
  return (
    <section className="result-card" aria-label={result.title}>
      <header className="result-card__head">
        <h3 className="result-card__title">{result.title}</h3>
        <SyntheticChip kind={result.provenance.run_kind} />
      </header>
      {plain ? (
        <>
          <p className="accuracy-plain">
            機械が見つけた建物のうち、既存の建物データ（基盤地図情報）と一致したのは約 <b>{percent(precision)}</b>。建物データにある建物のうち、機械が見つけられたのは約{' '}
            <b>{percent(recall)}</b>です（評価用の地区）。見落としや見まちがいがあるため、結果は目で確かめる前提の「候補」です。
          </p>
          <details className="provenance">
            <summary>くわしい指標（専門の数字）を見る</summary>
            {tiles}
          </details>
        </>
      ) : (
        tiles
      )}
      <p className="result-card__note">
        <Link href="/accuracy">このアプリの精度の画面で、詳しく見る</Link>
      </p>
      <ProvenanceBox provenance={result.provenance} />
    </section>
  );
}

// ---- お断り ----

export function RefusalCard({
  result,
  actions,
  answerText,
}: {
  result: RefusalResult;
  actions: ResultActions;
  /** 回答の本文。お断りの理由（message）がすでに本文にあれば、カードでは出さない */
  answerText?: string;
}) {
  return (
    <section className="result-card result-card--refusal" aria-label={refusalTitle(result.reason)} role="note">
      <h3 className="result-card__title">{refusalTitle(result.reason)}</h3>
      {!saidInAnswer(answerText, result.message) && <p className="result-card__text">{result.message}</p>}
      {result.suggestions.length > 0 && (
        <div className="suggest-block">
          <span className="suggest-block__label">代わりに、こんな質問ならお答えできます</span>
          <ul className="suggest-list">
            {result.suggestions.map((s) => (
              <li key={s}>
                <button type="button" className="chip" onClick={() => actions.ask(s)}>
                  {s}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

// ---- 未知の型・壊れた結果 ----

export function UnknownResultCard({ raw, reason }: { raw: unknown; reason?: string }) {
  const type = raw && typeof raw === 'object' && 'type' in raw ? String((raw as { type: unknown }).type) : '不明';
  let json = '';
  try {
    json = JSON.stringify(raw, null, 2) ?? '';
  } catch {
    json = '（JSON にできませんでした）';
  }
  return (
    <section className="result-card result-card--unknown" role="note" aria-label="表示できない結果">
      <h3 className="result-card__title">この結果は表示できません</h3>
      <p className="result-card__text">
        {reason ?? `この画面が知らない種類の結果です（type: ${type}）。`}
        画面を再読み込みしても直らないときは、API と画面の版がずれている可能性があります。
      </p>
      <details className="provenance">
        <summary>受け取った内容</summary>
        <pre className="raw-json">{json}</pre>
      </details>
    </section>
  );
}
