'use client';

import { useId, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { RESULT_VIEW_LABELS, RESULT_VIEW_ORDER, type ResultView } from '../lib/result-view';
import { ResultPanelBoundary } from './ResultPanelBoundary';

/** タブの 1 つ。狭い幅では、先頭にチャットのタブが付く（ADR 0007） */
export type TabId = ResultView | 'chat';

const TAB_LABELS: Record<TabId, string> = { chat: '回答', ...RESULT_VIEW_LABELS };

/** タブ・画面の id。タブの帯（ResultTabs）と画面（ResultPanels・チャット）が、別の場所に置かれても、aria-controls・aria-labelledby で結べるよう、共通の元の id から作る */
export const resultTabId = (baseId: string, id: TabId) => `${baseId}-tab-${id}`;
export const resultPanelId = (baseId: string, id: TabId) => `${baseId}-panel-${id}`;

interface TabsProps {
  baseId: string;
  /** タブの並び。選べるものだけ（広い幅は地図・グラフ・写真の比較、狭い幅は先頭にチャットを足す） */
  tabs: readonly TabId[];
  selected: TabId;
  /** ユーザー自身のタブ操作（クリック・矢印キー・Home・End）。図の「拡大」・結果カードのボタンで開いたときの画面は、親が直接決める */
  onSelect: (id: TabId) => void;
  /** タブの名前の後ろに付ける文字の印（チャットの「新着」など）。色や点だけにしない */
  marks?: Partial<Record<TabId, string>>;
  /** タブの帯の右端に置く部品（「閉じる」ボタン）。tablist の外に置く */
  trailing?: ReactNode;
  /** 画面（tabpanel）がまだ無いタブ（拡大ビューを開く前の、地図・グラフ・写真の比較）。aria-controls を付けない（存在しない id を指さない） */
  unmounted?: readonly TabId[];
  /** 帯の中の Esc（中の部品が使っていないとき）。広い幅は、拡大ビューの外枠が受けるので、渡さない */
  onEscape?: () => void;
}

/**
 * タブの帯（WAI-ARIA の tabs。選ぶと同時に切り替わる方式）。選択中のタブだけ Tab キーの順に入り、タブの間は矢印キー（端で反対側へ回る）・Home・End で動く。
 * 広い幅は拡大ビューの中、狭い幅はチャットの上に置く（置き場は親が決める）
 */
export function ResultTabs({ baseId, tabs, selected, onSelect, marks, trailing, unmounted, onEscape }: TabsProps) {
  const tabRefs = useRef<Partial<Record<TabId, HTMLButtonElement | null>>>({});

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    // 修飾キー付きの組み合わせ（Alt+←＝ブラウザーの戻る、Cmd+←、Ctrl+Home など）は、ブラウザー・OS の操作。奪わない
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const last = tabs.length - 1;
    let to: number;
    if (e.key === 'ArrowRight') to = index === last ? 0 : index + 1;
    else if (e.key === 'ArrowLeft') to = index === 0 ? last : index - 1;
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = last;
    else return;
    e.preventDefault();
    const next = tabs[to]!;
    tabRefs.current[next]?.focus();
    onSelect(next);
  };

  return (
    // 帯は、タブの列（tablist）と、右端の部品（閉じるボタン）を並べる。tablist には、タブだけを入れる
    <div
      className="result-area__bar"
      onKeyDown={
        onEscape
          ? (e) => {
              if (e.key === 'Escape' && !e.defaultPrevented) {
                e.preventDefault();
                onEscape();
              }
            }
          : undefined
      }
    >
      <div className="result-area__tabs" role="tablist" aria-label="結果の見せ方">
        {tabs.map((v, i) => {
          const isSelected = v === selected;
          return (
            <button
              key={v}
              ref={(el) => {
                tabRefs.current[v] = el;
              }}
              id={resultTabId(baseId, v)}
              type="button"
              role="tab"
              className="result-area__tab"
              aria-selected={isSelected}
              aria-controls={unmounted?.includes(v) ? undefined : resultPanelId(baseId, v)}
              tabIndex={isSelected ? 0 : -1}
              onClick={() => onSelect(v)}
              onKeyDown={(e) => onKeyDown(e, i)}
            >
              {TAB_LABELS[v]}
              {marks?.[v] ? <span className="result-area__mark">{marks[v]}</span> : null}
            </button>
          );
        })}
      </div>
      {trailing}
    </div>
  );
}

