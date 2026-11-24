'use client';

import { useCallback, useMemo, useState } from 'react';
import { getAreas, getCandidatesGeoJson } from '../lib/api';
import type { AreaSummary, BBox, CandidateDetail, CandidateFeature } from '../lib/api-types';
import { AreasProvider } from '../lib/areas-context';
import { drawerPad, featureBBox, nextNonce, WIDE_MIN_WIDTH, type MapFocus } from '../lib/map-config';
import { useAsync } from '../lib/use-api';
import { CandidateDrawer } from './CandidateDrawer';
import { ChatPanel } from './chat/ChatPanel';
import { MapPanel } from './map/MapPanel';

const loadAreas = (signal: AbortSignal) => getAreas(signal);
const loadFeatures = async (signal: AbortSignal): Promise<CandidateFeature[]> => (await getCandidatesGeoJson({}, signal)).features;
const NO_AREAS: AreaSummary[] = [];
const NO_IDS: ReadonlySet<string> = new Set();

/** `/`: 左にチャット、右に地図。結果カード・地図・ドロワーの間の受け渡しをここで持つ */
export function HomeClient() {
  const areasQ = useAsync(loadAreas);
  const candQ = useAsync(loadFeatures);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focus, setFocus] = useState<MapFocus | null>(null);
  const [highlightIds, setHighlightIds] = useState<ReadonlySet<string>>(NO_IDS);
  // 詳細を開いたとき、地図の候補データにまだ形が無ければ、詳細が届いてから寄せる
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);
  // 狭い画面で「地図で見る」を押したとき、選択は残したままドロワーだけ隠す
  const [drawerHidden, setDrawerHidden] = useState(false);

  const areas = areasQ.state.status === 'ready' ? areasQ.state.data : NO_AREAS;
  const features = candQ.state.status === 'ready' ? candQ.state.data : null;
  const byId = useMemo(() => new Map((features ?? []).map((f) => [f.properties.id, f])), [features]);

  const fitTo = useCallback((bbox: BBox, ids: string[], withDrawer: boolean) => {
    setFocus({ kind: 'fit', bbox, ids, padRight: withDrawer ? drawerPad() : 0, nonce: nextNonce() });
  }, []);

  /** チャットの表・検出画像・一覧から: 詳細を開いて、その候補へ寄せる */
  const openCandidate = useCallback(
    (id: string) => {
      setSelectedId(id);
      setDrawerHidden(false);
      const f = byId.get(id);
      const box = f ? featureBBox(f) : null;
      if (box) {
        setPendingFocusId(null);
        fitTo(box, [id], true);
      } else {
        setPendingFocusId(id);
      }
    },
    [byId, fitTo],
  );

  /** 地図の印・形から: 動かさず、ドロワーに隠れる位置なら見える所へずらす */
  const selectFromMap = useCallback(
    (id: string) => {
      setSelectedId(id);
      setDrawerHidden(false);
      setPendingFocusId(null);
      const f = byId.get(id);
      const box = f ? featureBBox(f) : null;
      if (box) {
        setFocus({
          kind: 'reveal',
          point: [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2],
          padRight: drawerPad(),
          nonce: nextNonce(),
        });
      }
    },
    [byId],
  );

  const focusMap = useCallback(
    (target: { bbox: BBox; candidateIds: string[] }) => {
      setHighlightIds(new Set(target.candidateIds));
      fitTo(target.bbox, target.candidateIds, false);
    },
    [fitTo],
  );

  const chatActions = useMemo(() => ({ openCandidate, focusMap }), [openCandidate, focusMap]);

  const closeDrawer = useCallback(() => {
    setSelectedId(null);
    setPendingFocusId(null);
  }, []);

  const onDetailLoaded = useCallback(
    (detail: CandidateDetail) => {
      if (pendingFocusId === detail.id && detail.bbox) {
        setPendingFocusId(null);
        fitTo(detail.bbox, [detail.id], true);
      }
    },
    [pendingFocusId, fitTo],
  );

  const showOnMap = useCallback(
    (detail: CandidateDetail) => {
      const wide = typeof window !== 'undefined' && window.innerWidth >= WIDE_MIN_WIDTH;
      fitTo(detail.bbox, [detail.id], wide);
      // 狭い画面ではドロワーが地図をふさぐので隠す（選択の強調は残す）
      if (!wide) setDrawerHidden(true);
    },
    [fitTo],
  );

  const drawerId = selectedId && !drawerHidden ? selectedId : null;

  return (
    <AreasProvider areas={areas}>
      <div className="home">
        <ChatPanel actions={chatActions} />
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
        />
      </div>
      {drawerId && (
        <CandidateDrawer
          key={drawerId}
          candidateId={drawerId}
          onClose={closeDrawer}
          onShowOnMap={showOnMap}
          onLoaded={onDetailLoaded}
        />
      )}
    </AreasProvider>
  );
}
