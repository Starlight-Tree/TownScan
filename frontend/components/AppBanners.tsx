'use client';

import { useHealth } from './HealthProvider';

/**
 * 本文の上に出すバナー（どの幅でも出す）: 合成データ（テスト用）のとき、API に接続できないとき。
 * /api/health を、HealthProvider から読む。以前は上の横帯（AppHeader）の中にあったが、横帯をやめたので、ここへ分けた。
 */
export function AppBanners() {
  const { state, reload } = useHealth();
  const health = state.status === 'ready' ? state.data : null;
  const synthetic = health?.run?.kind === 'synthetic';

  return (
    <>
      {synthetic && (
        <div className="banner banner--synthetic" role="status">
          <strong>合成データ（テスト用）</strong>
          <span>
            いま表示している件数・地図・写真は、動作確認のために作った合成データです。実際の写真から出した結果ではありません。
          </span>
        </div>
      )}
      {state.status === 'error' && (
        <div className="banner banner--error" role="alert">
          <strong>API に接続できません</strong>
          <span>{state.error.message}</span>
          <button type="button" className="btn btn--small" onClick={reload}>
            再試行
          </button>
        </div>
      )}
    </>
  );
}
