import type { ReactNode } from 'react';
import { logoutAction } from '../../actions/auth';
import { AccountMenu } from '../../components/AccountMenu';
import { AppHeader } from '../../components/AppHeader';
import { AppSidebar } from '../../components/AppSidebar';
import type { SidebarItem } from '../../components/AppSidebar';
import { HealthProvider } from '../../components/HealthProvider';
import { isAuthConfigured } from '../../lib/auth-config';
import { currentUser, displayName } from '../../lib/session';

const ITEMS: readonly SidebarItem[] = [
  { href: '/', label: 'チャットと地図', icon: 'chat' },
  { href: '/accuracy', label: 'このアプリの精度', icon: 'accuracy' },
  { href: '/about', label: 'このアプリについて', icon: 'about' },
];

/**
 * 画面の枠。1024px 以上は、左のサイドパネル（AppSidebar）と本文の 2 列。1023px 以下は、上の横帯（AppHeader）と本文の縦積み（どちらを出すかは CSS）。
 * ログインは任意。ログイン中の人はここで 1 回だけ取る（lib/session.ts。Cookie が無ければ DB へ行かない。未設定・失敗のときは null で、ログインしていない扱い）。
 * アカウントのメニューは、サイドパネルの下と、上の横帯の右端に、同じものを渡す（出すのは CSS が選んだ方だけ）。
 * ログインの入口（「Google でログイン」）は、ログインを使える設定のときだけ出す。Google の設定が無い環境では、押してもボタンの無いページへ着くだけなので、出さない。
 */
export default async function SiteLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();
  const account = user ? (
    <AccountMenu name={displayName(user)} email={user.email} image={user.image} logout={logoutAction} />
  ) : (
    <AccountMenu loginHref={isAuthConfigured() ? '/login' : undefined} />
  );
  return (
    <HealthProvider>
      <div className="app">
        <AppSidebar brand="TownScan" brandHref="/" navLabel="主なページ" items={ITEMS}>
          {account}
        </AppSidebar>
        <div className="app__column">
          <AppHeader account={account} />
          <main id="main" className="app__main" tabIndex={-1}>
            {children}
          </main>
        </div>
      </div>
    </HealthProvider>
  );
}
