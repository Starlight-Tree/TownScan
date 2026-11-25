import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// CSS はテストでは読み込まれない（vitest の css: false）。全体のレイアウト（縦に積む幅のスクロール・上の帯・押す大きさ）は、規則そのものを確かめる。
// 見た目の確認ではなく、「この宣言が消えたら落ちる」ための守り
const css = readFileSync(join(process.cwd(), 'app', 'globals.css'), 'utf8');

/** `start` で始まる @media を、出てきた順にすべて（波括弧が閉じるまでの全体。入れ子の `{}` を数える） */
function mediaBlocks(start: string): string[] {
  const out: string[] = [];
  let from = css.indexOf(`\n${start} {`);
  while (from >= 0) {
    let depth = 0;
    let end = -1;
    for (let i = css.indexOf('{', from); i < css.length; i += 1) {
      if (css[i] === '{') depth += 1;
      if (css[i] === '}' && --depth === 0) {
        end = i + 1;
        break;
      }
    }
    expect(end, `${start} が閉じていない`).toBeGreaterThan(0);
    out.push(css.slice(from, end));
    from = css.indexOf(`\n${start} {`, end);
  }
  return out;
}

function mediaBlock(start: string): string {
  const [first] = mediaBlocks(start);
  expect(first, `${start} が無い`).toBeDefined();
  return first!;
}

