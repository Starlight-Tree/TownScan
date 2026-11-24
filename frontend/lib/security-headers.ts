// 画面（Next.js）が返すセキュリティヘッダー。next.config.ts の headers() から全パスに付ける。
// 純関数にしておくのは、設定ファイルを読み込まずに、中身を vitest で確かめられるようにするため（JobNavi の lib/security-headers.ts から、必要な分だけ移した）。

export type SecurityHeader = { key: string; value: string };

// Content-Security-Policy は frame-ancestors だけにする（クリックジャッキング対策）。
// script-src・img-src・connect-src などは付けない: 地図（Leaflet）が国土地理院のタイル画像を別のホストから読み、
// Next.js が RSC の転送とテーマの描画前のスクリプト（app/layout.tsx）を inline で埋め込むため、制限すると画面が壊れる。
// 開発（next dev）にも付けてよい: フレームへの埋め込みの可否だけを決め、React の refresh（eval）には効かない。
export const CONTENT_SECURITY_POLICY = "frame-ancestors 'none'";

// HSTS（Strict-Transport-Security）は付けない: ローカルは http で動かす（本番ビルドを http で動かすことも多い）ため。
export function securityHeaders(): SecurityHeader[] {
  return [
    // Content-Type の推測（MIME スニッフィング）を止める
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    // 別のサイトへは、オリジン（パスなし）だけを渡す。画面の URL（検索や候補の ID）を外へ漏らさない
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    // フレームへの埋め込みを禁じる（ログインがあるので、別のサイトに重ねて表示させない）。
    // CSP の frame-ancestors を解さない古いブラウザー向けの備えも兼ねる
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Content-Security-Policy', value: CONTENT_SECURITY_POLICY },
    // 使わない機能は、閉じておく（位置情報も使わない: 地図は、利用者の現在地ではなく、熊本市中心部の固定の範囲を出す）
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  ];
}
