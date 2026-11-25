'use client';

import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { ResultView } from '../lib/result-view';
import { CHAT_INPUT_ID } from './chat/types';
import { ResultArea } from './ResultArea';

interface Props {
  view: ResultView;
  /** ユーザー自身のタブ操作 */
  onViewChange: (view: ResultView) => void;
  /** 3 つの画面の中身（ResultArea へそのまま渡す） */
  panels: Record<ResultView, ReactNode>;
  /** 「閉じる」・Esc・後ろの暗い部分で閉じる。外す（マウントをやめる）のは、親 */
  onClose: () => void;
  /** 閉じたとき、フォーカスを戻す要素（開いたボタン）を返す。閉じるときに呼ぶ。null・外れているときは、チャットの入力欄 */
  returnFocusTo: () => HTMLElement | null;
}

const TABBABLE = 'a[href], button, input, select, textarea, summary, [tabindex]';

/** ダイアログの中で、Tab で止まる要素（隠れたパネル・閉じた details の中身・tabindex=-1 の要素は除く） */
function tabbables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TABBABLE)).filter((el) => {
    if (el.matches('input[type="hidden"]') || (el as HTMLButtonElement).disabled) return false;
    // 属性が無い要素の既定は 0（button・a[href]・input など）。-1 は、矢印キーで動かす部品（タブ・地図の印）が、いまの 1 つ以外に付ける
    if (el.hasAttribute('tabindex') && el.tabIndex < 0) return false;
    if (el.closest('[hidden], [inert]')) return false;
    for (let d = el.closest('details'); d; d = d.parentElement?.closest('details') ?? null) {
      if (!d.open && !(el.tagName === 'SUMMARY' && el.parentElement === d)) return false;
    }
    return true;
  });
}

/** Tab が、ダイアログの外へ出ないようにする。端で反対の端へ回す（外にフォーカスがあるときは、中の端へ入れる） */
function cycleTab(e: { shiftKey: boolean; preventDefault: () => void }, dialog: HTMLElement) {
  const list = tabbables(dialog);
  const active = document.activeElement;
  if (list.length === 0) {
    e.preventDefault();
    dialog.focus();
    return;
  }
  const first = list[0]!;
  const last = list[list.length - 1]!;
  const outside = !dialog.contains(active);
  if (e.shiftKey) {
    if (outside || active === first || active === dialog) {
      e.preventDefault();
      last.focus();
    }
  } else if (outside || active === last) {
    e.preventDefault();
    first.focus();
  }
}

/**
 * 拡大ビュー。地図・グラフ・写真の比較（ResultArea）を、ダイアログ（`role="dialog"`・`aria-modal="true"`）に入れて見せる。
 * 幅 1024px 以上は画面の中央の大きなダイアログ、1023px 以下は窓いっぱいの全面のシート（CSS）。
 * 開くのは、結果カードのボタンを押したときだけ。マウントしているあいだだけ開いている（Leaflet が、大きさの無い枠で始まらないように）。閉じると全部外す。
 *
 * 開いているあいだ:
 * - 後ろのページ（body の、このダイアログ以外の子）は inert にして、操作できなくし、スクロールも固定する。閉じたら元に戻す。
 * - フォーカスは中へ移し（すでに中にあれば動かさない。詳細の見出しへ移す操作のときは、その見出し）、Tab は中だけを巡る。
 *   inert を実装しない環境でも外へ出ないよう、外へ出たフォーカスは中へ引き戻す。
 * - Esc で閉じる。ただし、中の部品が Esc を使ったとき（preventDefault。地図の選択の解除）と、詳細（stopPropagation。詳細だけを閉じる）は、閉じない。
 * - 後ろの暗い部分は、押し始めも押し終わりも後ろのときだけ閉じる（中で押し始めて、後ろで離したときは閉じない）。
 * 閉じると、フォーカスを開いたボタンへ戻す。開く・閉じるを live region で知らせない（フォーカスの移動で足りる）。
 */
