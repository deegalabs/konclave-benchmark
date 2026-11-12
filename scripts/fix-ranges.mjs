// SPDX-License-Identifier: MIT OR Apache-2.0
// Fixes the heights of the verdict ranges by the published rule (docs/method.md, "What is fixed before the runs").
// usage: node scripts/fix-ranges.mjs <endpoint> [--read-approved | --own-mock] [--write] [--ranges-file <path>]
//
// The rule. T is the highest height h with time(h) < CUTOFF, CUTOFF being 2026-11-17 00:00:00 UTC, where time is the block time of the
// compact block (CompactBlock field 5, uint32, seconds). Block times are not monotonic, so "the block before the cutoff" is not
// read from one comparison: every block above T, up to the tip, has time >= CUTOFF. Consensus requires a block's time to be greater
// than the median of the 11 blocks before it, so once 11 consecutive blocks have time >= CUTOFF every later block does too. The
// script therefore finds a block below the cutoff by bisection, walks up from it to the first 11 consecutive blocks at or after the
// cutoff, and takes the last block below the cutoff it met. A tip that does not have 11 such blocks above T is refused. Those 11 make T final by consensus; the tip must also be at least
// MARGIN (100) blocks past T before the heights are read, as a margin against a reorganisation.
//   daily           T-3,455 to T       (3,456 blocks)
//   first-scan      T-49,999 to T      (50,000 blocks)
//   first-scan-43d  from the block after U to T, U being the highest height with time(U) < CUTOFF minus 43.4 days (3,749,760 s),
//                   found by the same rule
// Reading the chain needs --read-approved (scripts/read-guard.mjs). Nothing is written without --write, and a write changes the six
// height values of web/ranges.mjs and nothing else.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { call, blocks } from '../web/grpcweb.js';
import { requireReadApproval } from './read-guard.mjs';

export const CUTOFF = Date.UTC(2026, 10, 17, 0, 0, 0) / 1000;
export const INFO_SPAN_S = 3_749_760; // 43.4 days
export const QUIET = 11; // the median span of the time rule
export const MARGIN = 100; // blocks the tip must be past T before the heights are read: a margin against a reorganisation
const RANGES_FILE = fileURLToPath(new URL('../web/ranges.mjs', import.meta.url));

// Reads the varint and bytes fields of one message.
function fields(msg) {
  const out = {};
  let i = 0;
  const rv = () => { let v = 0n, s = 0n; for (;;) { const b = msg[i++]; if (b === undefined) throw new Error('a message ends inside a field'); v |= BigInt(b & 127) << s; s += 7n; if (!(b & 128)) return v; } };
  while (i < msg.length) {
    const tag = Number(rv());
    const wire = tag & 7;
    if (wire === 0) out[tag >> 3] = rv();
    else if (wire === 2) { const n = Number(rv()); if (i + n > msg.length) throw new Error('a field runs past the message'); out[tag >> 3] = msg.subarray(i, i + n); i += n; }
    else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else throw new Error('unexpected field type');
  }
  return out;
}

async function tipOf(endpoint) {
  for await (const m of call(endpoint, 'GetLatestBlock', [])) return Number(fields(m)[1] ?? 0n);
  throw new Error('GetLatestBlock returned nothing');
}

// The compact block at a height: its height, time and hash. A different height back is an error.
async function headerAt(endpoint, h) {
  for await (const m of blocks(endpoint, h, h)) {
    const f = fields(m);
    if (Number(f[2] ?? 0n) !== h) throw new Error(`asked for block ${h}, got ${Number(f[2] ?? 0n)}`);
    if (f[5] === undefined) throw new Error(`block ${h} carries no time`);
    return { height: h, time: Number(f[5]), hash: f[3] ? Buffer.from(f[3]).toString('hex') : '' };
  }
  throw new Error(`no block at ${h}`);
}

