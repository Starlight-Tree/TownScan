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
  /** 行頭から始まる規則（`\n.sel {`）の本文。同じ selector を後ろに持つ、入れ子の規則（`.home--expanded .chat__chips`）は含めない */
  function ruleBody(selector: string): string {
    const start = css.indexOf(`\n${selector} {`);
    expect(start, selector).toBeGreaterThanOrEqual(0);
    return css.slice(start, css.indexOf('}', start));
  }

  /** 上・右・下・左の 4 辺（px）。shorthand（1〜4 個）と、辺ごとの指定の両方を読む */
  function edges(body: string, property: 'padding' | 'margin'): [number, number, number, number] {
    const sides = ['top', 'right', 'bottom', 'left'] as const;
    const out: [number, number, number, number] = [0, 0, 0, 0];
    const short = new RegExp(`(?:^|[\\s;{])${property}\\s*:\\s*([^;]+);`).exec(body);
    if (short) {
      const v = short[1]!.trim().split(/\s+/).map((x) => Number.parseFloat(x));
      const [t, r = t, b = t, l = r] = v as [number, number?, number?, number?];
      out.splice(0, 4, t, r, b!, l!);
    }
    sides.forEach((side, i) => {
      const long = new RegExp(`(?:^|[\\s;{])${property}-${side}\\s*:\\s*(-?[\\d.]+)px`).exec(body);
      if (long) out[i] = Number.parseFloat(long[1]!);
    });
    return out;
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

  it('.chat__scroll（overflow-y: auto）: 左に、輪が収まる余白を取り、同じだけの負の余白で、見かけの位置を保つ', () => {
    const body = ruleBody('.chat__scroll');
    expect(body).toMatch(/overflow-y\s*:\s*auto/);
    const padding = edges(body, 'padding');
    const margin = edges(body, 'margin');
    expect(padding[3]).toBeGreaterThanOrEqual(ring());
    expect(margin[3]).toBe(-padding[3]);
  });

  it('.chat__chips（overflow-x: auto。縦も切れる）: 上・左右・下に、輪が収まる余白を取り、上・左右は同じだけの負の余白で位置を保つ', () => {
    const body = ruleBody('.chat__chips');
    expect(body).toMatch(/overflow-x\s*:\s*auto/);
    const padding = edges(body, 'padding');
    const margin = edges(body, 'margin');
    for (const side of padding) expect(side).toBeGreaterThanOrEqual(ring());
    expect(margin[0]).toBe(-padding[0]);
    expect(margin[1]).toBe(-padding[1]);
    expect(margin[3]).toBe(-padding[3]);
    // 下は、これまでの余白（padding-bottom: 4px）と同じだけ、枠の下に残す
    expect(padding[2] + margin[2]).toBe(4);
  });

  it('.chat__chips: キーボードで枠の外の例へ進んだとき、輪が見える位置までスクロールする（scroll-padding が輪の長さ以上）', () => {
    const m = /scroll-padding\s*:\s*(\d+)px/.exec(ruleBody('.chat__chips'));
    expect(m, 'scroll-padding').not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(ring());
  });
});
