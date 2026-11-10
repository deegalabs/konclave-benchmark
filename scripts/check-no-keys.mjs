// SPDX-License-Identifier: MIT OR Apache-2.0
// Fails if any viewing key other than the published test key is in the tree. Run it on a fresh clone: it reads the working tree, and build
// output outside the skipped paths (a worktree's target/) is not in git. usage: node scripts/check-no-keys.mjs [dir]
// The key allowed is the one in config/test-vault.json, once it exists.
import { pathToFileURL } from 'node:url';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { KEY } from '../web/keys.mjs';

// Only what the build writes and a key cannot be committed in, by path from the root: no folder is skipped for its name (a folder called
// corpus or pkg anywhere else is scanned like the rest). A node_modules below the root is scanned too.
const SKIP = new Set(['.git', 'target', 'node_modules', 'web/pkg', 'web/pkg-mt']);

export function scan(root) {
  const cfg = join(root, 'config/test-vault.json');
  const allowed = existsSync(cfg) ? JSON.parse(readFileSync(cfg, 'utf8')).ufvk : null;
  const hits = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (SKIP.has(relative(root, p).split(sep).join('/'))) continue;
      if (statSync(p).isDirectory()) { walk(p); continue; }
      for (const m of readFileSync(p, 'latin1').match(KEY) ?? []) if (m !== allowed) hits.push(`${p}: ${m.slice(0, 12)}...`);
    }
  };
  walk(root);
  return hits;
}

// pathToFileURL, not pathname: a path with a space or a Windows drive must still run the script, not exit 0 silently.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const hits = scan(process.argv[2] ?? '.');
  for (const h of hits) console.error(h);
  if (hits.length) console.error('Run this on a fresh clone (git clone . /tmp/kb-fresh && node scripts/check-no-keys.mjs /tmp/kb-fresh): build output that is not in git can hold key-shaped test vectors of a dependency.');
  if (hits.length) process.exit(1);
  console.log('no viewing key other than the published test key');
}
