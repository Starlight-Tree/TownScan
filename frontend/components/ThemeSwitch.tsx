'use client';

import { useSyncExternalStore } from 'react';
import { chooseTheme, clearTheme, themeChoice } from '../lib/theme';
import type { Theme } from '../lib/theme';
import { THEME_OPTIONS } from './themeOptions';

// 選んだテーマは localStorage と <html data-theme> にあり、React の外にある。切り替えたときだけ、ここから知らせる
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
 * テーマの切り替え（ライト / ダーク / システム）。上部ヘッダーの右端（状態の表示の隣）で使う。選ぶと localStorage に保存し、以後は OS より優先する。「システム」で OS に従う状態へ戻す。
 * 保存値は、描画のあとに読む（サーバーの出力と最初の描画は「システム」で始め、ハイドレーションのずれを避ける。JobNavi は useEffect で読む。TownScan は、同じ動きを useSyncExternalStore で書いた）。
 */
export function ThemeSwitch() {
  const choice = useSyncExternalStore(subscribe, themeChoice, serverChoice);

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
            onClick={() => {
              if (option.value === 'system') clearTheme();
              else chooseTheme(option.value);
              for (const listener of listeners) listener();
            }}
          >
            {option.icon}
          </button>
        ))}
      </span>
    </div>
  );
}
