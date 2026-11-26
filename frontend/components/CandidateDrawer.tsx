'use client';

import { useCallback, useEffect, useRef } from 'react';
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
  /** 開いたとき見出しへフォーカスを移す（既定 true）。チャットの回答から自動で開くときは false（入力欄のフォーカスを奪わない） */
  autoFocus?: boolean;
  /**
   * 見出しへフォーカスを移す合図。マウントしたあとで値が増えたら（同じ候補の詳細が、見えないまま・フォーカスを移さないまま開いているときに、
   * ユーザーがボタンで「開く」をもう一度押した）、見出しへ移す。マウントしたときの値は合図に数えない（その移し方は autoFocus が決める）
   */
  focusNonce?: number;
}

/**
 * 候補の詳細。拡大ビューの「写真の比較」の中に収まる、流れの中の部品（地図に重ならない）。
 * 2018・2023 の切り出し、分類の説明、根拠の数字。重なりの表示（ドロワー）をやめたが、名前は変えない（差分を小さく保つ）
 */
export function CandidateDrawer({ candidateId, onClose, onShowOnMap, onLoaded, autoFocus = true, focusNonce = 0 }: Props) {
  const rootRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const openerRef = useRef<Element | null>(null);
  // 開いた時点の指定だけを使う。あとで変わっても、効果を作り直さない（作り直すと、閉じるときの戻し先の処理が走ってしまう）
  const autoFocusRef = useRef(autoFocus);
  const onLoadedRef = useRef(onLoaded);
  const { state, reload } = useAsync((signal) => getCandidate(candidateId, signal), [candidateId]);

  useEffect(() => {
    onLoadedRef.current = onLoaded;
  });

  // 見出しへフォーカスを移す。移す前にフォーカスのあった場所（詳細の外）を、閉じたときの戻し先として覚える
  const focusHeading = useCallback(() => {
    const active = document.activeElement;
    if (!rootRef.current?.contains(active)) openerRef.current = active;
    headingRef.current?.focus();
  }, []);

  // 開いたら見出しへフォーカスを移し（地図の「写真を比べる」から開いたときは、同じ更新の中で ResultArea の layout effect が、この effect より先にフォーカスを写真の比較のタブへ移す。だから覚える場所はそのタブ）、
  // 外れたとき、フォーカスを失っていれば（詳細の中にあった要素ごと消えて、body に落ちた）、覚えた場所へ戻す。
  // いまフォーカスが別の所にあるなら、動かさない: 見えない間に別の候補へ替わって外れる詳細が、地図の印やチャットの入力欄にあるフォーカスを奪わないように。
  // autoFocus が false（チャットの回答から自動で開くとき）は、開いたとき移さず、戻し先も覚えない（入力欄にあるフォーカスを奪わない）
  useEffect(() => {
    if (autoFocusRef.current) focusHeading();
    return () => {
      const active = document.activeElement;
      if (active && active !== document.body) return;
      const el = openerRef.current;
      if (el instanceof HTMLElement && document.contains(el)) el.focus();
    };
  }, [focusHeading]);

  // 開いたあとの合図（同じ候補をもう一度「開く」）。ユーザーが押したボタンが、新しい戻し先になる
  const seenFocusNonce = useRef(focusNonce);
  useEffect(() => {
    if (seenFocusNonce.current === focusNonce) return;
    seenFocusNonce.current = focusNonce;
    focusHeading();
  }, [focusNonce, focusHeading]);

  useEffect(() => {
    if (state.status === 'ready') onLoadedRef.current?.(state.data);
  }, [state]);

  /**
   * 閉じる（「閉じる」ボタン・Esc）。閉じる直前にフォーカスが詳細の中にあれば、先に、開く前の場所（覚えていれば。チャットの「詳細」ボタンなど）へ、
   * 覚えていない・戻せないときは、この詳細が入っている tabpanel を名づけているタブ（aria-labelledby。結果領域では「写真の比較」のタブ）へ移す。
   * 詳細が外れると、フォーカスのあった要素ごと消えて、フォーカスが body に落ちるため
   * （開いたとき戻し先を覚えなかった autoFocus=false の詳細、たとえば検出画像の回答で自動で開いたものは、戻し先が無いのでタブへ移す）。
   * 外れるときの後始末は、フォーカスが body に落ちたときだけ戻すので、ここで移したフォーカスは、そのまま残る
   */
  const close = () => {
    const root = rootRef.current;
    if (root?.contains(document.activeElement)) {
      const opener = openerRef.current;
      if (opener instanceof HTMLElement && document.contains(opener) && !root.contains(opener)) opener.focus();
      if (root.contains(document.activeElement)) {
        const tabId = root.closest('[role="tabpanel"]')?.getAttribute('aria-labelledby')?.split(/\s+/)[0];
        (tabId ? document.getElementById(tabId) : null)?.focus();
      }
    }
    onClose();
  };

  return (
    <section
      ref={rootRef}
      className="drawer"
      aria-labelledby="drawer-title"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          close();
        }
      }}
    >
      <header className="drawer__head">
        <h2 id="drawer-title" ref={headingRef} tabIndex={-1} className="drawer__title">
          候補の詳細
        </h2>
        <button type="button" className="btn" onClick={close}>
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
    </section>
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
        {cls ? <ClassBadge cls={cls} reason={detail.reason} /> : <span className="pill">{String(detail.class)}</span>}
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
                      <span className="bar__fill" style={{ width: `${Math.min(100, Math.max(0, Number(raw) * 100))}%`, background: 'var(--primary)' }} />
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
