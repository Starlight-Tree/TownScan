'use server';

import { revalidatePath } from 'next/cache';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getAuth } from '../lib/auth';
import { AUTH_COOKIE_PREFIX } from '../lib/auth-config';
import { isUnauthorized, logAuthError } from '../lib/auth-log';
import { validateDisplayName, type NameFormState } from '../lib/display-name';

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

const MSG_SAVE_FAILED = '表示名を保存できませんでした。しばらく待ってから、もう一度お試しください。';
const MSG_EXPIRED = 'ログインの有効期限が切れました。もう一度ログインしてください。';

/**
 * 表示名を変える（アカウントのメニューの「表示名を変更」。DocuNavi と同じ）。保存の前に、サーバーで必ず検査する（lib/display-name.ts）。
 * 書き換えるのは名前だけ（auth.api.updateUser の body に name だけを渡す）。HTTP の `/api/auth/update-user` は閉じたまま（lib/auth.ts の disabledPaths）で、ブラウザーから画像・メールなどを書き換えさせない。
 * 利用者は、Cookie のセッションから決まる（本文の値では決めない）。保存できたら、画面の枠（サイドパネルの名前）を描き直す。
 */
export async function updateNameAction(_prev: NameFormState, data: FormData): Promise<NameFormState> {
  const raw = data.get('display_name');
  const value = typeof raw === 'string' ? raw : '';
  const checked = validateDisplayName(value);
  if (!checked.ok) return { error: checked.message, value };
  const auth = getAuth();
  if (!auth) return { error: MSG_SAVE_FAILED, value };
  try {
    await auth.api.updateUser({ body: { name: checked.name }, headers: await headers() });
  } catch (error) {
    if (isUnauthorized(error)) return { error: MSG_EXPIRED, value };
    logAuthError('updateNameAction', error);
    return { error: MSG_SAVE_FAILED, value };
  }
  revalidatePath('/', 'layout');
  return { saved: true, value: checked.name };
}
