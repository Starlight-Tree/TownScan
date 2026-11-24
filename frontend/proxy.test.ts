// @vitest-environment node
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAuthPath, proxy } from './proxy';

afterEach(() => vi.unstubAllEnvs());

const req = (path: string) => new NextRequest(`http://localhost:3500${path}`);

describe('proxy（/api/* の転送）', () => {
  it('/api/* は、API_URL の同じパス・クエリへ書き換える', () => {
    vi.stubEnv('API_URL', 'http://api:8000');
    const res = proxy(req('/api/candidates?area_id=1'));
    expect(res.headers.get('x-middleware-rewrite')).toBe('http://api:8000/api/candidates?area_id=1');
  });

  it('API_URL が無ければ、ホストの API（127.0.0.1:8500）へ', () => {
    vi.stubEnv('API_URL', '');
    expect(proxy(req('/api/health')).headers.get('x-middleware-rewrite')).toBe('http://127.0.0.1:8500/api/health');
  });

  it('/api/me（アカウントの入口）も API へ転送する', () => {
    vi.stubEnv('API_URL', 'http://api:8000');
    expect(proxy(req('/api/me')).headers.get('x-middleware-rewrite')).toBe('http://api:8000/api/me');
  });

  it('/api/auth/*（ログイン）は、API へ転送せず、画面のサーバーへ通す', () => {
    vi.stubEnv('API_URL', 'http://api:8000');
    for (const path of ['/api/auth/sign-in/social', '/api/auth/callback/google?code=x', '/api/auth/jwks', '/api/auth']) {
      const res = proxy(req(path));
      expect(res.headers.get('x-middleware-rewrite'), path).toBeNull();
      expect(res.headers.get('x-middleware-next'), path).toBe('1');
    }
  });

  it('/api/auth で始まるだけの別のパスは、境目で区切って、API へ転送する', () => {
    vi.stubEnv('API_URL', 'http://api:8000');
    expect(isAuthPath('/api/authors')).toBe(false);
    expect(proxy(req('/api/authors')).headers.get('x-middleware-rewrite')).toBe('http://api:8000/api/authors');
    expect(isAuthPath('/api/auth/jwks')).toBe(true);
  });

  it('API_URL が URL でなければ 502（固定の文）', async () => {
    vi.stubEnv('API_URL', 'not a url');
    const res = proxy(req('/api/health'));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: { code: 'bad_gateway', message: 'API_URL が正しい URL ではありません。' } });
  });
});
