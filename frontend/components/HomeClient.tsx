'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  answerKey,
  applyExpandRequest,
  clearSelection,
  comparePhotos,
  detailLoaded,
  figureKinds,
  initialAnswerView,
  NO_IDS,
  openCandidate,
  selectFromMap,
  showDetailOnMap,
  showMapForFilter,
  type AnswerContext,
  type AnswerRef,
  type AnswerView,
  type ExpandRequest,
  type FigureKind,
  type Selection,
} from '../lib/answer-view';
import { getAreas, getCandidatesGeoJson } from '../lib/api';
import type { AreaSummary, CandidateDetail, CandidateFeature } from '../lib/api-types';
import { AreasProvider } from '../lib/areas-context';
import { RESULT_VIEW_ORDER, type MapFilter, type ResultView } from '../lib/result-view';
import { useAsync } from '../lib/use-api';
import { AnswerFigure, type FigureActions, type FigureData } from './AnswerFigure';
import { CandidateDrawer } from './CandidateDrawer';
import { AreaChartView } from './chart/AreaChartView';
import { ChatPanel } from './chat/ChatPanel';
import type { ChatActions } from './chat/types';
import { ExpandedView } from './ExpandedView';
import { MapPanel } from './map/MapPanel';
import { ResultTabs, resultPanelId, resultTabId, type TabId } from './ResultArea';

const loadAreas = (signal: AbortSignal) => getAreas(signal);
const loadFeatures = async (signal: AbortSignal): Promise<CandidateFeature[]> => (await getCandidatesGeoJson({}, signal)).features;
const NO_AREAS: AreaSummary[] = [];
const NO_STATES: ReadonlyMap<string, AnswerView> = new Map();

/** 「写真の比較」で候補を選んでいないときの表示 */
function PhotosEmptyState() {
  return (
    // フォーカスできる中身が無いパネルなので、外枠をフォーカスできるようにする（キーボードの人がパネルへ入れるように）
    <div className="result-area__empty" tabIndex={0}>
      <p>候補を選ぶと、2018 年と 2023 年の写真を並べて見られます。</p>
      <p className="result-area__empty-hint">地図の印、候補の一覧、チャットの結果の「詳細」から選べます。</p>
    </div>
  );
}

interface PhotosPanelProps {
  selected: Selection | null;
  /** ユーザーが「開く」ボタンを押すたびに +1。同じ候補の詳細がすでに開いているときも、見出しへフォーカスを移す合図になる */
  focusNonce: number;
  /** 「写真の比較」を見ているか（結果領域のいまの画面が写真の比較か） */
  visible: boolean;
  onClose: () => void;
  onShowOnMap: (detail: CandidateDetail) => void;
  onLoaded: (detail: CandidateDetail) => void;
}

/**
 * 「写真の比較」のパネルの中身。選んだ候補の詳細（CandidateDrawer）は、「写真の比較」が見えるまでマウントしない。
 * 地図の印を選んだだけでは、まだ見ていない詳細の通信を始めない（印を続けて押すと、その数だけ取りに行ってしまう）。
 * 一度見えた詳細は、別のタブへ替えても保つ（外すと、戻したときに取り直す）。選んだ候補が替わったら、新しい候補は、また見えるまでマウントしない。
 * 見えたときにマウントするので、詳細の「フォーカスを移すか」（autoFocus）も、見えた時点の選び方で決まる
 */
function PhotosPanel({ selected, focusNonce, visible, onClose, onShowOnMap, onLoaded }: PhotosPanelProps) {
  const id = selected?.id ?? null;
  // 詳細を見せた候補の id。見えているあいだは選択に追いつき、見えていないあいだは、同じ候補なら保ち、別の候補（または選択なし）なら外す。
  // 描画の中で、自分の state だけを直す（React が、この描画をやり直す。効果で直すと、見えた直後の 1 描画だけ遅れる）
  const [shownId, setShownId] = useState<string | null>(null);
  const nextShownId = visible || id === shownId ? id : null;
  if (nextShownId !== shownId) setShownId(nextShownId);

  if (!selected) return <PhotosEmptyState />;
  // 見えていない（hidden のパネルの中）うちは、何も描かない。見えたら、次の描画でマウントする
  if (!visible && shownId !== id) return null;
  return (
    <CandidateDrawer
      key={selected.id}
      candidateId={selected.id}
      autoFocus={selected.focus}
      focusNonce={focusNonce}
      onClose={onClose}
      onShowOnMap={onShowOnMap}
      onLoaded={onLoaded}
    />
  );
}

