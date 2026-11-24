// コンテナのヘルスチェック用。API には触れない（web 自身が起きているかだけを返す）。
export const dynamic = 'force-static';

export function GET() {
  return new Response('ok', { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
}
