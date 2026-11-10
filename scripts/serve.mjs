// SPDX-License-Identifier: MIT OR Apache-2.0
// A static server for web/. usage: node scripts/serve.mjs [port] [--isolated]
// Plain by default, so index.html is not cross-origin isolated and a threads run must refuse. --isolated adds COOP and COEP.
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.bin': 'application/octet-stream' };

export const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' https: http://localhost:* http://127.0.0.1:*; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'";

export function serve(port, { isolated = false, root = fileURLToPath(new URL('../web/', import.meta.url)) } = {}) {
  return new Promise((ok) => {
    const s = createServer(async (req, res) => {
      // An address that does not decode is a bad request, not a crash: one malformed request must not stop a measuring session.
      let path;
      try { path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^\/+/, '') || 'index.html'; } catch { res.writeHead(400).end(); return; }
      if (path.includes('..')) { res.writeHead(403).end(); return; }
      try {
        const body = await readFile(join(root, path));
        // The same policy as the pages' meta tag, as a header too: a meta tag does not reach a worker, a header does.
        const headers = { 'content-type': types[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-store', 'content-security-policy': CSP };
        if (isolated) { headers['cross-origin-opener-policy'] = 'same-origin'; headers['cross-origin-embedder-policy'] = 'require-corp'; }
        res.writeHead(200, headers).end(body);
      } catch { res.writeHead(404).end(); }
    });
    s.listen(port, '127.0.0.1', () => ok(s));
  });
}

// pathToFileURL, not pathname: a path with a space or a Windows drive must still run the script, not exit 0 silently.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const port = Number(process.argv[2] ?? 8090);
  const isolated = process.argv.includes('--isolated');
  await serve(port, { isolated });
  console.log(`http://localhost:${port}/ isolated=${isolated}`);
}
