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

describe('チャット（`/`）: 基本は 1 列。拡大ビューを開いたときだけ、全幅の 4 つのタブ（ADR 0008）', () => {
  it('基本は 1 列で、枠も余白も持たない。幅 1000px 以上も同じ 1 列で、本文の高さいっぱい（幅の上限は .home に無い。会話の本文を 46rem の列に収めるのは、チャットの中の --chat-pad）', () => {
    const home = ruleIn(css, '.home');
    expect(decl(home, 'grid-template-columns')).toBe('minmax(0, 1fr)');
    expect(decl(home, 'padding')).toBe('0');
    // 同じ条件の @media が複数ある（本文の高さの規則など）。チャットの 1 列の規則を持つ方を取る
    const wide = mediaBlocks('@media (min-width: 1000px)').find((b) => b.includes('.home__chat > .chat'))!;
    expect(wide).toBeDefined();
    const body = ruleIn(wide, '.home');
    // 列の幅（旧: minmax(0, 760px)）と、それを中央に置く指定は無い。幅いっぱいの 1 列のまま
    expect(decl(body, 'grid-template-columns')).toBeNull();
    expect(decl(body, 'justify-content')).toBeNull();
    expect(decl(body, 'padding')).toBeNull();
    expect(decl(body, 'flex')).toBe('1');
    expect(decl(ruleIn(wide, '.home__chat > .chat'), 'height')).toBe('auto');
    expect(css).not.toContain('760px');
  });

  it('1000px 未満（ページ全体がスクロールする幅）: チャットは、内容が少なければ縮み、増えたら 64dvh（640px）で止まって中でスクロールする', () => {
    const chat = ruleIn(mediaBlock('@media (max-width: 999px)'), '.home__chat > .chat');
    expect(decl(chat, 'height')).toBe('auto');
    expect(decl(chat, 'max-height')).toBe('min(64dvh, 640px)');
    expect(decl(chat, 'min-height')).toBe('min(420px, 64dvh)');
  });

  it('幅で形を替えない: 広い・狭いの判定（data-layout）も、チャットの右に並べる横パネルの規則も無い', () => {
    expect(css).not.toContain('data-layout');
    expect(css).not.toContain('minmax(24rem, 32rem)');
  });

  it('開くと、1 行目がタブの帯、2 行目にチャットと画面が重なる。隠すほうは visibility: hidden のまま（display: none にしない。チャットのスクロール位置と、地図の大きさを保つ）', () => {
    expect(decl(ruleIn(css, ".home[data-open='true']"), 'grid-template-rows')).toBe('auto minmax(0, 1fr)');
    expect(decl(ruleIn(css, '.home__tabs'), 'grid-area')).toBe('1 / 1');
    const stacked = /\.home\[data-open='true'\] > \.home__chat,\s*\.home\[data-open='true'\] > \.home__panel\s*\{([^}]*)\}/.exec(css);
    expect(stacked, 'チャットと画面を同じ場所に重ねる規則が無い').not.toBeNull();
    expect(decl(stacked![1]!, 'grid-area')).toBe('2 / 1');
    const hidden = /\.home__chat\[hidden\],\s*\.home__panel\[hidden\]\s*\{([^}]*)\}/.exec(css);
    expect(hidden, 'チャット・画面を隠す規則が無い').not.toBeNull();
    expect(decl(hidden![1]!, 'visibility')).toBe('hidden');
    expect(decl(hidden![1]!, 'display')).toBe('flex');
  });

  it('無くした規則が、残っていない: 結果領域を本文に並べる・積む規則、「拡大」の列の規則、サイドパネルの開閉での縦積み、モーダルのダイアログ・暗い背景', () => {
    for (const gone of [
      '.home--expanded',
      '.home--chat-only',
      '.result-area__expand',
      '.home > .result-area',
      '.home > .chat',
      '.expanded-view__dialog',
      '.result-area__panel:not([hidden])',
      '@media (min-width: 1024px) and (max-width: 1256px)',
      '@media (min-width: 1257px)',
      '86dvh',
      'min-height: 560px',
    ]) {
      expect(css, gone).not.toContain(gone);
    }
    expect(css).not.toMatch(/\.app:has\(\.app-sidebar\[data-open='true'\]\)[^{]*\.home/);
  });
});

describe('拡大ビュー（.expanded-view。モーダルではない。結果領域を入れる）', () => {
  it('窓を覆わない（固定の層・暗い背景・z-index を持たない）。タブの画面の一部になる', () => {
    const root = ruleIn(css, '.expanded-view');
    expect(decl(root, 'position')).toBeNull();
    expect(decl(root, 'inset')).toBeNull();
    expect(decl(root, 'z-index')).toBeNull();
    expect(decl(root, 'background')).toBe('var(--bg)');
    expect(decl(root, 'display')).toBe('flex');
    expect(decl(root, 'flex-direction')).toBe('column');
  });

  it('タブの画面の一部（余白を詰め、枠・角丸なし）。横パネルの枠は無い', () => {
    const root = ruleIn(css, '.expanded-view');
    expect(decl(root, 'padding')).toBe('8px');
    expect(decl(root, 'border')).toBeNull();
    expect(decl(root, 'border-radius')).toBeNull();
  });

  it('中の結果領域は、パネルの高さをすべて使い、3 つの画面は置き場いっぱいに重なる（選んでいない画面は、visibility: hidden のまま。display: none にしない）', () => {
    expect(decl(ruleIn(css, '.expanded-view > .result-area'), 'flex')).toBe('1');
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
    // 回答の中の図（.answer-figure__map）の地図だけは、固定の高さ（clamp。components/chat/chat-layout.test.ts）。それを除いて、拡大ビューの地図の規則に clamp は無い
    expect(css.replace(/\.answer-figure__map \.map-stage/g, '')).not.toMatch(/\.map-stage\s*\{[^}]*clamp\(/);
  });

  it('「閉じる」は、タブの帯の右端（タブと同じ高さ 44px）。質問の行は 1 行で省略する', () => {
    expect(decl(ruleIn(css, '.expanded-view__close'), 'min-height')).toBe('44px');
    expect(decl(ruleIn(css, '.expanded-view__close'), 'flex')).toBe('none');
    const q = ruleIn(css, '.expanded-view__question');
    expect(decl(q, 'white-space')).toBe('nowrap');
    expect(decl(q, 'text-overflow')).toBe('ellipsis');
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
