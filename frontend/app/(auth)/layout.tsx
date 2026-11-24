import Link from 'next/link';
import type { ReactNode } from 'react';
import { ThemeSwitch } from '../../components/ThemeSwitch';

// ログインの画面は、迷わないよう、サイドパネルを出さず、上の帯を「← チャットと地図」とテーマの切り替えだけにする（JobNavi の (auth) と同じ）
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="app">
      <header className="auth-header">
        <Link href="/" className="app-header__logo">
          TownScan
        </Link>
        <nav aria-label="主なページ" className="auth-header__nav">
          <Link href="/" className="nav-link">
            ← チャットと地図
          </Link>
          <ThemeSwitch />
        </nav>
      </header>
      <main id="main" className="app__main auth-main" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
