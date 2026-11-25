'use client';

import { useId, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { RESULT_VIEW_LABELS, RESULT_VIEW_ORDER, type ResultView } from '../lib/result-view';
import { ResultPanelBoundary } from './ResultPanelBoundary';

interface Props {
  view: ResultView;
  /** ユーザー自身のタブ操作（クリック・矢印キー・Home・End）。結果カードのボタンで開いたときの画面は、親が view を直接決める */
  onViewChange: (view: ResultView) => void;
  /** 3 つの画面の中身。どれも外さず、選んでいない画面は hidden にする（地図の Leaflet が、位置や拡大を保つため） */
  panels: Record<ResultView, ReactNode>;
  /** タブの帯の右端に置く部品（拡大ビューの「閉じる」ボタン）。tablist の外に置く */
  trailing?: ReactNode;
}

/**
 * 拡大ビュー（ExpandedView）の中身。地図・グラフ・写真の比較を、タブで切り替える（WAI-ARIA の tabs。選ぶと同時に切り替わる方式）。
 * 選択中のタブだけ Tab キーの順に入り、タブの間は矢印キー・Home・End で動く
 */
export function ResultArea({ view, onViewChange, panels, trailing }: Props) {
  const baseId = useId();
  const tabRefs = useRef<Partial<Record<ResultView, HTMLButtonElement | null>>>({});
  const panelRefs = useRef<Partial<Record<ResultView, HTMLDivElement | null>>>({});
  const previousView = useRef(view);
  const tabId = (v: ResultView) => `${baseId}-tab-${v}`;
  const panelId = (v: ResultView) => `${baseId}-panel-${v}`;

  // 見ていた画面の中（「地図で見る」など）にフォーカスがあるまま画面が替わると、フォーカスが消える。そのときだけ、選ばれたタブへ移す。
  // 画面の外（拡大ビューの「閉じる」ボタンなど）にあるフォーカスは、動かさない。DOM の更新の直後（描画の前）に見ないと、ブラウザーが先にフォーカスを外してしまう
  useLayoutEffect(() => {
    const before = previousView.current;
    previousView.current = view;
    if (before === view) return;
    const active = document.activeElement;
    if (active && panelRefs.current[before]?.contains(active)) tabRefs.current[view]?.focus();
  }, [view]);

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
    <div className="result-area">
      {/* 帯は、タブの列（tablist）と、右端の部品（閉じるボタン）を並べる。tablist には、タブだけを入れる */}
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
        {trailing}
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
    </div>
  );
}
