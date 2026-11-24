import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CANDIDATE_CLASSES } from './api-types';
import { CLASS_INFO } from './classes';
import { THEME_INIT_SCRIPT, THEME_KEY, chooseTheme, clearTheme, currentTheme, storedTheme, systemTheme, themeChoice } from './theme';

function stubSystem(dark: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: dark && query === '(prefers-color-scheme: dark)', media: query }));
}

beforeEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
});
afterEach(() => vi.unstubAllGlobals());

describe('テーマ（保存・読み出し）', () => {
  it('保存先のキーは townscan-theme（描画前のスクリプトも同じキーを読む）', () => {
    expect(THEME_KEY).toBe('townscan-theme');
    expect(THEME_INIT_SCRIPT).toContain(JSON.stringify('townscan-theme'));
  });

  it('選んでいなければ OS に従う（保存も data-theme も無い）', () => {
    stubSystem(true);
    expect(storedTheme()).toBeNull();
    expect(themeChoice()).toBe('system');
    expect(systemTheme()).toBe('dark');
    expect(currentTheme()).toBe('dark');
    stubSystem(false);
    expect(currentTheme()).toBe('light');
  });

  it('選ぶと、適用して保存し、OS より優先する', () => {
    stubSystem(true);
    chooseTheme('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(window.localStorage.getItem(THEME_KEY)).toBe('light');
    expect(storedTheme()).toBe('light');
    expect(themeChoice()).toBe('light');
    expect(currentTheme()).toBe('light');
  });

  it('選択を取り消すと、保存と data-theme を消して OS に従う', () => {
    stubSystem(true);
    chooseTheme('light');
    clearTheme();
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(window.localStorage.getItem(THEME_KEY)).toBeNull();
    expect(currentTheme()).toBe('dark');
  });

  it('保存が無くても、適用中の data-theme があれば、それを選択として返す（保存できない環境）', () => {
    document.documentElement.dataset.theme = 'dark';
    expect(storedTheme()).toBeNull();
    expect(themeChoice()).toBe('dark');
    document.documentElement.dataset.theme = 'blue';
    expect(themeChoice()).toBe('system');
  });

  it('保存値が壊れていれば、無いものとして扱う', () => {
    window.localStorage.setItem(THEME_KEY, 'blue');
    expect(storedTheme()).toBeNull();
    expect(themeChoice()).toBe('system');
  });

  it('localStorage が使えなくても、例外にせず、このページでは適用する', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(storedTheme()).toBeNull();
    expect(() => chooseTheme('dark')).not.toThrow();
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(() => clearTheme()).not.toThrow();
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it('描画前のスクリプトは、保存値（light / dark）だけを data-theme へ入れる', () => {
    window.localStorage.setItem(THEME_KEY, 'dark');
    new Function(THEME_INIT_SCRIPT)();
    expect(document.documentElement.dataset.theme).toBe('dark');

    delete document.documentElement.dataset.theme;
    window.localStorage.setItem(THEME_KEY, '<script>');
    new Function(THEME_INIT_SCRIPT)();
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});

// ---- globals.css（変数・ダークの 2 か所・色の直書き・コントラスト） ----

const css = readFileSync(join(process.cwd(), 'app', 'globals.css'), 'utf8');
const lightBlock = /^:root \{([^}]*)\}/m.exec(css)?.[1] ?? '';
const darkMediaBlock = /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme='light'\]\) \{([^}]*)\}/.exec(css)?.[1] ?? '';
const darkManualBlock = /:root\[data-theme='dark'\] \{([^}]*)\}/.exec(css)?.[1] ?? '';

const declarationPairs = (block: string) => [...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name as string, (value ?? '').trim()] as const);
const declarations = (block: string) => declarationPairs(block).map(([name, value]) => `${name}: ${value}`).sort();
const varsOf = (block: string) => Object.fromEntries(declarationPairs(block));

