import type { Provenance } from '../../lib/api-types';
import { useToolCall } from './tool-call-context';

/** 結果カードの根拠（出どころ）。折りたたみ。合成データのときは印を付ける */
export function ProvenanceBox({ provenance }: { provenance: Provenance }) {
  const synthetic = provenance.run_kind === 'synthetic';
  const tool = useToolCall();
  return (
    <details className="provenance">
      <summary>
        根拠を見る
        {synthetic && <span className="pill pill--warn pill--inline">合成データ</span>}
      </summary>
      <dl className="provenance__list">
        <dt>データ</dt>
        <dd>{provenance.source}</dd>
        <dt>写真の年</dt>
        <dd>{provenance.photo_years.length > 0 ? provenance.photo_years.map((y) => `${y} 年`).join('・') : '—'}</dd>
        <dt>モデル</dt>
        <dd>{provenance.model}</dd>
        {provenance.metric && (
          <>
            <dt>指標</dt>
            <dd>{provenance.metric}</dd>
          </>
        )}
        <dt>実行</dt>
        <dd>
          {provenance.run_id}（{synthetic ? '合成データ（テスト用）' : '実データ'}）
        </dd>
        {provenance.note && (
          <>
            <dt>注記</dt>
            <dd>{provenance.note}</dd>
          </>
        )}
        {tool && (
          <>
            <dt>ツール</dt>
            <dd>
              <code>{tool.name}</code>
              <code className="tool-list__args">{JSON.stringify(tool.args)}</code>
            </dd>
          </>
        )}
      </dl>
    </details>
  );
}
