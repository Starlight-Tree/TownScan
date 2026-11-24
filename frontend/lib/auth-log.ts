// ログイン処理で握りつぶす例外の、ログへの 1 行。依存を持たない（単体で試せる）。JobNavi の src/lib/auth-log.ts と同じ。
// 画面は「ログアウトに見える」「ログインに失敗しました」としか出さないので、原因（DB の表が無い・BETTER_AUTH_SECRET を変えた・URL の書き間違い）は、ここでしか分からない。
// 出すのは、場所と、例外の名前・短くした本文だけ。Better Auth と pg の本文には、秘密（接続文字列・Secret）が入らない。

/** Better Auth の「ログインしていない」（401）か。ログアウト中の訪問者では描画のたびに起きる普通の状態なので、エラーとして記録しない。 */
export function isUnauthorized(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { statusCode?: unknown }).statusCode === 401;
}

/** `auth: <場所> failed: <名前>: <本文（200 文字まで）>` を console.error に出す。 */
export function logAuthError(where: string, error: unknown): void {
  const name = error instanceof Error ? error.name : 'Error';
  const message = error instanceof Error ? error.message.replace(/\s+/g, ' ').slice(0, 200) : '';
  console.error(`auth: ${where} failed: ${name}${message ? `: ${message}` : ''}`);
}
