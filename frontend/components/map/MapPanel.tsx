'use client';

import dynamic from 'next/dynamic';
import { useId, useMemo, useState } from 'react';
import type { AreaSummary, CandidateClass, CandidateFeature } from '../../lib/api-types';
import { isCandidateClass } from '../../lib/classes';
import { formatNumber } from '../../lib/format';
import {
  BASE_LAYERS,
  BASE_LAYER_ORDER,
  POLYGON_MIN_ZOOM,
  displayStatusText,
  nextNonce,
  type BaseLayerId,
  type MapFocus,
  type TileStatus,
} from '../../lib/map-config';
import type { AsyncState } from '../../lib/use-api';
import { ClassBadge } from '../ClassBadge';
import { multiAreaName } from '../chart/area-stats';
import { CandidateList } from './CandidateList';
import { ALL_FILTER, areaScopeIds, type MapFilter } from '../../lib/result-view';
import { SummaryStrip } from './SummaryStrip';

// Leaflet は window を触るので、サーバー側では読み込まない
const LeafletMap = dynamic(() => import('./LeafletMap'), {
  ssr: false,
  loading: () => (
    <div className="map-placeholder" role="status">
      地図を読み込んでいます…
    </div>
  ),
});

interface Props {
  areas: AreaSummary[];
  areasState: AsyncState<AreaSummary[]>;
  candidatesState: AsyncState<CandidateFeature[]>;
  reloadCandidates: () => void;
  reloadAreas: () => void;
  focus: MapFocus | null;
  selectedId: string | null;
  highlightIds: ReadonlySet<string>;
  /** 地図の印・形を選んだ（地図は動かさない） */
  onSelect: (id: string) => void;
  /** 一覧から選んだ（詳細を開き、その候補へ寄せる） */
  onOpen: (id: string) => void;
  onClearHighlight: () => void;
  /** 絞り込み（地区・分類）。渡されたときは親が持つ（チャットの回答・グラフと共有する） */
  filter?: MapFilter;
  onFilterChange?: (next: MapFilter) => void;
  /** 選択中の候補の「写真を比べる」を押した（親が結果領域を写真の比較へ切り替える）。無ければ、選択中の候補のカードを出さない */
  onComparePhotos?: (id: string) => void;
}

/** 地区の選択ボックスで、複数の地区（区など）の条件を表す項目の値。選んでも何も変えない */
const MULTI_AREA_VALUE = '__multi_area__';

const TILE_NOTICE: Record<TileStatus, string | null> = {
  ok: null,
  partial: 'この範囲の一部には、この年の写真がありません（標準地図を表示しています）。',
  none: 'この範囲には、この年の写真がありません（標準地図を表示しています）。',
};

