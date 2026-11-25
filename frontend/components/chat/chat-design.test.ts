import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// チャットの見た目は、DocuNavi（frontend/src/styles.css）にそろえている。「同じ」は、値をそのまま写すこと（丸めない・計算し直さない）。
// jsdom にはレイアウトも CSS も無い（vitest の css: false）ので、規則そのものを読んで確かめる。
// ここの期待値は、DocuNavi の宣言を写したもの（セレクターの名前だけ TownScan に替えた）。コメントは取り除いてから読む
const css = readFileSync(join(process.cwd(), 'app', 'globals.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** 行頭から始まる規則（`\nsel {`）の宣言を、書かれた順の [プロパティ, 値] で返す。入れ子の規則（`.a .sel`）や @media の中の規則は拾わない */
function rule(selector: string): Array<[string, string]> {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, `${selector} が無い`).toBeGreaterThanOrEqual(0);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  return body
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const i = d.indexOf(':');
      return [d.slice(0, i).trim(), d.slice(i + 1).trim()] as [string, string];
    });
}

describe('チャットの枠: 外側のカード（背景・枠線・角丸・余白）が無く、ページの地が見える', () => {
  it('.chat は縦の flex だけ（背景・枠線・角丸・余白・間隔を持たない）', () => {
    expect(rule('.chat')).toEqual([
      ['display', 'flex'],
      ['flex-direction', 'column'],
      ['min-height', '0'],
    ]);
  });

  it('入力欄の外側（.chat__composer）の地は、ページの地（--bg）。--surface の塗りは入力の枠（.chat__field）だけ', () => {
    expect(rule('.chat__composer')).toContainEqual(['background', 'var(--bg)']);
    expect(rule('.chat__field')).toContainEqual(['background', 'var(--surface)']);
  });

  it('760px の上限は、どこにも残っていない', () => {
    expect(css).not.toContain('760px');
  });
});

