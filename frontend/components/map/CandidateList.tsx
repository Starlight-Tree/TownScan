'use client';

import { useState } from 'react';
import { getCandidates } from '../../lib/api';
import type { CandidateClass } from '../../lib/api-types';
import { useAreas } from '../../lib/areas-context';
import { formatArea, formatNumber } from '../../lib/format';
import { useAsync } from '../../lib/use-api';
import { ClassBadge } from '../ClassBadge';

const PAGE = 30;

interface Props {
  areaId: string | null;
  /**
   * 絞り込みの対象が 2 地区以上（区など）か。API は地区を 1 つしか受けないので、このときは一覧の本体を出さない
   * （出すと、地図・グラフ・集計の帯と対象がずれる）
   */
  multiArea?: boolean;
  cls: CandidateClass | null;
  onSelect: (id: string) => void;
}

/** 地図の印を使えない人（キーボード・スクリーンリーダー）のための、面積順の一覧 */
export function CandidateList({ areaId, multiArea = false, cls, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <details className="cand-list" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>候補を一覧で見る（面積の大きい順）</summary>
      {/* API が分類を 1 つしか受けない（契約は変えない）ので、複数の分類を表示しているときは、一覧が地図・グラフとずれる。見出しの近くで言う */}
      <p className="cand-list__note">分類が 1 つのときだけ、一覧も絞り込みます。</p>
      {open &&
        (multiArea ? (
          <p className="empty-note">地区を 1 つに絞ると、一覧が出ます。</p>
        ) : (
          <CandidateListBody areaId={areaId} cls={cls} onSelect={onSelect} />
        ))}
    </details>
  );
}

function CandidateListBody({ areaId, cls, onSelect }: Omit<Props, 'multiArea'>) {
  const { nameOf } = useAreas();
  const [limit, setLimit] = useState(PAGE);
  const { state, reload } = useAsync(
    (signal) => getCandidates({ area_id: areaId, cls, limit }, signal),
    [areaId, cls, limit],
  );

  if (state.status === 'loading') return <p className="empty-note" role="status">読み込んでいます…</p>;
  if (state.status === 'error') {
    return (
      <p className="inline-error" role="alert">
        一覧を読み込めませんでした（{state.error.message}）
        <button type="button" className="btn btn--small" onClick={reload}>
          再試行
        </button>
      </p>
    );
  }
  const { items, total } = state.data;
  if (items.length === 0) return <p className="empty-note">条件に合う候補はありません。</p>;
  return (
    <>
      <ul className="cand-list__items">
        {items.map((c) => (
          <li key={c.id}>
            <button type="button" className="cand-list__item" onClick={() => onSelect(c.id)}>
              <ClassBadge cls={c.class} reason={c.reason} short />
              <span className="cand-list__area">{formatArea(c.area_m2)}</span>
              <span className="cand-list__where">{c.area_name ?? nameOf(c.area_id)}</span>
              <span className="visually-hidden">（{c.id} の詳細を開く）</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="result-card__note">
        全 {formatNumber(total)} 件中 {formatNumber(items.length)} 件を表示
        {items.length < total && (
          <button type="button" className="btn btn--small" onClick={() => setLimit((n) => n + PAGE)}>
            さらに {PAGE} 件
          </button>
        )}
      </p>
    </>
  );
}
