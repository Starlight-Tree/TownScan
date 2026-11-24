import { toNextJsHandler } from 'better-auth/next-js';
import { getAuth } from '../../../../lib/auth';

// ブラウザーからのログインの通信（Google への行き来・Cookie・JWKS）を、Better Auth に渡す。設定が足りないときは 503（画面は「まだ設定されていません」と出す）。
// /api/auth/* は、proxy.ts が API へ転送せず、ここへ通す（それ以外の /api/* は API へ転送する）。
export const dynamic = 'force-dynamic';

const notConfigured = () => Response.json({ error: 'not_configured' }, { status: 503 });

export async function GET(request: Request): Promise<Response> {
  const auth = getAuth();
  return auth ? toNextJsHandler(auth).GET(request) : notConfigured();
}

export async function POST(request: Request): Promise<Response> {
  const auth = getAuth();
  return auth ? toNextJsHandler(auth).POST(request) : notConfigured();
}