export function MapPanel(props: Props) {
  const { areas, areasState, candidatesState, focus, selectedId, highlightIds } = props;
  const [base, setBase] = useState<BaseLayerId>('photo2023');
  const [showFrames, setShowFrames] = useState(true);
  const [tileStatus, setTileStatus] = useState<TileStatus>('ok');
  const [zoom, setZoom] = useState(0);
  const [localFocus, setLocalFocus] = useState<MapFocus | null>(null);
  // 絞り込み（地区・分類）は、親（HomeClient）が持つときはそれに従い、渡されなければ自分で持つ
  const [localFilter, setLocalFilter] = useState<MapFilter>(ALL_FILTER);
  const filter = props.filter ?? localFilter;
  const changeFilter = (next: MapFilter) => {
    setLocalFilter(next);
    props.onFilterChange?.(next);
  };
  const areaId = filter.areaId;
  const visible = filter.classes;
  // 対象の地区の集合（全地区なら null）。単一の地区も、複数の地区（区など）も、同じ集合で絞る
  const scope = useMemo(() => areaScopeIds(filter), [filter]);
  const multiName = multiAreaName(filter);
  // 一覧の API は地区を 1 つしか受けない。対象が 2 地区以上のときは、一覧の本体を出さない
  const multiArea = scope !== null && scope.size > 1;
  const listAreaId = scope !== null && scope.size === 1 ? [...scope][0]! : null;
  const selectedLabelId = useId();

  const activeFocus = localFocus && (!focus || localFocus.nonce > focus.nonce) ? localFocus : focus;

  const allFeatures = candidatesState.status === 'ready' ? candidatesState.data : null;
  // 選択中の候補は、絞り込みで地図から外れていても、地図の候補データにあればカードに出す
  const selectedFeature = useMemo(
    () => (selectedId && allFeatures ? (allFeatures.find((f) => f.properties.id === selectedId) ?? null) : null),
    [selectedId, allFeatures],
  );
  // 「写真を比べる」を受ける親がいないとき（onComparePhotos が無い）は、押せないカードを出さず、読み上げもしない
  const selectedCard = props.onComparePhotos ? selectedFeature : null;
  const features = useMemo(() => {
    if (!allFeatures) return [];
    return allFeatures.filter((f) => visible.has(f.properties.class) && (scope === null || scope.has(f.properties.area_id)));
  }, [allFeatures, visible, scope]);

  const onAreaChange = (id: string) => {
    // 複数の地区の項目は、いまの条件の表示。選び直しても何も変えない
    if (id === MULTI_AREA_VALUE) return;
    // 単一の地区（または全地区）へ変える。複数の地区の条件（areaIds・scope）は、ここで消す
    changeFilter({ areaId: id, classes: filter.classes });
    const a = areas.find((x) => x.id === id);
    // 詳細は地図に重ならず、右の結果領域の別の画面に出る。右端をあける必要は無い
    if (a) setLocalFocus({ bbox: a.bbox, ids: [], nonce: nextNonce() });
  };

  // 一覧の API が受ける分類は 1 つだけ。2 分類を表示しているときは、一覧は分類で絞れない（一覧の見出しで言う）
  const onlyClass: CandidateClass | null = visible.size === 1 ? ([...visible][0] ?? null) : null;
  const notice = base === 'std' ? null : TILE_NOTICE[tileStatus];

  // 読み込み中・失敗は、地図の上に小さく 1 つだけ重ねる（地図を覆わない）。候補と地区の一覧が両方失敗したら、1 つにまとめて、再試行で両方を取り直す
  const candidatesError = candidatesState.status === 'error' ? candidatesState.error : null;
  const areasError = areasState.status === 'error' ? areasState.error : null;
  const loadFailure =
    candidatesError || areasError
      ? {
          what: candidatesError && areasError ? '候補と地区の一覧' : candidatesError ? '候補' : '地区の一覧',
          message: (candidatesError ?? areasError)!.message,
          retry: () => {
            if (candidatesError) props.reloadCandidates();
            if (areasError) props.reloadAreas();
          },
        }
      : null;

  return (
    // 外側の tabpanel が「地図」と名乗るので、ここに同じ名前のランドマークを重ねない
    <div className="map-panel">
      <div className="map-toolbar">
        <div className="map-toolbar__group" role="group" aria-label="地図の種類">
          {BASE_LAYER_ORDER.map((id) => (
            <button
              key={id}
              type="button"
              className="seg-btn"
              aria-pressed={base === id}
              onClick={() => setBase(id)}
            >
              {BASE_LAYERS[id].label}
            </button>
          ))}
        </div>
        <div className="map-toolbar__group map-toolbar__group--area">
          <label htmlFor="area-select" className="map-toolbar__label">
            地区
          </label>
          <select
            id="area-select"
            className="select"
            value={multiName ? MULTI_AREA_VALUE : areaId}
            onChange={(e) => onAreaChange(e.target.value)}
            disabled={areas.length === 0}
          >
            {multiName && <option value={MULTI_AREA_VALUE}>{multiName}（複数の地区）</option>}
            <option value="">すべて（{areas.length} 地区）</option>
            {areas.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}（{a.ward}）　{formatNumber(a.counts.total)} 件
              </option>
            ))}
          </select>
        </div>
        <label className="check">
          <input type="checkbox" checked={showFrames} onChange={(e) => setShowFrames(e.target.checked)} />
          解析した地区の枠
        </label>
      </div>

      {/* 分類の件数と、表示の切り替え（チェックボックス）を兼ねる。地図に重ねる凡例は無い */}
      <SummaryStrip areas={areas} filter={filter} onFilterChange={changeFilter} />

      <div className="map-stage">
        <LeafletMap
          base={base}
          areas={areas}
          features={features}
          showFrames={showFrames}
          selectedId={selectedId}
          highlightIds={highlightIds}
          focus={activeFocus}
          onSelect={props.onSelect}
          onAreaSelect={onAreaChange}
          onTileStatus={setTileStatus}
          onZoom={setZoom}
        />

        {/* 地図の中に重ねるので、選んでも地図の大きさは変わらず、押した印が動かない。DOM では印（Leaflet の本体）より後ろ（Tab で印から近い） */}
        {selectedCard && (
          // 印・形を選んでも、地図に留まる。写真の比較へ移るのは、ここのボタンを押したときだけ
          <div className="map-selected" role="group" aria-labelledby={selectedLabelId}>
            <span id={selectedLabelId} className="map-selected__key">
              選択中の候補
            </span>
            {isCandidateClass(selectedCard.properties.class) && <ClassBadge cls={selectedCard.properties.class} short />}
            <span className="map-selected__id">{selectedCard.properties.id}</span>
            <button
              type="button"
              className="btn btn--small map-selected__compare"
              onClick={() => props.onComparePhotos?.(selectedCard.properties.id)}
            >
              写真を比べる
            </button>
          </div>
        )}

        {/* 印を選んだこと・「写真を比べる」が出たことを、読み上げに知らせる（いつも描き、文だけを替える。role=status は、下の通知に譲る） */}
        <div className="visually-hidden" aria-live="polite" aria-atomic="true">
          {selectedCard ? `候補 ${selectedCard.properties.id} を選びました。「写真を比べる」で写真を比べられます。` : ''}
        </div>

        {(loadFailure || candidatesState.status === 'loading') && (
          <div className="map-overlay-top">
            {loadFailure ? (
              <p className="map-note map-note--error" role="alert">
                {loadFailure.what}を読み込めませんでした（{loadFailure.message}）
                <button type="button" className="btn btn--small" onClick={loadFailure.retry}>
                  再試行
                </button>
              </p>
            ) : (
              <p className="map-note" role="status">
                候補を読み込んでいます…
              </p>
            )}
          </div>
        )}
      </div>

      {/* 現在表示と、地図についての通知・案内を 1 つの帯にまとめる（長いときは折り返す）。最初の子は、現在表示の文 */}
      <div className="map-status">
        <span>{displayStatusText(base, tileStatus, allFeatures ? features.length : null)}</span>
        {highlightIds.size > 0 && (
          <button type="button" className="btn btn--small" onClick={props.onClearHighlight}>
            強調表示を解除
          </button>
        )}
        <span className="map-status__hint">印・形を選ぶと「写真を比べる」が出ます。</span>
        {notice && (
          <span className="map-status__note" role="status">
            {notice}
          </span>
        )}
        {zoom > 0 && zoom < POLYGON_MIN_ZOOM && features.length > 0 && (
          <span className="map-status__note map-status__note--soft">候補は印で表示しています。拡大すると建物の形が見えます。</span>
        )}
        {candidatesState.status === 'ready' && features.length === 0 && (
          <span className="map-status__note">
            {candidatesState.data.length === 0 ? '表示できる候補がありません。' : '条件に合う候補がありません（分類の選択を確かめてください）。'}
          </span>
        )}
      </div>

      <CandidateList areaId={listAreaId} multiArea={multiArea} cls={onlyClass} onSelect={props.onOpen} />
    </div>
  );
}
