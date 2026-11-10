// SPDX-License-Identifier: MIT OR Apache-2.0
// Fails if a key (the one rule of web/keys.mjs: viewing and spending keys) is in any object reachable from a local ref of the repository:
// every blob (text or binary, whatever a diff driver would show), every commit message, every annotated tag message, the objects a tag
// on a blob or a tree points at, and every entry of the stash, not only the last. A key written as UTF-16 is read too. A ref that exists
// only on a remote and was never fetched is not in the count.
// usage: node scripts/check-history.mjs [repo dir]
// The one key allowed is the published test key of config/test-vault.json, once it exists. A hit says where, never the key.
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KEY } from '../web/keys.mjs';

const git = (repo, args, input) => {
  const out = execFileSync('git', ['-C', repo, ...args], { input, maxBuffer: 1 << 30 });
  return input === undefined ? out.toString('latin1') : out;
};

export function scanHistory(repo) {
  const cfg = join(repo, 'config/test-vault.json');
  const allowed = existsSync(cfg) ? JSON.parse(readFileSync(cfg, 'utf8')).ufvk : null;
  const found = (text) => [text, text.replace(/\0/g, '')].some((t) => (t.match(KEY) ?? []).some((m) => m !== allowed));
  // Every object reachable from a ref, and from each stash entry (--all has the last one only; the older ones are in the stash's reflog).
  const stash = git(repo, ['stash', 'list', '--format=%H']).split('\n').filter(Boolean);
  const listing = git(repo, ['rev-list', '--all', '--objects', ...stash]).split('\n').filter(Boolean);
  const path = new Map();
  for (const l of listing) { const sp = l.indexOf(' '); if (sp > 0) path.set(l.slice(0, sp), l.slice(sp + 1)); }
  const oids = listing.map((l) => l.split(' ')[0]);
  const out = git(repo, ['cat-file', '--batch'], `${oids.join('\n')}\n`);
  const hits = [];
  const where = (oid) => git(repo, ['log', '--all', '--format=%h', `--find-object=${oid}`]).split('\n').filter(Boolean).slice(0, 3).join(', ');
  let i = 0;
  while (i < out.length) {
    const nl = out.indexOf(10, i);
    const [oid, type, size] = out.subarray(i, nl).toString('latin1').split(' ');
    const body = out.subarray(nl + 1, nl + 1 + Number(size));
    i = nl + 1 + Number(size) + 1;
    if (type === 'tree' || !found(body.toString('latin1'))) continue;
    if (type === 'blob') hits.push(`blob ${oid.slice(0, 12)} ${path.get(oid) ?? '?'} (in commit ${where(oid) || 'none: only a tag, a tree or the stash points at it'})`);
    else if (type === 'commit') hits.push(`commit ${oid.slice(0, 12)} (commit message)`);
    else hits.push(`tag object ${oid.slice(0, 12)} (tag message)`);
  }
  // A path with a key in its name.
  for (const [oid, p] of path) if (found(p)) hits.push(`path of ${oid.slice(0, 12)} (the name of a file)`);
  return [...new Set(hits)];
}

// pathToFileURL, not pathname: a path with a space or a Windows drive must still run the script, not exit 0 silently.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const hits = scanHistory(process.argv[2] ?? '.');
  for (const h of hits) console.error(h);
  if (hits.length) process.exit(1);
  console.log('no key in the history other than the published test key');
}
