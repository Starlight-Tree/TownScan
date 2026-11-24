import { NextResponse, type NextRequest } from 'next/server';

// 既定はホストで動かす API（compose の 127.0.0.1:8500）。コンテナでは API_URL（例 http://api:8000）で上書きする。
const DEFAULT_API_URL = 'http://127.0.0.1:8500';

/** ログイン（Better Auth）の入口。画面のサーバーの app/api/auth/[...all]/route.ts が受けるので、API へは転送しない。 */
export function isAuthPath(pathname: string): boolean {
  return pathname === '/api/auth' || pathname.startsWith('/api/auth/');
}

/**
 * /api/* を API へ転送する（ブラウザからは同じオリジンに見える）。ただし /api/auth/*（ログイン）は転送せず、画面のサーバーへ通す。
 * next.config の rewrites はビルド時に転送先が固定されるため、実行時に process.env.API_URL を読めるこちらで行う。
 */
export function proxy(request: NextRequest) {
  if (isAuthPath(request.nextUrl.pathname)) return NextResponse.next();
  const base = process.env.API_URL || DEFAULT_API_URL;
  let target: URL;
  try {
    target = new URL(request.nextUrl.pathname + request.nextUrl.search, base);
  } catch {
    return NextResponse.json(
      { error: { code: 'bad_gateway', message: 'API_URL が正しい URL ではありません。' } },
      { status: 502 },
    );
  }
  return NextResponse.rewrite(target);
}

export const config = { matcher: '/api/:path*' };
