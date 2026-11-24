import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONTENT_SECURITY_POLICY, securityHeaders } from './security-headers';

function valueOf(headers: { key: string; value: string }[], key: string) {
  return headers.find((h) => h.key === key)?.value;
}

describe('セキュリティヘッダー', () => {
  it('ほかのサイトへの埋め込みを禁じる（X-Frame-Options: DENY と CSP の frame-ancestors）', () => {
    const headers = securityHeaders();
    expect(valueOf(headers, 'X-Frame-Options')).toBe('DENY');
    expect(valueOf(headers, 'Content-Security-Policy')).toBe("frame-ancestors 'none'");
  });

  it('CSP は frame-ancestors だけ（地理院タイル・Leaflet・Next の inline を妨げる指令を付けない）', () => {
    const directives = CONTENT_SECURITY_POLICY.split(';').map((d) => d.trim()).filter(Boolean);
    expect(directives).toEqual(["frame-ancestors 'none'"]);
    for (const name of ['default-src', 'script-src', 'style-src', 'img-src', 'connect-src', 'font-src', 'form-action']) {
      expect(CONTENT_SECURITY_POLICY).not.toContain(name);
    }
  });

  it('MIME の推測を止め、リファラーはオリジンだけを渡す', () => {
    const headers = securityHeaders();
    expect(valueOf(headers, 'X-Content-Type-Options')).toBe('nosniff');
    expect(valueOf(headers, 'Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });

  it('Permissions-Policy は、カメラ・マイク・位置情報を空にする', () => {
    expect(valueOf(securityHeaders(), 'Permissions-Policy')).toBe('camera=(), microphone=(), geolocation=()');
  });

  it('HSTS は付けない（ローカルは http で動かす）', () => {
    expect(valueOf(securityHeaders(), 'Strict-Transport-Security')).toBeUndefined();
  });

  it('同じヘッダー名を重複させない', () => {
    const names = securityHeaders().map((h) => h.key.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('next.config.ts', () => {
  const config = readFileSync(join(process.cwd(), 'next.config.ts'), 'utf8');

  it('headers() で、全パスにセキュリティヘッダーを付ける', () => {
    expect(config).toContain("import { securityHeaders } from './lib/security-headers';");
    expect(config).toMatch(/async headers\(\)\s*\{\s*return \[\{ source: '\/\(\.\*\)', headers: securityHeaders\(\) \}\];\s*\}/);
  });
});
