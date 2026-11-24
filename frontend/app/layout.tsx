import type { Metadata, Viewport } from 'next';
import '@fontsource-variable/noto-sans-jp/wght.css';
import { Inter } from 'next/font/google';
import type { ReactNode } from 'react';
import { THEME_INIT_SCRIPT } from '../lib/theme';
import './globals.css';

// 可変フォント（JobNavi・DocuNavi と同じ）。ビルド時に取得して自前の配信にする（実行時に Google へは接続しない）。日本語は Noto Sans JP（globals.css の --font）
const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });

export const metadata: Metadata = {
  title: 'TownScan',
  description: '熊本市中心部の航空写真から、新築の候補を棟ごとに検出し、会話で調べるアプリ（たたき台）。',
  other: { 'color-scheme': 'light dark' },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

// 画面の枠は、グループごとの layout が持つ: (site) = サイドパネルと上の横帯と本文（ログイン中の人も、そこで取る）、(auth) = ログイン画面（サイドパネルなし）。
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // data-theme は描画前のスクリプトが付ける（サーバーの出力とは違うので、警告を止める）
    <html lang="ja" className={inter.variable} suppressHydrationWarning>
      <head>
        <script>{THEME_INIT_SCRIPT}</script>
      </head>
      <body>
        <a href="#main" className="skip-link">
          本文へ移動
        </a>
        {children}
      </body>
    </html>
  );
}
