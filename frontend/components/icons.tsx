import { useId } from 'react';
import type { ReactNode } from 'react';

/** 線画のアイコンの共通の枠。JobNavi・DocuNavi と同じく、アイコンのライブラリは使わず、線だけの SVG を直に置く（20×20 の枠・線の太さ 1.6・端と角は丸く）。名前は、アイコンを入れるボタン・リンクの側が持つ（ここは読み上げの対象にしない）。 */
function Line({ size, children }: { size: number; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

/**
 * サイドパネル上部のロゴの絵（JobNavi・DocuNavi と同じ。星あかりの空に立つ大樹）。色は 1 色で、周りの文字の色（`currentColor`）に合わせる。
 * ファビコン（`app/icon.svg`）も同じ絵。
 * 白抜きのマスクの色は、JobNavi では 16 進の記法（白と黒）で書いてある。ここでは同じ色を名前（white・black）で書いた（lib/theme.test.ts が、TS の中の色の 16 進の直書きを禁じているため。描画は同じ）。
 */
export function BrandIcon() {
  // 白抜きのマスクの id は、ロゴを同時に 2 つ描いても重ならないよう、インスタンスごとに分ける
  const maskId = `brand-mask-${useId().replace(/:/g, '')}`;
  return (
    <svg className="app-brand-icon" width="24" height="24" viewBox="1 0.5 30 30" aria-hidden="true">
      <g fill="currentColor">
        <path d="M16 0.5 L16.87 2.53 L18.9 3.4 L16.87 4.27 L16 6.3 L15.13 4.27 L13.1 3.4 L15.13 2.53Z" />
        <path d="M9 3.4 L9.6 4.8 L11 5.4 L9.6 6 L9 7.4 L8.4 6 L7 5.4 L8.4 4.8Z" />
        <path d="M23 3.4 L23.6 4.8 L25 5.4 L23.6 6 L23 7.4 L22.4 6 L21 5.4 L22.4 4.8Z" />
        <path d="M4.2 9.6 L4.62 10.58 L5.6 11 L4.62 11.42 L4.2 12.4 L3.78 11.42 L2.8 11 L3.78 10.58Z" />
        <path d="M27.8 9.6 L28.22 10.58 L29.2 11 L28.22 11.42 L27.8 12.4 L27.38 11.42 L26.4 11 L27.38 10.58Z" />
      </g>
      <g transform="translate(4.16 6.3) scale(0.74)">
        <mask id={maskId}>
          <rect width="32" height="32" fill="white" />
          <g fill="none" stroke="black" strokeWidth="1.5" strokeLinecap="round">
            <path d="M16 19 V9.5" />
            <path d="M16 16.5 L11 11.5" />
            <path d="M16 16.5 L21 11.5" />
          </g>
        </mask>
        <g fill="currentColor" mask={`url(#${maskId})`}>
          <circle cx="16" cy="11.5" r="7.5" />
          <circle cx="9" cy="14" r="5.5" />
          <circle cx="23" cy="14" r="5.5" />
          <circle cx="11.5" cy="8" r="5" />
          <circle cx="20.5" cy="8" r="5" />
          <path d="M14 17 H18 L19.2 28.5 H12.8Z" />
        </g>
      </g>
      <path d="M7 29.4 Q16 26.6 25 29.4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** サイドパネルを畳む・開くボタンの絵（JobNavi・DocuNavi と同じ。左に縦線のある四角）。 */
export function SidebarIcon() {
  return (
    <Line size={18}>
      <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
      <path d="M8 3.5v13" />
    </Line>
  );
}

/** 「新しい会話」の絵（十字。DocuNavi の PlusIcon と同じ）。 */
export function PlusIcon() {
  return (
    <Line size={18}>
      <path d="M10 4v12M4 10h12" />
    </Line>
  );
}

/** アカウントのアバターの絵（線画の人型）。 */
export function PersonIcon() {
  return (
    <Line size={18}>
      <circle cx="10" cy="7" r="3.2" />
      <path d="M3.5 17c0-3.3 2.9-5.5 6.5-5.5s6.5 2.2 6.5 5.5" />
    </Line>
  );
}

/** ゴミ箱（会話の削除。DocuNavi の TrashIcon と同じ線）。 */
export function TrashIcon() {
  return (
    <Line size={18}>
      <path d="M3.5 5.5h13M8 5.5V3.8c0-.7.5-1.3 1.2-1.3h1.6c.7 0 1.2.6 1.2 1.3v1.7M5.2 5.5l.7 10.2c0 .6.5 1.1 1.1 1.1h6c.6 0 1.1-.5 1.1-1.1l.7-10.2M8.3 9v4.5M11.7 9v4.5" />
    </Line>
  );
}
