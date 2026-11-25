'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useHealth } from './HealthProvider';
import { BrandIcon, MockModelIcon, ModelIcon, PlusIcon, SidebarIcon } from './icons';
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
 * 開いた表示: 上にロゴと名前・閉じるボタン、続いて「新しい会話」、下に API の状態の印とアカウント（アバター＋名前）。ページへの入口の欄は無い（ホームはロゴ、「このアプリの精度」はアカウントのメニューの中）。はじめは開いた状態で、保存はしない。
 * 閉じた表示（細い帯）: ロゴの位置が「サイドパネルを開く」ボタンになる（ホバー・フォーカスで、ロゴが開閉の絵に変わる）。帯の空き部分をクリックしても開く。名前は、ホバーとキーボードのフォーカスで、アイコンの右に出る。
 * 開閉できるのは、1024px 以上（JobNavi・DocuNavi と同じ）。1023px 以下は、サイドパネルを出さず、上の横帯（AppHeader。ブランド・状態の印・テーマの切り替え・アカウント）を出す（JobNavi は同じ要素が横帯に変わるが、TownScan は、いまの AppHeader をそのまま横帯に使う）。
 * ロゴの下に「新しい会話」（DocuNavi と同じ位置）。ホームが開いていればそのチャットを新しくし、ほかのページではホームへ移る（NewConversation.tsx）。
 * ボタンの名前は、閉じた表示では画面に出さない文字（`.app-rail-label`）で持つ（読み上げの名前になり、開いた表示では見える）。
 * 開閉の見た目（アカウントの名前を出すことを含む）は、`data-open` を見る CSS が決める。アカウントのメニューはサーバーの layout から渡されるので、開閉の状態は props では渡さない。
 * 状態の印: /api/health の llm が mock のとき「模擬モデルで応答しています」（mock 以外は「モデル: 名前」。AppHeader と同じ。HealthProvider の使い方は変えない）。細い帯では、アイコンだけで、名前はツールチップと読み上げで持つ。
 */
export function AppSidebar({ brand, brandHref, navLabel, children }: Props) {
  const router = useRouter();
  const startNew = useStartNewConversation();
  // ホームが開いていれば、そのチャットを新しくする。ほかのページなら、ホームへ移る（チャットは新しく始まる）
  const newConversation = () => {
    if (!startNew()) router.push('/');
  };
  const { state } = useHealth();
  const health = state.status === 'ready' ? state.data : null;
  const mock = health?.llm === 'mock';
  const statusText = health ? (mock ? '模擬モデルで応答しています' : `モデル: ${health.llm}`) : null;
  const [open, setOpen] = useState(true);
  const openRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
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
  return (
    <aside className="app-sidebar" data-open={open ? 'true' : 'false'}>
      {/* 閉じた細い帯の空き部分をクリックしても開く（JobNavi・DocuNavi と同じ）。下敷きのボタンがパネル全体を覆い、帯の項目・アイコンは、その上に載って自分のクリックだけを受ける（globals.css の pointer-events）。
          マウス用なので、読み上げ・Tab の対象にはしない（キーボードと読み上げは、先頭のロゴの位置のボタンが受ける） */}
      {!open && <button type="button" className="app-rail-open" aria-hidden="true" tabIndex={-1} onClick={() => toggle(true)} />}
      <nav className="app-rail" aria-label={navLabel}>
        <div className="app-brand-row">
          <Link href={brandHref} className="app-rail-btn app-rail-logo app-brand-link" data-tip={brand}>
            <BrandIcon />
            <span className="app-rail-label app-brand-name">{brand}</span>
          </Link>
          {open ? (
            <button ref={closeRef} type="button" className="app-icon-btn app-toggle" aria-label="サイドパネルを閉じる" aria-expanded="true" onClick={() => toggle(false)}>
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
        <button type="button" className="app-rail-btn app-new" data-tip="新しい会話" onClick={newConversation}>
          <PlusIcon />
          <span className="app-rail-label">新しい会話</span>
        </button>
      </nav>
      <div className="app-rail-foot">
        <div className="app-status" aria-live="polite">
          {statusText ? (
            <span className={`pill app-status-pill${mock ? ' pill--warn' : ''}`} data-tip={statusText}>
              {mock ? <MockModelIcon /> : <ModelIcon />}
              <span className="app-rail-label">{statusText}</span>
            </span>
          ) : null}
        </div>
        {children}
      </div>
    </aside>
  );
}