interface PanelsProps {
  baseId: string;
  /** 見せている画面。null は、どれも見せない（狭い幅で、チャットのタブを選んでいるあいだ） */
  view: ResultView | null;
  /** 3 つの画面の中身。どれも外さず、選んでいない画面は hidden にする（地図の Leaflet が、位置や拡大を保つため） */
  panels: Record<ResultView, ReactNode>;
}

/** 3 つの画面（tabpanel）の置き場。どれも外さず、選んでいない画面は隠すだけ */
export function ResultPanels({ baseId, view, panels }: PanelsProps) {
  const previousView = useRef(view);

  // 見ていた画面の中（「地図で見る」など）にフォーカスがあるまま画面が替わると、フォーカスが消える。そのときだけ、選ばれたタブへ移す。
  // 画面の外（拡大ビューの「閉じる」ボタンなど）にあるフォーカスは、動かさない。DOM の更新の直後（描画の前）に見ないと、ブラウザーが先にフォーカスを外してしまう。
  // タブは、別の場所（狭い幅はチャットの上）にあるので、id で探す
  useLayoutEffect(() => {
    const before = previousView.current;
    previousView.current = view;
    if (before === view || before === null || view === null) return;
    const active = document.activeElement;
    if (active && document.getElementById(resultPanelId(baseId, before))?.contains(active)) document.getElementById(resultTabId(baseId, view))?.focus();
  }, [baseId, view]);

  return (
    <div className="result-area__panels">
      {RESULT_VIEW_ORDER.map((v) => (
        <div
          key={v}
          id={resultPanelId(baseId, v)}
          role="tabpanel"
          aria-labelledby={resultTabId(baseId, v)}
          className="result-area__panel"
          hidden={v !== view}
        >
          <ResultPanelBoundary name={RESULT_VIEW_LABELS[v]}>{panels[v]}</ResultPanelBoundary>
        </div>
      ))}
    </div>
  );
}

interface AreaProps {
  view: ResultView;
  onViewChange: (view: ResultView) => void;
  panels: Record<ResultView, ReactNode>;
  /** タブの帯の右端に置く部品（拡大ビューの「閉じる」ボタン） */
  trailing?: ReactNode;
  /** タブの帯と画面のあいだに置く行（どの回答かを示す行・閉じる ✕） */
  header?: ReactNode;
  /** タブの帯を、ここに置くか（広い幅）。狭い幅は、帯をチャットの上に置くので、false */
  showTabs?: boolean;
  /** 帯と画面を結ぶ元の id。タブの帯を別の場所に置くとき、そちらと同じ値を渡す（既定は、自前） */
  baseId?: string;
}

/**
 * 拡大ビュー（ExpandedView）の中身。地図・グラフ・写真の比較を、タブで切り替える。
 * 広い幅は、帯（3 つのタブ）と画面。狭い幅は、帯が外（チャットの上）にあるので、画面だけ（showTabs=false）
 */
export function ResultArea({ view, onViewChange, panels, trailing, header, showTabs = true, baseId }: AreaProps) {
  const ownId = useId();
  const base = baseId ?? ownId;
  return (
    <div className="result-area">
      {showTabs && <ResultTabs baseId={base} tabs={RESULT_VIEW_ORDER} selected={view} onSelect={(id) => id !== 'chat' && onViewChange(id)} trailing={trailing} />}
      {header}
      <ResultPanels baseId={base} view={view} panels={panels} />
    </div>
  );
}
