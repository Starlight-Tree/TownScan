'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getAreas, getCandidatesGeoJson } from '../lib/api';
import type { AreaSummary, BBox, CandidateDetail, CandidateFeature, ToolResult } from '../lib/api-types';
import { AreasProvider } from '../lib/areas-context';
import { featureBBox, nextNonce, scopeBBox, type MapFocus } from '../lib/map-config';
import {
  ALL_FILTER,
  areaScopeIds,
  filterFromResults,
  isWellFormedResult,
  RESULT_VIEW_LABELS,
  viewForResults,
  widenFilterFor,
  type MapFilter,
  type ResultView,
} from '../lib/result-view';
import { useAsync } from '../lib/use-api';
import { CandidateDrawer } from './CandidateDrawer';
import { AreaChartView } from './chart/AreaChartView';
import { ChatPanel } from './chat/ChatPanel';
import type { ChatActions } from './chat/types';
import { MapPanel } from './map/MapPanel';
import { ResultArea } from './ResultArea';

const loadAreas = (signal: AbortSignal) => getAreas(signal);
const loadFeatures = async (signal: AbortSignal): Promise<CandidateFeature[]> => (await getCandidatesGeoJson({}, signal)).features;
const NO_AREAS: AreaSummary[] = [];
const NO_IDS: ReadonlySet<string> = new Set();

/** 詳細（写真の比較）で選んでいる候補。focus は、その詳細を開いたとき見出しへフォーカスを移すか（詳細をマウントする時点の値で決まる。PhotosPanel は、写真の比較が見えるまでマウントしない） */
interface Selection {
  id: string;
  focus: boolean;
}

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

