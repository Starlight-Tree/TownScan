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

const OPEN = ".app:has(.app-sidebar[data-open='true'])";

describe('縦に積む幅（窓 999px 以下）: スクロールはページ 1 つ（結果領域の枠の中で別にスクロールしない）', () => {
  const block = mediaBlock('@media (max-width: 999px)');

  it('結果領域は、高さを固定せず、内容の高さで伸びる（86dvh・最小 560px の枠にしない）', () => {
    const body = ruleIn(block, '.home > .result-area');
    expect(decl(body, 'height')).toBe('auto');
    expect(decl(body, 'min-height')).toBe('0');
  });

  it('見えている画面だけが流れの中に入る（relative）。選んでいない画面は、流れの外のまま（高さを増やさない）', () => {
    const visible = ruleIn(block, '.result-area__panel:not([hidden])');
    expect(decl(visible, 'position')).toBe('relative');
    expect(decl(visible, 'inset')).toBe('auto');
    expect(decl(visible, 'overflow')).toBe('visible');
    // 隠す規則は、これまでどおり（display: none にしない。Leaflet が大きさを覚えているので、visibility: hidden のまま）
    const hidden = ruleIn(css, '.result-area__panel[hidden]');
    expect(decl(hidden, 'visibility')).toBe('hidden');
    expect(decl(hidden, 'display')).toBe('flex');
    // 隠れた画面は、基本の規則（絶対配置・置き場いっぱい）のまま。縦積みの規則は、隠れた画面に触れない
    expect(decl(ruleIn(css, '.result-area__panel'), 'position')).toBe('absolute');
    expect(block).not.toMatch(/\.result-area__panel\[hidden\]/);
  });

  it('パネルの中身（地図・詳細・空の状態）は、残りの高さを取らず、内容の高さ。地図のパネルは自分でスクロールしない', () => {
    expect(decl(ruleIn(block, '.result-area__panels'), 'flex')).toBe('none');
    const map = ruleIn(block, '.result-area__panel > .map-panel');
    expect(decl(map, 'flex')).toBe('none');
    expect(decl(map, 'overflow-y')).toBe('visible');
    expect(decl(ruleIn(block, '.result-area__panel > .drawer'), 'flex')).toBe('none');
    expect(decl(ruleIn(block, '.result-area__panel > .result-area__empty'), 'flex')).toBe('none');
  });

  it('地図は、置き場の高さに依らず、画面の高さに対する割合の高さを持つ（320〜560px）', () => {
    const stage = ruleIn(block, '.map-stage');
    expect(decl(stage, 'flex')).toBe('none');
    expect(decl(stage, 'height')).toMatch(/^clamp\(320px,\s*\d+dvh,\s*560px\)$/);
  });

  it('チャットの高さの既定（78dvh の固定）は、ここで置き換わる: 内容が少なければ縮み、増えたら 64dvh（640px）で止まって中でスクロールする', () => {
    const chat = ruleIn(block, '.home > .chat');
    expect(decl(chat, 'height')).toBe('auto');
    expect(decl(chat, 'max-height')).toBe('min(64dvh, 640px)');
    expect(decl(chat, 'min-height')).toBe('min(420px, 64dvh)');
  });
});

describe('サイドパネルを開いた 1024〜1256px の縦積みも、同じ決め方（開いているとき（data-open）だけ効く）', () => {
  const block = mediaBlock('@media (min-width: 1024px) and (max-width: 1256px)');
  const stacked = mediaBlock('@media (max-width: 999px)');

  it('結果領域は内容の高さ。固定の高さ（86dvh・最小 560px）は、どちらの幅にも残っていない', () => {
    const body = ruleIn(block, `${OPEN} .home > .result-area`);
    expect(decl(body, 'height')).toBe('auto');
    expect(decl(body, 'min-height')).toBe('0');
    // 固定の高さ（height: 86dvh・min-height: 560px）は、どちらの幅にも残っていない（地図の clamp(…, 560px) の上限とは別）
    expect(block).not.toMatch(/height:\s*86dvh|min-height:\s*560px/);
    expect(stacked).not.toMatch(/height:\s*86dvh|min-height:\s*560px/);
  });

  it('チャットは、上の幅と同じ（auto・64dvh まで）。78dvh の固定は無い', () => {
    const chat = ruleIn(block, `${OPEN} .home > .chat`);
    expect(decl(chat, 'height')).toBe('auto');
    expect(decl(chat, 'max-height')).toBe('min(64dvh, 640px)');
    expect(block).not.toMatch(/78dvh/);
  });

  it('見えている画面だけが流れの中。パネルの中身は内容の高さ。地図は割合の高さ', () => {
    const visible = ruleIn(block, `${OPEN} .result-area__panel:not([hidden])`);
    expect(decl(visible, 'position')).toBe('relative');
    expect(decl(ruleIn(block, `${OPEN} .result-area__panels`), 'flex')).toBe('none');
    expect(decl(ruleIn(block, `${OPEN} .result-area__panel > .map-panel`), 'flex')).toBe('none');
    expect(decl(ruleIn(block, `${OPEN} .result-area__panel > .drawer`), 'flex')).toBe('none');
    const stage = ruleIn(block, `${OPEN} .map-stage`);
    expect(decl(stage, 'flex')).toBe('none');
    expect(decl(stage, 'height')).toBe(decl(ruleIn(stacked, '.map-stage'), 'height'));
  });

  it('縦積みの同じ規則（上の幅）を、同じ宣言で持つ（片方だけ変えない）', () => {
    for (const [plain, withOpen] of [
      ['.result-area__panel:not([hidden])', `${OPEN} .result-area__panel:not([hidden])`],
      ['.result-area__panel > .map-panel', `${OPEN} .result-area__panel > .map-panel`],
      ['.result-area__panel > .drawer', `${OPEN} .result-area__panel > .drawer`],
      ['.result-area__panel > .result-area__empty', `${OPEN} .result-area__panel > .result-area__empty`],
      ['.map-stage', `${OPEN} .map-stage`],
      ['.home > .chat', `${OPEN} .home > .chat`],
    ] as const) {
      expect(ruleIn(block, withOpen).replace(/\s+/g, ' ').trim(), plain).toBe(ruleIn(stacked, plain).replace(/\s+/g, ' ').trim());
    }
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
