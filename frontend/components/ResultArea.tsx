'use client';

import { useEffect, useId, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { RESULT_VIEW_LABELS, RESULT_VIEW_ORDER, type ResultView } from '../lib/result-view';
import { ResultPanelBoundary } from './ResultPanelBoundary';

interface Props {
  view: ResultView;
  /** ユーザー自身のタブ操作（クリック・矢印キー・Home・End）。回答や結果カードからの切り替えは、親が view を直接変える */
  onViewChange: (view: ResultView) => void;
  /** 3 つの画面の中身。どれも外さず、選んでいない画面は hidden にする（地図の Leaflet が、位置や拡大を保つため） */
  panels: Record<ResultView, ReactNode>;
  /** 結果領域を広げているか（チャットの列を狭める）。無ければ「拡大」ボタンを出さない */
  expanded?: boolean;
  onToggleExpanded?: () => void;
  /** 値が変わるたびに（回答・結果カード・詳細の操作で画面が替わったとき）、縦に積む幅では結果領域の上端が見える所までスクロールする。フォーカスは動かさない */
  revealNonce?: number;
  /** マウントされた直後にも、同じ「見える所まで」のスクロールをする。閉じていた結果領域が、回答・操作で開いた（マウントされた）とき、縦に積む幅ではチャットの下に出て見えないため */
  revealOnMount?: boolean;
}

/** 上端がこの割合（画面の高さに対して）より下にあるときは、見えていても「見える所まで」動かす（下の端に頭だけ出ている状態を、見えたと数えない） */
const REVEAL_LIMIT = 0.6;

/**
 * 結果領域の上端が見える所まで、ページをスクロールする。チャットと結果領域が縦に積む幅（1000px 未満、またはサイドパネルを開いた 1024〜1256px）では、
 * 結果領域がチャットの下にあり、画面が替わっても見える変化が無いため。横に並ぶ幅では、最初から上端が見えているので、何も起きない。
 * scrollIntoView は、スクロールするだけでフォーカスを動かさない。無い環境（jsdom）では何もしない
 */
function revealIfOutOfView(el: HTMLElement | null) {
  if (!el || typeof el.scrollIntoView !== 'function') return;
  const { top } = el.getBoundingClientRect();
  const height = window.innerHeight || document.documentElement.clientHeight;
  if (top >= 0 && top <= height * REVEAL_LIMIT) return;
  const reduceMotion = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ block: 'start', behavior: reduceMotion ? 'auto' : 'smooth' });
}

/**
 * `/` の右の結果領域。地図・グラフ・写真の比較を、タブで切り替える（WAI-ARIA の tabs。選ぶと同時に切り替わる方式）。
 * 選択中のタブだけ Tab キーの順に入り、タブの間は矢印キー・Home・End で動く
 */
