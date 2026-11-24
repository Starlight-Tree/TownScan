import type { ReactNode } from 'react';
import type { Theme } from '../lib/theme';

/** テーマの 3 択のアイコン（線画）。名前は、ボタンの `aria-label` と `title`。 */
function Svg({ children }: { children: ReactNode }) {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

/** ライト / ダーク / システム（OS に従う）。上の横帯の切り替え（ThemeSwitch）と、アカウントのメニュー（AccountMenu）が共有する（JobNavi と同じ）。 */
export const THEME_OPTIONS: ReadonlyArray<{ value: Theme | 'system'; label: string; icon: ReactNode }> = [
  {
    value: 'light',
    label: 'ライト',
    icon: (
      <Svg>
        <circle cx="10" cy="10" r="3.2" />
        <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" />
      </Svg>
    ),
  },
  {
    value: 'dark',
    label: 'ダーク',
    icon: (
      <Svg>
        <path d="M16.5 11.6A6.8 6.8 0 0 1 8.4 3.5a6.8 6.8 0 1 0 8.1 8.1z" />
      </Svg>
    ),
  },
  {
    value: 'system',
    label: 'システム',
    icon: (
      <Svg>
        <rect x="2.5" y="3.5" width="15" height="10" rx="1.5" />
        <path d="M7 17h6M10 13.5V17" />
      </Svg>
    ),
  },
];
