import { Fragment, type ReactNode } from 'react';
import { logoutAction } from '../../actions/auth';
import { AccountMenu } from '../../components/AccountMenu';
import { AppBanners } from '../../components/AppBanners';
import { AppSidebar } from '../../components/AppSidebar';
import { HealthProvider } from '../../components/HealthProvider';
import { HistoryProvider } from '../../components/HistoryProvider';
import { NewConversationProvider } from '../../components/NewConversation';
import { isAuthConfigured } from '../../lib/auth-config';
import { currentUser, displayName } from '../../lib/session';

/**
 * 画面の枠。左のサイドパネル（AppSidebar）と、本文の列（バナー・本文）。1024px 以上はサイドパネルが常に左にあり（開閉できる）、1023px 以下は、はじめは閉じていて、上の細い行のボタンで重ねて開く。上の横帯は無い。
 * ログインは任意。ログイン中の人はここで 1 回だけ取る（lib/session.ts。Cookie が無ければ DB へ行かない。未設定・失敗のときは null で、ログインしていない扱い）。
 * アカウントのメニューは、サイドパネルの下に 1 つだけ渡す。
 * 会話の履歴（ログイン中だけ）: ログイン中か（currentUser() の真偽値）と、ログインを使える設定か（isAuthConfigured()）を、コンテキスト（HistoryProvider）で画面の部品へ渡す。
 * ログインしていなければ、/api/auth/token も /api/conversations も、一度も呼ばない（仕様 §2.3.6）。ログインの有無が変わったとき（ログアウト）は、本文を作り直す（前の人の会話を、画面に残さない）。
 * ログインの入口（「Google でログイン」）は、ログインを使える設定のときだけ出す。Google の設定が無い環境では、押してもボタンの無いページへ着くだけなので、出さない。
 */
export default async function SiteLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();
  const loginAvailable = isAuthConfigured();
  const account = user ? (
    <AccountMenu name={displayName(user)} email={user.email} image={user.image} logout={logoutAction} />
  ) : (
    <AccountMenu loginHref={loginAvailable ? '/login' : undefined} />
  );
  return (
    <HealthProvider>
      <HistoryProvider loggedIn={user !== null} loginAvailable={loginAvailable}>
        <NewConversationProvider>
          <div className="app">
            <AppSidebar brand="TownScan" brandHref="/" navLabel="主なページ">
              {account}
            </AppSidebar>
            <div className="app__column">
              <AppBanners />
              <main id="main" className="app__main" tabIndex={-1}>
                <Fragment key={user ? 'signed-in' : 'signed-out'}>{children}</Fragment>
              </main>
            </div>
          </div>
        </NewConversationProvider>
      </HistoryProvider>
    </HealthProvider>
  );
}