export function ExpandedView({ view, onViewChange, panels, onClose, returnFocusTo }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const pressRef = useRef({ down: false, up: false });
  const onCloseRef = useRef(onClose);
  const returnRef = useRef(returnFocusTo);

  useEffect(() => {
    onCloseRef.current = onClose;
    returnRef.current = returnFocusTo;
  });

  useEffect(() => {
    const root = rootRef.current;
    const dialog = dialogRef.current;
    if (!root || !dialog) return;
    const body = document.body;

    // 後ろを操作できなくする（このダイアログは body 直下に置く）
    const inerted: Element[] = [];
    for (const el of Array.from(body.children)) {
      if (el === root || el.hasAttribute('inert')) continue;
      el.setAttribute('inert', '');
      inerted.push(el);
    }
    // 後ろのスクロールを固定する。スクロールバーが消えて、ページが横にずれないよう、その幅だけ余白を取る
    const saved = { overflow: body.style.overflow, paddingRight: body.style.paddingRight };
    const scrollbar = window.innerWidth - document.documentElement.clientWidth;
    body.style.overflow = 'hidden';
    if (scrollbar > 0) body.style.paddingRight = `${scrollbar}px`;

    // フォーカスを中へ。詳細の見出しなど、中の要素がすでに受けていれば、そのまま
    if (!dialog.contains(document.activeElement)) {
      (dialog.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ?? dialog).focus({ preventScroll: true });
    }

    let lastInside: HTMLElement | null = null;
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (target && dialog.contains(target)) {
        lastInside = target;
        return;
      }
      const back = lastInside && dialog.contains(lastInside) ? lastInside : (tabbables(dialog)[0] ?? dialog);
      back.focus({ preventScroll: true });
    };
    // フォーカスが中に無いとき（中の何も無い所を押して、body に落ちたあと）の Esc・Tab。中にあるときは、下の onKeyDown が受ける
    const onDocumentKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || (e.target instanceof Node && dialog.contains(e.target))) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
      } else if (e.key === 'Tab') {
        cycleTab(e, dialog);
      }
    };
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('keydown', onDocumentKeyDown);

    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('keydown', onDocumentKeyDown);
      for (const el of inerted) el.removeAttribute('inert');
      body.style.overflow = saved.overflow;
      body.style.paddingRight = saved.paddingRight;
      // 開いたボタンへ戻す（そのボタンが無ければ、チャットの入力欄）。inert を外したあとでないと、フォーカスできない
      const returnTo = returnRef.current();
      (returnTo?.isConnected ? returnTo : document.getElementById(CHAT_INPUT_ID))?.focus({ preventScroll: true });
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      // 中の部品が Esc を使ったとき（地図の選択の解除）は、閉じない。詳細は stopPropagation するので、ここへ来ない
      if (e.defaultPrevented) return;
      e.preventDefault();
      onClose();
    } else if (e.key === 'Tab' && dialogRef.current) {
      cycleTab(e, dialogRef.current);
    }
  };

  return createPortal(
    <div
      ref={rootRef}
      className="expanded-view"
      // 後ろの暗い部分: 押し始めも押し終わりも、この要素自身のときだけ閉じる（中で押し始めて、外で離すと、click はここへ来るので、押し終わりも見る）
      onMouseDown={(e) => {
        pressRef.current = { down: e.target === e.currentTarget, up: false };
      }}
      onMouseUp={(e) => {
        pressRef.current.up = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        const { down, up } = pressRef.current;
        pressRef.current = { down: false, up: false };
        if (e.target === e.currentTarget && down && up) onClose();
      }}
    >
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="結果" tabIndex={-1} className="expanded-view__dialog" onKeyDown={onKeyDown}>
        <ResultArea
          view={view}
          onViewChange={onViewChange}
          panels={panels}
          trailing={
            <button type="button" className="btn expanded-view__close" title="拡大ビューを閉じます（Esc でも閉じます）" onClick={onClose}>
              閉じる
            </button>
          }
        />
      </div>
    </div>,
    document.body,
  );
}
