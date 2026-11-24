import { useEffect, useState } from 'react';

/**
 * CSS の変数（app/globals.css）の、いま効いている値。
 * Leaflet の線・塗りのように、CSS の外（JS の引数）へ色を渡す所で使う。色の値そのものは TS に書かず、CSS の変数だけが持つ（ライト・ダークで値が違う）。
 * 読めないとき（CSS が無い環境。テストなど）は `var(--名前)` をそのまま返す。ブラウザーの CSS・SVG の属性は、これを解決できる。
 */
export function readCssColor(name: string): string {
  if (typeof window === 'undefined' || typeof document === 'undefined') return `var(${name})`;
  const value = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || `var(${name})`;
}

/**
 * テーマが変わったときに呼ぶ。手動の切り替え（`<html data-theme>` の変化）と、OS の設定の変化（システムのまま追従しているとき）の両方を見る。
 * 返す関数で購読を外す。
 */
export function watchTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  media?.addEventListener?.('change', onChange);
  return () => {
    observer.disconnect();
    media?.removeEventListener?.('change', onChange);
  };
}

/** テーマが変わるたびに増える番号。Leaflet のように、色を JS の値として持つ部品が、これを依存に入れて描き直す。 */
export function useThemeVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => watchTheme(() => setVersion((v) => v + 1)), []);
  return version;
}