export function ResultArea({
  view,
  onViewChange,
  panels,
  expanded = false,
  onToggleExpanded,
  revealNonce,
  revealOnMount = false,
}: Props) {
  const baseId = useId();
  const rootRef = useRef<HTMLElement>(null);
  const tabRefs = useRef<Partial<Record<ResultView, HTMLButtonElement | null>>>({});
  const panelRefs = useRef<Partial<Record<ResultView, HTMLDivElement | null>>>({});
  const previousView = useRef(view);
  // 初回の描画では動かさない（開いたばかりのページを、勝手にスクロールしない）。値が変わったときだけ
  const seenNonce = useRef(revealNonce);
  const tabId = (v: ResultView) => `${baseId}-tab-${v}`;
  const panelId = (v: ResultView) => `${baseId}-panel-${v}`;

  // 見ていた画面の中（「地図で見る」など）にフォーカスがあるまま画面が替わると、フォーカスが消える。そのときだけ、選ばれたタブへ移す。
  // 画面の外（チャットの入力・ボタン）にあるフォーカスは、動かさない。DOM の更新の直後（描画の前）に見ないと、ブラウザーが先にフォーカスを外してしまう
  useLayoutEffect(() => {
    const before = previousView.current;
    previousView.current = view;
    if (before === view) return;
    const active = document.activeElement;
    if (active && panelRefs.current[before]?.contains(active)) tabRefs.current[view]?.focus();
  }, [view]);

  // 開いたとき（マウント）の 1 回。マウント時の値で決める
  const revealOnMountRef = useRef(revealOnMount);
  useEffect(() => {
    if (revealOnMountRef.current) revealIfOutOfView(rootRef.current);
  }, []);

  useEffect(() => {
    if (seenNonce.current === revealNonce) return;
    seenNonce.current = revealNonce;
    revealIfOutOfView(rootRef.current);
  }, [revealNonce]);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    // 修飾キー付きの組み合わせ（Alt+←＝ブラウザーの戻る、Cmd+←、Ctrl+Home など）は、ブラウザー・OS の操作。奪わない
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const last = RESULT_VIEW_ORDER.length - 1;
    let to: number;
    if (e.key === 'ArrowRight') to = index === last ? 0 : index + 1;
    else if (e.key === 'ArrowLeft') to = index === 0 ? last : index - 1;
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = last;
    else return;
    e.preventDefault();
    const next = RESULT_VIEW_ORDER[to]!;
    tabRefs.current[next]?.focus();
    onViewChange(next);
  };

  return (
    <section ref={rootRef} className="result-area" aria-label="結果">
      {/* 帯は、タブの列（tablist）と、拡大のボタンを並べる。tablist には、タブだけを入れる */}
      <div className="result-area__bar">
        <div className="result-area__tabs" role="tablist" aria-label="結果の見せ方">
          {RESULT_VIEW_ORDER.map((v, i) => {
            const selected = v === view;
            return (
              <button
                key={v}
                ref={(el) => {
                  tabRefs.current[v] = el;
                }}
                id={tabId(v)}
                type="button"
                role="tab"
                className="result-area__tab"
                aria-selected={selected}
                aria-controls={panelId(v)}
                tabIndex={selected ? 0 : -1}
                onClick={() => onViewChange(v)}
                onKeyDown={(e) => onKeyDown(e, i)}
              >
                {RESULT_VIEW_LABELS[v]}
              </button>
            );
          })}
        </div>
        {onToggleExpanded && (
          // 名前は「拡大」のまま、状態は aria-pressed で持つ（名前も変えると、二重に状態を言うことになる）。
          // 広げているときは、押すと何が起きるか（元の大きさに戻る）を、目に見える文でも出す: 向きを替えた矢印と太い枠だけでは、「広がっている」状態の印としか読めない。
          // この文は見た目の補足なので aria-hidden（名前を「拡大」のまま保つ）。読み上げには、title（説明）で同じことを伝える。
          // 押してもフォーカスは動かさない（ボタンは外れず、そのまま残る）。縦に積む幅では CSS で隠す（広げる先の列が無い）
          <button
            type="button"
            className="result-area__expand"
            aria-pressed={expanded}
            title={expanded ? '元の大きさに戻します' : 'チャットの列を狭めて、結果領域を広げます'}
            onClick={onToggleExpanded}
          >
            <ExpandIcon expanded={expanded} />
            拡大
            {expanded && (
              <span className="result-area__expand-hint" aria-hidden="true">
                （元の大きさに戻す）
              </span>
            )}
          </button>
        )}
      </div>
      <div className="result-area__panels">
        {RESULT_VIEW_ORDER.map((v) => (
          <div
            key={v}
            ref={(el) => {
              panelRefs.current[v] = el;
            }}
            id={panelId(v)}
            role="tabpanel"
            aria-labelledby={tabId(v)}
            className="result-area__panel"
            hidden={v !== view}
          >
            <ResultPanelBoundary name={RESULT_VIEW_LABELS[v]}>{panels[v]}</ResultPanelBoundary>
          </div>
        ))}
      </div>
    </section>
  );
}

/** 拡大のボタンの絵（装飾。名前と状態は、文字と aria-pressed が持つ）。広げているときは、向きを内側にして、色に頼らず状態を見分けられるようにする */
function ExpandIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className="result-area__expand-icon"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {expanded ? (
        <path d="M14 6h-4V2 M10 6l4-4 M2 10h4v4 M6 10l-4 4" />
      ) : (
        <path d="M10 2h4v4 M14 2l-5 5 M6 14H2v-4 M2 14l5-5" />
      )}
    </svg>
  );
}
