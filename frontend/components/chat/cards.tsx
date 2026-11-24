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
import { ProvenanceBox } from './ProvenanceBox';
import type { ResultActions } from './types';

const CANDIDATE_ID = /^c-\d+-\d+-\d+$/;

function SyntheticChip({ kind }: { kind: string }) {
  return kind === 'synthetic' ? <span className="pill pill--warn pill--inline">合成データ</span> : null;
}

function barColor(key: string): string {
  return isCandidateClass(key) ? CLASS_INFO[key].color : 'var(--primary)';
}

/**
 * 件数・比較の結果から、右の結果領域のグラフ（件数は地図も）へ進む（回答の数字を、グラフ・地図でも確かめられるように）。
 * 押すと、このカードの結果から作った条件で開く。古い回答のカードを押しても、いまの絞り込みではなく、その回答の条件になる
 */
function ViewButtons({ result, actions, withMap }: { result: CountResult | CompareResult; actions: ResultActions; withMap?: boolean }) {
  return (
    <div className="button-row">
      <button type="button" className="btn" onClick={() => actions.showView('chart', filterFromResults([result]) ?? undefined)}>
        グラフで見る
      </button>
      {withMap && (
        <button type="button" className="btn" onClick={() => actions.showView('map', filterFromResults([result]) ?? undefined)}>
          地図で見る
        </button>
      )}
    </div>
  );
}

// ---- 件数 ----

export function CountCard({ result, actions }: { result: CountResult; actions: ResultActions }) {
  const { nameOf } = useAreas();
  const max = Math.max(1, ...result.breakdown.map((b) => b.value));
  const cls = isCandidateClass(result.filter?.cls) ? result.filter.cls : null;
  // 複数の地区（区など）は API の scope をそのまま出す。右の地図・グラフに写す条件と同じ読み方
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
      <ViewButtons result={result} actions={actions} withMap />
      <ProvenanceBox provenance={result.provenance} />
    </section>
  );
}

// ---- 一覧 ----

function renderCell(colKey: string, value: TableCell | undefined, nameOf: (id: string) => string) {
  if (value === null || value === undefined) return '—';
  if (colKey === 'class' && isCandidateClass(value)) return <ClassBadge cls={value} short />;
  if (colKey === 'area_id' && typeof value === 'string') return nameOf(value);
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'boolean') return value ? 'はい' : 'いいえ';
  return value;
}

export function TableCard({ result, actions }: { result: TableResult; actions: ResultActions }) {
  const { nameOf } = useAreas();
  const hasDetail = result.rows.some((r) => typeof r.id === 'string' && CANDIDATE_ID.test(r.id));
  return (
    <section className="result-card" aria-label={result.title}>
      <header className="result-card__head">
        <h3 className="result-card__title">{result.title}</h3>
        <SyntheticChip kind={result.provenance.run_kind} />
      </header>
      {result.rows.length === 0 ? (
        <p className="empty-note">該当する行はありません。</p>
      ) : (
        <div className="table-scroll" role="region" aria-label={`${result.title}（横にスクロールできます）`} tabIndex={0}>
          <table className="data-table">
            <thead>
              <tr>
                {result.columns.map((c) => (
                  <th key={c.key} scope="col">
                    {c.label}
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
                  {result.columns.map((c) => (
                    <td key={c.key}>{renderCell(c.key, row[c.key], nameOf)}</td>
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
        </div>
      )}
      <p className="result-card__note">
        全 {formatNumber(result.total)} 件中 {formatNumber(result.shown)} 件を表示
      </p>
      <ProvenanceBox provenance={result.provenance} />
    </section>
  );
}

// ---- 比較 ----

export function CompareCard({ result, actions }: { result: CompareResult; actions: ResultActions }) {
  const known: string[] = [...CLASS_ORDER];
  const extraKeys = new Set<string>();
  for (const item of result.items) {
    for (const key of Object.keys(item.counts)) {
      if (!known.includes(key) && key !== 'total') extraKeys.add(key);
    }
  }
  const hasTotal = result.items.some((i) => typeof i.counts.total === 'number');
  const max = Math.max(1, ...result.items.flatMap((i) => Object.entries(i.counts).filter(([k]) => k !== 'total').map(([, v]) => v)));
  const columns = [
    ...CLASS_ORDER.map((k) => ({ key: k as string, label: CLASS_INFO[k].short, color: CLASS_INFO[k].color })),
    ...[...extraKeys].map((k) => ({ key: k, label: k, color: 'var(--primary)' })),
  ];
  return (
    <section className="result-card" aria-label={result.title}>
      <header className="result-card__head">
        <h3 className="result-card__title">{result.title}</h3>
        <SyntheticChip kind={result.provenance.run_kind} />
      </header>
      {result.items.length === 0 ? (
        <p className="empty-note">比べる地区がありません。</p>
      ) : (
        <div className="table-scroll" role="region" aria-label={`${result.title}（横にスクロールできます）`} tabIndex={0}>
          <table className="data-table compare-table">
            <thead>
              <tr>
                <th scope="col">地区</th>
                {columns.map((c) => (
                  <th key={c.key} scope="col">
                    {c.label}
                  </th>
                ))}
                {hasTotal && <th scope="col">合計</th>}
              </tr>
            </thead>
            <tbody>
              {result.items.map((item) => (
                <tr key={item.area_id}>
                  <th scope="row">{item.name}</th>
                  {columns.map((c) => {
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
                  {hasTotal && <td className="mini-cell__value">{formatNumber(item.counts.total ?? 0)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {/* 比べる地区が無いときは、グラフにも出すものが無い */}
      {result.items.length > 0 && <ViewButtons result={result} actions={actions} />}
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
        結果領域の「地図」で、{result.candidate_ids.length > 0 ? `候補 ${formatNumber(result.candidate_ids.length)} 件を目立たせて` : 'この範囲を'}表示します。
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

export function DetectionImageCard({ result, actions }: { result: DetectionImageResult; actions: ResultActions }) {
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
        <span className="result-card__text">{result.caption}</span>
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

export function AccuracyCard({ result }: { result: AccuracyResult }) {
  return (
    <section className="result-card" aria-label={result.title}>
      <header className="result-card__head">
        <h3 className="result-card__title">{result.title}</h3>
        <SyntheticChip kind={result.provenance.run_kind} />
      </header>
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
      <p className="result-card__note">
        <Link href="/accuracy">このアプリの精度の画面で、詳しく見る</Link>
      </p>
      <ProvenanceBox provenance={result.provenance} />
    </section>
  );
}

// ---- お断り ----

export function RefusalCard({ result, actions }: { result: RefusalResult; actions: ResultActions }) {
  return (
    <section className="result-card result-card--refusal" aria-label={refusalTitle(result.reason)} role="note">
      <h3 className="result-card__title">{refusalTitle(result.reason)}</h3>
      <p className="result-card__text">{result.message}</p>
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