describe('globals.css のダークの値（2 か所と、直書きの色）', () => {
  // CSS では 2 つの条件で共有できないので、同じ内容を 2 か所に書いている。ずれたらここで気づく。
  it('OS 追従と data-theme の 2 か所に、同じ宣言が入っている', () => {
    expect(darkMediaBlock).not.toBe('');
    expect(darkManualBlock).not.toBe('');
    expect(declarations(darkManualBlock)).toEqual(declarations(darkMediaBlock));
  });

  it('ダークは、ライトと同じ変数をすべて定義している（定義漏れで、ライトの色が残らない）', () => {
    const names = (block: string) => declarations(block).map((d) => d.split(':')[0]);
    const colorNames = names(lightBlock).filter((n) => n !== '--radius' && n !== '--font');
    expect(colorNames.length).toBeGreaterThan(30);
    expect([...names(darkManualBlock)].sort()).toEqual([...colorNames].sort());
  });

  it('JobNavi と同じ名前の変数を、すべて持っている', () => {
    const jobnavi = [
      'bg', 'surface', 'surface-muted', 'border', 'border-soft', 'text', 'muted', 'faint', 'primary', 'primary-dark', 'tag-bg', 'tag-text', 'accent', 'focus',
      'error', 'error-text', 'error-bg', 'error-border', 'on-primary', 'input-bg', 'input-border', 'danger', 'shadow', 'radius', 'font',
    ];
    const light = varsOf(lightBlock);
    for (const name of jobnavi) expect(light, `--${name}`).toHaveProperty(`--${name}`);
    expect(light['--color-scheme']).toBeUndefined();
    expect(lightBlock).toContain('color-scheme: light dark;');
    expect(css).toContain(":root[data-theme='light'] { color-scheme: light; }");
    expect(css).toContain(":root[data-theme='dark'] { color-scheme: dark; }");
  });

  it('色の直書き（#xxxxxx・rgba）は、変数の定義だけに置く（本体は var(--…) を使う）', () => {
    const body = css.slice(css.indexOf(":root[data-theme='dark'] { color-scheme: dark; }"));
    expect(body.length).toBeGreaterThan(1000);
    expect(body.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g)).toBeNull();
  });

  it('本体が使う変数は、すべてライトで定義されている（旧 --brand などの取り残しが無い）', () => {
    const body = css.slice(css.indexOf(":root[data-theme='dark'] { color-scheme: dark; }"));
    const defined = new Set(Object.keys(varsOf(lightBlock)));
    // --c は、地図の印が style で渡す局所の値。--font-inter は next/font が <html> に付ける
    const external = new Set(['--c', '--font-inter']);
    const used = [...new Set([...body.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1] as string))];
    expect(used.length).toBeGreaterThan(20);
    expect(used.filter((name) => !defined.has(name) && !external.has(name))).toEqual([]);
    // 旧 TownScan の変数は、定義も残さない（--brand 系は --primary、--soft は --surface-muted、--border-strong は --input-border に置き換えた）
    for (const old of ['--brand', '--brand-dark', '--brand-soft', '--soft', '--border-strong', '--new', '--omit', '--unc']) expect(defined.has(old), old).toBe(false);
  });
});

describe('TS の中に色を書かない（色は CSS の変数だけが持つ）', () => {
  const root = process.cwd();
  function walk(dir: string): string[] {
    return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
      const rel = join(dir, entry.name);
      if (entry.isDirectory()) return walk(rel);
      return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [rel] : [];
    });
  }

  it('app・components・lib の実装に、#xxxxxx・rgb()・hsl() が無い', () => {
    const files = ['app', 'components', 'lib'].flatMap(walk);
    expect(files.length).toBeGreaterThan(15);
    const hits = files.filter((file) => /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.test(readFileSync(join(root, file), 'utf8')));
    expect(hits).toEqual([]);
  });

  it('3 分類は、CSS の変数（--class-*）を参照し、その変数はライト・ダークの両方にある', () => {
    const light = varsOf(lightBlock);
    const dark = varsOf(darkManualBlock);
    for (const cls of CANDIDATE_CLASSES) {
      const info = CLASS_INFO[cls];
      expect(info.cssVar).toMatch(/^--class-/);
      expect(info.color).toBe(`var(${info.cssVar})`);
      expect(light).toHaveProperty(info.cssVar);
      expect(dark).toHaveProperty(info.cssVar);
    }
  });
});

// ---- WCAG のコントラスト ----

function hexOf(value: string | undefined): string {
  expect(value, 'hex の値').toMatch(/^#[0-9a-f]{6}$/i);
  return value as string;
}
function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
}
function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
/** CIE76 の色差。色の見分けやすさの目安（0 に近いほど似ている） */
function deltaE(a: string, b: string): number {
  const lab = (hex: string) => {
    const [r, g, bl] = channels(hex).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
    const x = (0.4124 * r + 0.3576 * g + 0.1805 * bl) / 0.95047;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
    const z = (0.0193 * r + 0.1192 * g + 0.9505 * bl) / 1.08883;
    const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))] as const;
  };
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

