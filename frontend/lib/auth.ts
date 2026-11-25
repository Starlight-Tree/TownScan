// ログイン（Better Auth。Google だけ）。画面のサーバー（Next.js）の中で動く。JobNavi・DocuNavi と同じ Better Auth 1.7.18 を、Next.js の公式の組み込み方で使う。
//   - ブラウザーからの /api/auth/* は、app/api/auth/[...all]/route.ts が受ける（Google への行き来・Cookie・JWKS）。proxy.ts は /api/auth/* を API へ転送しない。
//   - ログイン中の人の確認は、サーバー側で auth.api を直接呼ぶ（session.ts）。API（Go）の /api/me は、JWT（15 分・ES256）を Bearer で受け、JWKS（/api/auth/jwks）で検証するだけ。
//   - 利用者の表は auth_ 付きの名前（pipeline/sql/auth.sql。JobNavi の 0004_better_auth.sql と同じ形）。
// 設定が足りないとき（Google の OAuth クライアントをまだ作っていない、など）は getAuth() が null を返し、画面は「まだ設定されていません」と出す。値は環境変数だけで受ける。
import { betterAuth } from 'better-auth';
import { nextCookies } from 'better-auth/next-js';
import { jwt } from 'better-auth/plugins';
import pg from 'pg';
import { AUTH_COOKIE_PREFIX, authConfigProblem, type AuthEnv } from './auth-config';

const SESSION_SECONDS = 60 * 60 * 24 * 14; // 14 日
/** JWT の対象（aud）の既定。API の AUTH_AUDIENCE と同じ値にする。 */
export const DEFAULT_AUDIENCE = 'townscan';

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

export function createAuth(env: AuthEnv, pool: pg.Pool) {
  const baseURL = (env.BETTER_AUTH_URL ?? '').trim().replace(/\/+$/, '');
  return betterAuth({
    database: pool,
    baseURL,
    secret: (env.BETTER_AUTH_SECRET ?? '').trim(),
    user: {
      modelName: 'auth_user',
    },
    // ログインは、最初のログインから 14 日で切れる（延長しない）。延長（updateAge）は、Server Component から呼ぶと DB の期限だけが延びて、Cookie の期限は延びない（Cookie を書き換えられない）ので、閉じる
    session: { modelName: 'auth_session', expiresIn: SESSION_SECONDS, disableSessionRefresh: true },
    // Cookie 名の接頭辞。既定（better-auth）のままだと、同じ localhost で動く JobNavi・DocuNavi と、Cookie を上書きし合う
    advanced: { cookiePrefix: AUTH_COOKIE_PREFIX },
    // Google のトークンのうち、アクセス・更新は、ログイン後に使わないが、DB に置く分は暗号化する（既定は平文）。ID トークンは、ライブラリの仕様で暗号化されない（Google の署名つき。有効は 1 時間）
    account: { modelName: 'auth_account', encryptOAuthTokens: true },
    verification: { modelName: 'auth_verification' },
    socialProviders: {
      google: {
        clientId: (env.GOOGLE_CLIENT_ID ?? '').trim(),
        clientSecret: (env.GOOGLE_CLIENT_SECRET ?? '').trim(),
      },
    },
    // メール + パスワードは使わない（既定で無効）。名前の変更は、サーバーアクション（actions/auth.ts の updateNameAction）が auth.api.updateUser で名前だけを書き換える。
    // HTTP の入口（/api/auth/update-user）は閉じたままにする（ブラウザーから画像・メールなどを書き換えさせない。disabledPaths は HTTP の入口だけを止め、サーバー側の auth.api の呼び出しは止めない）
    disabledPaths: ['/update-user'],
    plugins: [
      jwt({
        jwks: { keyPairConfig: { alg: 'ES256' } },
        jwt: {
          issuer: baseURL,
          audience: (env.JWT_AUDIENCE ?? '').trim() || DEFAULT_AUDIENCE,
          expirationTime: '15m',
          // 既定は利用者の全項目。API が使う分だけに絞る（sub は、利用者の ID）
          definePayload: ({ user }) => {
            const u = user as Record<string, unknown>;
            return {
              email: text(u.email),
              email_verified: u.emailVerified === true,
              name: text(u.name),
              picture: text(u.image),
            };
          },
        },
        schema: { jwks: { modelName: 'auth_jwks' } },
      }),
      // サーバー側の関数（signInSocial・signOut）が出す Set-Cookie を、Next.js の cookies() に反映する。最後に置く（公式の指示）
      nextCookies(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

type Holder = { auth?: Auth | null; pool?: pg.Pool };
// 開発サーバーの再読み込みで、接続プールが増えないよう、globalThis に 1 つだけ持つ
const holder = ((globalThis as { __tsAuth?: Holder }).__tsAuth ??= {});

/** Better Auth。設定が足りなければ null（作り直しもしない。環境変数を直したら、サーバーを再起動する）。 */
export function getAuth(env: AuthEnv = process.env): Auth | null {
  if (holder.auth !== undefined) return holder.auth;
  const problem = authConfigProblem(env);
  if (problem !== null) {
    console.warn(`auth: not configured (${problem})`);
    return (holder.auth = null);
  }
  const { Pool } = pg;
  holder.pool = new Pool({ connectionString: (env.DATABASE_URL ?? '').trim(), max: 4, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000 });
  // 接続が切れてもプロセスを落とさない。次のクエリで張り直す。本文は出さない
  holder.pool.on('error', (err) => console.error(`auth: database pool error: ${err.name}`));
  return (holder.auth = createAuth(env, holder.pool));
}
