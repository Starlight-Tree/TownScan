import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// CSS はテストでは読み込まれない（vitest の css: false）。地図の画面の配置（地図が高さを取る・カードの重ね方・フォーカスの輪が切れない余白）は、
// 規則そのものを確かめる。見た目の確認ではなく、「この宣言が消えたら落ちる」ための守り
const css = readFileSync(join(process.cwd(), 'app', 'globals.css'), 'utf8');

/** 行頭から始まる規則（`\n.sel {`）の本文。無ければ null */
function ruleBody(selector: string): string | null {
  const start = css.indexOf(`\n${selector} {`);
  if (start < 0) return null;
  return css.slice(start, css.indexOf('}', start));
}

function decl(selector: string, property: string): string | null {
  const body = ruleBody(selector);
  if (body === null) return null;
  const m = new RegExp(`(?:^|[\\s;{])${property}\\s*:\\s*([^;]+);`).exec(body);
  return m ? m[1]!.trim() : null;
}

describe('地図のパネルの配置（地図が残りの高さを取る）', () => {
  it('パネルは縦の flex。中身が収まらないときだけスクロールする', () => {
    expect(decl('.map-panel', 'display')).toBe('flex');
    expect(decl('.map-panel', 'flex-direction')).toBe('column');
    expect(decl('.map-panel', 'overflow-y')).toBe('auto');
    expect(decl('.map-panel', 'min-height')).toBe('0');
  });

  it('地図（.map-stage）が残りの高さを取り（flex: 1 1 0）、窓が低くても 320px 以上を保つ', () => {
    expect(decl('.map-stage', 'flex')).toBe('1 1 0');
    expect(decl('.map-stage', 'min-height')).toBe('320px');
    expect(decl('.map-stage', 'position')).toBe('relative'); // 重ねる部品（カード・読み込み中）の基準
  });

  it('地図以外の帯（ツールバー・集計・現在表示・一覧）は、中身の高さのまま縮めない', () => {
    expect(decl('.map-panel > :not(.map-stage)', 'flex')).toBe('none');
  });

  it('ツールバー・集計の帯（先頭の行も、分類の件数も）は、狭い幅で折り返す。現在表示の帯は、文として流し込むので、折り返しの箱にしない', () => {
    expect(decl('.map-toolbar', 'flex-wrap')).toBe('wrap');
    expect(decl('.summary-strip', 'flex-wrap')).toBe('wrap');
    expect(decl('.summary-strip__head', 'flex-wrap')).toBe('wrap');
    expect(decl('.summary-strip__counts', 'flex-wrap')).toBe('wrap');
    expect(decl('.map-status', 'flex-wrap')).toBeNull();
  });

  it('ツールバーの操作部品は、地図に高さを回すため 36px（44px のままにしない）', () => {
    const body = ruleBody('.map-toolbar .seg-btn,\n.map-toolbar .select,\n.map-toolbar .check');
    expect(body).toMatch(/min-height\s*:\s*36px/);
  });

  it('地図に重ねた凡例の規則は、もう無い（集計の帯のチェックボックスへ統合した）', () => {
    expect(css).not.toMatch(/^\.legend\b/m);
    expect(css).not.toMatch(/^\.legend__/m);
    expect(css).not.toMatch(/^\.legend > legend/m);
  });
});

