// Better Auth の設定値の検査。依存を持たない（単体で試せる）。JobNavi の src/lib/auth-config.ts と同じ（Cookie の接頭辞だけ townscan）。
// Better Auth は BETTER_AUTH_SECRET が無いと、本番（NODE_ENV=production）以外では公開されている既定の Secret で動く。ここで先に止める。
// 返すのは変数名だけ（値は含めない）。

export type AuthEnv = Record<string, string | undefined>;

const REQUIRED = ['BETTER_AUTH_SECRET', 'BETTER_AUTH_URL', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'DATABASE_URL'] as const;
/** Better Auth のソースに書かれている既定の Secret の接頭辞（公開されている値）。 */
const DEFAULT_SECRET_PREFIX = 'better-auth-secret';
/** Better Auth が勧める Secret の長さ（これより短いと推測されやすい）。 */
export const MIN_SECRET_LENGTH = 32;
/** Better Auth の Cookie 名の接頭辞（`<接頭辞>.session_token`。https では先頭に `__Secure-` が付く）。既定の `better-auth` のままだと、同じ localhost の別のアプリ（JobNavi・DocuNavi など）と Cookie を取り合う。 */
export const AUTH_COOKIE_PREFIX = 'townscan';

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '';
  } catch {
    return false;
  }
}

/** 問題があれば、変数名だけを含む説明を返す。問題が無ければ null。 */
export function authConfigProblem(env: AuthEnv): string | null {
  const missing = REQUIRED.filter((name) => (env[name] ?? '').trim() === '');
  if (missing.length > 0) return `missing: ${missing.join(', ')}`;
  // 形が違うと、Better Auth は作れても、あとの呼び出しごとに失敗し、画面には「ログアウト」としか見えない。ここで先に止める（API の _http_url と同じ検査）
  if (!isHttpUrl((env.BETTER_AUTH_URL ?? '').trim())) return 'BETTER_AUTH_URL is not an http(s) URL';
  const secret = (env.BETTER_AUTH_SECRET ?? '').trim();
  if (secret.startsWith(DEFAULT_SECRET_PREFIX)) return 'BETTER_AUTH_SECRET is the public default value';
  if (secret.length < MIN_SECRET_LENGTH) return `BETTER_AUTH_SECRET is shorter than ${MIN_SECRET_LENGTH} characters`;
  return null;
}

/**
 * ログインを使える設定か。getAuth() が null を返さない条件と同じ（authConfigProblem が null）。
 * Better Auth も DB も作らずに答える（ログインしていない人の画面の枠が、ログインの入口を出すかどうかを決めるため）。
 */
export function isAuthConfigured(env: AuthEnv = process.env): boolean {
  return authConfigProblem(env) === null;
}
