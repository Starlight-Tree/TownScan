import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// スキップリンク（キーボードで、サイドパネルや横帯を飛ばして本文へ移る）の行き先は、ルートの layout の href="#main" と、
// 各画面の枠の <main id="main"> の対応でだけ決まる。片方を変えると、リンクが何も指さなくなる（テストが無いと、全件合格のまま壊れる）。
// layout.tsx は next/font を読み込むので、theme.test.ts の app/layout.tsx の節と同じく、ファイルの中身を読んで確かめる。
const read = (...path: string[]) => readFileSync(join(process.cwd(), 'app', ...path), 'utf8');

const layout = read('layout.tsx');

// 行き先を持つ枠: (site) の本文、(auth) のログイン、枠が付かない 404
const TARGETS: ReadonlyArray<readonly [string, string]> = [
  ['(site)/layout.tsx', read('(site)', 'layout.tsx')],
  ['(auth)/layout.tsx', read('(auth)', 'layout.tsx')],
  ['not-found.tsx', read('not-found.tsx')],
];

describe('スキップリンク（app/layout.tsx）', () => {
  it('href は "#main"、文言は「本文へ移動」、クラスは skip-link', () => {
    expect(layout).toMatch(/<a href="#main" className="skip-link">\s*本文へ移動\s*<\/a>/);
  });

  it('<body> の最初に置く（キーボードの最初の Tab で届く）', () => {
    expect(layout).toMatch(/<body>\s*<a href="#main" className="skip-link">[\s\S]*?<\/a>\s*\{children\}/);
  });

  it('見た目は globals.css の .skip-link（ふだんは画面の外、フォーカスで出る）', () => {
    const css = readFileSync(join(process.cwd(), 'app', 'globals.css'), 'utf8');
    expect(css).toMatch(/\.skip-link\s*\{/);
    expect(css).toMatch(/\.skip-link:focus\s*\{/);
  });

  it.each(TARGETS)('行き先 %s は、<main id="main"> を 1 つ持つ', (_name, source) => {
    expect(source.match(/<main\b[^>]*\bid="main"/g)).toHaveLength(1);
  });

  it('リンクの行き先（#main）と、各枠の main の id が同じ', () => {
    const href = /<a href="#([^"]+)" className="skip-link">/.exec(layout)?.[1];
    expect(href).toBe('main');
    for (const [, source] of TARGETS) expect(source).toContain(`id="${href}"`);
  });
});
