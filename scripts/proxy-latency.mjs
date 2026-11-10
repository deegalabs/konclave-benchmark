// SPDX-License-Identifier: MIT OR Apache-2.0
// What the gRPC-web proxy costs per call, measured from this host: the proxied path minus a direct path. Not a browser number and not the
// phone's: see the `said` field of the output.
// usage: node scripts/proxy-latency.mjs --entry <proxy origin from web/endpoints.mjs> --range <start>-<end> --read-approved [--runs N] [--out file]
// It reads the chain twice a round (through the proxy and straight from its upstream), so --read-approved is required for every entry of the table, a proxy on localhost included.
// The upstream and the proxy's config hashes come from the table: there is no option to name an upstream. The range is the caller's: give one
// the size of the row this accompanies (a daily range is 3,456 blocks since NU7; web/ranges.mjs holds the protocol's ranges) and outside every verdict range.
// The proxied path is gRPC-web through fetch; the direct path is gRPC over HTTP/2 (node:http2) to the declared upstream, with the same
// frame and request encoding as web/grpcweb.js. The two alternate, so a drift in the network falls on both.
import { connect } from 'node:http2';
import { hostname } from 'node:os';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { call, frame, blockRange, SERVICE } from '../web/grpcweb.js';
import { ENDPOINTS, findEndpoint, originOf, declaredFor } from '../web/endpoints.mjs';
import { bareOrigin } from '../web/endpoint.mjs';
import { median } from '../web/summarize-core.mjs';
import { requireReadApproval } from './read-guard.mjs';

export function entryFor(origin, table = ENDPOINTS) {
  const e = findEndpoint(origin ? bareOrigin(origin) : null, table);
  if (!e) throw new Error(`${origin} is not in the endpoint table`);
  if (e.via !== 'proxy' || !originOf(e)) throw new Error(`${origin} is not in the endpoint table as a proxy with an origin`);
  return e;
}

// One gRPC call over HTTP/2: the messages and their bytes, and an error on a status other than 0.
function direct(session, method, request) {
  return new Promise((ok, no) => {
    const req = session.request({ ':method': 'POST', ':path': `/${SERVICE}/${method}`, 'content-type': 'application/grpc', te: 'trailers' });
    const chunks = [];
    let status = null, message = '';
    const note = (h) => { if (h['grpc-status'] !== undefined) { status = h['grpc-status']; message = h['grpc-message'] ?? ''; } };
    req.on('response', note);
    req.on('trailers', note);
    req.on('data', (c) => chunks.push(c));
    req.on('error', no);
    req.on('end', () => {
      if (status !== '0') { no(new Error(`${method}: grpc-status ${status} ${message}`)); return; }
      const buf = Buffer.concat(chunks);
      let i = 0, messages = 0;
      while (i + 5 <= buf.length) { i += 5 + buf.readUInt32BE(i + 1); messages++; }
      if (i !== buf.length) { no(new Error(`${method}: the response ends inside a message`)); return; }
      ok({ messages, bytes: buf.length });
    });
    req.end(Buffer.from(frame(Uint8Array.from(request))));
  });
}

async function proxied(origin, method, request) {
  let messages = 0, bytes = 0;
  for await (const m of call(origin, method, request)) { messages++; bytes += m.length + 5; }
  return { messages, bytes };
}

const spread = (xs) => ({ n: xs.length, median: median(xs), min: Math.min(...xs), max: Math.max(...xs) });

