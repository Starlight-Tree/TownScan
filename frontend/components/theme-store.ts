import { useSyncExternalStore } from 'react';
import { chooseTheme, clearTheme, themeChoice } from '../lib/theme';
import type { Theme } from '../lib/theme';

// 選んだテーマは localStorage と <html data-theme> にあり、React の外にある。切り替えたときだけ、ここから知らせる。
// 上の帯のテーマの切り替え（ThemeSwitch）と、アカウントのメニュー（AccountMenu）が、同じ選択を見られるよう、1 つにしてある。
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function serverChoice(): Theme | 'system' {
  return 'system';
}

/**
 * 利用者のテーマの選択（ライト / ダーク / システム）。
 * 保存値は、描画のあとに読む（サーバーの出力と最初の描画は「システム」で始め、ハイドレーションのずれを避ける。JobNavi は useEffect で読む。TownScan は、同じ動きを useSyncExternalStore で書いた）。
 */
export function useThemeChoice(): Theme | 'system' {
  return useSyncExternalStore(subscribe, themeChoice, serverChoice);
}

/** テーマを選ぶ。localStorage に保存して適用し（「システム」は、選択を取り消して OS に従う）、同じ画面の ThemeSwitch・AccountMenu に知らせる。 */
export function selectTheme(value: Theme | 'system'): void {
  if (value === 'system') clearTheme();
  else chooseTheme(value);
  for (const listener of listeners) listener();
}
