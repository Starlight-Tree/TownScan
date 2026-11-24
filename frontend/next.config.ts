import type { NextConfig } from 'next';
import { securityHeaders } from './lib/security-headers';

const nextConfig: NextConfig = {
  // Docker の prebuilt / runtime のどちらでも .next/standalone/server.js を実行する
  output: 'standalone',
  // standalone の出力が frontend/ を根にするよう固定する（親ディレクトリのロックファイルに引かれない）
  outputFileTracingRoot: import.meta.dirname,
  poweredByHeader: false,
  // next/image は使わない。sharp（OS ごとのネイティブ部品）を standalone に含めない
  images: { unoptimized: true },
  devIndicators: false,
  agentRules: false,
  allowedDevOrigins: ['127.0.0.1'],
  // セキュリティヘッダー（クリックジャッキング対策など。中身と理由は lib/security-headers.ts）。全パスに付ける
  async headers() {
    return [{ source: '/(.*)', headers: securityHeaders() }];
  },
  // /api/* の転送は rewrites ではなく proxy.ts で行う。
  // rewrites の転送先は next build の時点で routes-manifest.json に固定され、実行時の API_URL が効かない（実測）。
};

export default nextConfig;
