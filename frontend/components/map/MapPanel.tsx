'use client';

import dynamic from 'next/dynamic';
import { useMemo, useState } from 'react';
import type { AreaSummary, CandidateClass, CandidateFeature } from '../../lib/api-types';
import { CLASS_INFO, CLASS_ORDER } from '../../lib/classes';
import { formatNumber } from '../../lib/format';
import {
  BASE_LAYERS,
  BASE_LAYER_ORDER,
  POLYGON_MIN_ZOOM,
  nextNonce,
  drawerPad,
  type BaseLayerId,
  type MapFocus,
} from '../../lib/map-config';
import type { AsyncState } from '../../lib/use-api';
import { ClassSwatch } from '../ClassBadge';
import { CandidateList } from './CandidateList';
import type { TileStatus } from './LeafletMap';

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
}

const TILE_NOTICE: Record<TileStatus, string | null> = {
  ok: null,
  partial: 'この範囲の一部には、この年の写真がありません（標準地図を表示しています）。',
  none: 'この範囲には、この年の写真がありません（標準地図を表示しています）。',
};

export function MapPanel(props: Props) {
  const { areas, areasState, candidatesState, focus, selectedId, highlightIds } = props;
  const [base, setBase] = useState<BaseLayerId>('photo2023');
  const [visible, setVisible] = useState<Set<CandidateClass>>(new Set(CLASS_ORDER));
  const [areaId, setAreaId] = useState<string>('');
  const [showFrames, setShowFrames] = useState(true);
  const [tileStatus, setTileStatus] = useState<TileStatus>('ok');
  const [zoom, setZoom] = useState(0);
  const [localFocus, setLocalFocus] = useState<MapFocus | null>(null);

  const activeFocus = localFocus && (!focus || localFocus.nonce > focus.nonce) ? localFocus : focus;

  const allFeatures = candidatesState.status === 'ready' ? candidatesState.data : null;
  const features = useMemo(() => {
    if (!allFeatures) return [];
    return allFeatures.filter(
      (f) => visible.has(f.properties.class) && (areaId === '' || f.properties.area_id === areaId),
    );
  }, [allFeatures, visible, areaId]);

  const counts = useMemo(() => {
    const sum: Record<CandidateClass, number> = { confirmed_new: 0, existing_omission: 0, uncertain: 0 };
    for (const a of areas) {
      if (areaId !== '' && a.id !== areaId) continue;
      for (const c of CLASS_ORDER) sum[c] += a.counts[c] ?? 0;
    }
    return sum;
  }, [areas, areaId]);

  const toggleClass = (c: CandidateClass) =>
    setVisible((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });

  const onAreaChange = (id: string) => {
    setAreaId(id);
    const a = areas.find((x) => x.id === id);
    if (a) setLocalFocus({ kind: 'fit', bbox: a.bbox, ids: [], padRight: drawerPad() > 0 && selectedId ? drawerPad() : 0, nonce: nextNonce() });
  };

  const onlyClass: CandidateClass | null = visible.size === 1 ? ([...visible][0] ?? null) : null;
  const notice = base === 'std' ? null : TILE_NOTICE[tileStatus];

  return (
    <section className="map-panel" aria-label="地図">
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
        <div className="map-toolbar__group">
          <label htmlFor="area-select" className="map-toolbar__label">
            地区
          </label>
          <select
            id="area-select"
            className="select"
            value={areaId}
            onChange={(e) => onAreaChange(e.target.value)}
            disabled={areas.length === 0}
          >
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

        <fieldset className="legend">
          <legend>表示する分類（色・線・形で区別）</legend>
          {CLASS_ORDER.map((c) => (
            <label key={c} className="legend__row">
              <input type="checkbox" checked={visible.has(c)} onChange={() => toggleClass(c)} />
              <ClassSwatch cls={c} />
              <span className="legend__label">{CLASS_INFO[c].label}</span>
              <span className="legend__count">{formatNumber(counts[c])}</span>
            </label>
          ))}
        </fieldset>

        <div className="map-overlay-top">
          {notice && (
            <p className="map-note" role="status">
              {notice}
            </p>
          )}
          {zoom > 0 && zoom < POLYGON_MIN_ZOOM && features.length > 0 && (
            <p className="map-note map-note--soft">候補は印で表示しています。拡大すると建物の形が見えます。</p>
          )}
          {candidatesState.status === 'loading' && (
            <p className="map-note" role="status">
              候補を読み込んでいます…
            </p>
          )}
          {candidatesState.status === 'error' && (
            <p className="map-note map-note--error" role="alert">
              候補を読み込めませんでした（{candidatesState.error.message}）
              <button type="button" className="btn btn--small" onClick={props.reloadCandidates}>
                再試行
              </button>
            </p>
          )}
          {areasState.status === 'error' && (
            <p className="map-note map-note--error" role="alert">
              地区の一覧を読み込めませんでした（{areasState.error.message}）
              <button type="button" className="btn btn--small" onClick={props.reloadAreas}>
                再試行
              </button>
            </p>
          )}
          {candidatesState.status === 'ready' && features.length === 0 && (
            <p className="map-note">
              {candidatesState.data.length === 0 ? '表示できる候補がありません。' : '条件に合う候補がありません（分類の選択を確かめてください）。'}
            </p>
          )}
        </div>
      </div>

      <div className="map-status">
        <span>
          表示中: {BASE_LAYERS[base].label}・候補 {formatNumber(features.length)} 件
        </span>
        {highlightIds.size > 0 && (
          <button type="button" className="btn btn--small" onClick={props.onClearHighlight}>
            強調表示を解除
          </button>
        )}
        <span className="map-status__hint">候補の印・形を選ぶと、詳細が開きます。</span>
      </div>

      <CandidateList areaId={areaId || null} cls={onlyClass} onSelect={props.onOpen} />
    </section>
  );
}
