'use client';

import Link from 'next/link';
import { useContext, useState } from 'react';
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
import { CLASS_INFO, isCandidateClass, refusalTitle } from '../../lib/classes';
import { countRank } from '../../lib/count-order';
import { compareSummary } from '../../lib/compare-summary';
import { isCandidateList } from '../../lib/answer-view';
import { candidateImageUrl } from '../../lib/api';
import { formatNumber } from '../../lib/format';
import { ALL_FILTER, areaLabel, areaScopeIds, filterFromResults } from '../../lib/result-view';
import { CandidateFeaturesContext } from '../../lib/candidates-context';
import { CandidateImage } from '../CandidateImage';
import { ClassBadge } from '../ClassBadge';
import { classOfCell, reasonOfCell } from './cell';
import { MSG_STALE_BUTTON, MSG_STALE_PHOTO } from './conversation';
import { ScrollHint } from './ScrollHint';
import type { ResultActions } from './types';

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

const PHOTO_YEARS = [2014, 2024] as const;

/** 写真のカード 1 枚ぶん。候補 ID は画面に出さない（読み上げの名前と写真の説明にだけ使う）。分類は回答では言わない（詳細で読める） */
interface PhotoItem {
  id: string;
  place: string;
  areaM2: string;
}

/** 写真の出典。IGN の写真は出典の記載が利用の条件（Licence Ouverte）なので、写真を出すところに添える */
function PhotoCredit() {
  return <p className="result-card__note">出典：IGN</p>;
}

function PhotoCard({ item, actions, staleRun }: { item: PhotoItem; actions: ResultActions; staleRun: boolean }) {
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
        <span className="visually-hidden">の詳細を開く（{item.id}）</span>
      </button>
    </li>
  );
}

/** 候補を、2014 年と 2024 年の写真のカードで並べる */
function PhotoCards({ items, label, actions, staleRun = false }: { items: PhotoItem[]; label: string; actions: ResultActions; staleRun?: boolean }) {
  const [open, setOpen] = useState(false);
  const shown = open ? items : items.slice(0, PHOTO_FIRST);
  return (
    <>
      {staleRun && <p className="empty-note">{MSG_STALE_PHOTO}</p>}
      <ul className="photo-grid" aria-label={label}>
        {shown.map((item) => (
          <PhotoCard key={item.id} item={item} actions={actions} staleRun={staleRun} />
        ))}
      </ul>
      {items.length > PHOTO_FIRST && (
        <button type="button" className="count-more" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? `先頭の ${PHOTO_FIRST} 件だけ表示` : `全 ${formatNumber(items.length)} 件を表示`}
        </button>
      )}
      {!staleRun && <PhotoCredit />}
    </>
  );
}

// 地図は、回答の中の図（ChatPanel の renderFigure）に出る。件数のカードに、拡大ビューを開くボタンは無い
export function CountCard({
  result,
  actions,
  staleRun = false,
}: {
  result: CountResult;
  actions: ResultActions;
  staleRun?: boolean;
}) {
  const { nameOf } = useAreas();
  const features = useContext(CandidateFeaturesContext);
  // 条件か内訳の無い件数は、壊れた結果。条件が分からないまま「全地区」の件数として出さず、代わりの表示にする（ResultCard の境界が受ける）
  if (!result.filter || !Array.isArray(result.breakdown)) throw new Error('壊れた件数の結果（filter・breakdown が無い）');
  const cls = isCandidateClass(result.filter.cls) ? result.filter.cls : null;
  const filter = filterFromResults([result]) ?? ALL_FILTER;
  // 複数の地区（区など）は API の scope をそのまま出す。拡大ビューの地図・グラフに写す条件と同じ読み方
  const areaText = areaLabel(filter, nameOf) ?? '全地区';
  // 分類で絞ったときだけ、全体の数を添える（写真を出せないとき）
  const context = cls && result.overall ? `候補は全部で ${formatNumber(result.overall.total)} 件` : null;
  const scope = areaScopeIds(filter);
  const rows =
    !features || staleRun
      ? null
      : features
          // 分類を指定しない件数は、API の合計と同じく全部の分類（画面の表示用の分類で絞ると、合計と合わなくなる）
          .filter((f) => (!scope || scope.has(f.properties.area_id)) && (cls === null || f.properties.class === cls))
          .sort(
              (a, b) =>
                countRank(a.properties) - countRank(b.properties) ||
                b.properties.area_m2 - a.properties.area_m2 ||
                a.properties.id.localeCompare(b.properties.id),
            );
  // 写真を出せるときは、枠と見出しを出さない（件数は返答の本文が言う）。出せないとき（別の解析結果・0 件）は、見出しを残す
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
          items={table.map(({ properties: p }) => ({ id: p.id, place: nameOf(p.area_id), areaM2: formatNumber(p.area_m2) }))}
          actions={actions}
        />
      )}
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
  // 候補の一覧（どの行にも候補 ID がある）は、表でなく写真のカードで出す。並びは API が返した順（面積の大きい順）のまま
  if (isCandidateList(result)) {
    const items: PhotoItem[] = result.rows.map((row) => ({
      id: row.id as string,
      place: typeof row.area === 'string' ? row.area : typeof row.area_id === 'string' ? nameOf(row.area_id) : '—',
      areaM2: typeof row.area_m2 === 'number' ? formatNumber(row.area_m2) : '—',
    }));
    return (
      <section className="result-card result-card--plain" aria-label={result.title}>
        <header className="result-card__head">
          <h3 className="result-card__title">{result.title}</h3>
          <SyntheticChip kind={result.provenance.run_kind} />
        </header>
        <PhotoCards label={result.title} items={items} actions={actions} staleRun={staleRun} />
        {result.total > result.shown && (
          <p className="result-card__note">
            全 {formatNumber(result.total)} 件中、上位 {formatNumber(result.shown)} 件
          </p>
        )}
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
    </section>
  );
}

