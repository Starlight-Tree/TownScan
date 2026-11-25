import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// jsdom にはレイアウトが無いので、見た目の規則そのもの（globals.css）を読んで確かめる。
// 実画面での確かめ方（Chrome）: / で 4 問ほど送り、チャット欄の末尾でホイールを回したあと
//   document.scrollingElement.scrollHeight === window.innerHeight（ページ全体が伸びない）、scrollTop === 0（動かない）
// 規則の説明のコメントに、同じ語（position: absolute など）が入っているので、取り除いてから読む
const css = readFileSync(join(process.cwd(), 'app', 'globals.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** `selector { … }` の本文。同じ selector の規則が複数あれば、すべて（@media の中のものも含む。入れ子は想定しない） */
function bodies(selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...css.matchAll(new RegExp(`(?:^|[}\\s,])${escaped}\\s*\\{([^}]*)\\}`, 'gm'))].map((m) => m[1] ?? '');
}

describe('チャット欄の規則: 読み上げ用の span が、文書の高さを押し広げない', () => {
  it('前提: .visually-hidden は position: absolute（だから、位置の基準になる祖先が要る）', () => {
    const [body] = bodies('.visually-hidden');
    expect(body).toMatch(/position:\s*absolute/);
  });

  it('.chat__scroll（overflow-y: auto）は position: relative で、中の読み上げ用 span の包含ブロックになる', () => {
    const all = bodies('.chat__scroll');
    expect(all.length).toBeGreaterThan(0);
    expect(all.some((b) => /overflow-y:\s*auto/.test(b))).toBe(true);
    expect(all.some((b) => /position:\s*(relative|absolute|fixed|sticky)/.test(b))).toBe(true);
    // 後の規則で static に戻していない
    expect(all.every((b) => !/position:\s*static/.test(b))).toBe(true);
  });

  it('.table-scroll（表の横スクロール枠）も position: relative。表の右はしの「詳細（候補 ID）」が、外の枠の横幅を押し広げない', () => {
    const all = bodies('.table-scroll');
    expect(all.some((b) => /overflow-x:\s*auto/.test(b))).toBe(true);
    expect(all.some((b) => /position:\s*relative/.test(b))).toBe(true);
  });

  it('縁の影（.table-scroll-wrap の ::before / ::after）は、クリックを通し、ふだんは見えない', () => {
    const [before] = bodies('.table-scroll-wrap::before');
    expect(before).toMatch(/background:/);
    const shared = bodies('.table-scroll-wrap::after').join('\n');
    expect(shared).toMatch(/background:/);
    // ::before と ::after は同じ規則（カンマ区切り）で、位置・クリックの扱い・既定の透明度を決める
    const common = css.match(/\.table-scroll-wrap::before,\s*\.table-scroll-wrap::after\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(common).toMatch(/pointer-events:\s*none/);
    expect(common).toMatch(/opacity:\s*0/);
    expect(common).toMatch(/position:\s*absolute/);
    // はみ出している側だけ見せる
    expect(css).toMatch(/\.table-scroll-wrap\[data-overflow-start\]::before,\s*\.table-scroll-wrap\[data-overflow-end\]::after\s*\{[^}]*opacity:\s*1/);
  });

  it('チャット用の表（.data-table--chat）は、余白を詰め、見出し・文字を折り返す（面積・詳細が横スクロールの先に隠れない）', () => {
    const joined = css.match(/\.data-table--chat th,\s*\.data-table--chat td\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(joined).toMatch(/white-space:\s*normal/);
    expect(joined).toMatch(/padding:\s*6px 7px/);
    expect(css).toMatch(/\.data-table--chat \.btn\s*\{[^}]*white-space:\s*nowrap/);
  });
});

describe('チャット欄のスクロールする枠: 中身のフォーカスの輪が、枠の辺で切れない', () => {
  /** 行頭から始まる規則（`\n.sel {`）の本文。同じ selector を後ろに持つ、入れ子の規則（たとえば `.foo .chat__scroll`）は含めない */
  function ruleBody(selector: string): string {
    const start = css.indexOf(`\n${selector} {`);
    expect(start, selector).toBeGreaterThanOrEqual(0);
    return css.slice(start, css.indexOf('}', start));
  }

  // 輪の出ている長さ: 全体の :focus-visible の outline の太さ + 離れ（3px + 2px = 5px）
  const ring = () => {
    const body = ruleBody(':focus-visible');
    const width = /outline\s*:\s*(\d+)px/.exec(body);
    const offset = /outline-offset\s*:\s*(\d+)px/.exec(body);
    expect(width, 'outline の太さ').not.toBeNull();
    expect(offset, 'outline-offset').not.toBeNull();
    return Number(width![1]) + Number(offset![1]);
  };

  it('前提: 輪の長さは 5px（3px + 離れ 2px）', () => {
    expect(ring()).toBe(5);
  });

  it('.chat__scroll（overflow-y: auto）: 左右の余白は --chat-pad で、その下限（1.25rem）も、狭い画面の余白（0.75rem）も、輪より大きい。見かけの位置を保つ負の余白は要らない', () => {
    const body = ruleBody('.chat__scroll');
    expect(body).toMatch(/overflow-y\s*:\s*auto/);
    expect(/(?:^|[\s;{])padding\s*:\s*([^;]+);/.exec(body)?.[1]?.trim()).toBe('1.5rem var(--chat-pad) 1.5rem');
    expect(/(?:^|[\s;{])margin(?:-left)?\s*:/.test(body)).toBe(false);
    // --chat-pad は max(1.25rem, …)。下限の 1.25rem（20px）が、輪の長さ以上
    const floor = /--chat-pad:\s*max\(\s*([\d.]+)rem\s*,/.exec(readFileSync(join(process.cwd(), 'app', 'globals.css'), 'utf8'));
    expect(floor, '--chat-pad の下限').not.toBeNull();
    expect(Number(floor![1]) * 16).toBeGreaterThanOrEqual(ring());
    // 420px 以下の余白（0.75rem = 12px）も、輪の長さ以上
    const narrow = /@media \(max-width: 420px\) \{\s*\.chat__scroll \{\s*padding:\s*([\d.]+)rem;/.exec(css);
    expect(narrow, '420px 以下の .chat__scroll').not.toBeNull();
    expect(Number(narrow![1]) * 16).toBeGreaterThanOrEqual(ring());
  });
});