/** ブロックの中の、セレクターが一致する規則の本体（インデントは問わない。`{` の直前までの一致） */
function ruleIn(block: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|\\n)[ \\t]*${escaped}\\s*\\{([^}]*)\\}`).exec(block);
  expect(m, `${selector} が無い`).not.toBeNull();
  return m![1]!;
}

const decl = (body: string, property: string): string | null => {
  const m = new RegExp(`(?:^|[\\s;{])${property}\\s*:\\s*([^;]+);`).exec(body);
  return m ? m[1]!.trim() : null;
};

describe('チャット（`/`）は 1 列だけ（常設の結果領域も、左右に並べる・縦に積む切り替えも無い）', () => {
  it('基本は 1 列。幅 1000px 以上は、中央に最大 760px の 1 列（チャットは、本文の残りの高さをすべて使う）', () => {
    const home = ruleIn(css, '.home');
    expect(decl(home, 'grid-template-columns')).toBe('minmax(0, 1fr)');
    // 同じ条件の @media が複数ある（本文の高さの規則など）。チャットの 1 列の規則を持つ方を取る
    const wide = mediaBlocks('@media (min-width: 1000px)').find((b) => b.includes('.home > .chat'))!;
    expect(wide).toBeDefined();
    const body = ruleIn(wide, '.home');
    expect(decl(body, 'grid-template-columns')).toBe('minmax(0, 760px)');
    expect(decl(body, 'justify-content')).toBe('center');
    expect(decl(body, 'flex')).toBe('1');
    expect(decl(ruleIn(wide, '.home > .chat'), 'height')).toBe('auto');
  });

  it('1000px 未満（ページ全体がスクロールする幅）: チャットは、内容が少なければ縮み、増えたら 64dvh（640px）で止まって中でスクロールする', () => {
    const chat = ruleIn(mediaBlock('@media (max-width: 999px)'), '.home > .chat');
    expect(decl(chat, 'height')).toBe('auto');
    expect(decl(chat, 'max-height')).toBe('min(64dvh, 640px)');
    expect(decl(chat, 'min-height')).toBe('min(420px, 64dvh)');
  });

  it('無くした規則が、残っていない: 結果領域を本文に並べる・積む規則、「拡大」の列の規則、サイドパネルの開閉での縦積み', () => {
    for (const gone of [
      '.home--expanded',
      '.home--chat-only',
      '.result-area__expand',
      '.home > .result-area',
      '.result-area__panel:not([hidden])',
      '@media (min-width: 1024px) and (max-width: 1256px)',
      '86dvh',
      'min-height: 560px',
    ]) {
      expect(css, gone).not.toContain(gone);
    }
    expect(css).not.toMatch(/\.app:has\(\.app-sidebar\[data-open='true'\]\)[^{]*\.home/);
  });
});

describe('拡大ビュー（.expanded-view。結果領域を入れるダイアログ）', () => {
  it('窓全体を覆う固定の層で、後ろを暗くする（色は変数 --scrim）。サイドパネルのメニュー（25）より上、スキップリンク（3000）より下。中の重なりは閉じ込める', () => {
    const root = ruleIn(css, '.expanded-view');
    expect(decl(root, 'position')).toBe('fixed');
    expect(decl(root, 'inset')).toBe('0');
    expect(decl(root, 'background')).toBe('var(--scrim)');
    expect(decl(root, 'isolation')).toBe('isolate');
    const z = Number(decl(root, 'z-index'));
    expect(z).toBeGreaterThan(25);
    expect(z).toBeLessThan(3000);
    // ライト・ダークの両方で定義されている（定義漏れで、暗くならない）
    expect(css.match(/--scrim\s*:/g)).toHaveLength(3);
  });

  it('幅 1024px 以上: 窓の四方から 24px あけた大きなダイアログ（幅は最大 1440px、高さは窓の高さ − 48px）', () => {
    expect(decl(ruleIn(css, '.expanded-view'), 'padding')).toBe('24px');
    const dialog = ruleIn(css, '.expanded-view__dialog');
    expect(decl(dialog, 'max-width')).toBe('1440px');
    expect(decl(dialog, 'height')).toBe('calc(100dvh - 48px)');
    expect(decl(dialog, 'width')).toBe('100%');
  });

  it('幅 1023px 以下: 窓いっぱいの全面のシート（余白・角丸なし）', () => {
    const block = mediaBlock('@media (max-width: 1023px)');
    expect(decl(ruleIn(block, '.expanded-view'), 'padding')).toBe('0');
    const dialog = ruleIn(block, '.expanded-view__dialog');
    expect(decl(dialog, 'max-width')).toBe('none');
    expect(decl(dialog, 'height')).toBe('100dvh');
    expect(decl(dialog, 'border-radius')).toBe('0');
    expect(decl(dialog, 'border')).toBe('0');
  });

  it('中の結果領域は、ダイアログの高さをすべて使い、3 つの画面は置き場いっぱいに重なる（選んでいない画面は、visibility: hidden のまま。display: none にしない）', () => {
    expect(decl(ruleIn(css, '.expanded-view__dialog > .result-area'), 'flex')).toBe('1');
    expect(decl(ruleIn(css, '.result-area__panels'), 'flex')).toBe('1');
    expect(decl(ruleIn(css, '.result-area__panel'), 'position')).toBe('absolute');
    expect(decl(ruleIn(css, '.result-area__panel'), 'inset')).toBe('0');
    // Leaflet が、隠れても大きさを覚えているので、display: none にしない
    const hidden = ruleIn(css, '.result-area__panel[hidden]');
    expect(decl(hidden, 'visibility')).toBe('hidden');
    expect(decl(hidden, 'display')).toBe('flex');
  });

  it('地図は、パネルの残りの高さをすべて取る（最小 320px）。画面の高さの割合で決める縦積みの規則は無い', () => {
    const stage = ruleIn(css, '.map-stage');
    expect(decl(stage, 'flex')).toBe('1 1 0');
    expect(decl(stage, 'min-height')).toBe('320px');
    expect(css).not.toMatch(/\.map-stage\s*\{[^}]*clamp\(/);
  });

  it('「閉じる」は、タブの帯の右端（タブと同じ高さ 44px）', () => {
    expect(decl(ruleIn(css, '.expanded-view__close'), 'min-height')).toBe('44px');
    expect(decl(ruleIn(css, '.expanded-view__close'), 'flex')).toBe('none');
  });
});

describe('狭い画面（600px 以下）の上の横帯', () => {
  // 同じ条件の @media が 2 つある（余白などの既存と、上の帯の組み直し）。上の帯の方を取る
  const block = mediaBlocks('@media (max-width: 600px)').find((b) => b.includes('.app-header__tagline'))!;
  it('上の帯の @media がある', () => {
    expect(block).toBeDefined();
  });

  it('帯は 3 段の格子（ロゴ＋アカウント / ナビ / 状態）。390px で 281px あった高さを収める', () => {
    const header = ruleIn(block, '.app-header');
    expect(decl(header, 'display')).toBe('grid');
    expect(header).toMatch(/grid-template-areas:\s*'brand account'\s*'nav nav'\s*'status status'/);
    expect(decl(ruleIn(block, '.app-header__tools'), 'display')).toBe('contents');
  });

  it('説明文は隠す。ナビは 1 行に収める大きさ（横スクロールにしない: フォーカスの輪が切れる）', () => {
    expect(decl(ruleIn(block, '.app-header__tagline'), 'display')).toBe('none');
    const nav = ruleIn(block, '.app-header__nav');
    expect(decl(nav, 'overflow-x')).toBeNull();
    expect(decl(nav, 'overflow')).toBeNull();
    const link = ruleIn(block, '.app-header__nav .nav-link');
    expect(decl(link, 'white-space')).toBe('nowrap');
    expect(decl(link, 'font-size')).toBe('13px');
  });

  it('テーマの切り替えは、アカウントのメニューに同じものがあるときだけ、帯から隠す（アカウントが無ければ帯に残る）', () => {
    expect(decl(ruleIn(block, '.app-header__tools:has(.app-header__account) .theme-switch'), 'display')).toBe('none');
    expect(block).not.toMatch(/\n\s*\.theme-switch\s*\{/);
  });

  it('状態の印は、あるときだけ 3 段目に出る（空なら高さを取らない）', () => {
    expect(decl(ruleIn(block, '.app-header__status'), 'min-height')).toBe('0');
    expect(block).toContain('.app-header__status:not(:empty)');
  });
});

describe('指で押す画面（狭い幅・粗いポインター）の押す大きさ', () => {
  const block = mediaBlock('@media (max-width: 600px), (pointer: coarse)');

  it('帯のロゴのリンク・テーマの切り替え・「根拠を見る」は 44px', () => {
    expect(decl(ruleIn(block, '.app-header__logo'), 'min-height')).toBe('44px');
    const option = ruleIn(block, '.theme-switch-option');
    expect(decl(option, 'min-width')).toBe('44px');
    expect(decl(option, 'min-height')).toBe('44px');
    expect(decl(ruleIn(block, '.provenance > summary'), 'min-height')).toBe('44px');
  });

  it('広い画面（マウス）の既定は、密なまま（40×36px・32px）', () => {
    expect(decl(ruleIn(css, '.theme-switch-option'), 'min-height')).toBe('36px');
    expect(decl(ruleIn(css, '.provenance > summary'), 'min-height')).toBe('32px');
  });
});

describe('ログインの画面', () => {
  it('ボタンの代わりに出す「戻る」リンクは、ボタンと同じ幅・位置で、下線を付けない', () => {
    const body = ruleIn(css, '.auth-box .auth-back');
    expect(decl(body, 'display')).toBe('flex');
    expect(decl(body, 'width')).toBe('100%');
    expect(decl(body, 'text-decoration')).toBe('none');
  });
});
