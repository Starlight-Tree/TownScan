'use client';

import { useEffect, useRef } from 'react';
import { candidateImageUrl, getCandidate } from '../lib/api';
import type { CandidateDetail } from '../lib/api-types';
import { useAreas } from '../lib/areas-context';
import { CLASS_INFO, EVIDENCE_FIELDS, isCandidateClass, reasonText } from '../lib/classes';
import { formatArea, formatLonLat, formatProb, formatRatio } from '../lib/format';
import { useAsync } from '../lib/use-api';
import { CandidateImage } from './CandidateImage';
import { ClassBadge } from './ClassBadge';
import { ProvenanceBox } from './chat/ProvenanceBox';

interface Props {
  candidateId: string;
  onClose: () => void;
  onShowOnMap: (detail: CandidateDetail) => void;
  onLoaded?: (detail: CandidateDetail) => void;
}

/** 候補の詳細（右からのドロワー）。2018・2023 の切り出し、分類の説明、根拠の数字 */
export function CandidateDrawer({ candidateId, onClose, onShowOnMap, onLoaded }: Props) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const openerRef = useRef<Element | null>(null);
  const onLoadedRef = useRef(onLoaded);
  const { state, reload } = useAsync((signal) => getCandidate(candidateId, signal), [candidateId]);

  useEffect(() => {
    onLoadedRef.current = onLoaded;
  });

  // 開いたら見出しへフォーカスを移し、閉じたら元の場所へ戻す
  useEffect(() => {
    openerRef.current = document.activeElement;
    headingRef.current?.focus();
    return () => {
      const el = openerRef.current;
      if (el instanceof HTMLElement && document.contains(el)) el.focus();
    };
  }, []);

  useEffect(() => {
    if (state.status === 'ready') onLoadedRef.current?.(state.data);
  }, [state]);

  return (
    <aside
      className="drawer"
      role="dialog"
      aria-modal="false"
      aria-labelledby="drawer-title"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="drawer__head">
        <h2 id="drawer-title" ref={headingRef} tabIndex={-1} className="drawer__title">
          候補の詳細
        </h2>
        <button type="button" className="btn" onClick={onClose}>
          閉じる
        </button>
      </header>
      <div className="drawer__body">
        {state.status === 'loading' && (
          <p className="empty-note" role="status">
            読み込んでいます…
          </p>
        )}
        {state.status === 'error' && (
          <div className="inline-error" role="alert">
            <p>
              {state.error.status === 404
                ? `候補 ${candidateId} は見つかりませんでした。`
                : `詳細を読み込めませんでした（${state.error.message}）`}
            </p>
            {state.error.status !== 404 && (
              <button type="button" className="btn btn--small" onClick={reload}>
                再試行
              </button>
            )}
          </div>
        )}
        {state.status === 'ready' && <DetailBody detail={state.data} onShowOnMap={onShowOnMap} />}
      </div>
    </aside>
  );
}

function DetailBody({ detail, onShowOnMap }: { detail: CandidateDetail; onShowOnMap: (d: CandidateDetail) => void }) {
  const { nameOf } = useAreas();
  const cls = isCandidateClass(detail.class) ? detail.class : null;
  const images =
    detail.images && detail.images.length > 0
      ? detail.images
      : [2018, 2023].map((year) => ({ year, url: candidateImageUrl(detail.id, year) }));
  const reason = reasonText(detail.reason) ?? reasonText(detail.explanation_key) ?? detail.explanation ?? null;
  return (
    <>
      <div className="drawer__summary">
        {cls ? <ClassBadge cls={cls} /> : <span className="pill">{String(detail.class)}</span>}
        <p className="drawer__meta">
          {detail.area_name ?? nameOf(detail.area_id)}・{formatArea(detail.area_m2)}
          <br />
          <span className="drawer__id">{detail.id}</span>
        </p>
      </div>

      <section aria-label="2018 年と 2023 年の写真">
        <h3 className="drawer__h">同じ場所の写真（輪郭が、この候補）</h3>
        <div className="image-pair">
          {images.map((img) => (
            <CandidateImage key={img.year} src={img.url} year={img.year} candidateId={detail.id} />
          ))}
        </div>
        <p className="drawer__small">出典：国土地理院。写真は年度単位で、撮影月は分かりません。</p>
      </section>

      <section aria-label="分類の説明">
        <h3 className="drawer__h">どう判定したか</h3>
        {cls && <p className="drawer__p">{CLASS_INFO[cls].description}</p>}
        {reason && <p className="drawer__p drawer__p--reason">{reason}</p>}
      </section>

      <section aria-label="根拠の数字">
        <h3 className="drawer__h">根拠の数字</h3>
        <dl className="evidence">
          {EVIDENCE_FIELDS.map((f) => {
            const raw = detail.evidence ? detail.evidence[f.key] : undefined;
            if (raw === undefined || raw === null) return null;
            const text =
              f.kind === 'bool'
                ? raw
                  ? 'はい'
                  : 'いいえ'
                : f.kind === 'ratio'
                  ? formatRatio(Number(raw))
                  : formatProb(Number(raw));
            return (
              <div key={f.key} className="evidence__row">
                <dt>
                  {f.label}
                  <span className="evidence__hint">{f.hint}</span>
                </dt>
                <dd>
                  {text}
                  {f.kind !== 'bool' && (
                    <span className="bar bar--mini evidence__bar" aria-hidden="true">
                      <span className="bar__fill" style={{ width: `${Math.min(100, Math.max(0, Number(raw) * 100))}%`, background: 'var(--brand)' }} />
                    </span>
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
        <p className="drawer__small">
          分類の閾値は未検証の初期値です（手でラベルした正解が無いため）。数字は、ツールの結果をそのまま出しています。
        </p>
      </section>

      <section aria-label="位置">
        <h3 className="drawer__h">位置</h3>
        <p className="drawer__p">{formatLonLat(detail.centroid)}</p>
      </section>

      <div className="button-row">
        <button type="button" className="btn btn--primary" onClick={() => onShowOnMap(detail)}>
          地図で見る
        </button>
      </div>
      {detail.provenance && <ProvenanceBox provenance={detail.provenance} />}
    </>
  );
}