const TABS: readonly TabId[] = ['chat', ...RESULT_VIEW_ORDER];

/**
 * `/`: チャットの 1 列。結果のうち、グラフ・地図は、回答の中に図として出る（件数: 地図とグラフ・比較: グラフ・地図の表示: 地図。AnswerFigure）。
 * 図の「拡大」、結果カードの「詳細」「詳細を開く」「地図で見る」（地図の表示）、最初の画面の「解析した地区を地図で見る」を押したときだけ、
 * 拡大ビュー（地図・グラフ・写真の比較）が開く。回答が届いただけでは、何も開かず、何も替えない。
 * 拡大ビューは、モーダルでも横パネルでもない（ADR 0008）。全幅の、チャット・地図・グラフ・写真の 4 つのタブ（タブの帯は本文の上端。開いているあいだだけ出る。チャットは隠すだけで外さない）。幅で形は変わらない。
 * 状態の単位は回答 1 件: 回答ごとに、タブ・絞り込み・強調・選んだ候補・地図の寄せ先を持ち、会話のあいだ保つ（保存しない。地図の拡大・移動は保たない）。
 * 回答の中の図と、その回答の拡大ビューは、同じ状態を読み書きする（図で変えた絞り込みは拡大ビューに引き継がれ、逆も同じ）。
 * 拡大ビューは同時に 1 つだけ。開いているあいだだけマウントする（図は、回答の中に残る）。「新しい会話」で閉じ、回答ごとの状態を捨てる
 */
