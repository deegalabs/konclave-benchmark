// SPDX-License-Identifier: MIT OR Apache-2.0
// Saves a range from a light client server, for examples/pack_corpus. No key is involved.
// usage: node scripts/save-range.mjs <endpoint> <start> <end> <out prefix> [--read-approved | --own-mock]
// A server may reach the chain, which needs its own approval first: every endpoint but the repo's own mock is refused without
// --read-approved, a proxy on localhost included (scripts/read-guard.mjs). There is no default endpoint.
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { treeState, blocks } from '../web/grpcweb.js';
import { requireReadApproval } from './read-guard.mjs';

const hex = (b) => Buffer.from(b).toString('hex');

export async function saveRange(endpoint, start, end, prefix, { readApproved = false, ownMock = false } = {}) {
  requireReadApproval(endpoint, { readApproved, ownMock });
  if (!(start > 0 && end >= start)) throw new Error('a range needs a first and a last height');
  const before = await treeState(endpoint, start - 1);
  const parts = [];
  let n = 0;
  for await (const m of blocks(endpoint, start, end)) {
    const len = Buffer.alloc(4);
    len.writeUInt32LE(m.length);
    parts.push(len, Buffer.from(m));
    n++;
  }
  if (n !== end - start + 1) throw new Error(`asked for ${end - start + 1} blocks, got ${n}`);
  const after = await treeState(endpoint, end);
  if (after.height !== end) throw new Error(`asked for the tree at ${end}, got ${after.height}`);
  writeFileSync(`${prefix}.raw`, Buffer.concat(parts));
  writeFileSync(`${prefix}.json`, JSON.stringify({ endpoint, start, end, saved_at: new Date().toISOString(), start_orchard: hex(before.orchard), start_ironwood: hex(before.ironwood), end_orchard: hex(after.orchard), end_ironwood: hex(after.ironwood) }));
  return n;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [endpoint, start, end, prefix] = process.argv.slice(2);
  const n = await saveRange(endpoint, Number(start), Number(end), prefix, { readApproved: process.argv.includes('--read-approved'), ownMock: process.argv.includes('--own-mock') });
  console.log(`${n} blocks in ${prefix}.raw`);
}
