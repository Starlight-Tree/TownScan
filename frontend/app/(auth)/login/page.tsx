import Link from 'next/link';
import { redirect } from 'next/navigation';
import { googleLoginAction } from '../../../actions/auth';
import { getAuth } from '../../../lib/auth';
import { loginErrorMessage } from '../../../lib/login-error';
import { currentUser } from '../../../lib/session';

export const dynamic = 'force-dynamic';

// ログインは Google アカウントだけ（JobNavi・DocuNavi と同じ。はじめての方は、ログインすると、そのまま登録される）。画面は、見出し・1 行の案内・ボタンだけにする。
// ログインは任意で、しなくても、チャット・地図・精度は、そのまま使える。タブ名は、ほかのページと同じ TownScan のまま（このページも metadata を持たない）。
// 設定が足りないとき（Google の OAuth クライアントをまだ作っていない、など）は、「まだ設定されていません」と出して、ボタンは出さない（JobNavi は、ボタンを出して、押したあとにこの文へ戻す）。
// そのときは、案内の 1 行も「ログインは、いまは使えません」にそろえ（「ログインしてください」と言いながらボタンが無い、をやめる）、行き止まりにならないよう「チャットと地図へ戻る」を出す。
// サイドパネルのメニューは、設定が足りないとき、このページへの入口を出さない（app/(site)/layout.tsx）。
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await currentUser()) redirect('/');
  const configured = getAuth() !== null;
  const message = loginErrorMessage(configured ? (await searchParams).error : 'not_configured');
  return (
    <div className="auth-box">
      <h1>ログイン</h1>
      <p className="auth-lead">{configured ? 'Google アカウントでログインしてください' : 'ログインは、いまは使えません'}</p>
      {message ? (
        <p className="inline-error login-alert" role="alert">
          {message}
        </p>
      ) : null}
      {/* サーバーアクションのフォーム。JavaScript の読み込み前でも押せる */}
      {configured ? (
        <form action={googleLoginAction}>
          <button type="submit" className="btn btn--primary google-login">
            Google でログイン
          </button>
        </form>
      ) : (
        <Link href="/" className="btn auth-back">
          チャットと地図へ戻る
        </Link>
      )}
      <p className="auth-note">ログインしなくても、チャット・地図・精度は使えます。</p>
    </div>
  );
}
