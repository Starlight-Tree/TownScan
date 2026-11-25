'use client';

import { selectTheme, useThemeChoice } from './theme-store';
import { THEME_OPTIONS } from './themeOptions';

/**
 * テーマの切り替え（ライト / ダーク / システム）。ログイン画面の上の帯で使う。選ぶと localStorage に保存し、以後は OS より優先する。「システム」で OS に従う状態へ戻す。
 * 保存値は、描画のあとに読む（theme-store.ts）。サイドパネルの画面では、アカウントのメニュー（AccountMenu）の中に、同じ選択がある。
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
