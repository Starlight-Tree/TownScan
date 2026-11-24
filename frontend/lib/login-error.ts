// ログイン画面に出す文。URL には、コード（Better Auth や画面が付ける名前）だけが入り、文はここで決める（URL の文字をそのまま画面に出さない）。JobNavi の src/lib/login-error.ts と同じ。
const MESSAGES = {
  not_configured: 'Google でのログインは、まだ設定されていません',
  access_denied: 'Google でのログインが取り消されました。もう一度お試しください',
} as const;

const FAILED = 'Google でのログインに失敗しました。もう一度お試しください';

/** `?error=` の値から、ログイン画面に出す文。無ければ null。知らないコードは、ひとまとめの失敗の文にする。 */
export function loginErrorMessage(code: string | undefined): string | null {
  if (!code) return null;
  // Object.hasOwn: 'constructor' のような、プロトタイプにある名前を通さない
  return Object.hasOwn(MESSAGES, code) ? MESSAGES[code as keyof typeof MESSAGES] : FAILED;
}
