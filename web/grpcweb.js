// SPDX-License-Identifier: MIT OR Apache-2.0
// The lightwalletd calls a live row needs, over gRPC-web, in plain JS: GetLightdInfo, GetTreeState and GetBlockRange.
// Tags checked against zcash_client_backend 0.25.0 src/proto/service.rs. An endpoint is only ever what the person typed.
export const SERVICE = 'cash.z.wallet.sdk.rpc.CompactTxStreamer';

function varint(n) {
  const out = [];
  let v = BigInt(n);
  while (v > 127n) { out.push(Number(v & 127n) | 128); v >>= 7n; }
  out.push(Number(v));
  return out;
}
const blockId = (height) => [0x08, ...varint(height)];
export function blockRange(start, end) {
  const a = blockId(start), b = blockId(end);
  return [0x0a, a.length, ...a, 0x12, b.length, ...b];
}
export function frame(msg) {
  const out = new Uint8Array(5 + msg.length);
  new DataView(out.buffer).setUint32(1, msg.length);
  out.set(msg, 5);
  return out;
}

// Yields each message of a gRPC-web response as it arrives. An empty body with grpc-status in the headers is a valid
// empty answer (Trailers-Only), and a non-zero status anywhere is an error.
export async function* call(endpoint, method, request, fetchImpl = fetch) {
  const res = await fetchImpl(`${endpoint.replace(/\/$/, '')}/${SERVICE}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1' },
    body: frame(Uint8Array.from(request)),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const status = res.headers.get('grpc-status');
  if (status !== null && status !== '0') throw new Error(`${method}: grpc-status ${status} ${res.headers.get('grpc-message') ?? ''}`);
  const reader = res.body.getReader();
  let buf = new Uint8Array(0);
  let sawTrailer = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (value) {
      const next = new Uint8Array(buf.length + value.length);
      next.set(buf);
      next.set(value, buf.length);
      buf = next;
    }
    while (buf.length >= 5) {
      const len = new DataView(buf.buffer, buf.byteOffset).getUint32(1);
      if (buf.length < 5 + len) break;
      const flag = buf[0];
      const body = buf.subarray(5, 5 + len);
      if (flag & 0x80) {
        sawTrailer = true;
        const text = new TextDecoder().decode(body);
        const m = /grpc-status:\s*(\d+)/i.exec(text);
        if (!m) throw new Error(`${method}: a trailer with no status`);
        if (m[1] !== '0') throw new Error(`${method}: grpc-status ${m[1]} ${text.trim()}`);
      } else {
        yield body.slice();
      }
      buf = buf.subarray(5 + len);
    }
    if (done) break;
  }
  if (buf.length) throw new Error(`${method}: the response ends inside a message`);
  if (!sawTrailer && status === null) throw new Error(`${method}: the response ended with no status`);
}

function fields(msg) {
  const out = {};
  let i = 0;
  const rv = () => { let v = 0n, s = 0n; for (;;) { const b = msg[i++]; v |= BigInt(b & 127) << s; s += 7n; if (!(b & 128)) return v; } };
  while (i < msg.length) {
    const tag = Number(rv());
    const wire = tag & 7;
    if (wire === 0) out[tag >> 3] = rv();
    else if (wire === 2) { const n = Number(rv()); if (i + n > msg.length) throw new Error('a field runs past the message'); out[tag >> 3] = msg.subarray(i, i + n); i += n; }
    else throw new Error('unexpected field type');
  }
  return out;
}
const hexBytes = (b) => {
  const s = b ? new TextDecoder().decode(b) : '';
  if (s.length % 2 || /[^0-9a-f]/i.test(s)) throw new Error('bad hex in tree state');
  return Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
};

// The state of both trees at the end of `height`, in the bytes the wasm takes.
export async function treeState(endpoint, height, fetchImpl = fetch) {
  for await (const m of call(endpoint, 'GetTreeState', blockId(height), fetchImpl)) {
    const f = fields(m);
    const text = (b) => (b ? new TextDecoder().decode(b) : '');
    // The bytes the wasm takes, and the strings the server sent: the block hash and the trees are what a run records.
    return { height: Number(f[2] ?? 0n), hash: text(f[3]), orchard: hexBytes(f[6]), ironwood: hexBytes(f[7]), orchard_hex: text(f[6]), ironwood_hex: text(f[7]) };
  }
  throw new Error('GetTreeState returned nothing');
}

// What the server says it is: version, vendor, chain and the height it has. Read once per live run; the harness does not act on it, it records it.
export async function lightdInfo(endpoint, fetchImpl = fetch) {
  for await (const m of call(endpoint, 'GetLightdInfo', [], fetchImpl)) {
    const f = fields(m);
    const text = (b) => (b ? new TextDecoder().decode(b) : '');
    return { version: text(f[1]), vendor: text(f[2]), chain_name: text(f[4]), block_height: Number(f[7] ?? 0n), consensus_branch_id: text(f[6]), git_commit: text(f[8]), lightwallet_protocol_version: text(f[18]) };
  }
  throw new Error('GetLightdInfo returned nothing');
}

export const blocks = (endpoint, start, end, fetchImpl = fetch) => call(endpoint, 'GetBlockRange', blockRange(start, end), fetchImpl);
