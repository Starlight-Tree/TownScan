'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useHealth } from './HealthProvider';
import { ThemeSwitch } from './ThemeSwitch';

const NAV = [
  { href: '/', label: 'チャットと地図' },
  { href: '/accuracy', label: 'このアプリの精度' },
  { href: '/about', label: 'このアプリについて' },
] as const;

/** 全画面の上部: ナビ、模擬モデルの表示、合成データ・API 不通のバナー */
export function AppHeader() {
  const pathname = usePathname();
  const { state, reload } = useHealth();
  const health = state.status === 'ready' ? state.data : null;
  const synthetic = health?.run?.kind === 'synthetic';

  return (
    <>
      <header className="app-header">
        <div className="app-header__brand">
          <Link href="/" className="app-header__logo">
            TownScan
          </Link>
          <span className="app-header__tagline">熊本市中心部の航空写真から、新築の候補を会話で調べる</span>
        </div>
        <nav aria-label="主なページ" className="app-header__nav">
          {NAV.map((item) => {
            const current = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
            return (
              <Link key={item.href} href={item.href} className="nav-link" aria-current={current ? 'page' : undefined}>
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="app-header__tools">
          <div className="app-header__status" aria-live="polite">
            {health?.llm === 'mock' && <span className="pill pill--warn">模擬モデルで応答しています</span>}
            {health && health.llm !== 'mock' && <span className="pill">モデル: {health.llm}</span>}
          </div>
          <ThemeSwitch />
        </div>
      </header>
      {synthetic && (
        <div className="banner banner--synthetic" role="status">
          <strong>合成データ（テスト用）</strong>
          <span>
            いま表示している件数・地図・写真は、動作確認のために作った合成データです。実際の写真から出した結果ではありません。
          </span>
        </div>
      )}
      {state.status === 'error' && (
        <div className="banner banner--error" role="alert">
          <strong>API に接続できません</strong>
          <span>{state.error.message}</span>
          <button type="button" className="btn btn--small" onClick={reload}>
            再試行
          </button>
        </div>
      )}
    </>
  );
}
