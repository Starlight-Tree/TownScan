import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { metadata } from '../app/layout';

// タブ名は全ページで「TownScan」だけにそろえる（DocuNavi と同じ。JobNavi のようにページごとのタイトルは付けない）。
// layout の metadata.title が文字列 'TownScan'（template を持たない）で、各ページが自前の metadata を持たなければ、
// どのページのタブも 'TownScan' になる。

const PAGES: Array<[string, () => Promise<Record<string, unknown>>]> = [
  ['/', () => import('../app/page')],
  ['/about', () => import('../app/about/page')],
  ['/accuracy', () => import('../app/accuracy/page')],
];

describe('タブ名', () => {
  it('layout の metadata.title は、template の無い文字列 TownScan', () => {
    expect(metadata.title).toBe('TownScan');
  });

  it('ファビコンは app/icon.svg（Next の規約。JobNavi・DocuNavi と同じ）。metadata.icons では指定しない', () => {
    // 規約のファイルだと、配信の URL に内容のハッシュが付く（/icon.svg?xxxx）ので、図柄を変えたとき、ブラウザーの古いファビコンが残らない
    expect(metadata.icons).toBeUndefined();
    expect(existsSync(resolve(__dirname, '../app/icon.svg'))).toBe(true);
    // 同じ /icon.svg を public にも置くと、経路が重なる
    expect(existsSync(resolve(__dirname, '../public/icon.svg'))).toBe(false);
  });

  it.each(PAGES)('%s のページは、自前の metadata を出さない（タブ名が layout の TownScan のままになる）', async (_path, load) => {
    const mod = await load();
    expect(mod).not.toHaveProperty('metadata');
    expect(mod).not.toHaveProperty('generateMetadata');
  });
});