// The highest height h <= tip with time(h) < limit. Refuses, with the reason, when the tip is not far enough past the limit to know it.
export async function lastBelow(endpoint, limit, tip, headers = new Map()) {
  const at = async (h) => { if (!headers.has(h)) headers.set(h, await headerAt(endpoint, h)); return headers.get(h); };
  if ((await at(tip)).time < limit) throw new Error(`the tip ${tip} (time ${(await at(tip)).time}) is still before ${new Date(limit * 1000).toISOString()}: no height is fixed yet`);
  let lo = 1, hi = tip; // time(lo) < limit <= time(hi)
  if ((await at(lo)).time >= limit) throw new Error('block 1 is not before the limit');
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await at(mid)).time < limit) lo = mid; else hi = mid;
  }
  let last = lo, quiet = 0;
  for (let h = lo + 1; h <= tip && quiet < QUIET; h++) {
    if ((await at(h)).time < limit) { last = h; quiet = 0; } else quiet++;
  }
  if (quiet < QUIET) throw new Error(`the tip ${tip} is fewer than ${QUIET} blocks past the block ${last} before ${new Date(limit * 1000).toISOString()}: wait for more blocks`);
  return last;
}

export async function findRanges(endpoint, { readApproved = false, ownMock = false, cutoff = CUTOFF } = {}) {
  requireReadApproval(endpoint, { readApproved, ownMock });
  const tip = await tipOf(endpoint);
  const headers = new Map();
  const T = await lastBelow(endpoint, cutoff, tip, headers);
  const t = headers.get(T), next = headers.get(T + 1);
  if (!(t.time < cutoff && next && next.time >= cutoff)) throw new Error(`block ${T} is not the last before the cutoff`);
  if (tip - T < MARGIN) throw new Error(`the tip ${tip} is ${tip - T} blocks past T ${T}: wait for ${MARGIN}, a margin against a reorganisation`);
  const U = await lastBelow(endpoint, cutoff - INFO_SPAN_S, tip, headers);
  const ranges = [
    { id: 'daily', start_height: T - 3455, end_height: T },
    { id: 'first-scan', start_height: T - 49999, end_height: T },
    { id: 'first-scan-43d', start_height: U + 1, end_height: T },
  ];
  return { tip, cutoff, T, time: t.time, hash: t.hash, next_time: next.time, ranges };
}

// The file with the six heights replaced and every other byte as it was.
export function rewrite(text, ranges) {
  let out = text;
  for (const r of ranges) {
    const re = new RegExp(`(\\{ id: '${r.id}',[^\\n]*?start_height: )(?:null|\\d+)(, end_height: )(?:null|\\d+)( \\})`);
    if (!re.test(out)) throw new Error(`the line of ${r.id} is not in the file`);
    out = out.replace(re, `$1${r.start_height}$2${r.end_height}$3`);
  }
  return out;
}

const diff = (a, b) => {
  const x = a.split('\n'), y = b.split('\n');
  return x.flatMap((l, i) => (l === y[i] ? [] : [`- ${l}`, `+ ${y[i]}`])).join('\n');
};

export async function main(argv, log = console.log) {
  const args = argv.slice();
  const flag = (n) => { const i = args.indexOf(n); if (i < 0) return false; args.splice(i, 1); return true; };
  const readApproved = flag('--read-approved'), ownMock = flag('--own-mock'), write = flag('--write');
  let file = RANGES_FILE;
  const fi = args.indexOf('--ranges-file');
  if (fi >= 0) { file = args[fi + 1]; args.splice(fi, 2); }
  if (args.length !== 1) throw new Error('usage: node scripts/fix-ranges.mjs <endpoint> [--read-approved | --own-mock] [--write] [--ranges-file <path>]');
  const r = await findRanges(args[0], { readApproved, ownMock });
  const iso = (s) => new Date(s * 1000).toISOString();
  log(`cutoff ${iso(r.cutoff)}, tip ${r.tip}`);
  log(`T ${r.T} time ${r.time} (${iso(r.time)}) hash ${r.hash} (as the server sent it); next block time ${r.next_time} (${iso(r.next_time)})`);
  for (const e of r.ranges) log(`${e.id}: ${e.start_height} to ${e.end_height} (${e.end_height - e.start_height + 1} blocks)`);
  if (write) {
    const before = readFileSync(file, 'utf8');
    const after = rewrite(before, r.ranges);
    writeFileSync(file, after);
    log(diff(before, after) || 'no change');
  }
  return r;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
}
