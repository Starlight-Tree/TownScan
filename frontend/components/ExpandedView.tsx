'use client';

import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import type { LayoutMode } from '../lib/layout-mode';
import type { ResultView } from '../lib/result-view';
import { CHAT_INPUT_ID } from './chat/types';
import { ResultArea, resultTabId } from './ResultArea';

interface Props {
  /** 広い: チャットの右の横パネル（タブの帯を、この中に置く）。狭い: タブの帯はチャットの上にあり、ここは、質問の行と 3 つの画面だけ */
  layout: LayoutMode;
  /** タブの帯と画面を結ぶ元の id（狭い幅は、チャットの上の帯と同じ値） */
  baseId: string;
  view: ResultView;
  /** ユーザー自身のタブ操作 */
  onViewChange: (view: ResultView) => void;
  /** 3 つの画面の中身（ResultArea へそのまま渡す） */
  panels: Record<ResultView, ReactNode>;
  /** どの回答の拡大ビューか。回答の質問（無いとき〔最初の画面の「解析した地区を地図で見る」〕は null） */
  question: string | null;
  /** 「閉じる」・Esc で閉じる。外す（マウントをやめる）のは、親 */
  onClose: () => void;
  /** 「チャットへ戻る」。広い幅は入力欄へフォーカスを移し、狭い幅はチャットのタブを選ぶ（親が決める）。拡大ビューは閉じない */
  onBackToChat: () => void;
  /** 閉じたとき、フォーカスを戻す要素（開いたボタン）を返す。閉じるときに呼ぶ。null・外れているときは、チャットの入力欄 */
  returnFocusTo: () => HTMLElement | null;
  /** 利用者の操作で開く・別の回答へ切り替えるたびに +1。変わったら、フォーカスをこの拡大ビュー（選んでいるタブ）へ移す（すでに中にあれば動かさない） */
  openNonce: number;
}

/**
 * 拡大ビュー。地図・グラフ・写真の比較（ResultArea）を見せる。**モーダルではない**（ADR 0007）:
 * 広い幅は、チャットの右に置く横パネル（`role="region"`・名前「結果」。`aria-modal` なし）。後ろのチャット・サイドパネルは、操作でき、スクロールもする（inert・スクロールの固定はしない）。
 * 狭い幅は、チャット・地図・グラフ・写真の 4 つのタブの画面で、タブの帯はチャットの上にある（HomeClient が置く）。この部品は、その画面の側（質問の行と 3 つの画面）。
 * 開くのは、回答の中の図の「拡大」・結果カードのボタンを押したときだけ。マウントしているあいだだけ開いている（Leaflet が、大きさの無い枠で始まらないように）。閉じると全部外す（回答の中の図は、別に残る）。
 *
 * - 利用者の操作で開く・別の回答へ切り替えたとき（openNonce）、フォーカスを中（選んでいるタブ。すでに中にあれば動かさない。詳細の見出しへ移す操作のときは、その見出し）へ移す。回答が届いたことでは動かさない。
 * - Tab は、外へも抜けられる（フォーカストラップを作らない）。
 * - Esc で閉じる（中にフォーカスがあるとき）。ただし、中の部品が Esc を使ったとき（preventDefault。地図の選択の解除）と、詳細（stopPropagation。詳細だけを閉じる）は、閉じない。
 * - 閉じると、フォーカスを開いたボタンへ戻す。開く・閉じるを live region で知らせない（フォーカスの移動で足りる）。
 */
export function ExpandedView({ layout, baseId, view, onViewChange, panels, question, onClose, onBackToChat, returnFocusTo, openNonce }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const returnRef = useRef(returnFocusTo);
  const viewRef = useRef(view);

  useEffect(() => {
    onCloseRef.current = onClose;
    returnRef.current = returnFocusTo;
    viewRef.current = view;
  });

  // 開いたとき・別の回答へ切り替えたとき（openNonce）: フォーカスを、選んでいるタブへ移す。詳細の見出しなど、中の要素がすでに受けていれば、そのまま。
  // タブの帯は、広い幅は中、狭い幅はチャットの上にあるので、帯の中も「中」として見る
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const tab = document.getElementById(resultTabId(baseId, viewRef.current));
    const bar = tab?.closest('.result-area__bar') ?? null;
    const active = document.activeElement;
    if (active && (root.contains(active) || bar?.contains(active))) return;
    (tab ?? root).focus({ preventScroll: true });
  }, [openNonce, baseId]);

  // 閉じたら、開いたボタンへ戻す（そのボタンが無ければ、チャットの入力欄）
  useEffect(
    () => () => {
      const returnTo = returnRef.current();
      (returnTo?.isConnected ? returnTo : document.getElementById(CHAT_INPUT_ID))?.focus({ preventScroll: true });
    },
    [],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape') return;
    // 中の部品が Esc を使ったとき（地図の選択の解除）は、閉じない。詳細は stopPropagation するので、ここへ来ない
    if (e.defaultPrevented) return;
    e.preventDefault();
    onClose();
  };

  const header = (
    <div className="expanded-view__context">
      <p className="expanded-view__question" title={question ?? undefined}>
        {question ? (
          <>
            <span className="expanded-view__question-label">この回答の質問: </span>
            {question}
          </>
        ) : (
          '解析した地区'
        )}
      </p>
      <button type="button" className="btn btn--small expanded-view__back" onClick={onBackToChat}>
        チャットへ戻る
      </button>
    </div>
  );

  return (
    <div
      ref={rootRef}
      className="expanded-view"
      data-layout={layout}
      // 広い幅は、チャットと並ぶ名前つきの領域。狭い幅は、タブの画面の一部なので、領域にはしない（タブの帯・画面の名前は、タブから読まれる）
      {...(layout === 'wide' ? { role: 'region', 'aria-label': '結果' } : {})}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <ResultArea
        baseId={baseId}
        view={view}
        onViewChange={onViewChange}
        panels={panels}
        header={header}
        showTabs={layout === 'wide'}
        trailing={
          <button type="button" className="btn expanded-view__close" title="拡大ビューを閉じます（Esc でも閉じます）" onClick={onClose}>
            閉じる
          </button>
        }
      />
    </div>
  );
}