// ---- 比較 ----

/**
 * 比較のカード。回答の並びは「本文 → 合計の 1 行 → グラフ」。結論は返答の本文、地区ごとの数字は回答の中のグラフ（「表で見る」で表も読める）が言うので、
 * カードは、グラフに無い全体の合計と内訳だけを 1 行で言う（lib/compare-summary.ts）。枠は付けず、題は読み上げ用にする。
 * 別の解析結果の回答はグラフが出ないので、最も多い地区の文も出す
 */
export function CompareCard({ result, staleRun = false }: { result: CompareResult; staleRun?: boolean }) {
  const summary = compareSummary(result);
  return (
    <section className={summary ? 'result-card result-card--plain' : 'result-card'} aria-label={result.title}>
      <header className={summary ? 'result-card__head result-card__head--quiet' : 'result-card__head'}>
        <h3 className={summary ? 'visually-hidden' : 'result-card__title'}>{result.title}</h3>
        <SyntheticChip kind={result.provenance.run_kind} />
      </header>
      {summary === null ? (
        <p className="empty-note">比べる地区がありません。</p>
      ) : (
        <p className="compare-summary">{staleRun || !summary.sub ? `${summary.lead}${summary.sub ?? ''}` : summary.sub}</p>
      )}
    </section>
  );
}

// ---- 地図の表示 ----

export function MapFocusCard({
  result,
  actions,
  staleRun = false,
  chipOnly = false,
}: {
  result: MapFocusResult;
  actions: ResultActions;
  staleRun?: boolean;
  chipOnly?: boolean;
}) {
  // 回答の中の地図が同じことを見せるとき（または 2 位以下のとき）は、合成データの印だけを出す
  if (chipOnly) return <SyntheticChip kind={result.provenance.run_kind} />;
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
  const images =
    result.images.length > 0
      ? result.images
      : [2014, 2024].map((year) => ({ year, url: candidateImageUrl(result.candidate_id, year) }));
  return (
    <section className="result-card" aria-label={result.title}>
      <header className="result-card__head">
        <h3 className="result-card__title">{result.title}</h3>
        <SyntheticChip kind={result.provenance.run_kind} />
      </header>
      {staleRun ? (
        <p className="empty-note">{MSG_STALE_PHOTO}</p>
      ) : (
        // 写真を押すと詳細が開く（ボタンは写真に重ねる。文字のリンクは置かない）
        <div className="photo-open">
          <div className="image-pair">
            {images.map((img) => (
              <CandidateImage key={img.year} src={img.url} year={img.year} candidateId={result.candidate_id} />
            ))}
          </div>
          <button type="button" className="photo-open__hit" onClick={() => actions.openCandidate(result.candidate_id)}>
            <span className="visually-hidden">詳細を開く（{result.candidate_id}）</span>
          </button>
        </div>
      )}
      {!saidInAnswer(answerText, result.caption) && <p className="result-card__text">{result.caption}</p>}
      {!staleRun && <PhotoCredit />}
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
            機械が見つけた建物のうち、正解の建物データと一致したのは約 <b>{percent(precision)}</b>。建物データにある建物のうち、機械が見つけられたのは約{' '}
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
