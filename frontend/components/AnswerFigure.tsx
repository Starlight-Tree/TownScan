'use client';

import { memo, useEffect, useId, useRef, type ReactNode } from 'react';
import { answerKey, type AnswerRef, type AnswerView, type ExpandRequest, type FigureKind } from '../lib/answer-view';
import type { AreaSummary, CandidateFeature } from '../lib/api-types';
import type { MapFilter } from '../lib/result-view';
import type { AsyncState } from '../lib/use-api';
import { useNearViewport } from '../lib/use-near-viewport';
import { AreaChartView } from './chart/AreaChartView';
import { MapPanel } from './map/MapPanel';
import { ResultPanelBoundary } from './ResultPanelBoundary';

/** 図が読むデータ（拡大ビューの地図・グラフと同じもの。HomeClient が読み込む） */
export interface FigureData {
  areas: AreaSummary[];
  areasState: AsyncState<AreaSummary[]>;
  candidatesState: AsyncState<CandidateFeature[]>;
  reloadAreas: () => void;
  reloadCandidates: () => void;
}

/**
 * 図の操作。どれも、どの回答の図かを渡して、その回答の状態へ当てる（拡大ビューを開いている回答と同じ状態。HomeClient が持つ）。
 * 絞り込み・強調・選択は、図で変えると拡大ビューへ引き継がれ、拡大ビューで変えると図にも写る
 */
export interface FigureActions {
  /** その回答の状態が無ければ、回答の結果から作る（はじめて図を出すとき） */
  ensure: (answer: AnswerRef) => void;
  setFilter: (key: string, filter: MapFilter) => void;
  clearHighlight: (key: string) => void;
  selectOnMap: (key: string, id: string) => void;
  clearSelection: (key: string) => void;
  /** その回答の拡大ビューを開く。opener は、閉じたときにフォーカスを戻す要素（図の「拡大」ボタン） */
  expand: (answer: AnswerRef, request: ExpandRequest, opener: HTMLElement | null) => void;
  /** 広い幅で、その回答をパネルが表示中のとき、図の 1 行を押したら、フォーカスをパネルへ移す */
  focusPanel: () => void;
}

interface Props {
  kind: FigureKind;
  answer: AnswerRef;
  /** その回答の状態。まだ無いあいだ（地区・候補の読み込み中、または作る前の 1 描画）は undefined */
  state: AnswerView | undefined;
  /** 同じ回答に、地図の図もあるか（あれば、グラフの「地図で見る」は要らない。地図が、すぐ近くにある） */
  withMap: boolean;
  /** 広い幅で、この回答を、横のパネルが表示中か。そのとき、図は「右のパネルで表示中」の 1 行になる（同じ図が 2 つ出て、連動がどちらに効くか曖昧になるのを避ける。ADR 0007） */
  inPanel: boolean;
  data: FigureData;
  actions: FigureActions;
}

const LABEL: Record<FigureKind, string> = { map: '地図', chart: 'グラフ' };

/**
 * 回答の中に出す図（地図・グラフ）。結果カードの並びの下に、結果カードと同じ幅・枠で出る。
 * 状態は、拡大ビューと同じ回答ごとの状態（HomeClient が持つ）を読み、操作は同じ関数で当てる。
 * 「拡大」を押すと、その回答の拡大ビューを、この図の画面で開く（閉じたとき、フォーカスは「拡大」へ戻る）。
 * 写真の比較は図に入れない（地図の「写真を比べる」・一覧、チャットの「詳細」で、拡大ビューが写真の比較で開く）。
 *
 * - 地図（Leaflet）は、画面に近づくまでマウントしない（チャットを流すだけで、地図を何枚も作らない）。一度マウントしたら保つ。
 *   広い幅で、横のパネルがこの回答を表示中のあいだは、図の中身を外し、「右のパネルで表示中」の 1 行にする（`inPanel`。頭の行のボタンが、その 1 行。押すとパネルへフォーカスが移る）。
 *   パネルを閉じる・別の回答へ切り替えると、図に戻る（地図は、一度近づいた扱いを保つので、すぐマウントする。閉じたあとのフォーカスの戻り先は、同じボタン）。
 *   狭い幅は、図を外さない（チャットは隠すだけ）。
 * - 名前つきの region（`aria-live="off"`）。回答が増えたとき、図の中身（地図の印・凡例・一覧）を、チャットの読み上げ（role="log"）が読み上げないようにする。
 *   図の中の、自分で知らせる部品（地図の選択の知らせ）は、そのまま読み上げる。キーボードは、図の中を Tab で巡って、そのまま抜けられる（トラップは作らない）
 */
