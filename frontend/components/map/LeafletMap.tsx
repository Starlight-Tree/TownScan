'use client';

// 地図の描画（Leaflet）。React の外にある命令的な部品なので、状態は props から差分で反映する。
// 選んだ理由: ラスタータイル（地理院）と GeoJSON の重ね描きだけで足り、WebGL を要さず軽い（MapLibre GL JS は不要）。
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
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
  prefersReducedMotion,
  shiftAboveCover,
  toLatLngs,
  type BaseLayerId,
  type MapFocus,
  type PixelBox,
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
  /** 地図の空いている所を押した（選択を外す）。無ければ何もしない */
  onClearSelection?: () => void;
  /**
   * 地図の上に重ねた部品（選択中の候補のカード）の要素。選んだ印・フォーカスした印が、この部品の下に隠れるときだけ、地図を上へ寄せる。
   * 寄せる・移すときの下の余白も、この部品の分だけ広げる。無い（要素が null）ときは、何もしない
   */
  coverRef?: RefObject<HTMLElement | null>;
  /**
   * 回答の中の図（チャットのスクロールの中）。ホイールを回しても、フォーカスが地図に無いあいだは、拡大・縮小しない（ページのスクロールを奪わない）。
   * 地図を押す・Tab で地図へ入る（フォーカスが着く）と、ホイールでも拡大・縮小できる。地図を作るときの値で決まり、あとから替えない
   */
  guardWheel?: boolean;
}

interface Entry {
  cls: CandidateClass;
  /** 印・形の名前（読み上げ・ツールチップ。「新規出現・231.9 m²」） */
  label: string;
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

type Direction = 'left' | 'right' | 'up' | 'down';

const ARROW_DIRECTION: Record<string, Direction> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };

/** 地図の空いている所を押してから、選択を外すまでの待ち（ミリ秒）。ダブルクリックの拡大（2 回の click のあとに dblclick）で、選択を外さないため */
const CLEAR_DELAY = 300;

/** 印の箱の一辺（px）。見た目の点は 18px で、まわりに余白を持つ。押せる大きさの目安 24px（WCAG 2.2 の 2.5.8）に合わせる */
const MARKER_BOX = 24;

/** 印の箱（24px）の対角の半分。マウスで押した所から、この距離にある印は「押した印の候補」として、いちばん近いものを選ぶ */
const HIT_RADIUS = 17;

/** カードの下に隠れるかを見るときの、印の中心から外側へ見る距離（選択中の印の輪・フォーカスの輪まで含む）と、形（ポリゴン）の外側の余白（選択の輪の太さ） */
const MARKER_REACH = 18;
const SHAPE_REACH = 9;
/** カードの上端から、寄せたあとの印の下端までの空き */
const COVER_GAP = 8;

/** 「動きを減らす」設定のときだけ、動かす呼び出しに足す。Leaflet の animate は、未指定なら状況で決め、true にすると必ず動かすので、false のときだけ渡す */
const noAnimationIfReduced = (): { animate?: false } => (prefersReducedMotion() ? { animate: false } : {});

/** フォーカスが、キーボードの操作で着いたか（マウスで押して着いたときは、押した印が動かないよう、寄せない）。判定できない環境では true */
function isKeyboardFocus(target: EventTarget | null): boolean {
  try {
    return !(target instanceof Element) || target.matches(':focus-visible');
  } catch {
    return true;
  }
}

/**
 * from の印から、矢印の向き（画面の上下左右）にいちばん近い印の id。その向きに印が無ければ null。
 * 向きに沿った距離に、横へのずれを 2 倍で足した値が小さいものを選ぶ（まっすぐ先にある印を、斜めの印より先に選ぶ）
 */
function neighbourId(map: L.Map, entries: Map<string, Entry>, from: string, dir: Direction): string | null {
  const origin = entries.get(from);
  if (!origin) return null;
  const o = map.latLngToContainerPoint(origin.marker.getLatLng());
  let best: string | null = null;
  let bestCost = Infinity;
  for (const [id, e] of entries) {
    if (id === from) continue;
    const p = map.latLngToContainerPoint(e.marker.getLatLng());
    const dx = p.x - o.x;
    const dy = p.y - o.y;
    const along = dir === 'right' ? dx : dir === 'left' ? -dx : dir === 'down' ? dy : -dy;
    if (along <= 0) continue;
    const across = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
    const cost = along + 2 * across;
    if (cost < bestCost) {
      best = id;
      bestCost = cost;
    }
  }
  return best;
}

