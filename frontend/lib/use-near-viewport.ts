'use client';

import { useEffect, useState, type RefObject } from 'react';

interface Options {
  /** 画面（root）の外側へ、どれだけ広げて「近い」と見るか。既定は 200px（地図は、見える少し手前でマウントを始める） */
  rootMargin?: string;
  /**
   * 見る枠（スクロールする親）を、要素から `closest` で探すセレクター。無ければ、窓。
   * スクロールする親の中の要素は、窓を基準にすると、その親の外へ広げた余白（rootMargin）が効かない（親の枠で切られる）ので、親を枠にする
   */
  rootSelector?: string;
  /** false なら、観測せず、いつも true（遅らせる必要が無い部品。グラフ）。既定は true */
  enabled?: boolean;
}

/**
 * 要素が、画面（スクロールする親）に近づいたか。一度近づいたら、true のまま保つ（外れても戻さない）。
 * 重い部品（Leaflet の地図）を、会話を流すだけでは作らず、見える少し手前で作るために使う。
 * IntersectionObserver が無い環境（jsdom・古いブラウザー）では、すぐ true にする（マウントを止めたままにしない）
 */
export function useNearViewport(ref: RefObject<Element | null>, { rootMargin = '200px', rootSelector, enabled = true }: Options = {}): boolean {
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined');

  useEffect(() => {
    if (near || !enabled) return;
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { root: rootSelector ? el.closest(rootSelector) : null, rootMargin },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [near, enabled, ref, rootMargin, rootSelector]);

  return near || !enabled;
}
