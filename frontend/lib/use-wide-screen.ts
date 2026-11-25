import { useSyncExternalStore } from 'react';

/** CSS の `@media (min-width: 1024px)`（PC 幅）と同じ境目。PC 幅はサイドパネルを開閉（細い帯）、それより狭いと、必要なときだけ重ねて出す。 */
const WIDE_QUERY = '(min-width: 1024px)';

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia?.(WIDE_QUERY);
  if (!query) return () => {};
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/** PC 幅か。サーバーの描画と、`matchMedia` が無い環境（単体テスト）では true（PC 幅として扱う。見えるかどうかは CSS が決める）。 */
export function useWideScreen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia?.(WIDE_QUERY).matches ?? true,
    () => true,
  );
}
