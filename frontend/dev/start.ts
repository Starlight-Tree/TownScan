// `npm start`: ビルドした standalone サーバー（.next/standalone/server.js）を、画面の部品を添えて起動する。
//
// next build の standalone 出力には .next/static（CSS・JS）と public（アイコン）が入らない。
// server.js だけを実行すると、HTML は返るが CSS・JS・アイコンが 404 になり、操作できない画面になる。
// Docker の prebuilt / runtime は Dockerfile で同じものを COPY しているので、ここは npm start の分だけ。
import { spawn } from 'node:child_process';
import { cpSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** static と public を standalone の下へ写し、server.js のパスを返す。ビルドが無ければ例外 */
export function prepareStandalone(root: string): string {
  const server = join(root, '.next', 'standalone', 'server.js');
  if (!existsSync(server)) {
    throw new Error('.next/standalone/server.js がありません。先に npm run build を実行してください。');
  }
  const copies: [from: string, to: string][] = [
    [join(root, '.next', 'static'), join(root, '.next', 'standalone', '.next', 'static')],
    [join(root, 'public'), join(root, '.next', 'standalone', 'public')],
  ];
  for (const [from, to] of copies) {
    if (existsSync(from)) cpSync(from, to, { recursive: true, force: true });
  }
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let server: string;
  try {
    server = prepareStandalone(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
  const child = spawn(process.execPath, [server], { stdio: 'inherit', env: process.env });
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  for (const sig of signals) process.on(sig, () => child.kill(sig));
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 0 : 1)));
}
