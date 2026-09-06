#!/usr/bin/env node
/**
 * 依存パッケージなしの静的サーバ。
 *
 * ES モジュールを使うので file:// では動かない（CORS で弾かれる）。
 * python3 が無い環境でも `npm start` だけで開けるように、Node だけで配信する。
 *
 *   node tools/serve.mjs [--port 8080] [--open]
 */

import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8',
};

const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const port = Number(argOf('--port', process.env.PORT || 8080));
const open = args.includes('--open');

const server = createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  let path = join(ROOT, normalize(url).replace(/^(\.\.[/\\])+/, ''));
  // ルート外への参照を弾く（.. を含むパスは normalize 後にもう一度確かめる）
  if (!path.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
  try {
    let st = statSync(path);
    if (st.isDirectory()) { path = join(path, 'index.html'); st = statSync(path); }
    res.writeHead(200, {
      'content-type': MIME[extname(path)] || 'application/octet-stream',
      'content-length': st.size,
      // 生成器を書き換えながら見るので、キャッシュは持たせない
      'cache-control': 'no-cache',
    });
    createReadStream(path).pipe(res);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404');
  }
});

server.listen(port, () => {
  const url = `http://localhost:${port}/`;
  console.log(`中生代アトラスを配信中: ${url}`);
  console.log('（停止は Ctrl+C）');
  if (open) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
  }
});
