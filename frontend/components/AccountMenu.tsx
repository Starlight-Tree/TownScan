'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { PersonIcon } from './icons';
import { selectTheme, useThemeChoice } from './theme-store';
import { THEME_OPTIONS } from './themeOptions';

type Props = {
  /** ログイン中の表示名。渡さなければ、ログインしていない人のメニュー（テーマと、`loginHref` があればログインの入口）。 */
  name?: string;
  email?: string;
  logout?: () => Promise<void>;
  /** プロフィール画像の URL。https のときだけ表示し、読めなければ人型アイコンに戻す（JobNavi・DocuNavi と同じ）。 */
  image?: string | null;
  /** ログインしていない人のメニューに出す、ログイン（Google）の行き先。 */
  loginHref?: string;
};

/**
 * サイドパネル下部のアカウント（JobNavi・DocuNavi と同じ形）。アバターのボタンを押すと、メニューが開く（細い帯では右へ、開いたパネルでは上へ。1023px 以下の上の横帯では下へ）。パネルを開いているときは、ボタンにアバターと名前が並ぶ。
 * ログイン中は、メールアドレス（先頭）・テーマ（ライト / ダーク / システム）・ログアウト（名前は、パネルを開いているときのボタンに出る）。ログインしていなければ、テーマと、ログインの入口（入口があるときは、ボタンの名前が「ログイン」で、人型のアイコン。入口が無ければ、「メニュー」と ≡）。
 * 開いたら先頭の項目にフォーカスを置く。↑↓ で移動、Esc で閉じてボタンへ戻る。メニューの外を押しても閉じる。
 * テーマを選ぶと localStorage に保存し、以後は OS より優先する（「システム」で OS に従う状態へ戻す）。保存値は、描画のあとに読む（theme-store.ts。サーバーの出力とずれないよう、描画の最初には読まない）。
 * JobNavi にある「表示名を変更」と「画面への入口（nav）」は、TownScan にはない（名前を持たない。行き先はサイドパネルの項目にある）。
 */
export function AccountMenu({ name, email, logout, image, loginHref }: Props) {
  const signedIn = name !== undefined && email !== undefined && logout !== undefined;
  // 読み込みに失敗した URL は覚えて、人型アイコンに戻す（URL が変わったら、また試す）
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const avatarUrl = signedIn && image && image.startsWith('https://') && image !== failedImage ? image : null;
  const [open, setOpen] = useState(false);
  const theme = useThemeChoice();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  // ログインしていない人のボタンの名前。ログインの入口があるときは、「ログイン」と名乗る（「メニュー」だけでは、ログインの入口と分からない）。入口が無ければ（テーマだけ）、「メニュー」。
  // 見える文字（label）は、読み上げの名前（button）に含める
  const guest = loginHref
    ? { label: 'ログイン', button: 'ログイン・テーマのメニュー', tip: 'ログイン・テーマ', menu: 'ログインとテーマ' }
    : { label: 'メニュー', button: 'メニュー', tip: 'メニュー', menu: 'メニュー' };

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();
    const onPointer = (event: MouseEvent) => {
      const node = event.target as Node;
      if (!menuRef.current?.contains(node) && !buttonRef.current?.contains(node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [open]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
    const index = items.findIndex((node) => node === document.activeElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    } else if (event.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div className="account">
      {open ? (
        <div ref={menuRef} id={menuId} role="menu" aria-label={signedIn ? 'アカウント' : guest.menu} className="account-menu" onKeyDown={handleKeyDown}>
          {signedIn ? <p className="account-who">{email}</p> : null}
          <div role="group" aria-label="テーマ" className="account-theme">
            <span className="account-theme-label" aria-hidden="true">
              テーマ
            </span>
            <span className="account-theme-options">
              {THEME_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={theme === option.value}
                  aria-label={option.label}
                  title={option.label}
                  className="account-theme-option"
                  onClick={() => selectTheme(option.value)}
                >
                  {option.icon}
                </button>
              ))}
            </span>
          </div>
          {signedIn ? (
            <form action={logout}>
              <button type="submit" role="menuitem" className="account-item">
                ログアウト
              </button>
            </form>
          ) : loginHref ? (
            <Link href={loginHref} role="menuitem" className="account-item" onClick={() => setOpen(false)}>
              Google でログイン
            </Link>
          ) : null}
        </div>
      ) : null}
      <button
        ref={buttonRef}
        type="button"
        className="account-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={signedIn ? `${name}のアカウントメニュー` : guest.button}
        data-tip={signedIn ? 'アカウントメニュー' : guest.tip}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="account-avatar" aria-hidden="true">
          {avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- Google のプロフィール画像（外部の URL）をそのまま出す。最適化の対象外（next.config の images.unoptimized）
            <img src={avatarUrl} alt="" referrerPolicy="no-referrer" onError={() => setFailedImage(avatarUrl)} />
          ) : signedIn || loginHref ? (
            <PersonIcon />
          ) : (
            '≡'
          )}
        </span>
        {/* 名前と矢印は、サイドパネルを開いているときだけ CSS が見せる（閉じた帯では隠す） */}
        <span className="account-label" aria-hidden="true">
          {signedIn ? name : guest.label}
        </span>
        <span className="account-caret" aria-hidden="true">
          ▴
        </span>
      </button>
    </div>
  );
}