describe('選択中の候補のカード（地図の中に重ねる）', () => {
  it('地図の枠の中の絶対配置。流れの中に差し込まないので、地図の大きさが変わらない', () => {
    expect(decl('.map-selected', 'position')).toBe('absolute');
  });

  it('Leaflet のコントロール（z-index 1000）より上。出典の表示（右下）に重ならないよう、下から 30px あける', () => {
    expect(Number(decl('.map-selected', 'z-index'))).toBeGreaterThan(1000);
    expect(Number(decl('.map-selected', 'z-index'))).toBeLessThan(2000); // サイドパネルのメニュー・スキップリンク（3000）の下
    expect(decl('.map-selected', 'bottom')).toBe('30px');
  });

  it('下側の中央寄せ。左右に余白を持ち、幅は min(100% - 16px, 520px)', () => {
    expect(decl('.map-selected', 'left')).toBe('0');
    expect(decl('.map-selected', 'right')).toBe('0');
    expect(decl('.map-selected', 'margin')).toBe('0 auto');
    expect(decl('.map-selected', 'width')).toBe('min(100% - 16px, 520px)');
  });

  it('枠を太くして、集計の帯と見分ける（色だけに頼らない）。地色は不透明（写真の上で読める）', () => {
    expect(decl('.map-selected', 'border')).toBe('2px solid var(--primary)');
    expect(decl('.map-selected', 'background')).toBe('var(--surface)');
  });
});

