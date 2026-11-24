'use client';

import { selectTheme, useThemeChoice } from './theme-store';
import { THEME_OPTIONS } from './themeOptions';

/**
 * テーマの切り替え（ライト / ダーク / システム）。上の横帯（1023px 以下）の右端（状態の表示の隣）と、ログイン画面の上の帯で使う。選ぶと localStorage に保存し、以後は OS より優先する。「システム」で OS に従う状態へ戻す。
 * 保存値は、描画のあとに読む（theme-store.ts）。1024px 以上のサイドパネルでは、アカウントのメニュー（AccountMenu）の中に、同じ選択がある。上の横帯でも、600px 以下では帯のこの切り替えを隠し、アカウントのメニューの中の選択を使う（globals.css）。
 */
export function ThemeSwitch() {
  const choice = useThemeChoice();

  return (
    <div role="group" aria-label="テーマ" className="theme-switch">
      <span className="theme-switch-label" aria-hidden="true">
        テーマ
      </span>
      <span className="theme-switch-options">
        {THEME_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            className="theme-switch-option"
            aria-pressed={choice === option.value}
            aria-label={option.label}
            title={option.label}
            onClick={() => selectTheme(option.value)}
          >
            {option.icon}
          </button>
        ))}
      </span>
    </div>
  );
}
