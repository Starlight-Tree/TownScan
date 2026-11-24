/** 画面のテーマ（ライト / ダーク）。既定は OS の設定に従い、利用者が選んだときだけ localStorage に保存して優先する。 */

export type Theme = 'light' | 'dark';

/** 保存先のキー。`app/layout.tsx` の描画前のスクリプトも、同じキーを読む。 */
export const THEME_KEY = 'townscan-theme';

/** 初回描画の前に、保存済みのテーマを `<html data-theme>` へ入れるスクリプト（白フラッシュを防ぐ）。保存が無ければ何もせず、CSS の OS 追従に任せる。 */
export const THEME_INIT_SCRIPT = `try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`;

function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark';
}

/** 保存済みのテーマ。無い・読めない（プライベートブラウズなど）ときは null。 */
export function storedTheme(): Theme | null {
  try {
    const value = window.localStorage.getItem(THEME_KEY);
    return isTheme(value) ? value : null;
  } catch {
    return null;
  }
}

/** OS の設定。`matchMedia` が無い環境では light。 */
export function systemTheme(): Theme {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** いま画面に効いているテーマ（選択があればそれ、無ければ OS）。 */
export function currentTheme(): Theme {
  const applied = document.documentElement.dataset.theme;
  return isTheme(applied) ? applied : systemTheme();
}

/** 選んだテーマを、画面に適用して保存する。保存できなくても、このページでは適用する。 */
export function chooseTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    window.localStorage.setItem(THEME_KEY, theme);
  } catch {
    // 保存できない環境では、このページの間だけ有効
  }
}

/** 利用者の選択。保存が無ければ、適用中の `data-theme`（保存できない環境で、このページの間だけ選んだもの）。それも無ければ 'system'（OS に従う）。 */
export function themeChoice(): Theme | 'system' {
  const applied = document.documentElement.dataset.theme;
  return storedTheme() ?? (isTheme(applied) ? applied : 'system');
}

/** 選択を取り消して、OS の設定に従う状態へ戻す（保存を消し、`data-theme` も外す）。 */
export function clearTheme(): void {
  delete document.documentElement.dataset.theme;
  try {
    window.localStorage.removeItem(THEME_KEY);
  } catch {
    // 保存できない環境では、このページの間だけ有効
  }
}
