import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { AppHeader } from '../components/AppHeader';
import { HealthProvider } from '../components/HealthProvider';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'TownScan', template: '%s | TownScan' },
  description: '熊本市中心部の航空写真から、新築の候補を棟ごとに検出し、会話で調べるアプリ（たたき台）。',
  icons: { icon: '/icon.svg' },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <a href="#main" className="skip-link">
          本文へ移動
        </a>
        <HealthProvider>
          <div className="app">
            <AppHeader />
            <main id="main" className="app__main" tabIndex={-1}>
              {children}
            </main>
          </div>
        </HealthProvider>
      </body>
    </html>
  );
}
