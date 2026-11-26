'use client';

import Link from 'next/link';
import { useContext, useState } from 'react';
import { useAreas } from '../../lib/areas-context';
import type {
  AccuracyResult,
  CandidateClass,
  CompareResult,
  CountResult,
  DetectionImageResult,
  MapFocusResult,
  RefusalResult,
  TableCell,
  TableResult,
} from '../../lib/api-types';
import { CLASS_INFO, classText, isCandidateClass, refusalTitle } from '../../lib/classes';
import { countRank } from '../../lib/count-order';
import { compareSummary } from '../../lib/compare-summary';
import { candidateImageUrl } from '../../lib/api';
import { formatNumber } from '../../lib/format';
import { ALL_FILTER, areaLabel, areaScopeIds, filterFromResults } from '../../lib/result-view';
import { CandidateFeaturesContext } from '../../lib/candidates-context';
import { CandidateImage } from '../CandidateImage';
import { ClassBadge, ClassSwatch } from '../ClassBadge';
import { classOfCell, reasonOfCell } from './cell';
import { MSG_STALE_BUTTON, MSG_STALE_PHOTO } from './conversation';
import { UncertainNote } from './ClassGuide';
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

// ---- 件数 ----

/** 写真のカードで、はじめに出す件数 */
const PHOTO_FIRST = 4;

const PHOTO_YEARS = [2018, 2023] as const;

/** 写真のカード 1 枚ぶん。候補 ID は画面に出さない（読み上げの名前と写真の説明にだけ使う） */
interface PhotoItem {
  id: string;
  place: string;
  areaM2: string;
  cls: CandidateClass | null;
  reason?: string;
}

function PhotoCard({ item, tag, actions, staleRun }: { item: PhotoItem; tag: string | null; actions: ResultActions; staleRun: boolean }) {
  return (
    <li className="photo-card">
      {!staleRun && (
        <div className="image-pair">
          {PHOTO_YEARS.map((year) => (
            <CandidateImage key={year} src={candidateImageUrl(item.id, year)} year={year} candidateId={item.id} />
          ))}
        </div>
      )}
      <button
        type="button"
        className="photo-card__open"
        disabled={staleRun}
        title={staleRun ? MSG_STALE_BUTTON : undefined}
        onClick={() => actions.openCandidate(item.id)}
      >
        <span className="photo-card__place">{item.place}</span>
        <span className="photo-card__area">{item.areaM2} m²</span>
        {tag && item.cls && (
          <span className="photo-card__tag">
            <ClassSwatch cls={item.cls} size={12} />
            {tag}
          </span>
        )}
        <span className="photo-card__more">
          詳細<span className="visually-hidden">（{item.id}）</span>
        </span>
      </button>
    </li>
  );
}

/**
 * 候補を、2018 年と 2023 年の写真のカードで並べる。grouped なら、分類の見出しで区切る（items は分類ごとに続けて並んでいること）。
 * 見出しの件数は、隠れているぶんも含む。見出しがあるときのカードの札は、未判定の理由だけ。見出しが無く分類が混ざるときは、tagAll で全部に付ける
 */
function PhotoCards({
  items,
  label,
  grouped = false,
  tagAll = false,
  actions,
  staleRun = false,
}: {
  items: PhotoItem[];
  label: string;
  grouped?: boolean;
  tagAll?: boolean;
  actions: ResultActions;
  staleRun?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const shown = open ? items : items.slice(0, PHOTO_FIRST);
  const groups: { cls: CandidateClass | null; items: PhotoItem[] }[] = [];
  for (const item of shown) {
    const last = groups[groups.length - 1];
    if (last && (!grouped || last.cls === item.cls)) last.items.push(item);
    else groups.push({ cls: item.cls, items: [item] });
  }
  const tagOf = (item: PhotoItem) => {
    if (!item.cls) return null;
    if (tagAll) return classText(item.cls, item.reason);
    const held = classText(item.cls, item.reason);
    return held === CLASS_INFO[item.cls].short ? null : held;
  };
  return (
    <>
      {staleRun && <p className="empty-note">{MSG_STALE_PHOTO}</p>}
      {groups.map((group) => (
        <div key={group.items[0]?.id} className="photo-group">
          {grouped && group.cls && (
            <h4 className="photo-group__title">
              <ClassSwatch cls={group.cls} size={14} />
              {CLASS_INFO[group.cls].short}（{formatNumber(items.filter((i) => i.cls === group.cls).length)} 件）
            </h4>
          )}
          <ul className="photo-grid" aria-label={grouped && group.cls ? `${label}（${CLASS_INFO[group.cls].short}）` : label}>
            {group.items.map((item) => (
              <PhotoCard key={item.id} item={item} tag={tagOf(item)} actions={actions} staleRun={staleRun} />
            ))}
          </ul>
        </div>
      ))}
      {items.length > PHOTO_FIRST && (
        <button type="button" className="count-more" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? `先頭の ${PHOTO_FIRST} 件だけ表示` : `全 ${formatNumber(items.length)} 件を表示`}
        </button>
      )}
    </>
  );
}

