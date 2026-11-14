// SPDX-License-Identifier: MIT OR Apache-2.0
// Static server for ./site on 127.0.0.1, WITH Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy (threads on).
// The wasm_thread worker snippet imports the package directory ("../../../../../"), which a bundler resolves to the
// package entry; here a request for the bare pkg/ directory is answered with webzjs_wallet.js. No library file is changed.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'site');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm' };

export function start(port) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((q, r) => {
      let p = path.join(root, decodeURIComponent(q.url.split('?')[0]));
      if (p.endsWith(path.sep) || p === path.join(root, 'pkg')) {
        p = path.join(p, p.includes(`${path.sep}pkg`) ? 'webzjs_wallet.js' : 'index.html');
      }
      if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { r.writeHead(404).end(); return; }
      r.writeHead(200, {
        'content-type': mime[path.extname(p)] || 'application/octet-stream',
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-embedder-policy': 'require-corp',
        'cross-origin-resource-policy': 'same-origin',
        'cache-control': 'no-store',
      });
      fs.createReadStream(p).pipe(r);
    });
    srv.on('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}
