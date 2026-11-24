import { cookies, headers } from 'next/headers';
import { cache } from 'react';
import { getAuth } from './auth';
import { AUTH_COOKIE_PREFIX } from './auth-config';
import { isUnauthorized, logAuthError } from './auth-log';

// ログインの印は、Better Auth の Cookie（HttpOnly。画面のサーバーだけが読む。lib/auth.ts）。
// TownScan は、ブラウザーから同じオリジンの /api/* を呼ぶ形なので、API へ渡す JWT（JobNavi の userToken）は、まだ使わない。ここは「だれがログインしているか」を画面に出すためだけ。

/** ログイン中の利用者（画面に出す分だけ。Better Auth の利用者の行から）。 */
export type SessionUser = {
  id: string;
  email: string;
  /** Google のアカウントの名前。空のこともある。 */
  name: string;
  /** プロフィール画像の URL。無ければ null（表示は https のときだけ。AccountMenu）。 */
  image: string | null;
};

/** Better Auth の session_token の Cookie が、リクエストにあるか（https の Cookie 名は `__Secure-` で始まる）。 */
async function hasSessionCookie(): Promise<boolean> {
  return (await cookies()).getAll().some(({ name }) => name.includes(`${AUTH_COOKIE_PREFIX}.session_token`));
}

/**
 * ログイン中の利用者。ログインしていない・期限切れ・設定が無い・DB に届かないときは null（画面は、ログインしていない扱いで動く）。同じ描画の中では 1 回しか呼ばない。
 * Cookie が無い訪問者（ほとんどの人）では、Better Auth も DB も呼ばない（Better Auth の getSession も、署名つきの Cookie が無ければ DB へ行かずに null を返す）。
 */
export const currentUser = cache(async (): Promise<SessionUser | null> => {
  if (!(await hasSessionCookie())) return null;
  const auth = getAuth();
  if (!auth) return null;
  try {
    const result = await auth.api.getSession({ headers: await headers() });
    const user = result?.user;
    if (!user || typeof user.email !== 'string' || user.email === '') return null;
    return {
      id: String(user.id),
      email: user.email,
      name: typeof user.name === 'string' ? user.name : '',
      image: typeof user.image === 'string' && user.image !== '' ? user.image : null,
    };
  } catch (error) {
    // ログインしていない（401）は普通の状態なので記録しない。それ以外は画面では「ログアウト」に見える。
    // 原因（auth.sql を流す前に使った・BETTER_AUTH_SECRET を変えた）は、ここにしか残らない
    if (!isUnauthorized(error)) logAuthError('currentUser', error);
    return null;
  }
});

/** サイドパネルに出す名前。Google の名前が無ければ、メールアドレス。 */
export function displayName(user: Pick<SessionUser, 'name' | 'email'>): string {
  return user.name || user.email;
}
