// SPDX-License-Identifier: MIT OR Apache-2.0
// Writes web/stamp.json: the commit and the sha256 of the page's script files. build.sh runs it with the commit it stamps the
// wasm with. usage: node scripts/stamp-js.mjs <commit> [web dir]
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { STAMPED } from '../web/stamp.mjs';

export function stampJs(commit, web) {
  const files = {};
  for (const f of STAMPED) files[f] = createHash('sha256').update(readFileSync(join(web, f))).digest('hex');
  writeFileSync(join(web, 'stamp.json'), `${JSON.stringify({ commit, files })}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [commit, web] = process.argv.slice(2);
  if (!commit) { console.error('usage: node scripts/stamp-js.mjs <commit> [web dir]'); process.exit(2); }
  stampJs(commit, web ?? fileURLToPath(new URL('../web/', import.meta.url)));
}
