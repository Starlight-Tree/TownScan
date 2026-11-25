'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { useWideScreen } from '../lib/use-wide-screen';
import { BrandIcon, PlusIcon, SidebarIcon } from './icons';
import { useStartNewConversation } from './NewConversation';

type Props = {
  /** ロゴの名前（読み上げと、ホバーで出る名前）と、その行き先。 */
  brand: string;
  brandHref: string;
  /** ナビゲーションの名前（読み上げ用）。 */
  navLabel: string;
  /** 下部に出すもの（アカウントのメニュー）。 */
  children?: ReactNode;
};

/**
 * 左のサイドパネル（JobNavi・DocuNavi と同じ。開いた表示と、アイコンだけの細い帯を、ボタンで切り替える）。
 * 開いた表示: 上にロゴと名前・閉じるボタン、続いて「新しい会話」、下にアカウント（アバター＋名前）。ページへの入口の欄は無い（ホームはロゴ、「このアプリの精度」はアカウントのメニューの中）。状態の印（模擬モデルなど）は出さない。はじめは開いた状態で、保存はしない。
 * 閉じた表示（細い帯）: ロゴの位置が「サイドパネルを開く」ボタンになる（ホバー・フォーカスで、ロゴが開閉の絵に変わる）。帯の空き部分をクリックしても開く。名前は、ホバーとキーボードのフォーカスで、アイコンの右に出る。
 * 開閉（細い帯）は、1024px 以上（JobNavi・DocuNavi と同じ）。1023px 以下は、はじめは閉じていて（出さない）、上の細い行の「サイドパネルを開く」ボタンで、本文の上に重ねて開く（DocuNavi の狭い幅と同じく、開閉できる。背景の暗い部分・Esc・閉じるボタン・ページの移動・「新しい会話」で閉じる。重ねて開くときは、いつも開いた表示）。
 * ロゴの下に「新しい会話」（DocuNavi と同じ位置）。ホームが開いていればそのチャットを新しくし、ほかのページではホームへ移る（NewConversation.tsx）。
 * ボタンの名前は、閉じた表示では画面に出さない文字（`.app-rail-label`）で持つ（読み上げの名前になり、開いた表示では見える）。
 * 開閉の見た目（アカウントの名前を出すことを含む）は、`data-open` を見る CSS が決める。アカウントのメニューはサーバーの layout から渡されるので、開閉の状態は props では渡さない。
 */
export function AppSidebar({ brand, brandHref, navLabel, children }: Props) {
  const router = useRouter();
  const startNew = useStartNewConversation();
  // ホームが開いていれば、そのチャットを新しくする。ほかのページなら、ホームへ移る（チャットは新しく始まる）
  const newConversation = () => {
    if (!startNew()) router.push('/');
  };
  const wide = useWideScreen();
  const pathname = usePathname();
  // PC 幅の開閉（細い帯）。狭い幅の「重ねて開く」は、別の状態（drawer）。重ねて開くときは、いつも開いた表示
  const [open, setOpen] = useState(true);
  // 重ねて開いたときのページ（pathname）を一緒に持つ。ページが変わったら、開いたときと違うので、閉じた扱いにする（effect で state を直さない）
  const [drawer, setDrawerState] = useState<string | null>(null);
  const setDrawer = (next: boolean) => setDrawerState(next ? pathname : null);
  // ページが変わったら、描画の中で閉じた状態へ戻す（あとで同じページへ戻っても、開いたままにならない）
  if (drawer !== null && drawer !== pathname) setDrawerState(null);
  const drawerOpen = !wide && drawer !== null;
  const rail = wide && !open;
  const openRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const drawerOpenerRef = useRef<HTMLButtonElement>(null);
  const toggled = useRef(false);
  // 開閉したら、フォーカスを、いま押せる側のボタンへ移す（消えたボタンにフォーカスを残さない）
  useEffect(() => {
    if (!toggled.current) return;
    (open ? closeRef.current : openRef.current)?.focus();
  }, [open]);
  const toggle = (next: boolean) => {
    toggled.current = true;
    setOpen(next);
  };
  const closeDrawer = (refocus: boolean) => {
    setDrawer(false);
    if (refocus) drawerOpenerRef.current?.focus();
  };
  const openDrawer = () => {
    setDrawer(true);
    // 開いたら、閉じるボタンへフォーカスを移す（描画のあとに）
    setTimeout(() => closeRef.current?.focus(), 0);
  };
  // 重ねて開いているときの Esc（アカウントのメニューの Esc は、メニューだけを閉じる）
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || !drawerOpen) return;
    if (event.target instanceof Element && event.target.closest('[role="menu"]')) return;
    event.preventDefault();
    closeDrawer(true);
  };
  return (
    <>
    <div className="app-narrow-bar">
      <button ref={drawerOpenerRef} type="button" className="app-icon-btn" aria-label="サイドパネルを開く" aria-expanded={drawerOpen} onClick={openDrawer}>
        <SidebarIcon />
      </button>
    </div>
    {drawerOpen && <button type="button" className="app-scrim" aria-hidden="true" tabIndex={-1} onClick={() => closeDrawer(true)} />}
    <aside className="app-sidebar" data-open={rail ? 'false' : 'true'} data-drawer={drawerOpen ? 'open' : 'closed'} onKeyDown={onKeyDown}>
      {/* 閉じた細い帯の空き部分をクリックしても開く（JobNavi・DocuNavi と同じ）。下敷きのボタンがパネル全体を覆い、帯の項目・アイコンは、その上に載って自分のクリックだけを受ける（globals.css の pointer-events）。
          マウス用なので、読み上げ・Tab の対象にはしない（キーボードと読み上げは、先頭のロゴの位置のボタンが受ける） */}
      {rail && <button type="button" className="app-rail-open" aria-hidden="true" tabIndex={-1} onClick={() => toggle(true)} />}
      <nav className="app-rail" aria-label={navLabel}>
        <div className="app-brand-row">
          <Link href={brandHref} className="app-rail-btn app-rail-logo app-brand-link" data-tip={brand} onClick={() => setDrawer(false)}>
            <BrandIcon />
            <span className="app-rail-label app-brand-name">{brand}</span>
          </Link>
          {!rail ? (
            <button ref={closeRef} type="button" className="app-icon-btn app-toggle" aria-label="サイドパネルを閉じる" aria-expanded="true" onClick={() => (wide ? toggle(false) : closeDrawer(true))}>
              <SidebarIcon />
            </button>
          ) : (
            <button ref={openRef} type="button" className="app-rail-btn app-rail-logo app-open-btn app-toggle" aria-label="サイドパネルを開く" aria-expanded="false" data-tip="サイドパネルを開く" onClick={() => toggle(true)}>
              <BrandIcon />
              <span className="app-open-icon">
                <SidebarIcon />
              </span>
            </button>
          )}
        </div>
        <button
          type="button"
          className="app-rail-btn app-new"
          data-tip="新しい会話"
          onClick={() => {
            setDrawer(false);
            newConversation();
          }}
        >
          <PlusIcon />
          <span className="app-rail-label">新しい会話</span>
        </button>
      </nav>
      <div className="app-rail-foot">
        {children}
      </div>
    </aside>
    </>
  );
}
