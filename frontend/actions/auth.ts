'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getAuth } from '../lib/auth';
import { AUTH_COOKIE_PREFIX } from '../lib/auth-config';
import { logAuthError } from '../lib/auth-log';

/** Google でログインする。Google の同意画面へ送り出す（戻りは /api/auth/callback/google。Better Auth が受けて Cookie を発行し、/ へ戻す）。 */
export async function googleLoginAction(): Promise<void> {
  const auth = getAuth();
  if (!auth) redirect('/login?error=not_configured');
  let url: string | null = null;
  try {
    // errorCallbackURL: 失敗・取り消しのときに戻す画面（?error=コード が付く。文はログイン画面が決める）
    const result = await auth.api.signInSocial({
      body: { provider: 'google', callbackURL: '/', errorCallbackURL: '/login' },
      headers: await headers(),
    });
    url = result.url ?? null;
  } catch (error) {
    logAuthError('googleLoginAction', error);
    url = null;
  }
  // redirect は例外で動くので、try の外で呼ぶ
  redirect(url ?? '/login?error=google_failed');
}

export async function logoutAction(): Promise<void> {
  const auth = getAuth();
  let done = false;
  if (auth) {
    try {
      // サーバー側の印を消す（Cookie の削除は nextCookies が反映する）。注意: Better Auth は、DB の削除に失敗しても、失敗を返さずに Cookie だけを消す（その印は 14 日の期限まで残る）
      await auth.api.signOut({ headers: await headers() });
      done = true;
    } catch (error) {
      logAuthError('logoutAction', error);
      done = false;
    }
  }
  if (!done) {
    // サーバーに届かなくても、この端末の Cookie は消す（サーバー側の印は期限で消える）。https の Cookie 名は `__Secure-` で始まり、Secure 付きでなければブラウザーが消させない
    const store = await cookies();
    for (const { name } of store.getAll()) {
      if (!name.includes(`${AUTH_COOKIE_PREFIX}.`)) continue;
      store.set(name, '', { maxAge: 0, path: '/', httpOnly: true, sameSite: 'lax', secure: name.startsWith('__Secure-') });
    }
  }
  redirect('/');
}