describe('チャットの幅: 会話・質問の例の行・入力欄が、同じ式（--chat-pad）で 46rem の列を中央に置く（DocuNavi の .message-list・.composer と同じ）', () => {
  it('.chat__scroll: gap 1.5rem、padding は 1.5rem var(--chat-pad) 1.5rem', () => {
    const r = rule('.chat__scroll');
    expect(r).toContainEqual(['gap', '1.5rem']);
    expect(r).toContainEqual(['padding', '1.5rem var(--chat-pad) 1.5rem']);
    expect(r).toContainEqual(['flex', '1']);
    expect(r).toContainEqual(['overflow-y', 'auto']);
  });

  it('.chat__composer: padding は 0.25rem var(--chat-pad) 1rem、下は safe-area を見る', () => {
    const r = rule('.chat__composer');
    expect(r).toContainEqual(['padding', '0.25rem var(--chat-pad) 1rem']);
    expect(r).toContainEqual(['padding-bottom', 'max(1rem, env(safe-area-inset-bottom))']);
  });

  it('.chat__tools（「新しい会話」の行）も、同じ列に収まる', () => {
    expect(rule('.chat__tools')).toContainEqual(['padding', '0 var(--chat-pad)']);
  });

  it('「新しい会話」の行は、サイドパネルのある幅（1024px 以上）では隠す（DocuNavi のチャットには無い。サイドパネルの同じボタンが処理を呼ぶ）', () => {
    expect(css).toMatch(/@media \(min-width: 1024px\) \{\s*\.chat__tools \{\s*display: none;\s*\}\s*\}/);
  });

  it('420px 以下は、DocuNavi と同じ 0.75rem に詰める', () => {
    expect(css).toMatch(/@media \(max-width: 420px\) \{\s*\.chat__scroll \{\s*padding: 0\.75rem;\s*\}\s*\.chat__tools,\s*\.chat__composer \{\s*padding-inline: 0\.75rem;\s*\}\s*\}/);
  });

  it('列の幅（--chat-w）は、質問の例・入力欄・最初の画面を含む .chat の中だけで使い、.home には幅の上限を持たせない', () => {
    expect(css).not.toMatch(/\.home[^{]*\{[^}]*(?:max-width|minmax\(0, \d+px\))/);
  });
});

describe('質問の吹き出し（.msg--user。DocuNavi の .message-question）: 枠なしの無彩色の淡い背景', () => {
  it('宣言が DocuNavi と同じ（max-width 85%・padding・角丸・--surface-muted・1rem・行間 1.7）', () => {
    expect(rule('.msg--user')).toEqual([
      ['align-self', 'flex-end'],
      ['max-width', '85%'],
      ['padding', '0.6rem 1rem'],
      ['border-radius', 'var(--radius) var(--radius) 0.25rem var(--radius)'],
      ['background', 'var(--surface-muted)'],
      ['font-size', '1rem'],
      ['line-height', '1.7'],
      ['overflow-wrap', 'anywhere'],
    ]);
  });

  it('主色の塗り・主色の上の文字・枠線は使わない（文字は通常の色のまま）', () => {
    const props = rule('.msg--user').map(([p]) => p);
    expect(props).not.toContain('color');
    expect(props).not.toContain('border');
    expect(JSON.stringify(rule('.msg--user'))).not.toMatch(/--primary|--on-primary/);
  });

  it('送信に失敗した発言の破線の枠（.msg--failed）は残っている', () => {
    expect(rule('.msg--failed')).toEqual([
      ['outline', '2px dashed var(--error)'],
      ['outline-offset', '2px'],
    ]);
  });
});

describe('続けて聞く（.follow-ups・.follow-up。DocuNavi の同名の規則）: 最後の回答の下に、枠なしの小さい文字で並べる', () => {
  it('.follow-ups: 縦の列・左寄せ・列の幅いっぱい・上に区切りの線（宣言が DocuNavi と同じ）', () => {
    expect(rule('.follow-ups')).toEqual([
      ['display', 'flex'],
      ['flex-direction', 'column'],
      ['align-items', 'flex-start'],
      ['gap', '0.1rem'],
      ['width', '100%'],
      ['align-self', 'center'],
      ['padding-top', '0.7rem'],
      ['border-top', '1px solid var(--border)'],
    ]);
  });

  it('.follow-up: 枠・背景なし・0.85rem・控えめな色（--text-muted）。先頭に「↳ 」。触れると主色（DocuNavi の --accent。TownScan の --primary）と下線', () => {
    expect(rule('.follow-up')).toEqual([
      ['padding', '0.15rem 0'],
      ['border', '0'],
      ['background', 'none'],
      ['color', 'var(--text-muted)'],
      ['font', 'inherit'],
      ['font-size', '0.85rem'],
      ['line-height', '1.5'],
      ['text-align', 'left'],
      ['cursor', 'pointer'],
    ]);
    expect(rule('.follow-up::before')).toEqual([['content', "'↳ '"]]);
    expect(rule('.follow-up:hover')).toEqual([
      ['color', 'var(--primary)'],
      ['text-decoration', 'underline'],
    ]);
  });

  it('入力欄の上の、丸い質問の例の行（.chat__chips・.chip--compact）は、もう無い', () => {
    expect(css).not.toContain('.chat__chips');
    expect(css).not.toContain('.chip--compact');
  });
});

describe('質問の時刻（.chat__time。DocuNavi の .message-time）', () => {
  it('宣言が DocuNavi と同じ（中央・0.8rem・--text-muted・下に -0.75rem）', () => {
    expect(rule('.chat__time')).toEqual([
      ['display', 'block'],
      ['margin-bottom', '-0.75rem'],
      ['text-align', 'center'],
      ['font-size', '0.8rem'],
      ['color', 'var(--text-muted)'],
    ]);
  });

  it('負の余白（-0.75rem）は、会話の間隔（1.5rem）の半分: 回答との間を保ったまま、質問に寄る', () => {
    const gap = Number.parseFloat(rule('.chat__scroll').find(([p]) => p === 'gap')![1]);
    const pull = Number.parseFloat(rule('.chat__time').find(([p]) => p === 'margin-bottom')![1]);
    expect(gap).toBe(1.5);
    expect(-pull * 2).toBe(gap);
  });
});

describe('回答の本文（.msg__text。DocuNavi の .message-assistant）', () => {
  it('1rem・行間 1.85・--text-body。強調だけ --text-strong', () => {
    const r = rule('.msg__text');
    expect(r).toContainEqual(['font-size', '1rem']);
    expect(r).toContainEqual(['line-height', '1.85']);
    expect(r).toContainEqual(['color', 'var(--text-body)']);
    expect(rule('.msg__text strong')).toEqual([['color', 'var(--text-strong)']]);
  });

  it('回答の入れ物（.msg--assistant）には掛けない: 結果カード・条件の帯・表の文字は、これまでの大きさのまま', () => {
    const container = rule('.msg--assistant').map(([p]) => p);
    expect(container).not.toContain('font-size');
    expect(container).not.toContain('line-height');
    expect(container).not.toContain('color');
    // 結果カードの中身は、自分の大きさを持つ
    expect(rule('.result-card__text')).toContainEqual(['font-size', '13px']);
    expect(rule('.answer-scope')).toContainEqual(['font-size', '12px']);
    expect(rule('.msg')).toContainEqual(['font-size', '14px']);
  });
});

describe('入力欄（DocuNavi の .composer-field・.composer-input・.composer-footer）', () => {
  it('.chat__field（枠）: 1px の枠・--radius・--surface・影（0 1px 2px）', () => {
    expect(rule('.chat__field')).toEqual([
      ['border', '1px solid var(--border)'],
      ['border-radius', 'var(--radius)'],
      ['background', 'var(--surface)'],
      ['box-shadow', '0 1px 2px var(--field-shadow)'],
    ]);
  });

  it('フォーカスが中にあるあいだ、枠は主色の縁と、フォーカスの輪（3px・離れ 2px）。主色は DocuNavi の --accent（TownScan の --primary。--accent は橙で別の意味）', () => {
    expect(rule('.chat__field:focus-within')).toEqual([
      ['border-color', 'var(--primary)'],
      ['outline', '3px solid var(--focus)'],
      ['outline-offset', '2px'],
    ]);
    expect(rule('.chat__field:focus-within').flat().join(' ')).not.toContain('var(--accent)');
  });

  it('.chat__input: 2.9rem 以上・13rem まで伸びる・余白 0.5rem 0.8rem・行間 1.65・リサイズなし', () => {
    const r = rule('.chat__input');
    for (const d of [
      ['display', 'block'],
      ['width', '100%'],
      ['min-height', '2.9rem'],
      ['max-height', '13rem'],
      ['padding', '0.5rem 0.8rem'],
      ['border', '1px solid var(--border)'],
      ['border-radius', '0.5rem'],
      ['background', 'var(--bg)'],
      ['line-height', '1.65'],
      ['overflow-y', 'auto'],
      ['resize', 'none'],
    ] as const) {
      expect(r, d.join(': ')).toContainEqual(d);
    }
  });

  it('枠の中の入力は、枠線なし・透明（枠は外側が持つ）。フォーカスの輪は外側だけ', () => {
    expect(rule('.chat__field .chat__input')).toEqual([
      ['border', '0'],
      ['border-radius', '0 0 var(--radius) var(--radius)'],
      ['background', 'transparent'],
    ]);
    expect(rule('.chat__field .chat__input:focus-visible')).toEqual([['outline', 'none']]);
  });

  it('下の行（.chat__footer）は枠の中: 左右に分け、余白は 0.35rem 0.6rem 0.5rem。送信ボタンの並びは gap 0.5rem', () => {
    expect(rule('.chat__footer')).toEqual([
      ['display', 'flex'],
      ['align-items', 'center'],
      ['justify-content', 'space-between'],
      ['gap', '1rem'],
      ['margin-top', '0.5rem'],
    ]);
    expect(rule('.chat__field .chat__footer')).toEqual([
      ['margin-top', '0'],
      ['padding', '0.35rem 0.6rem 0.5rem'],
    ]);
    expect(rule('.chat__actions')).toEqual([
      ['display', 'flex'],
      ['align-items', 'center'],
      ['gap', '0.5rem'],
      // DocuNavi との唯一の違い: 左に「質問対象」の行が無いので、自分で右へ寄る（無いと、送信ボタンが左下に出る）
      ['margin-left', 'auto'],
    ]);
  });

  it('入力（textarea）は、ボタン・入力と同じく、書体と色を引き継ぐ（既定の等幅の書体にならない）', () => {
    expect(css).toMatch(/button,\s*input,\s*select,\s*textarea\s*\{\s*font:\s*inherit;\s*color:\s*inherit;\s*\}/);
  });
});

describe('送信ボタン（.btn--icon。DocuNavi の .btn-icon）: 丸いアイコンボタン', () => {
  it('2.2rem の円（50%）。TownScan の .btn の最小の高さ（44px）は外す（無いと縦長の楕円になる）', () => {
    expect(rule('.btn--icon')).toEqual([
      ['display', 'inline-grid'],
      ['width', '2.2rem'],
      ['height', '2.2rem'],
      ['min-height', '0'],
      ['place-items', 'center'],
      ['padding', '0'],
      ['border-radius', '50%'],
    ]);
  });

  it('.btn の最小の高さより後に書かれ、同じ強さの規則に勝つ', () => {
    expect(css.indexOf('\n.btn--icon {')).toBeGreaterThan(css.indexOf('\n.btn {'));
  });

  it('押せないときは、DocuNavi と同じ opacity 0.5', () => {
    expect(rule('.btn:disabled')).toContainEqual(['opacity', '0.5']);
  });
});
