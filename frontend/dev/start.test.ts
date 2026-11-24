import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareStandalone } from './start.ts';

let root: string;

function put(rel: string, body: string) {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
}

const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'townscan-start-'));
});

afterEach(() => {
  // このテストが作った一時ディレクトリだけを消す
  rmSync(root, { recursive: true, force: true });
});

describe('npm start の下準備', () => {
  it('static と public を standalone の下へ写し、server.js のパスを返す', () => {
    put('.next/standalone/server.js', '// server');
    put('.next/static/chunks/app.css', 'body{}');
    put('.next/static/media/font.woff2', 'font');
    put('public/icon.svg', '<svg/>');

    const server = prepareStandalone(root);

    expect(server).toBe(join(root, '.next', 'standalone', 'server.js'));
    expect(read('.next/standalone/.next/static/chunks/app.css')).toBe('body{}');
    expect(read('.next/standalone/.next/static/media/font.woff2')).toBe('font');
    expect(read('.next/standalone/public/icon.svg')).toBe('<svg/>');
  });

  it('何度実行しても同じ。ビルドをやり直したあとの新しい内容で置き換える', () => {
    put('.next/standalone/server.js', '// server');
    put('.next/static/chunks/app.css', 'v1');
    prepareStandalone(root);
    put('.next/static/chunks/app.css', 'v2');
    prepareStandalone(root);
    expect(read('.next/standalone/.next/static/chunks/app.css')).toBe('v2');
  });

  it('public が無くても動く（static だけ写す）', () => {
    put('.next/standalone/server.js', '// server');
    put('.next/static/chunks/app.css', 'body{}');
    expect(() => prepareStandalone(root)).not.toThrow();
    expect(read('.next/standalone/.next/static/chunks/app.css')).toBe('body{}');
  });

  it('ビルドが無いときは、npm run build を促す', () => {
    put('public/icon.svg', '<svg/>');
    expect(() => prepareStandalone(root)).toThrow(/npm run build/);
  });
});