describe('集計の帯の分類（チェックボックス）の見た目', () => {
  it('選んでいる分類は、色だけでなく、太い枠（1px + 内側の 1px）と地色で見分ける。寸法は変えない', () => {
    const body = ruleBody(".summary-strip__counts li[data-shown='true'] .summary-strip__opt");
    expect(body).toMatch(/border-color\s*:\s*var\(--primary\)/);
    expect(body).toMatch(/box-shadow\s*:\s*inset 0 0 0 1px var\(--primary\)/);
    expect(body).toMatch(/background\s*:\s*var\(--tag-bg\)/);
    expect(decl('.summary-strip__opt', 'border')).toBe('1px solid var(--input-border)');
  });

  it('押す範囲は 36px 以上', () => {
    expect(decl('.summary-strip__opt', 'min-height')).toBe('36px');
  });

  it('チェックボックスの大きさと色は、.check と同じ規則', () => {
    expect(css).toMatch(/\.check input,\n\.summary-strip__opt input \{\n  width: 18px;/);
  });
});

describe('候補の一覧（スクロールする枠の中のフォーカスの輪）', () => {
  it('枠の内側に、輪（3px + 離れ 2px = 5px）より広い余白を取り、同じだけの負の余白で位置を保つ。左右・先頭・末尾で輪が切れない', () => {
    const padding = decl('.cand-list__items', 'padding');
    expect(padding).toBe('6px');
    const px = (v: string) => Number.parseFloat(v);
    expect(px(padding!)).toBeGreaterThan(5);
    const margin = decl('.cand-list__items', 'margin')!.split(/\s+/);
    // 上・左右は、余白と同じ分の負の値
    expect(px(margin[0]!)).toBe(-px(padding!));
    expect(px(margin[1]!)).toBe(-px(padding!));
    expect(decl('.cand-list__items', 'overflow-y')).toBe('auto');
  });

  it('閉じたままの高さは最小（36px）', () => {
    expect(ruleBody('.cand-list > summary')).toMatch(/min-height\s*:\s*36px/);
  });
});

describe('現在表示の帯（現在表示・案内・通知を、ひと続きの文として流し込む）', () => {
  it('最小の高さは 36px（S1 の高さの見積もりの一部）。1 行のときは、文を真ん中に置く', () => {
    expect(decl('.map-status', 'min-height')).toBe('36px');
    expect(decl('.map-status', 'display')).toBe('flex');
    expect(decl('.map-status', 'align-items')).toBe('center');
  });

  it('文（.map-status__text）は帯の幅いっぱい（flex: 1・min-width: 0）。項目のあいだは右の余白で空け、空の通知（いつも描く role=status）は余白を取らない', () => {
    expect(decl('.map-status__text', 'flex')).toBe('1');
    expect(decl('.map-status__text', 'min-width')).toBe('0');
    expect(decl('.map-status__text > *', 'margin-right')).toBe('14px');
    expect(decl('.map-status__text > :empty', 'margin-right')).toBe('0');
  });

  it('文の中のボタンは、左の余白（.btn--small の 8px）を消す。行の中の高さは、ボタンに合わせて伸びる', () => {
    expect(decl('.map-status__text > .btn', 'margin-left')).toBe('0');
    expect(decl('.map-status__text > .btn', 'vertical-align')).toBe('middle');
  });
});

describe('集計の帯の先頭の行（対象・全 m 件のうち…・条件を解除）。出入りで帯の高さが動かない', () => {
  it('先頭の行（.summary-strip__head）は、残りの幅を取る。解除のボタンは、その行の右端へ寄せる', () => {
    expect(decl('.summary-strip__head', 'display')).toBe('flex');
    expect(decl('.summary-strip__head', 'flex')).toBe('1 1 auto');
    expect(decl('.summary-strip__reset', 'margin-left')).toBe('auto');
  });

  it('「全 m 件のうち…」は、出ないときも幅を空けておく（min-width）。出ているときの文が収まる幅', () => {
    expect(decl('.summary-strip__scope', 'min-width')).toBe('17em');
  });

  it('hidden のときは、display: none にせず、visibility: hidden で場所だけを保つ（見えず、フォーカスもできない）', () => {
    expect(decl('.summary-strip__scope[hidden]', 'visibility')).toBe('hidden');
    expect(decl('.summary-strip__scope[hidden]', 'display')).toBe('block');
    expect(decl('.summary-strip__reset[hidden]', 'visibility')).toBe('hidden');
    expect(decl('.summary-strip__reset[hidden]', 'display')).toBe('inline-flex');
  });
});

describe('候補の一覧（閉じたままの summary）のフォーカスの輪', () => {
  it('輪を内側へ描く（outline-offset: -3px）。閉じたままの summary は、スクロールするパネルの最後の子で、外側へ描くと、下の辺が切れる', () => {
    expect(decl('.cand-list > summary:focus-visible', 'outline-offset')).toBe('-3px');
    expect(decl('.map-panel', 'overflow-y')).toBe('auto');
  });
});

describe('印の大きさ（押せる大きさ 24px 以上。見た目の点は 18px のまま）', () => {
  it('点 18px + 余白 3px × 2 = 24px（LeafletMap の MARKER_BOX と同じ）', () => {
    const px = (v: string | null) => Number.parseFloat(v ?? 'NaN');
    expect(px(decl('.cand-dot', 'width'))).toBe(18);
    expect(px(decl('.cand-dot', 'height'))).toBe(18);
    expect(px(decl('.cand-dot', 'width')) + 2 * px(decl('.cand-dot', 'margin'))).toBe(24);
  });
});

describe('CSS だけが守っている振る舞い（規則が消えても、ほかのテストは通る。画面は壊れる）', () => {
  it('選んでいない画面（.result-area__panel[hidden]）は、display: none にせず visibility: hidden（Leaflet が 0×0 の大きさを覚えないため）', () => {
    expect(decl('.result-area__panel[hidden]', 'visibility')).toBe('hidden');
    expect(decl('.result-area__panel[hidden]', 'display')).toBe('flex');
  });

  it('.app__main の isolation: isolate は、地図の z-index（カード・通知の 1100）を、本文の中に閉じ込める（サイドパネルのメニュー 25 より下）', () => {
    expect(decl('.app__main', 'isolation')).toBe('isolate');
  });

  it('地図の上の通知: 外側（.map-overlay-top）は操作を通し、中身（.map-note）だけが受ける（「再試行」が押せる）', () => {
    expect(decl('.map-overlay-top', 'pointer-events')).toBe('none');
    expect(decl('.map-note', 'pointer-events')).toBe('auto');
  });

  it('ツールバーの地区の選択は、長い名前で行を押し広げない（最大 320px・残りの幅だけ使う）', () => {
    expect(decl('.map-toolbar__group--area', 'max-width')).toBe('320px');
    expect(decl('.map-toolbar__group--area', 'flex')).toBe('1 1 150px');
    expect(decl('.map-toolbar__group--area', 'min-width')).toBe('0');
  });
});