describe.each([
  ['ライト', varsOf(lightBlock)],
  ['ダーク', varsOf(darkManualBlock)],
] as const)('コントラスト（WCAG AA）: %s', (_name, vars) => {
  const v = (name: string) => hexOf(vars[`--${name}`]);
  const classNames = ['class-new', 'class-omit', 'class-unc'];

  // 文字（4.5:1 以上）
  const textPairs: Array<[string, string]> = [
    ['text', 'bg'], ['text', 'surface'], ['text', 'surface-muted'], ['text', 'tag-bg'],
    ['muted', 'bg'], ['muted', 'surface'], ['muted', 'surface-muted'],
    ['faint', 'input-bg'],
    ['primary', 'surface'], ['primary', 'bg'],
    // サイドパネル: 開いている画面の項目（主色の文字を --tag-bg の地に）と、ツールチップ（--bg の文字を --text の地に）
    ['primary', 'tag-bg'], ['bg', 'text'],
    ['on-primary', 'primary'],
    ['tag-text', 'tag-bg'],
    ['error-text', 'error-bg'],
    ['warn-text', 'warn-bg'], ['warn-text', 'warn-strong-bg'], ['warn-text', 'surface'],
    ...classNames.flatMap((c): Array<[string, string]> => [[c, 'surface'], [c, 'surface-muted'], [c, 'bg']]),
  ];
  it.each(textPairs)('文字: --%s と --%s は 4.5:1 以上', (fg, bg) => {
    expect(contrast(v(fg), v(bg))).toBeGreaterThanOrEqual(4.5);
  });

  // 線・図形・枠・フォーカス（3:1 以上）
  const graphicPairs: Array<[string, string]> = [
    ['input-border', 'input-bg'], ['input-border', 'surface'],
    ['focus', 'bg'], ['focus', 'surface'],
    ['error', 'surface'],
    ['map-frame', 'map-casing'],
    // 地図の線は、航空写真の上で「縁」との差で見せる。線の色と、その下に敷く縁の色
    ...classNames.flatMap((c): Array<[string, string]> => [[c, 'map-casing']]),
  ];
  it.each(graphicPairs)('線・図形: --%s と --%s は 3:1 以上', (fg, bg) => {
    expect(contrast(v(fg), v(bg))).toBeGreaterThanOrEqual(3);
  });

  it('3 分類の色は、主色（青）や互いと、色として見分けがつく', () => {
    for (const c of classNames) expect(deltaE(v(c), v('primary')), `${c} と primary`).toBeGreaterThanOrEqual(25);
    expect(deltaE(v('class-new'), v('class-omit'))).toBeGreaterThanOrEqual(40);
    expect(deltaE(v('class-new'), v('class-unc'))).toBeGreaterThanOrEqual(40);
    expect(deltaE(v('class-omit'), v('class-unc'))).toBeGreaterThanOrEqual(40);
  });
});

describe('app/layout.tsx', () => {
  const layout = readFileSync(join(process.cwd(), 'app', 'layout.tsx'), 'utf8');

  it('描画前のスクリプトを <head> に置き、data-theme の差を警告しない', () => {
    expect(layout).toContain("import { THEME_INIT_SCRIPT } from '../lib/theme';");
    expect(layout).toMatch(/<head>\s*<script>\{THEME_INIT_SCRIPT\}<\/script>\s*<\/head>/);
    expect(layout).toContain('suppressHydrationWarning');
    expect(layout).toContain('<html lang="ja" className={inter.variable} suppressHydrationWarning>');
  });

  it('書体は JobNavi・DocuNavi と同じ（Noto Sans JP の可変フォントと Inter）。color-scheme を宣言する', () => {
    expect(layout).toContain("import '@fontsource-variable/noto-sans-jp/wght.css';");
    expect(layout).toContain("import { Inter } from 'next/font/google';");
    expect(layout).toContain("Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' })");
    expect(layout).toContain("other: { 'color-scheme': 'light dark' }");
    expect(lightBlock).toContain("--font: var(--font-inter), 'Noto Sans JP Variable', system-ui,");
  });
});