// 地図は、回答の中の図（ChatPanel の renderFigure）に出る。件数のカードに、拡大ビューを開くボタンは無い
export function CountCard({
  result,
  actions,
  staleRun = false,
  part = 'all',
}: {
  result: CountResult;
  actions: ResultActions;
  staleRun?: boolean;
  part?: 'all' | 'body' | 'notes';
}) {
  const { nameOf } = useAreas();
  const features = useContext(CandidateFeaturesContext);
  const cls = isCandidateClass(result.filter?.cls) ? result.filter.cls : null;
  const filter = filterFromResults([result]) ?? ALL_FILTER;
  // 複数の地区（区など）は API の scope をそのまま出す。拡大ビューの地図・グラフに写す条件と同じ読み方
  const areaText = areaLabel(filter, nameOf) ?? '全地区';
  const uncertain = result.overall?.uncertain ?? result.breakdown.find((b) => b.key === 'uncertain')?.value ?? 0;
  // 分類で絞ったときは全体の数を、絞らないときは内訳を、見出しの下に添える
  let context: string | null = null;
  if (cls && result.overall) {
    const held = cls !== 'uncertain' && uncertain > 0 ? `（うち未判定 ${formatNumber(uncertain)} 件）` : '';
    context = `候補は全部で ${formatNumber(result.overall.total)} 件${held}`;
  } else if (!cls && result.breakdown.length > 0) {
    context = result.breakdown
      .map((b) => `${isCandidateClass(b.key) ? CLASS_INFO[b.key].short : b.label} ${formatNumber(b.value)} 件`)
      .join('・');
  }
  if (part === 'notes') {
    return (
      <div className="answer-notes">
        <ProvenanceBox provenance={result.provenance} />
      </div>
    );
  }
  const scope = areaScopeIds(filter);
  const rows =
    !features || staleRun
      ? null
      : features
          .filter((f) => (!scope || scope.has(f.properties.area_id)) && filter.classes.has(f.properties.class))
          .sort(
              (a, b) =>
                countRank(a.properties) - countRank(b.properties) ||
                b.properties.area_m2 - a.properties.area_m2 ||
                a.properties.id.localeCompare(b.properties.id),
            );
  // 写真を出せるときは、枠・見出し・内訳を出さない（件数は返答の本文が言う）。出せないとき（別の解析結果・0 件）は、見出しと内訳を残す
  const table = rows && rows.length > 0 && rows.length === result.total ? rows : null;
  return (
    <section className={table ? 'result-card result-card--plain' : 'result-card'} aria-label={result.title}>
      <header className={table ? 'result-card__head result-card__head--quiet' : 'result-card__head'}>
        <h3 className={table ? 'visually-hidden' : 'result-card__title'}>
          {cls ? CLASS_INFO[cls].short : '候補'} <span className="count-value">{formatNumber(result.total)}</span> 件（{areaText}）
        </h3>
        <SyntheticChip kind={result.provenance.run_kind} />
      </header>
      {!table && context && <p className="count-context">{context}</p>}
      {table && (
        <PhotoCards
          label="候補の写真"
          grouped={!cls}
          items={table.map(({ properties: p }) => ({
            id: p.id,
            place: nameOf(p.area_id),
            areaM2: formatNumber(p.area_m2),
            cls: isCandidateClass(p.class) ? p.class : null,
            reason: p.reason,
          }))}
          actions={actions}
        />
      )}
      {part === 'all' && <ProvenanceBox provenance={result.provenance} />}
    </section>
  );
}

// ---- 一覧 ----

function renderCell(colKey: string, value: TableCell | undefined, nameOf: (id: string) => string) {
  if (value === null || value === undefined) return '—';
  // 分類は、キーでも表示名でも、印つきの短い名前で出す（長い名前は、狭いチャットで切れる）
  const cls = colKey === 'class' ? classOfCell(value) : null;
  if (cls) return <ClassBadge cls={cls} reason={reasonOfCell(value)} short />;
  if (colKey === 'area_id' && typeof value === 'string') return nameOf(value);
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'boolean') return value ? 'はい' : 'いいえ';
  return value;
}