export async function measure({ proxyOrigin, directOrigin, runs, range, host, upstream, config, readApproved = false, ownMock = false }) {
  // Both paths read the chain: neither is called before the approval is checked, and only the repo's own stand-in is read without it.
  requireReadApproval(proxyOrigin, { readApproved, ownMock });
  requireReadApproval(directOrigin, { readApproved, ownMock });
  const [start, end] = range;
  const session = connect(directOrigin);
  session.on('error', () => {});
  const paths = { proxy: (m, r) => proxied(proxyOrigin, m, r), direct: (m, r) => direct(session, m, r) };
  const calls = { latest_block: ['GetLatestBlock', []], block_range: ['GetBlockRange', blockRange(start, end)] };
  const time = async (path, key) => { const t = performance.now(); const r = await paths[path](...calls[key]); return { ms: performance.now() - t, ...r }; };
  const samples = { proxy: { latest_block: [], block_range: [] }, direct: { latest_block: [], block_range: [] } };
  const order = [];
  try {
    // One call of each kind on each path, not counted: the connection, the DNS and the proxy's first request are not what is measured.
    for (const path of ['proxy', 'direct']) for (const key of Object.keys(calls)) await time(path, key);
    for (let i = 0; i < runs; i++) {
      const pair = i % 2 === 0 ? ['proxy', 'direct'] : ['direct', 'proxy'];
      order.push(pair.join(','));
      for (const path of pair) for (const key of Object.keys(calls)) samples[path][key].push(await time(path, key));
    }
  } finally { session.close(); }
  const summary = (path) => {
    const lat = samples[path].latest_block, rng = samples[path].block_range;
    const r = spread(rng.map((x) => x.ms));
    const bytes = rng[0].bytes;
    return { latest_block: spread(lat.map((x) => x.ms)), block_range: { ...r, messages: rng[0].messages, bytes, bytes_per_s: Math.round(bytes / (r.median / 1000)) } };
  };
  const proxy = summary('proxy'), directSummary = summary('direct');
  const round = (x) => Math.round(x * 100) / 100;
  return {
    label: `proxied path minus a direct path, measured from ${host}`,
    said: `Proxy overhead: the proxied path (gRPC-web through the proxy) minus a direct gRPC/HTTP2 path to the declared upstream, over ${runs} alternating runs of ${end - start + 1} blocks, measured from ${host}. It is not from the phone: it does not include the phone's radio or ISP path or the browser's own fetch cost. It is a per-call time, and the proxied time is never corrected by it.`,
    host, at: new Date().toISOString(), proxy_origin: proxyOrigin, upstream_declared: upstream, proxy_config_declared: config ?? null,
    runs, range: { start, end, blocks: end - start + 1 }, order,
    proxy, direct: directSummary,
    difference_ms: { latest_block: round(proxy.latest_block.median - directSummary.latest_block.median), block_range: round(proxy.block_range.median - directSummary.block_range.median) },
  };
}

function usage(why) {
  console.error(`${why}\nusage: node scripts/proxy-latency.mjs --entry <proxy origin in web/endpoints.mjs> --range <start>-<end> --read-approved [--runs N] [--out file]\nThe upstream comes from the table; there is no option to name one. It reads the chain, so --read-approved is required.`);
  process.exit(2);
}

// The command line, checked: throws with the reason. --read-approved is required, whatever the entry.
export function parseCli(args) {
  const { values } = parseArgs({ args, options: { entry: { type: 'string' }, range: { type: 'string' }, runs: { type: 'string', default: '20' }, out: { type: 'string' }, 'read-approved': { type: 'boolean', default: false } }, strict: true });
  if (!values.entry) throw new Error('--entry is required');
  const entry = entryFor(values.entry);
  const m = /^(\d+)-(\d+)$/.exec(values.range ?? '');
  if (!m || Number(m[1]) > Number(m[2])) throw new Error('--range <start>-<end> is required, start at most end');
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs must be a whole number of at least 1');
  if (!values['read-approved']) throw new Error('--read-approved is required: this script reads the chain, a proxy on localhost included');
  return { entry, range: [Number(m[1]), Number(m[2])], runs, out: values.out, readApproved: true };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  let o;
  try { o = parseCli(process.argv.slice(2)); } catch (e) { usage(e.message); }
  const out = await measure({ proxyOrigin: originOf(o.entry), directOrigin: `https://${o.entry.upstream}`, runs: o.runs, range: o.range, host: hostname(), upstream: o.entry.upstream, config: declaredFor(originOf(o.entry)).proxy_config_declared, readApproved: o.readApproved });
  const text = `${JSON.stringify(out, null, 2)}\n`;
  if (o.out) writeFileSync(o.out, text); else process.stdout.write(text);
}