export const AnswerFigure = memo(AnswerFigureView, (a, b) => {
  // チャットは、入力のたびに描き直す。回答の ID と結果・状態・データ・操作が同じなら、図（地図）は描き直さない（answer は、描くたびに作る入れ物なので、中身で比べる）
  return (
    a.kind === b.kind &&
    a.answer.id === b.answer.id &&
    a.answer.results === b.answer.results &&
    a.state === b.state &&
    a.withMap === b.withMap &&
    a.inPanel === b.inPanel &&
    a.data === b.data &&
    a.actions === b.actions
  );
});

function AnswerFigureView({ kind, answer, state, withMap, inPanel, data, actions }: Props) {
  const key = answerKey(answer);
  const label = LABEL[kind];
  const titleId = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  const expandRef = useRef<HTMLButtonElement>(null);
  // 遅らせるのは地図だけ（グラフは HTML と CSS だけで軽く、出す前後で高さが変わって、下の内容を動かさないよう、すぐ出す）
  const near = useNearViewport(bodyRef, { rootSelector: '.chat__scroll', enabled: kind === 'map' });
  // 状態は、地区の一覧・候補データが届いて（失敗も含む）から作る。拡大ビューをはじめて開くときと同じく、読み込み済みの値で、はじめの絞り込み・寄せ先を決める
  const ready = data.areasState.status !== 'loading' && data.candidatesState.status !== 'loading';
  const { id, results } = answer;
  const hasState = state !== undefined;
  const { ensure } = actions;
  useEffect(() => {
    if (ready && !hasState) ensure({ id, results });
  }, [ready, hasState, ensure, id, results]);

  // 「拡大」: 開く画面は、この図の画面。フォーカスの戻し先は、図の中の部品ではなく、この「拡大」ボタン（図の中の部品は、開いたあとも残るが、拡大ビューが閉じたときに戻す先は 1 つに決める）
  const expand = (request: ExpandRequest) => actions.expand(answer, request, expandRef.current);

  let body: ReactNode;
  if (inPanel) {
    // 中身は外す（本体の枠 bodyRef は残す。地図が近づいたかの観測は、パネルを閉じたあとも続く）
    body = null;
  } else if (!state || !near) {
    body = (
      <p className={`answer-figure__placeholder answer-figure__placeholder--${kind}`}>
        {label}を読み込んでいます…
      </p>
    );
  } else if (kind === 'map') {
    body = (
      <div className="answer-figure__map">
        <MapPanel
          inline
          areas={data.areas}
          areasState={data.areasState}
          candidatesState={data.candidatesState}
          reloadCandidates={data.reloadCandidates}
          reloadAreas={data.reloadAreas}
          focus={state.mapFocus}
          selectedId={state.selected?.id ?? null}
          highlightIds={state.highlightIds}
          onSelect={(cid) => actions.selectOnMap(key, cid)}
          onOpen={(cid) => expand({ type: 'candidate', id: cid })}
          onClearHighlight={() => actions.clearHighlight(key)}
          filter={state.filter}
          onFilterChange={(next) => actions.setFilter(key, next)}
          onComparePhotos={(cid) => expand({ type: 'compare', id: cid })}
          onClearSelection={() => actions.clearSelection(key)}
        />
      </div>
    );
  } else {
    body = (
      <AreaChartView
        areas={data.areas}
        filter={state.filter}
        onFilterChange={(next) => actions.setFilter(key, next)}
        onShowMap={withMap ? undefined : () => expand({ type: 'view', view: 'map' })}
      />
    );
  }

  return (
    <section className={`result-card answer-figure answer-figure--${kind}`} aria-labelledby={titleId} aria-live="off">
      <header className="answer-figure__head">
        <p id={titleId} className="answer-figure__title">
          {label}
        </p>
        <button
          ref={expandRef}
          type="button"
          className="btn btn--small"
          aria-label={inPanel ? `${label}は右のパネルで表示中。押すとパネルへ移ります` : `${label}を拡大ビューで開く`}
          title={inPanel ? 'パネルへ移ります' : `${label}を大きな画面で開きます`}
          onClick={() => (inPanel ? actions.focusPanel() : expand({ type: 'view', view: kind }))}
        >
          {inPanel ? '右のパネルで表示中' : '拡大'}
        </button>
      </header>
      <div className="answer-figure__body" ref={bodyRef} hidden={inPanel}>
        <ResultPanelBoundary name={label}>{body}</ResultPanelBoundary>
      </div>
    </section>
  );
}
