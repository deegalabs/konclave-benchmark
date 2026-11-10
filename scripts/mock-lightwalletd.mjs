// SPDX-License-Identifier: MIT OR Apache-2.0
// A gRPC-web server on this machine that answers from a saved corpus. No chain is touched: it exists so the live path
// can be tested with no mainnet read. Options cover the answers a real server may give.
import { createServer } from 'node:http';

function parseCorpus(buf) {
  let i = 40;
  const u32 = () => { const v = buf.readUInt32LE(i); i += 4; return v; };
  const start = Number(buf.readBigUInt64LE(i)); i += 8;
  const count = u32(); i += 8; i += 1 + 64 + 16;
  let n = u32(); i += n;
  n = u32(); i += n;
  const blocks = [];
  for (let b = 0; b < count; b++) { n = u32(); blocks.push(buf.subarray(i, i + n)); i += n; }
  return { start, blocks };
}
const frame = (flag, body) => { const h = Buffer.alloc(5); h[0] = flag; h.writeUInt32BE(body.length, 1); return Buffer.concat([h, body]); };
const trailer = (status = 0) => frame(0x80, Buffer.from(`grpc-status: ${status}\r\n`));

function readHeight(msg) { // BlockID { height = 1 }
  let i = 1, v = 0n, s = 0n;
  for (;;) { const b = msg[i++]; v |= BigInt(b & 127) << s; s += 7n; if (!(b & 128)) return Number(v); }
}
function readRange(msg) { // BlockRange { start = 1, end = 2 }
  const n = msg[1];
  return [readHeight(msg.subarray(2, 2 + n)), readHeight(msg.subarray(4 + n))];
}

export function mock(port, corpus, { dropBlock = null, failWith = null, trailersOnly = false, end = null, treeHeightOffset = 0, info = {}, infoDelayMs = 0 } = {}) {
  const { start, blocks } = parseCorpus(corpus);
  const requests = [];
  const s = createServer((req, res) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors).end(); return; }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).subarray(5);
      const method = req.url.split('/').pop();
      requests.push(method);
      const headers = { ...cors, 'content-type': 'application/grpc-web+proto' };
      if (failWith) { res.writeHead(200, { ...headers, 'grpc-status': String(failWith), 'grpc-message': 'mock failure' }).end(); return; }
      if (method === 'GetLightdInfo') {
        const str = (tag, t) => { const v = Buffer.from(t); return Buffer.concat([Buffer.from([tag, v.length]), v]); };
        const height = []; let x = info.block_height ?? 1; while (x > 127) { height.push((x & 127) | 128); x = Math.floor(x / 128); } height.push(x);
        const body = Buffer.concat([str(0x0a, info.version ?? 'mock'), str(0x12, info.vendor ?? 'mock'), str(0x22, info.chain_name ?? 'main'), Buffer.from([0x38, ...height])]);
        setTimeout(() => res.writeHead(200, headers).end(Buffer.concat([frame(0, body), trailer()])), infoDelayMs);
      } else if (method === 'GetTreeState') {
        // Field 2 height, then the tree strings: empty before the range, the corpus's end at its last height.
        const h = readHeight(body);
        const str = (tag, t) => { const v = Buffer.from(t); const len = []; let n = v.length; while (n > 127) { len.push((n & 127) | 128); n >>= 7; } len.push(n); return Buffer.concat([Buffer.from([tag, ...len]), v]); };
        const hv = []; let x = h + treeHeightOffset; while (x > 127) { hv.push((x & 127) | 128); x = Math.floor(x / 128); } hv.push(x);
        // Field 3, the block hash: 64 hex of the height, so a test can tell one height from another.
        const hashHex = h.toString(16).padStart(64, '0');
        const trees = end && h === start + blocks.length - 1 ? [str(0x32, end.orchard), str(0x3a, end.ironwood)] : [];
        res.writeHead(200, headers).end(Buffer.concat([frame(0, Buffer.concat([Buffer.from([0x10, ...hv]), str(0x1a, hashHex), ...trees])), trailer()]));
      } else if (method === 'GetBlockRange') {
        const [a, b] = readRange(body);
        const parts = [];
        for (let h = a; h <= b; h++) if (h !== dropBlock && blocks[h - start]) parts.push(frame(0, blocks[h - start]));
        if (trailersOnly && !parts.length) { res.writeHead(200, { ...headers, 'grpc-status': '0' }).end(); return; }
        res.writeHead(200, headers).end(Buffer.concat([...parts, trailer()]));
      } else { res.writeHead(200, { ...headers, 'grpc-status': '12' }).end(); }
    });
  });
  return new Promise((ok) => s.listen(port, '127.0.0.1', () => ok({ server: s, start, count: blocks.length, requests })));
}
