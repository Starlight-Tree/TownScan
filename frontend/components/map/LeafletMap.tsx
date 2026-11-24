'use client';

// 地図の描画（Leaflet）。React の外にある命令的な部品なので、状態は props から差分で反映する。
// 選んだ理由: ラスタータイル（地理院）と GeoJSON の重ね描きだけで足り、WebGL を要さず軽い（MapLibre GL JS は不要）。
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef } from 'react';
import type { AreaSummary, CandidateClass, CandidateFeature } from '../../lib/api-types';
import { CLASS_INFO, isCandidateClass } from '../../lib/classes';
import {
  areasBBox,
  ATTRIBUTION,
  BASE_LAYERS,
  BLANK_TILE,
  DEFAULT_CENTER,
  DEFAULT_ZOOM,
  MAX_ZOOM,
  MIN_ZOOM,
  POLYGON_MIN_ZOOM,
  STD_URL,
  toLatLngs,
  type BaseLayerId,
  type MapFocus,
  type TileStatus,
} from '../../lib/map-config';
import { formatArea } from '../../lib/format';
import { readCssColor, useThemeVersion } from '../../lib/theme-colors';

export interface LeafletMapProps {
  base: BaseLayerId;
  areas: AreaSummary[];
  features: CandidateFeature[];
  showFrames: boolean;
  selectedId: string | null;
  highlightIds: ReadonlySet<string>;
  focus: MapFocus | null;
  onSelect: (id: string) => void;
  onAreaSelect: (areaId: string) => void;
  onTileStatus: (status: TileStatus) => void;
  onZoom: (zoom: number) => void;
}

interface Entry {
  cls: CandidateClass;
  latlngs: L.LatLngExpression[][];
  /** 形（ポリゴン）を入れているグループ。選択・強調の輪を、必要なときだけ足し引きする */
  polys: L.LayerGroup;
  casing: L.Polygon;
  poly: L.Polygon;
  /** 選択・強調の輪（黄色）。選んだときだけ作る。普通の候補は、縁と本線の 2 本だけ */
  ring: L.Polygon | null;
  marker: L.Marker;
}

type Mark = 'normal' | 'highlight' | 'selected';

/**
 * 地図の上に描く線の色。値は CSS の変数（app/globals.css の --map-*）にあり、ここでは実際の値を読むだけ。
 * 背景は航空写真なので、線の下に「縁」を敷いて見せる。縁は線の色の反対側（ライトは白、ダークは黒に近い色）。
 */
function mapColors() {
  return {
    casing: readCssColor('--map-casing'),
    frame: readCssColor('--map-frame'),
    select: readCssColor('--map-select'),
    highlight: readCssColor('--map-highlight'),
  };
}

