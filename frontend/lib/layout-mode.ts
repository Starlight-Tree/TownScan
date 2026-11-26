'use client';

import { useLayoutEffect, useState, type RefObject } from 'react';

/** 結果パネルの置き方。広い: チャットの右に横パネル。狭い: チャット・地図・グラフ・写真の 4 つのタブ（ADR 0007） */
export type LayoutMode = 'wide' | 'narrow';

/**
 * 広い幅になる、本文（サイドパネルを除いた幅）の最小の幅（rem）。チャットの列 46rem（--chat-w）＋パネル約 32rem。
 * **未測定の初期値**（実画面で決める。ADR 0007）
 */
export const WIDE_MIN_REM = 78;

/** 本文の幅（px）と 1rem の大きさ（px）から、置き方を決める */
export function layoutModeFor(widthPx: number, remPx: number): LayoutMode {
  return remPx > 0 && widthPx >= WIDE_MIN_REM * remPx ? 'wide' : 'narrow';
}

function rootRemPx(): number {
  return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
}

/**
 * 要素（本文の枠）の幅を測って、置き方を返す。窓の幅ではなく、サイドパネルを除いた本文の幅で決める（サイドパネルが開いていると、広い窓でも狭くなりうる）。
 * 拡大ビューの DOM の形が変わる（横パネルか、タブか）ので、CSS のコンテナクエリではなく、JS で測る。測れるまで（サーバーの描画・最初の描画）は、狭い幅として扱う
 */
export function useLayoutMode(ref: RefObject<HTMLElement | null>): LayoutMode {
  const [mode, setMode] = useState<LayoutMode>('narrow');

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setMode(layoutModeFor(el.clientWidth, rootRemPx()));
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  return mode;
}