export function TableCard({ result, actions, staleRun = false }: { result: TableResult; actions: ResultActions; staleRun?: boolean }) {
  const { nameOf } = useAreas();
  // 候補の一覧（どの行にも候補 ID がある）は、表でなく写真のカードで出す。並びは API が返した順（面積の大きい順）のままなので、分類は見出しでなくカードに添える
  const isCandidateList = result.rows.length > 0 && result.rows.every((r) => typeof r.id === 'string' && CANDIDATE_ID.test(r.id));
  if (isCandidateList) {
    const items: PhotoItem[] = result.rows.map((row) => {
      const cls = classOfCell(row.class);
      return {
        id: row.id as string,
        place: typeof row.area === 'string' ? row.area : typeof row.area_id === 'string' ? nameOf(row.area_id) : '—',
        areaM2: typeof row.area_m2 === 'number' ? formatNumber(row.area_m2) : '—',
        cls,
        reason: reasonOfCell(row.class),
      };
    });
    return (
      <section className="result-card result-card--plain" aria-label={result.title}>
        <header className="result-card__head">
          <h3 className="result-card__title">{result.title}</h3>
          <SyntheticChip kind={result.provenance.run_kind} />
        </header>
        <PhotoCards label={result.title} items={items} tagAll actions={actions} staleRun={staleRun} />
        {result.total > result.shown && (
          <p className="result-card__note">
            全 {formatNumber(result.total)} 件中、上位 {formatNumber(result.shown)} 件
          </p>
        )}
        <ProvenanceBox provenance={result.provenance} />
      </section>
    );
  }
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
                {result.columns.map((c) => (
                  <th key={c.key} scope="col">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, i) => (
                <tr key={row.id ?? i}>
                  {result.columns.map((c) => (
                    <td key={c.key}>{renderCell(c.key, row[c.key], nameOf)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollHint>
      )}
      <p className="result-card__note">
        全 {formatNumber(result.total)} 件中 {formatNumber(result.shown)} 件を表示
      </p>
      <ProvenanceBox provenance={result.provenance} />
    </section>
  );
}

// ---- 比較 ----

/**
 * 比較のカード。地区ごとの数字の表は出さない（全地区の棒グラフが、回答の中の図に出る。分類ごとの件数は棒の中に書き、「表で見る」で表も読める）。
 * 同じ数字を表とグラフで 2 回見せず、カードは、いちばん知りたい要点（どこが多いか・全体の内訳）を言う（lib/compare-summary.ts）
 */
export function CompareCard({ result, part = 'all' }: { result: CompareResult; part?: 'all' | 'body' | 'notes' }) {
  const summary = compareSummary(result);
  // 'notes': 図のあとにまとめて置く補足（根拠）。回答の並びは「本文 → 図 → 条件 → 補足」（ChatPanel）
  if (part === 'notes') {
    return (
      <div className="answer-notes">
        <ProvenanceBox provenance={result.provenance} />
      </div>
    );
  }
  return (
    <section className={part === 'body' ? 'result-card result-card--plain' : 'result-card'} aria-label={result.title}>
      <header className="result-card__head">
        <h3 className="result-card__title">{result.title}</h3>
        <SyntheticChip kind={result.provenance.run_kind} />
      </header>
      {summary === null ? (
        <p className="empty-note">比べる地区がありません。</p>
      ) : (
        <div className="compare-summary">
          <p className="compare-summary__lead">{summary.lead}</p>
          {summary.sub && <p className="compare-summary__sub">{summary.sub}</p>}
        </div>
      )}
      {result.items.some((i) => (i.counts.uncertain ?? 0) > 0) && <UncertainNote />}
      {part === 'all' && <ProvenanceBox provenance={result.provenance} />}
    </section>
  );
}

// ---- 地図の表示 ----

export function MapFocusCard({ result, actions, staleRun = false }: { result: MapFocusResult; actions: ResultActions; staleRun?: boolean }) {
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
          disabled={staleRun}
          title={staleRun ? MSG_STALE_BUTTON : undefined}
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
  staleRun = false,
}: {
  result: DetectionImageResult;
  actions: ResultActions;
  /** 回答の本文。写真の説明（caption）がすでに本文にあれば、カードでは出さない */
  answerText?: string;
  /** 開き直した会話の、別の解析結果に基づく回答。保存された画像の URL は、いまのデータに無い候補・別の建物を指しうるので、写真を読み込まない（仕様 §7.1.5 の〔J5〕） */
  staleRun?: boolean;
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
      {staleRun ? (
        <p className="empty-note">{MSG_STALE_PHOTO}</p>
      ) : (
        <div className="image-pair">
          {images.map((img) => (
            <CandidateImage key={img.year} src={img.url} year={img.year} candidateId={result.candidate_id} />
          ))}
        </div>
      )}
      <p className="chip-row">
        {cls && <ClassBadge cls={cls} short />}
        {!saidInAnswer(answerText, result.caption) && <span className="result-card__text">{result.caption}</span>}
      </p>
      <div className="button-row">
        <button
          type="button"
          className="btn btn--primary"
          disabled={staleRun}
          title={staleRun ? MSG_STALE_BUTTON : undefined}
          onClick={() => actions.openCandidate(result.candidate_id)}
        >
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