function markerIcon(cls: CandidateClass, mark: Mark): L.DivIcon {
  const info = CLASS_INFO[cls];
  return L.divIcon({
    className: 'cand-marker',
    html: `<span class="cand-dot cand-dot--${info.shape} is-${mark}" style="--c:${info.color}"></span>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

export default function LeafletMap(props: LeafletMapProps) {
  const { base, areas, features, showFrames, selectedId, highlightIds, focus } = props;
  // テーマが変わるたびに増える。色は JS の値として Leaflet に渡しているので、増えたら線と塗りを描き直す（印・集計の帯の分類の印・ツールチップは CSS の変数なので、自然に追従する）
  const themeVersion = useThemeVersion();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const entriesRef = useRef<Map<string, Entry>>(new Map());
  const fittedRef = useRef(false);
  const callbacks = useRef({
    onSelect: props.onSelect,
    onAreaSelect: props.onAreaSelect,
    onTileStatus: props.onTileStatus,
    onZoom: props.onZoom,
  });

  useEffect(() => {
    callbacks.current = {
      onSelect: props.onSelect,
      onAreaSelect: props.onAreaSelect,
      onTileStatus: props.onTileStatus,
      onZoom: props.onZoom,
    };
  });

  // ---- 地図の生成 ----
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const map = L.map(el, {
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      attributionControl: false,
      zoomSnap: 0.5,
    });
    L.control.attribution({ prefix: false, position: 'bottomright' }).addTo(map);
    // 選択・強調の輪は専用の pane（印・輪郭の overlayPane=400 より下）に描く。縮小表示のあいだ輪郭のグループが地図から外れていると、
    // 輪を作った順が輪郭より後になり、拡大したとき輪が候補の縁と本線の上に出てしまう。pane で、描く順に依らず重なりを固定する
    map.createPane('ring').style.zIndex = '399';
    mapRef.current = map;
    fittedRef.current = false;
    const onZoomEnd = () => callbacks.current.onZoom(map.getZoom());
    map.on('zoomend', onZoomEnd);
    onZoomEnd();
    // 枠の大きさが変わったら地図に知らせる（Leaflet は window の大きさしか見ない）。結果領域の「拡大」で、チャットの列が狭まって地図の枠が広がる（戻すと縮む）ため。
    // invalidateSize は、中心と縮尺を変えずに、枠・タイルを描き直す。
    // タブで隠れても枠は 0×0 にならない（結果領域の CSS は display: none でなく visibility: hidden）ので、0 を避ける処理や、見えるまで待つ処理は要らない
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => map.invalidateSize()) : null;
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      map.off('zoomend', onZoomEnd);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // ---- 下地（標準地図 / 年度別の写真）。写真は標準地図の上に重ね、タイルが無い範囲でも崩さない ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const def = BASE_LAYERS[base];
    const common = { maxZoom: MAX_ZOOM, minZoom: MIN_ZOOM, errorTileUrl: BLANK_TILE, attribution: ATTRIBUTION, keepBuffer: 2 };
    const under = L.tileLayer(STD_URL, { ...common, maxNativeZoom: BASE_LAYERS.std.maxNativeZoom, zIndex: 1 }).addTo(map);
    let photo: L.TileLayer | null = null;
    let ok = 0;
    let bad = 0;
    if (def.photo) {
      photo = L.tileLayer(def.url, { ...common, maxNativeZoom: def.maxNativeZoom, zIndex: 2 }).addTo(map);
      photo.on('loading', () => {
        ok = 0;
        bad = 0;
      });
      photo.on('tileload', () => {
        ok += 1;
      });
      photo.on('tileerror', () => {
        bad += 1;
      });
      photo.on('load', () => {
        callbacks.current.onTileStatus(bad === 0 ? 'ok' : ok === 0 ? 'none' : 'partial');
      });
    }
    callbacks.current.onTileStatus('ok');
    return () => {
      photo?.off();
      photo?.remove();
      under.remove();
    };
  }, [base]);

  // ---- 解析地区の枠 ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !showFrames || areas.length === 0) return;
    const group = L.layerGroup();
    const colors = mapColors();
    for (const a of areas) {
      const [w, s, e, n] = a.bbox;
      const bounds: L.LatLngBoundsExpression = [
        [s, w],
        [n, e],
      ];
      L.rectangle(bounds, { color: colors.casing, weight: 5, opacity: 0.8, fill: false, interactive: false }).addTo(group);
      const frame = L.rectangle(bounds, {
        color: colors.frame,
        weight: 2,
        dashArray: '8 5',
        fillColor: colors.frame,
        fillOpacity: 0.03,
      });
      // 文字列で渡すと Leaflet が innerHTML に入れる。地区名は外部の応答由来なので、textContent の要素で渡す
      const tip = document.createElement('div');
      tip.textContent = `${a.name}（${a.ward}）　候補 ${a.counts.total} 件`;
      frame.bindTooltip(tip, { sticky: true, direction: 'top' });
      frame.on('click', () => callbacks.current.onAreaSelect(a.id));
      frame.addTo(group);
    }
    group.addTo(map);
    return () => {
      group.remove();
    };
  }, [areas, showFrames, themeVersion]);

  // ---- 候補（広く見るときは印、拡大すると形） ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const polys = L.layerGroup();
    const dots = L.layerGroup();
    const entries = new Map<string, Entry>();
    const colors = mapColors();
    for (const f of features) {
      const cls = f.properties.class;
      if (!isCandidateClass(cls)) continue;
      const info = CLASS_INFO[cls];
      const latlngs = toLatLngs(f.geometry) as L.LatLngExpression[][];
      const id = f.properties.id;
      const casing = L.polygon(latlngs, { color: colors.casing, weight: 5, opacity: 0.9, fill: false, interactive: false });
      const lineColor = readCssColor(info.cssVar);
      const poly = L.polygon(latlngs, {
        color: lineColor,
        weight: 2.5,
        dashArray: info.dash,
        lineCap: info.shape === 'triangle' ? 'round' : 'butt',
        fillColor: lineColor,
        fillOpacity: info.fillOpacity,
      });
      poly.on('click', () => callbacks.current.onSelect(id));
      const marker = L.marker(poly.getBounds().getCenter(), {
        icon: markerIcon(cls, 'normal'),
        keyboard: true,
        title: `${info.short}・${formatArea(f.properties.area_m2)}（Enter で選ぶ）`,
      });
      marker.on('click', () => callbacks.current.onSelect(id));
      polys.addLayer(casing);
      polys.addLayer(poly);
      dots.addLayer(marker);
      entries.set(id, { cls, latlngs, polys, casing, poly, ring: null, marker });
    }
    entriesRef.current = entries;

    const sync = () => {
      const showPolys = map.getZoom() >= POLYGON_MIN_ZOOM;
      if (showPolys) {
        dots.remove();
        if (!map.hasLayer(polys)) polys.addTo(map);
      } else {
        polys.remove();
        if (!map.hasLayer(dots)) dots.addTo(map);
      }
    };
    sync();
    map.on('zoomend', sync);
    return () => {
      map.off('zoomend', sync);
      polys.remove();
      dots.remove();
      entriesRef.current = new Map();
    };
  }, [features, themeVersion]);

  // ---- 選択・強調の見た目 ----
  // 輪（黄色）→ 縁 → 本線の順に重ねる。縁を間に挟むので、ライト・ダークのどちらの線の色も、黄色の上で見分けられる
  useEffect(() => {
    const colors = mapColors();
    for (const [id, e] of entriesRef.current) {
      const selected = id === selectedId;
      const highlighted = highlightIds.has(id);
      const emphasized = selected || highlighted;
      const mark: Mark = selected ? 'selected' : highlighted ? 'highlight' : 'normal';
      e.casing.setStyle({
        color: colors.casing,
        weight: selected ? 8 : highlighted ? 6.5 : 5,
        opacity: emphasized ? 1 : 0.9,
      });
      if (emphasized) {
        e.ring ??= L.polygon(e.latlngs, { pane: 'ring', fill: false, interactive: false });
        e.ring.setStyle({ color: selected ? colors.select : colors.highlight, weight: selected ? 14 : 10, opacity: 1 });
        e.polys.addLayer(e.ring);
      } else if (e.ring) {
        e.polys.removeLayer(e.ring);
      }
      e.poly.setStyle({ weight: selected ? 4 : highlighted ? 3.5 : 2.5 });
      e.marker.setIcon(markerIcon(e.cls, mark));
      e.marker.setZIndexOffset(selected ? 2000 : highlighted ? 1000 : 0);
      if (emphasized) {
        e.ring?.bringToFront();
        e.casing.bringToFront();
        e.poly.bringToFront();
      }
    }
  }, [selectedId, highlightIds, features, themeVersion]);

  // ---- 寄せる ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focus) return;
    // チャット・選択が先に地図を動かしたので、全地区への初回の寄せは要らない（後から来た地区の一覧で、動かした位置を戻さない）
    fittedRef.current = true;
    const [w, s, e, n] = focus.bbox;
    map.fitBounds(
      [
        [s, w],
        [n, e],
      ],
      {
        maxZoom: 19,
        paddingTopLeft: [32, 32],
        paddingBottomRight: [32, 32],
      },
    );
    // nonce が変わるたびに 1 回だけ動かす
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce]);

  // ---- 初回: 全地区が収まるように、1 度だけ寄せる ----
  // 地区の一覧が届いたとき、まだ誰も地図を動かしていなければ。上の寄せる処理が先に動いていれば（fittedRef が立つ）、何もしない
  useEffect(() => {
    const map = mapRef.current;
    if (!map || fittedRef.current || areas.length === 0) return;
    const box = areasBBox(areas);
    if (!box) return;
    fittedRef.current = true;
    map.fitBounds(
      [
        [box[1], box[0]],
        [box[3], box[2]],
      ],
      { padding: [40, 40], maxZoom: 17, animate: false },
    );
  }, [areas]);

  return (
    <div
      ref={containerRef}
      className="leaflet-host"
      role="application"
      aria-label="地図。矢印キーで移動、プラス・マイナスキーで拡大・縮小。候補の印は Tab で選べます"
    />
  );
}