/**
 * 押した所に、実際にいちばん近い印の id。重なった印では、手前（地図の下寄り）の印の箱が、奥の印の中心を覆い、
 * 見えている丸を押しても裏の三角が選ばれてしまう。押した所から印の中心までの距離で決めれば、見えている印を押した通りに選べる。
 * 中心が同じ距離なら、イベントを受けた印（fallback。手前に見えている印）のまま
 */
function nearestId(map: L.Map, entries: Map<string, Entry>, pointer: MouseEvent, fallback: string): string {
  const at = map.mouseEventToContainerPoint(pointer);
  const distance = (e: Entry) => map.latLngToContainerPoint(e.marker.getLatLng()).distanceTo(at);
  const own = entries.get(fallback);
  let best = fallback;
  let bestDistance = own ? distance(own) : Infinity;
  for (const [id, e] of entries) {
    if (id === fallback) continue;
    const d = distance(e);
    if (d <= HIT_RADIUS && d < bestDistance) {
      best = id;
      bestDistance = d;
    }
  }
  return best;
}

function markerIcon(cls: CandidateClass, mark: Mark): L.DivIcon {
  const info = CLASS_INFO[cls];
  return L.divIcon({
    className: 'cand-marker',
    html: `<span class="cand-dot cand-dot--${info.shape} is-${mark}" style="--c:${info.color}"></span>`,
    iconSize: [MARKER_BOX, MARKER_BOX],
    iconAnchor: [MARKER_BOX / 2, MARKER_BOX / 2],
  });
}