/** `/`: 左にチャット、右に結果領域（地図・グラフ・写真の比較）。回答・地図・グラフ・詳細の間の受け渡しをここで持つ */
export function HomeClient() {
  const areasQ = useAsync(loadAreas);
  const candQ = useAsync(loadFeatures);
  const [selected, setSelected] = useState<Selection | null>(null);
  const selectedId = selected?.id ?? null;
  // ユーザーが押したボタン（チャットの「詳細」・一覧・「写真を比べる」）で詳細を開くたびに +1。すでに同じ候補の詳細が開いていて、マウントし直されないときも、見出しへ移す合図にする
  const [focusNonce, setFocusNonce] = useState(0);
  const [focus, setFocus] = useState<MapFocus | null>(null);
  const [highlightIds, setHighlightIds] = useState<ReadonlySet<string>>(NO_IDS);
  // 詳細を開いたとき、地図の候補データにまだ形が無ければ、詳細が届いてから寄せる
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);
  const [view, setView] = useState<ResultView>('map');
  // 地図・グラフ・一覧に共通の絞り込み。チャットの回答（件数の条件）と、地図・グラフの操作が、同じものを書き換える
  const [filter, setFilter] = useState<MapFilter>(ALL_FILTER);
  const [announcement, setAnnouncement] = useState('');
  // 「いまの画面」を、コールバックの中で（再描画を待たずに）読むための控え。同じ画面への切り替えは、読み上げない
  const viewRef = useRef<ResultView>('map');
  // 結果領域を広げているか（チャットの列を狭める）。保存はしない
  const [expanded, setExpanded] = useState(false);
  // 回答・結果カード・詳細の操作で画面を替えるたびに +1（画面が同じでも）。縦に積む幅で、結果領域が見える所までスクロールする合図
  const [revealNonce, setRevealNonce] = useState(0);

  const areas = areasQ.state.status === 'ready' ? areasQ.state.data : NO_AREAS;
  const features = candQ.state.status === 'ready' ? candQ.state.data : null;
  const byId = useMemo(() => new Map((features ?? []).map((f) => [f.properties.id, f])), [features]);
  // 返答待ちの通信の途中で届く操作（answered・focusMap）が、古い byId を読まないように、最新のものを控える
  const byIdRef = useRef(byId);
  // 「地図で見る」が、いまの絞り込み・地区の一覧を読めるように（コールバックを、絞り込みが替わるたびに作り直さない）
  const filterRef = useRef(filter);
  const areasRef = useRef(areas);
  useEffect(() => {
    byIdRef.current = byId;
    filterRef.current = filter;
    areasRef.current = areas;
  });

  /**
   * 画面を替える。announce は、ユーザーのタブ操作ではなく、回答・結果カード・詳細の操作から替えたとき。
   * 見えない live region で知らせる（画面の外でボタンを押した人は、右が替わったことに気づけない）。フォーカスは動かさない。
   * 同じ操作の中で続けて 2 回呼ばれる（地図の表示と回答）ことがあり、2 回目は画面が変わらない。そのとき 1 回目の知らせを消さない。
   * 知らせを消すのは、ユーザー自身のタブ操作（announce が false）のときだけ
   */
  const applyView = useCallback((next: ResultView, announce: boolean) => {
    const changed = viewRef.current !== next;
    viewRef.current = next;
    setView(next);
    if (!announce) {
      setAnnouncement('');
      return;
    }
    if (changed) setAnnouncement(`「${RESULT_VIEW_LABELS[next]}」を表示しました`);
    setRevealNonce((n) => n + 1);
  }, []);
  const chooseView = useCallback((next: ResultView) => applyView(next, false), [applyView]);
  const switchView = useCallback((next: ResultView) => applyView(next, true), [applyView]);

  /**
   * 強調・選択する候補が、いまの絞り込みで隠れないように広げる（分類が無ければ足し、地区が外なら全地区に戻す）。
   * まだ読み込まれていない候補（byId に無い）は、何もしない
   */
  const revealInFilter = useCallback((ids: readonly string[]) => {
    const targets = ids.flatMap((id) => {
      const f = byIdRef.current.get(id);
      return f ? [f.properties] : [];
    });
    if (targets.length > 0) setFilter((cur) => targets.reduce((acc, t) => widenFilterFor(acc, t), cur));
  }, []);

  // 詳細は結果領域の中（地図に重ならない）なので、寄せるときに右の余白を空ける必要は無い
  const fitTo = useCallback((bbox: BBox, ids: string[]) => {
    setFocus({ bbox, ids, nonce: nextNonce() });
  }, []);

  /** 候補を選び、地図もその候補へ寄せる（画面は替えない）。focus は、開く詳細が見出しへフォーカスを移すか */
  const selectCandidate = useCallback(
    (id: string, focus: boolean) => {
      setSelected({ id, focus });
      revealInFilter([id]);
      const f = byIdRef.current.get(id);
      const box = f ? featureBBox(f) : null;
      if (box) {
        setPendingFocusId(null);
        fitTo(box, [id]);
      } else {
        setPendingFocusId(id);
      }
    },
    [fitTo, revealInFilter],
  );

  /** チャットの表・検出画像のカード・一覧から（ユーザーが押したボタン）: 写真の比較を開いて、見出しへフォーカスを移し、地図もその候補へ寄せる */
  const openCandidate = useCallback(
    (id: string) => {
      selectCandidate(id, true);
      setFocusNonce((n) => n + 1);
      switchView('photos');
    },
    [selectCandidate, switchView],
  );

  /**
   * 地図の印・形から: 地図に留まる（画面は替えない）。その候補を選んで強調し、フォーカスは地図に残す。
   * 写真の比較へ進むのは、地図の上の「写真を比べる」を押したとき（comparePhotos）
   */
  const selectFromMap = useCallback(
    (id: string) => {
      setSelected({ id, focus: false });
      setPendingFocusId(null);
      revealInFilter([id]);
    },
    [revealInFilter],
  );

  /** 地図の上の「写真を比べる」: その候補を選んで（すでに選んでいても）写真の比較へ切り替える。押したボタンが隠れるので、フォーカスは ResultArea がタブへ移す */
  const comparePhotos = useCallback(
    (id: string) => {
      setSelected({ id, focus: true });
      setFocusNonce((n) => n + 1);
      switchView('photos');
    },
    [switchView],
  );

  const focusMap = useCallback(
    (target: { bbox: BBox; candidateIds: string[] }) => {
      setHighlightIds(new Set(target.candidateIds));
      revealInFilter(target.candidateIds);
      fitTo(target.bbox, target.candidateIds);
      switchView('map');
    },
    [fitTo, revealInFilter, switchView],
  );

  /**
   * 回答が届いた: 合う画面へ切り替え、件数・比較の条件を地図・グラフの絞り込みに写す（どちらも、無ければ今のまま。手で選んだ画面は、この呼び出しまで保つ）。
   * 検出画像があれば、その候補を（チャットの入力のフォーカスを奪わずに）選ぶ
   */
  const answered = useCallback(
    (results: ToolResult[]) => {
      const next = viewForResults(results.map((r) => r.type));
      if (next) switchView(next);
      // 回答の「対象・条件」の行（AnswerScope）と同じ前処理: 壊れた結果（filter の無い count）は、条件なしと読まず、飛ばす
      const nextFilter = filterFromResults(results.filter(isWellFormedResult));
      if (nextFilter) setFilter(nextFilter);
      // ChatPanel は、地図の表示（focusMap）のあとにこれを呼ぶ。上の絞り込みの置き換えで、強調した候補がまた隠れないように、広げ直す
      for (const r of results) if (r.type === 'map_focus' && Array.isArray(r.candidate_ids)) revealInFilter(r.candidate_ids);
      const detection = [...results].reverse().find((r) => r.type === 'detection_image');
      if (detection?.type === 'detection_image' && typeof detection.candidate_id === 'string' && detection.candidate_id !== '') {
        selectCandidate(detection.candidate_id, false);
      }
    },
    [revealInFilter, selectCandidate, switchView],
  );

  /** 回答のカードの「グラフで見る」「地図で見る」: カードの条件を渡されたら、地図・グラフの絞り込みをそれに替えてから切り替える */
  const showView = useCallback(
    (next: ResultView, nextFilter?: MapFilter) => {
      if (nextFilter) setFilter(nextFilter);
      // 地図を見せるときは、その条件の地区（なければ全地区）が収まる範囲へ寄せる。地図がすでに出ていて拡大・移動したあとでも、押して何も変わらない、をなくす
      if (next === 'map') {
        const box = scopeBBox(areasRef.current, areaScopeIds(nextFilter ?? filterRef.current));
        if (box) fitTo(box, []);
      }
      switchView(next);
    },
    [fitTo, switchView],
  );

  const chatActions = useMemo<ChatActions>(
    () => ({ openCandidate, focusMap, showView, answered }),
    [openCandidate, focusMap, showView, answered],
  );

  const toggleExpanded = useCallback(() => setExpanded((e) => !e), []);

  const closeDrawer = useCallback(() => {
    setSelected(null);
    setPendingFocusId(null);
  }, []);

  const onDetailLoaded = useCallback(
    (detail: CandidateDetail) => {
      if (pendingFocusId === detail.id && detail.bbox) {
        setPendingFocusId(null);
        fitTo(detail.bbox, [detail.id]);
      }
    },
    [pendingFocusId, fitTo],
  );

  const showOnMap = useCallback(
    (detail: CandidateDetail) => {
      // 詳細の分類・地区で広げる（まだ地図の候補データに無い候補でも、詳細は届いている）
      setFilter((cur) => widenFilterFor(cur, detail));
      fitTo(detail.bbox, [detail.id]);
      switchView('map');
    },
    [fitTo, switchView],
  );

  return (
    <AreasProvider areas={areas}>
      <div className={expanded ? 'home home--expanded' : 'home'}>
        <ChatPanel actions={chatActions} />
        <ResultArea
          view={view}
          onViewChange={chooseView}
          announcement={announcement}
          expanded={expanded}
          onToggleExpanded={toggleExpanded}
          revealNonce={revealNonce}
          panels={{
            map: (
              <MapPanel
                areas={areas}
                areasState={areasQ.state}
                candidatesState={candQ.state.status === 'ready' ? { status: 'ready', data: candQ.state.data } : candQ.state}
                reloadCandidates={candQ.reload}
                reloadAreas={areasQ.reload}
                focus={focus}
                selectedId={selectedId}
                highlightIds={highlightIds}
                onSelect={selectFromMap}
                onOpen={openCandidate}
                onClearHighlight={() => setHighlightIds(NO_IDS)}
                filter={filter}
                onFilterChange={setFilter}
                onComparePhotos={comparePhotos}
                onClearSelection={closeDrawer}
              />
            ),
            chart: <AreaChartView areas={areas} filter={filter} onFilterChange={setFilter} onShowMap={() => showView('map')} />,
            photos: (
              <PhotosPanel
                selected={selected}
                focusNonce={focusNonce}
                visible={view === 'photos'}
                onClose={closeDrawer}
                onShowOnMap={showOnMap}
                onLoaded={onDetailLoaded}
              />
            ),
          }}
        />
      </div>
    </AreasProvider>
  );
}