export function HomeClient() {
  const areasQ = useAsync(loadAreas);
  const candQ = useAsync(loadFeatures);
  // 回答（鍵は answerKey）ごとの状態。開いているのは、そのうち 1 つ（openKey）
  const [states, setStates] = useState<ReadonlyMap<string, AnswerView>>(NO_STATES);
  const [openKey, setOpenKey] = useState<string | null>(null);
  // コールバックの中で（再描画を待たずに）「どの回答を開いているか」を読むための控え
  const openKeyRef = useRef<string | null>(null);
  // 開いたボタン。閉じたとき、フォーカスを戻す。「新しい会話」で閉じるときは、ボタンごと消えるので戻さない（resetting。入力欄へ移る）
  const openerRef = useRef<HTMLElement | null>(null);
  const resettingRef = useRef(false);
  // ユーザーが押したボタン（チャットの「詳細」・一覧・「写真を比べる」）で詳細を開くたびに +1。すでに同じ候補の詳細が開いていて、マウントし直されないときも、見出しへ移す合図にする
  const [focusNonce, setFocusNonce] = useState(0);
  // ---- 結果のタブ（ADR 0008）----
  const baseId = useId();
  // チャットのタブを選んでいるか（開いたとき・ボタンで開き直したときは false＝開いた画面。「チャットへ戻る」・チャットのタブで true）
  const [showChat, setShowChat] = useState(false);
  // 利用者の操作で開く・別の回答へ切り替えるたびに +1（拡大ビューが、フォーカスを中へ移す合図）
  const [openNonce, setOpenNonce] = useState(0);
  // いま開いている回答の質問（どの回答かを示す行に出す）
  const [openQuestion, setOpenQuestion] = useState<string | null>(null);
  // チャット以外のタブにいる間に回答が届いた（チャットのタブに文字の印を出す）。announcement は、空のまま先に置いてあるライブ領域へ入れる 1 文
  const [unread, setUnread] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  // コールバックの中で、最新の「チャットのタブを選んでいるか」を読むための控え
  const showChatRef = useRef(showChat);
  // 「チャットへ戻る」を押したあと、フォーカスをチャットのタブへ移す合図
  const backFocusRef = useRef(false);

  const areas = areasQ.state.status === 'ready' ? areasQ.state.data : NO_AREAS;
  const features = candQ.state.status === 'ready' ? candQ.state.data : null;
  const byId = useMemo(() => new Map((features ?? []).map((f) => [f.properties.id, f])), [features]);
  // ボタンの操作が、最新の地区の一覧・候補データを読めるように控える（コールバックを、読み込みのたびに作り直さない）
  const contextRef = useRef<AnswerContext>({ areas, byId });
  useEffect(() => {
    contextRef.current = { areas, byId };
  });

  /**
   * 拡大ビューを開く（結果カードのボタン・図の「拡大」・最初の画面のボタン）。その回答の状態が無ければ（図を出す前に開くとき）、回答の結果から作る。
   * あれば（図で変えたとき・開き直すとき）、利用者が変えた状態を残し、押したボタンの画面を選ぶ
   */
  const expand = useCallback((answer: AnswerRef | null, request: ExpandRequest, from: HTMLElement | null) => {
    const key = answerKey(answer);
    const ctx = contextRef.current;
    // 開き直し・別の回答への切り替えも「新しく開いた」扱い: 閉じたとき、フォーカスは、いま押したボタンへ戻る
    if (from || openKeyRef.current === null) openerRef.current = from;
    resettingRef.current = false;
    openKeyRef.current = key;
    setStates((prev) => {
      const base = prev.get(key) ?? initialAnswerView(answer?.results ?? [], ctx);
      return new Map(prev).set(key, applyExpandRequest(base, request, ctx));
    });
    setOpenKey(key);
    setOpenQuestion(answer?.question ?? null);
    setShowChat(false);
    setUnread(false);
    setAnnouncement('');
    setOpenNonce((n) => n + 1);
    if (request.type === 'candidate' || request.type === 'compare') setFocusNonce((n) => n + 1);
  }, []);

  const close = useCallback(() => {
    openKeyRef.current = null;
    setOpenKey(null);
    setShowChat(false);
    setUnread(false);
    setAnnouncement('');
  }, []);

  /** 「新しい会話」: 拡大ビューを閉じ、回答ごとの状態をすべて捨てる（前の会話の絞り込み・強調・選んだ候補・タブ・寄せ先が、次の会話に残らないように） */
  const resetAll = useCallback(() => {
    resettingRef.current = true;
    close();
    setStates(NO_STATES);
  }, [close]);

  /** 鍵で選んだ回答の状態へ、操作を当てる（その回答の状態が無ければ、何もしない）。変わらなければ、何もしない（無駄な再描画をしない） */
  const updateAt = useCallback((key: string | null, apply: (state: AnswerView, ctx: AnswerContext) => AnswerView) => {
    if (key === null) return;
    const ctx = contextRef.current;
    setStates((prev) => {
      const cur = prev.get(key);
      if (!cur) return prev;
      const next = apply(cur, ctx);
      return next === cur ? prev : new Map(prev).set(key, next);
    });
  }, []);

  /** 開いている回答の状態へ、操作を当てる（拡大ビューの中の操作） */
  const update = useCallback((apply: (state: AnswerView, ctx: AnswerContext) => AnswerView) => updateAt(openKeyRef.current, apply), [updateAt]);

  const chatActions = useMemo<ChatActions>(() => ({ expand }), [expand]);
  const returnFocusTo = useCallback(() => (resettingRef.current ? null : openerRef.current), []);

  const chooseView = useCallback((view: ResultView) => update((s) => ({ ...s, view })), [update]);
  const changeFilter = useCallback((filter: MapFilter) => update((s) => ({ ...s, filter })), [update]);
  const clearHighlight = useCallback(() => update((s) => ({ ...s, highlightIds: NO_IDS })), [update]);
  /** 地図の一覧から: 写真の比較を開いて、見出しへフォーカスを移し、地図もその候補へ寄せる */
  const openFromList = useCallback(
    (id: string) => {
      update((s, ctx) => openCandidate(s, id, ctx));
      setFocusNonce((n) => n + 1);
    },
    [update],
  );
  /** 地図の印・形から: 地図に留まる（画面は替えない）。写真の比較へ進むのは、地図の上の「写真を比べる」を押したとき（compare） */
  const selectOnMap = useCallback((id: string) => update((s, ctx) => selectFromMap(s, id, ctx)), [update]);
  const compare = useCallback(
    (id: string) => {
      update((s) => comparePhotos(s, id));
      setFocusNonce((n) => n + 1);
    },
    [update],
  );
  const closeDrawer = useCallback(() => update(clearSelection), [update]);
  const onDetailLoaded = useCallback((detail: CandidateDetail) => update((s) => detailLoaded(s, detail)), [update]);
  const showOnMap = useCallback((detail: CandidateDetail) => update((s) => showDetailOnMap(s, detail)), [update]);
  const showMap = useCallback(() => update((s, ctx) => showMapForFilter(s, ctx)), [update]);

  // ---- 回答の中の図（地図・グラフ）。拡大ビューと同じ回答ごとの状態を、鍵（回答の ID）で選んで読み書きする ----
  const figureActions = useMemo<FigureActions>(
    () => ({
      /** はじめて図を出すとき、その回答の状態を作る（拡大ビューを先に開いて、もうあるときは、そのまま） */
      ensure: (answer) => {
        const key = answerKey(answer);
        setStates((prev) => (prev.has(key) ? prev : new Map(prev).set(key, initialAnswerView(answer.results, contextRef.current))));
      },
      setFilter: (key, filter) => updateAt(key, (s) => ({ ...s, filter })),
      clearHighlight: (key) => updateAt(key, (s) => ({ ...s, highlightIds: NO_IDS })),
      selectOnMap: (key, id) => updateAt(key, (s, ctx) => selectFromMap(s, id, ctx)),
      clearSelection: (key) => updateAt(key, clearSelection),
      expand,
    }),
    [updateAt, expand],
  );
  const figureData = useMemo<FigureData>(
    () => ({ areas, areasState: areasQ.state, candidatesState: candQ.state, reloadAreas: areasQ.reload, reloadCandidates: candQ.reload }),
    [areas, areasQ.state, areasQ.reload, candQ.state, candQ.reload],
  );
  const renderFigure = (answer: AnswerRef, kind: FigureKind) => (
    <AnswerFigure
      kind={kind}
      answer={answer}
      state={states.get(answerKey(answer))}
      withMap={figureKinds(answer.results).includes('map')}
      data={figureData}
      actions={figureActions}
    />
  );

  const current = openKey !== null ? states.get(openKey) : undefined;
  useEffect(() => {
    showChatRef.current = showChat;
  });

  const chatHidden = current !== undefined && !showChat;

  /** タブの帯から選ぶ。チャットのタブは、チャットを見せるだけ（拡大ビューは開いたまま）。ほかは、その画面を選ぶ */
  const selectTab = useCallback(
    (id: TabId) => {
      if (id === 'chat') {
        setShowChat(true);
        setUnread(false);
        setAnnouncement('');
      } else {
        setShowChat(false);
        chooseView(id);
      }
    },
    [chooseView],
  );

  /** 「チャットへ戻る」: チャットのタブへ（拡大ビューは閉じない） */
  const backToChat = useCallback(() => {
    backFocusRef.current = true;
    selectTab('chat');
  }, [selectTab]);
  useLayoutEffect(() => {
    if (!showChat || !backFocusRef.current) return;
    backFocusRef.current = false;
    document.getElementById(resultTabId(baseId, 'chat'))?.focus();
  }, [showChat, baseId]);

  /** 回答が届いたとき（チャットが知らせる）。チャット以外のタブにいるときだけ、文字の印と 1 文の知らせを出す（フォーカスも画面も動かさない） */
  const onAnswer = useCallback(() => {
    if (openKeyRef.current === null || showChatRef.current) return;
    setUnread(true);
    setAnnouncement('新しい回答が届きました');
  }, []);

  const closeButton = (
    <button type="button" className="btn expanded-view__close" title="拡大ビューを閉じます（Esc でも閉じます）" onClick={close}>
      閉じる
    </button>
  );

  return (
    <AreasProvider areas={areas}>
      <div className="home" data-open={current ? 'true' : 'false'}>
        {current && (
          // チャット・地図・グラフ・写真の 4 つのタブ。拡大ビューを開いているあいだだけ出す（最初の画面は、チャットだけ）
          <div className="home__tabs">
            <ResultTabs
              baseId={baseId}
              tabs={TABS}
              selected={showChat ? 'chat' : current.view}
              onSelect={selectTab}
              marks={unread ? { chat: '（新着）' } : undefined}
              trailing={closeButton}
              onEscape={showChat ? undefined : close}
            />
          </div>
        )}
        <div
          className="home__chat"
          hidden={chatHidden}
          // タブの画面になるとき（拡大ビューを開いているあいだ）だけ、tabpanel にする（チャットは、いつも同じ場所に置き、外さない。入力中の文・受信・スクロール位置を保つ）
          // tabIndex 0: 画面の最初の要素（会話の一覧）はフォーカスを受けないので、キーボードでタブの次に画面へ入れるようにする（APG の注 4）
          {...(current ? { id: resultPanelId(baseId, 'chat'), role: 'tabpanel', 'aria-labelledby': resultTabId(baseId, 'chat'), tabIndex: 0 } : {})}
        >
          <ChatPanel actions={chatActions} renderFigure={renderFigure} onNewConversation={resetAll} onAnswer={onAnswer} />
        </div>
        {current && (
          // 開いているあいだだけマウントする（Leaflet が、大きさの無い枠で始まらないように）。閉じると全部外す。
          // チャットのタブを選んでいるあいだは、隠すだけ（地図の位置・拡大を保つ）
          <div className="home__panel" hidden={showChat}>
            <ExpandedView
              baseId={baseId}
              view={current.view}
              onViewChange={chooseView}
              question={openQuestion}
              onClose={close}
              onBackToChat={backToChat}
              returnFocusTo={returnFocusTo}
              openNonce={openNonce}
              panels={{
                map: (
                  <MapPanel
                    areas={areas}
                    areasState={areasQ.state}
                    candidatesState={candQ.state.status === 'ready' ? { status: 'ready', data: candQ.state.data } : candQ.state}
                    reloadCandidates={candQ.reload}
                    reloadAreas={areasQ.reload}
                    focus={current.mapFocus}
                    selectedId={current.selected?.id ?? null}
                    highlightIds={current.highlightIds}
                    onSelect={selectOnMap}
                    onOpen={openFromList}
                    onClearHighlight={clearHighlight}
                    filter={current.filter}
                    onFilterChange={changeFilter}
                    onComparePhotos={compare}
                    onClearSelection={closeDrawer}
                  />
                ),
                chart: <AreaChartView areas={areas} filter={current.filter} onFilterChange={changeFilter} onShowMap={showMap} />,
                photos: (
                  <PhotosPanel
                    selected={current.selected}
                    focusNonce={focusNonce}
                    visible={current.view === 'photos'}
                    onClose={closeDrawer}
                    onShowOnMap={showOnMap}
                    onLoaded={onDetailLoaded}
                  />
                ),
              }}
            />
          </div>
        )}
        {/* 新着の知らせ。空のまま先に置き、1 文だけ入れる（role="status"。フォーカスは移さない） */}
        <p role="status" className="visually-hidden">
          {announcement}
        </p>
      </div>
    </AreasProvider>
  );
}