export default function LeafletMap(props: LeafletMapProps) {
  const { base, areas, features, showFrames, selectedId, highlightIds, focus } = props;
  // 回答の中の図か。地図を作るときの値で決める（あとから替えない）
  const [guardWheel] = useState(props.guardWheel === true);
  // テーマが変わるたびに増える。色は JS の値として Leaflet に渡しているので、増えたら線と塗りを描き直す（印・集計の帯の分類の印・ツールチップは CSS の変数なので、自然に追従する）
  const themeVersion = useThemeVersion();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const entriesRef = useRef<Map<string, Entry>>(new Map());
  const fittedRef = useRef(false);
  // Tab が止まる印・形の id（1 つだけ。矢印キーで動かす roving tabindex）。選択中の候補の id は、aria-pressed のために控える
  const tabStopRef = useRef<string | null>(null);
  const selectedRef = useRef<string | null>(selectedId);
  const callbacks = useRef({
    onSelect: props.onSelect,
    onAreaSelect: props.onAreaSelect,
    onTileStatus: props.onTileStatus,
    onZoom: props.onZoom,
    onClearSelection: props.onClearSelection,
    coverRef: props.coverRef,
  });

  useEffect(() => {
    callbacks.current = {
      onSelect: props.onSelect,
      onAreaSelect: props.onAreaSelect,
      onTileStatus: props.onTileStatus,
      onZoom: props.onZoom,
      onClearSelection: props.onClearSelection,
      coverRef: props.coverRef,
    };
  });

  /** 地図の上に重ねた部品（カード）の、地図の枠の中の位置。部品が無い・大きさが無い（描かれていない）ときは null */
  const coverBox = useCallback((): PixelBox | null => {
    const host = containerRef.current;
    const card = callbacks.current.coverRef?.current;
    if (!host || !card) return null;
    const h = host.getBoundingClientRect();
    const c = card.getBoundingClientRect();
    if (c.width === 0 && c.height === 0) return null;
    return { top: c.top - h.top, bottom: c.bottom - h.top, left: c.left - h.left, right: c.right - h.left };
  }, []);

  /**
   * 候補 id の印（拡大して形のときは形）が、カードの下に隠れるなら、隠れない所まで、地図を上へ寄せる。
   * 隠れないなら何もしない（利用者が動かした地図を、引き戻さない）。選んだ候補と、キーボードでフォーカスした候補に使う
   */
  const revealAboveCover = useCallback(
    (id: string) => {
      const map = mapRef.current;
      const e = entriesRef.current.get(id);
      const cover = coverBox();
      if (!map || !e || !cover) return;
      let target: PixelBox;
      if (map.getZoom() >= POLYGON_MIN_ZOOM) {
        const b = e.poly.getBounds();
        const sw = map.latLngToContainerPoint(b.getSouthWest());
        const ne = map.latLngToContainerPoint(b.getNorthEast());
        target = { left: sw.x - SHAPE_REACH, right: ne.x + SHAPE_REACH, top: ne.y - SHAPE_REACH, bottom: sw.y + SHAPE_REACH };
      } else {
        const p = map.latLngToContainerPoint(e.marker.getLatLng());
        target = { left: p.x - MARKER_REACH, right: p.x + MARKER_REACH, top: p.y - MARKER_REACH, bottom: p.y + MARKER_REACH };
      }
      const dy = shiftAboveCover(target, cover, COVER_GAP);
      if (dy > 0) map.panBy([0, dy]);
    },
    [coverBox],
  );

  /**
   * 印（広く見るとき）・形（拡大したとき）のキーボード向けの属性を付け直す。
   * Leaflet の keyboard: true は、すべての印を Tab の停止にする（候補が多いと、何十回も Tab が要る）ので使わず、ここで role・名前・選択の状態を付ける。
   * Tab が止まるのは 1 つだけ（tabindex=0。ほかは -1）。印を作り直す・アイコンを替える・拡大の切り替えで要素が作られるたびに呼ぶ
   */
  const refreshKeys = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const entries = entriesRef.current;
    const showPolys = map.getZoom() >= POLYGON_MIN_ZOOM;
    const wanted = tabStopRef.current;
    const selected = selectedRef.current;
    const tabId =
      wanted !== null && entries.has(wanted) ? wanted : selected !== null && entries.has(selected) ? selected : (entries.keys().next().value ?? null);
    for (const [id, e] of entries) {
      const el = (showPolys ? e.poly : e.marker).getElement();
      if (!el) continue;
      el.setAttribute('role', 'button');
      el.setAttribute('tabindex', id === tabId ? '0' : '-1');
      el.setAttribute('aria-pressed', id === selected ? 'true' : 'false');
      el.setAttribute('aria-label', e.label);
    }
  }, []);

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
      // 既定の拡大・縮小ボタンの名前は英語（Zoom in / Zoom out）。日本語の名前で作り直す
      zoomControl: false,
      zoomSnap: 0.5,
      // 「動きを減らす」設定のときは、拡大縮小・パンの動きを止める（動かす呼び出しも、animate: false で呼ぶ）
      ...(prefersReducedMotion() ? { zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false, inertia: false } : {}),
    });
    // パンの動き（キーボードの矢印・ドラッグのあとの慣性・寄せる動き）は、Leaflet が animate 未指定で panBy を呼ぶ。「動きを減らす」設定のときは、その呼び出しを止める
    // （設定は呼ぶたびに見るので、地図を開いたあとに設定を替えても追従する。拡大縮小の動きは、上の地図の生成の指定）
    const panBy = map.panBy.bind(map);
    map.panBy = (offset, options) => panBy(offset, prefersReducedMotion() ? { ...options, animate: false } : options);
    L.control.zoom({ position: 'topleft', zoomInTitle: '地図を拡大', zoomOutTitle: '地図を縮小' }).addTo(map);
    L.control.attribution({ prefix: false, position: 'bottomright' }).addTo(map);
    // Tab の順は DOM の順。Leaflet は操作部品（拡大・縮小・出典）を地図の部品の後ろに置くので、見た目は左上なのに Tab では候補の印の後ろになる。
    // 部品は z-index で重なりを決めている（DOM の順に依らない）ので、見た目を変えずに、先頭へ移せる
    const controls = Array.from(el.children).find((c) => c.classList.contains('leaflet-control-container'));
    if (controls) el.prepend(controls);
    // 選択・強調の輪は専用の pane（印・輪郭の overlayPane=400 より下）に描く。縮小表示のあいだ輪郭のグループが地図から外れていると、
    // 輪を作った順が輪郭より後になり、拡大したとき輪が候補の縁と本線の上に出てしまう。pane で、描く順に依らず重なりを固定する
    map.createPane('ring').style.zIndex = '399';
    mapRef.current = map;
    fittedRef.current = false;
    const onZoomEnd = () => callbacks.current.onZoom(map.getZoom());
    map.on('zoomend', onZoomEnd);
    onZoomEnd();
    // 地図の空いている所を押したら、選択を外す（印・形・地区の枠は、押しても地図へ伝えない: bubblingMouseEvents: false）。ドラッグのあとの click は、Leaflet が出さない。
    // ダブルクリックで拡大するときは、選択を外さない: click のあと少し待ち、dblclick が来たら取り消す
    let clearTimer: number | undefined;
    const cancelClear = () => window.clearTimeout(clearTimer);
    const onMapClick = () => {
      cancelClear();
      clearTimer = window.setTimeout(() => callbacks.current.onClearSelection?.(), CLEAR_DELAY);
    };
    map.on('click', onMapClick);
    map.on('dblclick', cancelClear);
    // フォーカスが印・形に着いたら、そこを Tab の停止にする（マウスで押したときも、Tab で着いたときも）
    const onFocusIn = (ev: FocusEvent) => {
      for (const [id, e] of entriesRef.current) {
        if (e.marker.getElement() === ev.target || e.poly.getElement() === ev.target) {
          tabStopRef.current = id;
          refreshKeys();
          // キーボードで着いた印が、選択中のカードの下に隠れるなら、フォーカスの輪が見えるよう、上へ寄せる（マウスで押したときは動かさない: 押した印が、押している間に動かないように）
          if (isKeyboardFocus(ev.target)) revealAboveCover(id);
          return;
        }
      }
    };
    el.addEventListener('focusin', onFocusIn);
    // 回答の中の図: フォーカスが地図に無いあいだは、ホイールで拡大・縮小しない（チャットをホイールで流すとき、地図の上を通っても止まらないように）。
    // 地図を押す・Tab で入る（Leaflet は、押したとき地図へフォーカスを移す）と有効にし、フォーカスが地図の外へ出たら、また止める
    const wheelOn = () => map.scrollWheelZoom.enable();
    const wheelOff = (ev: FocusEvent) => {
      if (!(ev.relatedTarget instanceof Node && el.contains(ev.relatedTarget))) map.scrollWheelZoom.disable();
    };
    if (guardWheel) {
      map.scrollWheelZoom.disable();
      el.addEventListener('focusin', wheelOn);
      el.addEventListener('focusout', wheelOff);
    }
    // 枠の大きさが変わったら地図に知らせる（Leaflet は window の大きさしか見ない）。拡大ビュー（ダイアログ）の枠は、窓の大きさに合わせて広がり縮むため。
    // invalidateSize は、中心と縮尺を変えずに、枠・タイルを描き直す。
    // タブで隠れても枠は 0×0 にならない（結果領域の CSS は display: none でなく visibility: hidden）ので、0 を避ける処理や、見えるまで待つ処理は要らない
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => map.invalidateSize()) : null;
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      el.removeEventListener('focusin', onFocusIn);
      el.removeEventListener('focusin', wheelOn);
      el.removeEventListener('focusout', wheelOff);
      map.off('zoomend', onZoomEnd);
      map.off('click', onMapClick);
      map.off('dblclick', cancelClear);
      cancelClear();
      map.remove();
      mapRef.current = null;
    };
  }, [guardWheel, refreshKeys, revealAboveCover]);

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
      // 先に外す。層を地図から外すとき、Leaflet は層自身の 'remove' の受け口を使って、地図に登録した処理（viewreset・zoom・moveend など）を解く。
      // 先に photo.off() で受け口をすべて消すと、その処理が地図に残り、次に地図の表示が変わるとき（fitBounds など）、
      // 地図から外れた層（_map が null）が呼ばれて「Cannot read properties of null (reading 'getCenter')」で落ちる（年を切り替えたあとに候補を選ぶと再現した）
      photo?.remove();
      photo?.off();
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
        // 枠を押しても、地図の空き地を押した扱い（選択を外す）にしない
        bubblingMouseEvents: false,
      });
      // 文字列で渡すと Leaflet が innerHTML に入れる。地区名は外部の応答由来なので、textContent の要素で渡す
      const tip = document.createElement('div');
      tip.textContent = `${a.name}（${a.ward}）　候補 ${a.counts.total} 件`;
      frame.bindTooltip(tip, { sticky: true, direction: 'top' });
      frame.on('click', () => callbacks.current.onAreaSelect(a.id));
      // 枠はマウス向け（キーボードでは「地区」の選択から選べる）。ツールチップがフォーカスの受け口を付けるため、Chrome では名前も働きも無い Tab の停止になる。Tab の順から外す
      frame.on('add', () => frame.getElement()?.setAttribute('tabindex', '-1'));
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
    // 印・形を押した / キーで選ぶ。Enter・Space で選び、矢印で隣の印へ、Home・End で先頭・末尾の印へ移る（マウスの操作と同じく、選ぶだけで地図は動かさない）。
    // 矢印・Space は、効かせたあとページがスクロールしないよう、既定の動きを止める
    const onKey = (id: string) => (ev: L.LeafletKeyboardEvent) => {
      const k = ev.originalEvent;
      if (k.altKey || k.ctrlKey || k.metaKey) return;
      if (k.key === 'Enter' || k.key === ' ') {
        k.preventDefault();
        if (!k.repeat) callbacks.current.onSelect(id);
        return;
      }
      let to: string | null | undefined;
      const dir = ARROW_DIRECTION[k.key];
      if (dir) to = neighbourId(map, entries, id, dir);
      else if (k.key === 'Home') to = entries.keys().next().value;
      else if (k.key === 'End') to = [...entries.keys()].at(-1);
      else return;
      k.preventDefault();
      if (!to) return;
      tabStopRef.current = to;
      refreshKeys();
      const e = entries.get(to)!;
      const target = (map.getZoom() >= POLYGON_MIN_ZOOM ? e.poly : e.marker).getElement() as HTMLElement | SVGElement | undefined;
      target?.focus();
    };
    for (const f of features) {
      const cls = f.properties.class;
      if (!isCandidateClass(cls)) continue;
      const info = CLASS_INFO[cls];
      const latlngs = toLatLngs(f.geometry) as L.LatLngExpression[][];
      const id = f.properties.id;
      const label = `${info.short}・${formatArea(f.properties.area_m2)}`;
      const casing = L.polygon(latlngs, { color: colors.casing, weight: 5, opacity: 0.9, fill: false, interactive: false });
      const lineColor = readCssColor(info.cssVar);
      const poly = L.polygon(latlngs, {
        color: lineColor,
        weight: 2.5,
        dashArray: info.dash,
        lineCap: info.shape === 'triangle' ? 'round' : 'butt',
        fillColor: lineColor,
        fillOpacity: info.fillOpacity,
        // 形を押しても、地図の空き地を押した扱い（選択を外す）にしない
        bubblingMouseEvents: false,
      });
      poly.on('click', () => callbacks.current.onSelect(id));
      poly.on('keydown', onKey(id));
      const marker = L.marker(poly.getBounds().getCenter(), {
        icon: markerIcon(cls, 'normal'),
        // 既定の keyboard: true は、すべての印を Tab の停止にする。role・tabindex は refreshKeys で付ける
        keyboard: false,
        title: `${label}（Enter か Space で選ぶ）`,
      });
      // 重なった印では、押した位置にいちばん近い印を選ぶ（手前の印の箱が、奥の印の中心を覆っていても、見えている印を押した通りになる）
      marker.on('click', (ev) => callbacks.current.onSelect(nearestId(map, entries, ev.originalEvent, id)));
      marker.on('keydown', onKey(id));
      polys.addLayer(casing);
      polys.addLayer(poly);
      dots.addLayer(marker);
      entries.set(id, { cls, label, latlngs, polys, casing, poly, ring: null, marker });
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
      refreshKeys();
    };
    sync();
    map.on('zoomend', sync);
    return () => {
      map.off('zoomend', sync);
      polys.remove();
      dots.remove();
      entriesRef.current = new Map();
    };
  }, [features, themeVersion, refreshKeys]);

  // ---- 選択・強調の見た目 ----
  // 輪（黄色）→ 縁 → 本線の順に重ねる。縁を間に挟むので、ライト・ダークのどちらの線の色も、黄色の上で見分けられる
  useEffect(() => {
    const colors = mapColors();
    selectedRef.current = selectedId;
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
    // アイコンを替えると、role・tabindex・aria-pressed を付け直す必要がある
    refreshKeys();
  }, [selectedId, highlightIds, features, themeVersion, refreshKeys]);

  // ---- 選んだ印・形が、選択中のカードの下に隠れるなら、上へ寄せる ----
  // カードは、選んだのと同じ描画で出る（MapPanel）。印を押した直後に、押した印がカードの下になるのを防ぐ。
  // 次の「寄せる」と同じ描画のときは、あとの寄せる処理（カードの分の余白つき）が、この動きを上書きする
  useEffect(() => {
    if (selectedId) revealAboveCover(selectedId);
  }, [selectedId, revealAboveCover]);

  // ---- 寄せる ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focus) return;
    // チャット・選択が先に地図を動かしたので、全地区への初回の寄せは要らない（後から来た地区の一覧で、動かした位置を戻さない）
    fittedRef.current = true;
    const [w, s, e, n] = focus.bbox;
    // 選択中のカードが下に重なっているときは、その分だけ下の余白を広げる（寄せた候補・強調した候補が、カードの下に入らない）
    const cover = coverBox();
    const coverHeight = cover ? Math.max(0, (containerRef.current?.getBoundingClientRect().height ?? 0) - cover.top) : 0;
    map.fitBounds(
      [
        [s, w],
        [n, e],
      ],
      {
        maxZoom: 19,
        paddingTopLeft: [32, 32],
        paddingBottomRight: [32, Math.max(32, coverHeight + COVER_GAP)],
        ...noAnimationIfReduced(),
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
      aria-label="地図。矢印キーで移動、プラス・マイナスキーで拡大・縮小。Tab で候補の印へ入ると、矢印キーで隣の印へ移り、Enter か Space で選べます"
    />
  );
}
