// SPDX-License-Identifier: MIT OR Apache-2.0
// node --test tests/node.test.mjs : no browser and no network beyond this machine.
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { treeState, blocks, call, lightdInfo } from '../web/grpcweb.js';
import { openRun, markStage, closeRun, recoverKilled } from '../web/runs.js';
import { summarize as summarizeWith, median, line, report } from '../scripts/summarize.mjs';
import { ENDPOINTS, declaredFor, findEndpoint, verdictReady, originOf } from '../web/endpoints.mjs';
import { scan } from '../scripts/check-no-keys.mjs';
import { CHUNKED_TREE_INSERT } from '../web/summarize-core.mjs';
import { RANGES, askedEntry } from '../web/ranges.mjs';
import { mock } from '../scripts/mock-lightwalletd.mjs';
import { saveRange } from '../scripts/save-range.mjs';

// The real table has no hosted proxy yet, so nothing in it can carry a verdict. Tests of the verdict rules add two hosted entries
// that exist only here; summarizeReal is the summary as shipped.
export const HOSTED = 'https://m1-hosted.example', HOSTED_GLOBAL = 'https://m1-hosted-global.example';
const hostedEntry = (origin, upstream) => ({ origin, hostname: new URL(origin).hostname, via: 'proxy', role: 'verdict', upstream, files: { 'hosted/compose.yml': 'a'.repeat(64) }, platform: 'test', edge_tls: 'test', region: 'test', image_digest: `sha256:${'c'.repeat(64)}` });
const TEST_TABLE = [...ENDPOINTS, hostedEntry(HOSTED, 'zec.rocks:443'), hostedEntry(HOSTED_GLOBAL, 'zec.global:443')];
const summarizeReal = summarizeWith;
// The README and the long form it points to (docs/protocol-details.md): the text the tests of what the docs say read.
const docsText = () => ['../README.md', '../docs/protocol-details.md'].map((f) => readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n');
// The real RANGES hold no heights yet. Tests of the verdict rules use ranges that exist only here; summarizeReal is the summary as shipped.
const TEST_RANGES = [
  { id: 'daily', kind: 'daily', blocks: 3456, start_height: 3000000, end_height: 3003455 },
  { id: 'first-scan', kind: 'first-sync', blocks: 50000, start_height: 3100000, end_height: 3149999 },
  { id: 'first-scan-43d', kind: 'information', blocks: null, start_height: 2800000, end_height: 2950000 },
];
// What the page records on every run, dead or alive (range_asked), and what the wasm records when the run ends (the other three).
const ASKED_DAILY = { id: 'daily', kind: 'daily', start: 3000000, end: 3003455, blocks: 3456 };
const ASKED_FIRST = { id: 'first-scan', kind: 'first-sync', start: 3100000, end: 3149999, blocks: 50000 };
const DAILY = { range_kind: 'daily', start_height: 3000000, blocks: 3456, range_asked: ASKED_DAILY };
const FIRST_SCAN = { range_kind: 'first-sync', start_height: 3100000, blocks: 50000, range_asked: ASKED_FIRST };
// The only key a live verdict is scanned with: its hash is the published one in these tests (the shipped one is null).
const TEST_PUBLISHED = 'ab'.repeat(32);
const summarize = (input, opts = {}) => summarizeWith(input, { endpoints: TEST_TABLE, ranges: TEST_RANGES, publishedKey: TEST_PUBLISHED, ...opts });
// What a run that died leaves: the context of its row and the range it was asked, none of what the wasm writes at the end.
const died = (r, outcome = 'killed') => { const { start_height, blocks, range_kind, total_ms, actions_by_pool, stages_ms, pipeline_ms, elapsed_ms, ...rest } = r; return { ...rest, outcome }; };

// The sha256 of the 8 zero bytes the worker tests serve as their wasm: the stamp the page would hand to the worker.
const FAKE_WASM_SHA = 'af5570f5a1810b7af78caf4bc70a660f0df51e42baf91d4de5b2328de0e83dfc';
const corpus = readFileSync(new URL('../web/corpus/synthetic-10k.bin', import.meta.url));
const memStore = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }; };

test('the live client reads every block of a range, in order', async () => {
  const { server, start } = await mock(18901, corpus);
  const out = [];
  for await (const m of blocks('http://127.0.0.1:18901', start, start + 9)) out.push(m);
  server.close();
  assert.equal(out.length, 10);
});

test('a Trailers-Only empty answer is an empty answer, not an error', async () => {
  const { server } = await mock(18902, corpus, { trailersOnly: true });
  const out = [];
  for await (const m of blocks('http://127.0.0.1:18902', 1, 2)) out.push(m);
  server.close();
  assert.equal(out.length, 0);
});

test('a non-zero status is an error with its code', async () => {
  const { server } = await mock(18903, corpus, { failWith: 14 });
  await assert.rejects(async () => { for await (const _ of blocks('http://127.0.0.1:18903', 1, 2)); }, /grpc-status 14/);
  server.close();
});

test('a response cut inside a message is an error', async () => {
  const fake = async () => new Response(new Uint8Array([0, 0, 0, 0, 9, 1, 2]), { status: 200 });
  await assert.rejects(async () => { for await (const _ of call('http://x', 'M', [], fake)); }, /ends inside/);
});

test('a response with no status at all is an error', async () => {
  const fake = async () => new Response(new Uint8Array([]), { status: 200 });
  await assert.rejects(async () => { for await (const _ of call('http://x', 'M', [], fake)); }, /no status/);
});

test('tree state fields come from their own tags', async () => {
  const hex = (s) => [...Buffer.from(s)];
  const msg = [0x10, 5, 0x32, 2, ...hex('ab'), 0x3a, 2, ...hex('cd')];
  const framed = new Uint8Array([0, 0, 0, 0, msg.length, ...msg, 0x80, 0, 0, 0, 0]);
  const fake = async () => new Response(framed, { status: 200, headers: { 'grpc-status': '0' } });
  const s = await treeState('http://x', 5, fake);
  assert.deepEqual([s.height, [...s.orchard], [...s.ironwood]], [5, [0xab], [0xcd]]);
});

test('a run that never closed is recovered as killed, once, with its last stage', () => {
  const st = memStore();
  openRun(st, { row: 'prove-n2', run_index: 3 });
  markStage(st, 'prove');
  const k = recoverKilled(st);
  assert.deepEqual([k.outcome, k.stage, k.run_index], ['killed', 'prove', 3]);
  assert.equal(recoverKilled(st), null);
  openRun(st, { row: 'x', run_index: 1 });
  closeRun(st);
  assert.equal(recoverKilled(st), null);
});

let id = 0;
const run = (over = {}) => ({ kind: 'prove', row: 'prove-n2', pool: 'ironwood-v3', device_label: 'A14', device_class: 'phone', user_agent: 'Firefox/158', outcome: 'ok', runs_planned: 5, temp_before: '30', page_hidden_during_run: false, js_commit: 'abcdef1', js_files_match: true, key_build_ms: 111000, prove_ms: 130000, threads_asked: 0, wasm_sha256: 'a', wasm_sha256_stamped: 'a', glue_sha256: 'g', glue_sha256_stamped: 'g', snippets_sha256: {}, snippets_sha256_stamped: {}, harness_commit: 'abcdef1', started_at: 't', run_id: `r${++id}`, verified: true, cold: true, prepare_ms: 0, verify_ms: 0, ...over, pipeline_ms: over.pipeline_ms ?? ((over.key_build_ms ?? 111000) + (over.prove_ms ?? 130000)), elapsed_ms: over.elapsed_ms ?? over.pipeline_ms ?? ((over.key_build_ms ?? 111000) + (over.prove_ms ?? 130000)) });
const fast = { key_build_ms: 1000, prove_ms: 1000 };
const five = (o = {}) => [run(o), run(o), run(o), run(o), run(o)];
const fiveScan = (o = {}) => [0, 1, 2, 3, 4].map(() => scanRun({ runs_planned: 5, ...o }));

test('the proof bar is key build plus first proof: 111 + 130 fails 180 s', () => {
  const [l] = summarize(five());
  assert.equal(l.median_ms, 241000);
  assert.equal(l.verdict, 'fail');
  assert.equal(summarize(five({ key_build_ms: 30000, prove_ms: 50000 }))[0].verdict, 'pass');
});

// a real killed record carries what the page recorded before it died, no result fields
test('a missing or killed run stays in its row and takes the verdict away', () => {
  const [short] = summarize([run(fast), run(fast)]);
  assert.equal(short.missing, 3);
  assert.match(short.verdict, /FAIL/);
  const { key_build_ms, prove_ms, wasm_sha256, ...before } = run(fast);
  const lines = summarize([run(fast), run(fast), { ...before, outcome: 'killed', stage: 'prove' }]);
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].bad, ['killed']);
  assert.match(lines[0].verdict, /FAIL/);
});

test('a run with a required field missing is left out of the median and shown', () => {
  const [l] = summarize([run(fast), run(fast), run({ ...fast, device_label: 'A14', harness_commit: '' })]);
  assert.equal(l.runs.length, 2);
  assert.match(l.verdict, /FAIL/);
});

test('saving a session twice does not count a run twice', () => {
  const a = five(fast);
  const [l] = summarize([...a, ...a]);
  assert.equal(l.runs.length, 5);
  assert.equal(l.verdict, 'pass');
});

test('a row that mixes builds is refused', () => {
  assert.equal(summarize([run(), run({ wasm_sha256: 'b' }), run()])[0].verdict, 'REFUSED');
});

// What a live run saw of the upstream (web/observe.mjs): a verdict row without it is refused.
const OBSERVED = { lightd_info: { version: 'v', vendor: 'v', chain_name: 'main', block_height: 1 }, tree_state_start: { height: 1, hash: 'a', orchard: '', ironwood: '' }, tree_state_end: { height: 2, hash: 'b', orchard: 'aa', ironwood: 'bb' }, end_block_hash: 'b', tree_roots: { orchard: { start: '0a'.repeat(32), end: '0b'.repeat(32) }, ironwood: { start: '0c'.repeat(32), end: '0d'.repeat(32) } } };
const bareOriginOf = (e) => new URL(e).origin; // what the page records: planRows normalises the typed endpoint
const scanRun = (o = {}) => {
  const endpoint = 'endpoint' in o ? o.endpoint : HOSTED;
  return run({ kind: 'scan', row: 'scan-daily-x', pool: undefined, device_label: 'A72', user_agent: 'Chrome/155', runs_planned: 1, total_ms: 1000, live_or_replay_asked: 'live', endpoint, ...(endpoint ? { ...declaredFor(bareOriginOf(endpoint), TEST_TABLE), ...OBSERVED } : {}), actions_by_pool: { orchard: 1, ironwood: 1 }, key_sha256: TEST_PUBLISHED, tree_insert: 'chunk-10000', tree_insert_asked: 'chunked', ...DAILY, ...o, pipeline_ms: o?.pipeline_ms ?? o?.total_ms ?? 1000 });
};

test('a replay never carries a verdict, pass or fail, and live rows have bars', () => {
  assert.match(summarize([scanRun({ live_or_replay_asked: 'replay' })])[0].verdict, /replay/);
  assert.match(summarize([scanRun({ live_or_replay_asked: 'replay', total_ms: 99e6 })])[0].verdict, /replay/);
  assert.equal(summarize(fiveScan())[0].verdict, 'pass');
  assert.equal(summarize(fiveScan({ total_ms: 31000 }))[0].verdict, 'fail');
  assert.equal(summarize(fiveScan({ row: 'scan-first-sync-x', ...FIRST_SCAN, total_ms: 31000 }))[0].verdict, 'pass');
});

// A verdict is for the fixed range only. The row label and the form's kind are what a person typed; the heights and the block count are what ran.
test('a live scan gets a verdict only on a range the protocol fixed', () => {
  const v = (o, ranges) => summarize(fiveScan(o), ranges ? { ranges } : {})[0].verdict;
  assert.equal(v({}), 'pass');
  assert.equal(v({ ...FIRST_SCAN, row: 'scan-first-sync-x', total_ms: 700000 }), 'fail');
  // The shapes that once passed: 1,000 blocks as a first scan, 100 blocks as a day, one day that starts somewhere else.
  assert.match(v({ ...FIRST_SCAN, row: 'scan-first-sync-x', blocks: 1000, total_ms: 100000 }), /^range not fixed by the protocol, not a verdict$/);
  assert.match(v({ blocks: 100, total_ms: 5000 }), /^range not fixed by the protocol, not a verdict$/);
  assert.match(v({ start_height: 2999999 }), /^range not fixed/);
  assert.match(v({ ...FIRST_SCAN, row: 'scan-first-sync-x', range_kind: 'daily' }), /^range not fixed/, 'the first-scan range recorded as a day is not the day');
  assert.match(v({ ...DAILY, range_kind: 'first-sync' }), /^range not fixed/);
  assert.match(v({ range_asked: { ...ASKED_DAILY, id: 'made-up' } }), /^range not fixed/, 'an id that is not in the table');
  assert.match(v({ range_asked: { ...ASKED_DAILY, end: 3003454, blocks: 3455 } }), /^range not fixed/, 'heights that are not the entry\'s');
  // 43.4 days of chain: information, whatever it is labelled and however long it took.
  assert.equal(v({ row: 'scan-first-sync-x', range_kind: 'information', start_height: 2800000, blocks: 150001, total_ms: 999000, range_asked: { id: 'first-scan-43d', kind: 'information', start: 2800000, end: 2950000, blocks: 150001 } }), 'information only, not a verdict');
  // A runs that mixes ranges, or has no recorded range, has none.
  const mixed = [...fiveScan({}).slice(0, 4), scanRun({ blocks: 100 })];
  assert.match(summarize(mixed)[0].verdict, /^range not fixed/);
  const unrecorded = fiveScan({}).map((r) => { const { start_height, blocks, range_asked, ...rest } = r; return rest; });
  assert.match(summarize(unrecorded)[0].verdict, /^range not fixed/);
});

test('the shipped RANGES fix no height yet, so no live scan carries a verdict, and a fixed entry has the length the protocol says', () => {
  assert.deepEqual(RANGES.map((e) => [e.id, e.blocks, e.start_height, e.end_height]), [['daily', 3456, null, null], ['first-scan', 50000, null, null], ['first-scan-43d', null, null, null]]);
  assert.match(summarizeReal(fiveScan({}), { endpoints: TEST_TABLE })[0].verdict, /^range not fixed by the protocol, not a verdict$/);
  assert.equal(askedEntry(DAILY.range_asked, [{ id: 'daily', kind: 'daily', blocks: 3456, start_height: 3000000, end_height: 3003455 }]).id, 'daily');
  assert.equal(askedEntry({ ...DAILY.range_asked, start: 1, end: 3455 }, [{ id: 'daily', kind: 'daily', blocks: 3456, start_height: 1, end_height: 3455 }]), null, 'an entry of the wrong length is not fixed');
});

test('pools, filters and browsers are never merged, and a threads row has no verdict', () => {
  assert.equal(summarize([scanRun(), scanRun({ user_agent: 'Firefox/158' })]).length, 2);
  assert.equal(summarize([scanRun(), scanRun({ filter: 50 })]).length, 2);
  assert.equal(summarize([...five(fast), ...five({ ...fast, pool: 'orchard-v2' })]).length, 2);
  assert.match(summarize(five({ ...fast, threads_asked: 4 }))[0].verdict, /threads/);
});

test('the bar comes from the recorded class, never the label, and only for prove-n2 on Ironwood', () => {
  const dell = five({ device_label: 'Dell XPS 13', device_class: 'laptop', key_build_ms: 60000, prove_ms: 60000 });
  assert.equal(summarize(dell)[0].verdict, 'fail');
  assert.equal(summarize(five({ ...fast, device_class: '' }))[0].verdict, 'incomplete');
  assert.match(summarize(five({ ...fast, device_class: 'other' }))[0].verdict, /^REFUSED: class other hides the bar/);
  assert.equal(summarize(five({ ...fast, row: 'prove-n24' }))[0].verdict, 'no bar');
  assert.equal(summarize(five({ ...fast, pool: 'orchard-v2' }))[0].verdict, 'no bar');
});

test('a run that cannot be trusted takes the verdict away, however fast', () => {
  const refused = (o) => summarize(five({ ...fast, ...o }))[0].verdict;
  assert.match(refused({ verified: false }), /not verified/);
  assert.match(refused({ harness_commit: 'abc-dirty' }), /clean commit/);
  assert.match(refused({ harness_commit: 'unknown' }), /clean commit/);
  assert.match(refused({ wasm_sha256: undefined }), /not identified/);
  assert.match(summarize([scanRun({ filter: 50 })])[0].verdict, /filter/);
  assert.match(summarize([scanRun({ actions_by_pool: { orchard: 0, ironwood: 0 } })])[0].verdict, /no actions/);
  const keys = summarize([run({ ...fast, key_sha256: 'a' }), run({ ...fast, key_sha256: 'b' }), run({ ...fast, key_sha256: 'a' }), run({ ...fast, key_sha256: 'a' }), run({ ...fast, key_sha256: 'a' })])[0].verdict;
  assert.match(keys, /mixes key_sha256/);
});

test('a key that was not built in the run takes the verdict away', () => {
  assert.match(summarize(five({ key_build_ms: 0, prove_ms: 170000 }))[0].verdict, /not cold/);
  assert.match(summarize(five({ ...fast, cold: false }))[0].verdict, /not cold/);
});

test('stages that do not add up to the time they ran take the verdict away', () => {
  assert.match(summarize(five({ ...fast, pipeline_ms: 9000 }))[0].verdict, /add up/);
  assert.match(summarize(five({ ...fast, pipeline_ms: undefined, verify_ms: 5000 }))[0].verdict, /add up/);
  assert.match(summarize([scanRun({ total_ms: 1000, pipeline_ms: 3000 })])[0].verdict, /add up/);
  assert.equal(summarize(five({ ...fast, pipeline_ms: 2100 }))[0].verdict, 'pass', 'a small gap is timer noise');
});

// Witnesses stay out of the total, and are printed beside it
test('witness time is reported beside the verdict and never added to it', () => {
  const [l] = summarize(fiveScan({ total_ms: 1000, witness_ms: 99000 }));
  assert.equal(l.median_ms, 1000);
  assert.equal(l.verdict, 'pass');
  assert.equal(l.witness_median_ms, 99000);
});

// Thread control
test('a threads row must beat its one-thread control', () => {
  const t = (n, prove) => five({ ...fast, threads_asked: n, threads: n, prove_ms: prove, cross_origin_isolated: true });
  const lines = (a, b) => summarize([...t(1, a), ...t(4, b)]).find((l) => /threads 4/.test(l.row));
  assert.equal(lines(20000, 7000).threads_check, 'faster than one thread');
  assert.match(lines(20000, 19000).verdict, /NOT FASTER/);
  assert.match(summarize(t(4, 7000))[0].verdict, /no control/);
});

test('a thread pool smaller than asked, or a page not isolated, is refused', () => {
  const v = (o) => summarize(five({ ...fast, threads_asked: 1, cross_origin_isolated: true, threads: 1, ...o }))[0].verdict;
  assert.match(v({ threads: 2 }), /not the size asked/);
  assert.match(v({ cross_origin_isolated: false }), /not isolated/);
});

// Work before the worker's clock starts leaves a 0 s scan, and only the page's clock can see it
test('a scan whose work happened before its clock is refused, not passed', () => {
  const zero = { total_ms: 0, pipeline_ms: 0, stages_ms: { decode: 0, decrypt: 0, tree: 0 } };
  assert.match(summarize([scanRun({ ...zero, elapsed_ms: 8000 })])[0].verdict, /no stage accounts/);
  assert.match(summarize(five({ ...fast, elapsed_ms: 60000 }))[0].verdict, /no stage accounts/);
  assert.match(summarize(five({ ...fast, elapsed_ms: undefined, pipeline_ms: 2000 }))[0].verdict, /pass/, 'the fixture falls back to the pipeline');
  const missing = { ...run(fast) };
  delete missing.elapsed_ms;
  assert.match(summarize([{ ...missing, runs_planned: 1 }])[0].verdict, /no stage accounts/);
  assert.equal(summarize(fiveScan({ total_ms: 1000, elapsed_ms: 1400, wasm_load_ms: 100, preflight_ms: 100 }))[0].verdict, 'pass');
});

// The first run is not the median
test('the median is not the first run', () => {
  const l = summarize([run({ key_build_ms: 10, prove_ms: 900000 }), run({ key_build_ms: 10, prove_ms: 1000 }), run({ key_build_ms: 10, prove_ms: 2000 })])[0];
  assert.equal(l.median_ms, 2010);
});

test('a changed run changes the median', () => {
  assert.equal(median([1, 2, 30]), 2);
  assert.notEqual(summarize(five())[0].median_ms, summarize([run({ prove_ms: 200000 }), run({ prove_ms: 200000 }), run({ prove_ms: 200000 }), run(), run()])[0].median_ms);
});

test('a trailer with no status and a bad tree state are errors', async () => {
  const noStatus = async () => new Response(new Uint8Array([0x80, 0, 0, 0, 1, 65]), { status: 200 });
  await assert.rejects(async () => { for await (const _ of call('http://x', 'M', [], noStatus)); }, /no status/);
  const msg = [0x32, 2, 0x7a, 0x7a];
  const bad = async () => new Response(new Uint8Array([0, 0, 0, 0, msg.length, ...msg]), { status: 200, headers: { 'grpc-status': '0' } });
  await assert.rejects(() => treeState('http://x', 1, bad), /bad hex/);
});

// The service worker and the worker run where a page listener cannot see them, so the sources are read too
test('no web source names a host', () => {
  const dir = fileURLToPath(new URL('../web/', import.meta.url));
  // .mjs too. web/endpoints.mjs is the one allowed place: the endpoint table names the proxies, and nothing else may.
  for (const f of readdirSync(dir).filter((x) => /\.(m?js|html)$/.test(x) && x !== 'endpoints.mjs')) {
    const urls = readFileSync(join(dir, f), 'utf8').match(/\b(?:https?|wss?):\/\/[^\s'"`)]+/g) ?? [];
    // This machine only, as the page's own policy names it for a local light client server.
    assert.deepEqual(urls.filter((u) => !/^http:\/\/(localhost|127\.0\.0\.1):\*;?$/.test(u)), [], f);
  }
});

// Live, at the client: the page counts what it receives
test('a block the server leaves out is a block fewer, and a server can be told apart', async () => {
  const { server, start, count } = await mock(18904, corpus, { dropBlock: 3_000_002 });
  const out = [];
  for await (const m of blocks('http://127.0.0.1:18904', start, start + count - 1)) out.push(m);
  server.close();
  assert.equal(out.length, count - 1);
});

test('saving a range keeps every block and refuses a server not on this machine without approval', async () => {
  const end = JSON.parse(readFileSync(new URL('../web/corpus/synthetic-10k.bin.end.json', import.meta.url), 'utf8'));
  const { server, start, count } = await mock(18905, corpus, { end });
  const d = mkdtempSync(join(tmpdir(), 'kb-'));
  const prefix = join(d, 'r');
  try {
    assert.equal(await saveRange('http://127.0.0.1:18905', start, start + count - 1, prefix, { ownMock: true }), count);
    const saved = JSON.parse(readFileSync(`${prefix}.json`, 'utf8'));
    assert.equal(saved.end_orchard, end.orchard);
    await assert.rejects(() => saveRange('http://127.0.0.1:18905', start, start + count, prefix, { ownMock: true }), /asked for/);
  } finally {
    // A server left open keeps the suite alive after a failure, so it hangs instead of reporting.
    server.close();
  }
  let called = false;
  const real = globalThis.fetch;
  globalThis.fetch = async () => { called = true; throw new Error('no'); };
  await assert.rejects(() => saveRange('https://example.invalid/x', 1, 2, prefix), /read-approved/);
  globalThis.fetch = real;
  assert.equal(called, false, 'nothing was sent');
});

test('a server that answers the tree for another height is refused', async () => {
  const end = JSON.parse(readFileSync(new URL('../web/corpus/synthetic-10k.bin.end.json', import.meta.url), 'utf8'));
  const { server, start, count } = await mock(18906, corpus, { end, treeHeightOffset: 1 });
  const prefix = join(mkdtempSync(join(tmpdir(), 'kb-')), 'r');
  try {
    await assert.rejects(() => saveRange('http://127.0.0.1:18906', start, start + count - 1, prefix, { ownMock: true }), /asked for the tree/);
  } finally {
    server.close();
  }
});

test('the scripts run from a path with a space', async () => {
  const { execFileSync } = await import('node:child_process');
  const { cpSync } = await import('node:fs');
  const d = join(mkdtempSync(join(tmpdir(), 'kb ')), 'a b');
  cpSync(fileURLToPath(new URL('..', import.meta.url)), d, { recursive: true, filter: (p) => !/(target|node_modules|\.git|pkg|corpus)$/.test(p) });
  mkdirSync(join(d, 'results'), { recursive: true });
  writeFileSync(join(d, 'results', 'x.json'), JSON.stringify({ results: [run(fast)] }));
  assert.match(execFileSync('node', [join(d, 'scripts', 'summarize.mjs'), join(d, 'results'), '--commit', 'abcdef1']).toString(), /prove-n2/);
  const { serve } = await import(pathToFileURL(join(d, 'scripts', 'serve.mjs')).href);
  const sv = await serve(18908);
  const page = await fetch('http://127.0.0.1:18908/index.html');
  sv.close();
  assert.equal(page.status, 200);
  writeFileSync(join(d, 'k.txt'), 'uview1' + 'q'.repeat(40));
  assert.throws(() => execFileSync('node', [join(d, 'scripts', 'check-no-keys.mjs'), d], { stdio: 'pipe' }));
});

test('the policy header and the meta tag say the same, and a worker gets the header', async () => {
  const { serve, CSP } = await import('../scripts/serve.mjs');
  const s = await serve(18907);
  const r = await fetch('http://127.0.0.1:18907/worker.js');
  s.close();
  assert.equal(r.headers.get('content-security-policy'), CSP);
  for (const f of ['index.html', 'threads.html']) assert.ok(readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8').includes(CSP), f);
  assert.ok(readFileSync(new URL('../web/coi-sw.js', import.meta.url), 'utf8').includes(CSP));
});

test('a viewing key that is not the published one is found', () => {
  const d = mkdtempSync(join(tmpdir(), 'kb-'));
  const planted = 'uview1' + 'q'.repeat(40);
  for (const p of ['uviewregtest1', 'uivk1', 'uvf1', 'uvi1', 'zxviews1']) {
    const e = mkdtempSync(join(tmpdir(), 'kb-'));
    writeFileSync(join(e, 'a.txt'), p + 'q'.repeat(40));
    assert.equal(scan(e).length, 1, p);
  }
  writeFileSync(join(d, 'a.json'), `{"x":"${planted}"}`);
  assert.equal(scan(d).length, 1);
  mkdirSync(join(d, 'config'));
  writeFileSync(join(d, 'config/test-vault.json'), JSON.stringify({ ufvk: planted }));
  assert.equal(scan(d).length, 0);
});

test('the repo holds no viewing key today', () => {
  assert.deepEqual(scan(fileURLToPath(new URL('..', import.meta.url))), []);
});

test('a refused start is a row of its own, and runs that were not counted are named on the line', () => {
  const lines = summarize([{ row: 'threads-refused', outcome: 'refused', device_label: 'A', user_agent: 'Chrome/1', runs_planned: 1 }]);
  assert.equal(lines.length, 1);
  assert.match(line(lines[0]), /not counted: refused/);
  const [l] = summarize([run(fast), run(fast), { ...run(fast), outcome: 'stopped' }]);
  assert.match(line(l), /not counted: stopped/);
});

// The endpoint is in the result and in the row key, and a local server is never a verdict
const form = (o = {}) => ({ threads: 'off', nthreads: '', hardwareConcurrency: 8, runs: '5', prove: false, axis: '2', pool: 'ironwood-v3', scan: true, endpoint: '', ufvk: '', filter: '', rangeKind: 'other', corpus: 'synthetic-10k.bin', start: '3000000', end: '3000099', ...o });
test('a live row records the endpoint it asked, and a replay records none', async () => {
  const { planRows } = await import('../web/plan.mjs');
  const [live] = planRows(form({ endpoint: ' https://lwd.example:9067 ' })).rows;
  assert.equal(live.endpoint, 'https://lwd.example:9067');
  assert.equal(live.job.live.endpoint, 'https://lwd.example:9067');
  assert.equal(planRows(form()).rows[0].endpoint, null);
});

test('runs from two endpoints never merge into one row', () => {
  const a = fiveScan({ endpoint: HOSTED });
  const b = fiveScan({ endpoint: HOSTED_GLOBAL, total_ms: 40000 });
  const lines = summarize([...a, ...b]);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((l) => l.verdict).sort(), ['fail', 'pass']);
});

test('a live row against this machine is never a verdict', () => {
  for (const endpoint of ['http://localhost:8090', 'http://127.0.0.1:9067', 'http://[::1]:9067', 'https://mock.localhost', 'http://0.0.0.0:1']) {
    assert.match(summarize(fiveScan({ endpoint }))[0].verdict, /local endpoint, not a verdict/, endpoint);
  }
  assert.equal(summarize(fiveScan({ endpoint: HOSTED }))[0].verdict, 'pass');
  assert.match(summarize(fiveScan({ endpoint: undefined }))[0].verdict, /^REFUSED: .*endpoint is not recorded/);
});

// Sessions never merge, and a verdict row needs five ok runs
test('runs from two sessions are two rows', () => {
  const a = five({ ...fast, session_id: 'A' });
  const b = five({ ...fast, session_id: 'B' });
  assert.equal(summarize([...a, ...b]).length, 2);
  const lines = summarize([...b, { ...run(fast), session_id: 'A', outcome: 'stopped' }], { session: 'B' });
  assert.equal(lines.length, 2);
  assert.equal(lines.find((l) => /session B/.test(l.row)).verdict, 'pass');
});

// One verdict session per row. A second try of the same row on the same device is shown, never left to be picked.
test('a verdict row with runs from more than one session is refused unless the report names the session', () => {
  const failing = five({ ...fast, key_build_ms: 111000, prove_ms: 130000, session_id: 'S1' });
  const passing = five({ ...fast, session_id: 'S2' });
  const both = [...failing, ...passing];
  const verdicts = (opts) => Object.fromEntries(summarize(both, opts).map((l) => [l.row.match(/session (\w+)/)[1], l.verdict]));
  const refused = 'REFUSED: more than one session in this row; name the one that carries the verdict with --session <id>';
  assert.deepEqual(verdicts({}), { S1: refused, S2: refused });
  assert.deepEqual(verdicts({ session: 'S2' }), { S1: 'not the named session, not a verdict', S2: 'pass' });
  assert.deepEqual(verdicts({ session: 'S1' }), { S1: 'fail', S2: 'not the named session, not a verdict' });
  assert.deepEqual(verdicts({ session: 'S9' }), { S1: 'not the named session, not a verdict', S2: 'not the named session, not a verdict' });
  // One session, or two sessions that are different rows (another device, another pool), need no naming.
  assert.equal(summarize(passing)[0].verdict, 'pass');
  assert.deepEqual(summarize([...passing, ...five({ ...fast, device_label: 'other phone', session_id: 'S3' })]).map((l) => l.verdict), ['pass', 'pass']);
  // A row that carries no verdict anyway is not refused for its sessions.
  assert.deepEqual(summarize([...five({ ...fast, row: 'prove-n24', session_id: 'S1' }), ...five({ ...fast, row: 'prove-n24', session_id: 'S2' })]).map((l) => l.verdict), ['no bar', 'no bar']);
});

test('the script takes --session, says which session it judged, and refuses a session it cannot find', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-i2-'));
  const results = [...five({ ...fast, session_id: 'S1' }), ...five({ ...fast, session_id: 'S2' })];
  writeFileSync(join(dir, 'a.json'), JSON.stringify({ results }));
  const { spawnSync } = await import('node:child_process');
  const go = (...extra) => spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/summarize.mjs', import.meta.url)), dir, '--commit', 'abcdef1', ...extra], { encoding: 'utf8' });
  assert.match(go().stdout, /REFUSED: more than one session/);
  const named = go('--session', 'S2');
  assert.equal(named.status, 0);
  assert.match(named.stdout, /session S2 .*\| pass/);
  assert.match(named.stdout, /session S1 .*not the named session/);
  const none = go('--session', 'nope');
  assert.equal(none.status, 2);
  assert.match(none.stderr, /no run of session nope/);
});

test('a verdict row with fewer than five ok runs says it is short, with no pass or fail', async () => {
  const { MIN_VERDICT_RUNS } = await import('../web/summarize-core.mjs');
  assert.equal(MIN_VERDICT_RUNS, 5);
  for (const n of [1, 2, 4]) {
    const runs = five({ ...fast, runs_planned: n }).slice(0, n);
    const [l] = summarize(runs);
    assert.match(l.verdict, new RegExp(`^short: ${n} of 5 ok runs, no verdict`), `${n} runs`);
  }
  assert.match(summarize(fiveScan({ runs_planned: 3 }).slice(0, 3))[0].verdict, /^short: 3 of 5/);
  assert.equal(summarize(five(fast))[0].verdict, 'pass');
});

test('the script applies the same minimum', async () => {
  const { execFileSync } = await import('node:child_process');
  const d = mkdtempSync(join(tmpdir(), 'kb-min-'));
  writeFileSync(join(d, 'x.json'), JSON.stringify({ results: five({ ...fast, runs_planned: 2 }).slice(0, 2) }));
  const out = execFileSync('node', [fileURLToPath(new URL('../scripts/summarize.mjs', import.meta.url)), d, '--commit', 'abcdef1']).toString();
  assert.match(out, /short: 2 of 5 ok runs/);
  assert.doesNotMatch(out, /\| pass|\| fail/);
});

// Clear keeps a trail
test('clearing runs moves them to a trail that the summary and the JSON still show, and never counts them', async () => {
  const { clearRuns, loadCleared, exportJson } = await import('../web/runs.js');
  const { clearedLines } = await import('../web/summarize-core.mjs');
  const st = memStore();
  const kept = [run(fast), { ...run(fast), outcome: 'killed' }];
  const left = clearRuns(st, kept, '2026-11-09T10:00:00.000Z');
  assert.deepEqual(left, []);
  const trail = loadCleared(st);
  assert.equal(trail.length, 2);
  assert.deepEqual(trail.map((t) => [t.run.outcome, t.cleared_at]), [['ok', '2026-11-09T10:00:00.000Z'], ['killed', '2026-11-09T10:00:00.000Z']]);
  // a second Clear adds to the trail, it does not replace it
  clearRuns(st, [run(fast)], '2026-11-09T11:00:00.000Z');
  assert.equal(loadCleared(st).length, 3);
  const out = JSON.parse(exportJson([], loadCleared(st)));
  assert.equal(out.results.length, 0);
  assert.equal(out.cleared.length, 3);
  assert.match(clearedLines(loadCleared(st)).join('\n'), /3 runs cleared, never counted: ok 2, killed 1/);
  assert.deepEqual(clearedLines([]), []);
  assert.equal(summarize(out.results).length, 0);
});

test('the script prints the cleared runs it finds and does not count them', async () => {
  const { execFileSync } = await import('node:child_process');
  const d = mkdtempSync(join(tmpdir(), 'kb-clr-'));
  writeFileSync(join(d, 'x.json'), JSON.stringify({ results: five(fast), cleared: [{ cleared_at: 't', run: { ...run(fast), outcome: 'killed' } }] }));
  const out = execFileSync('node', [fileURLToPath(new URL('../scripts/summarize.mjs', import.meta.url)), d, '--commit', 'abcdef1']).toString();
  assert.match(out, /1 runs cleared, never counted: killed 1/);
  assert.match(out, /FAIL: runs missing or killed \(cleared\) \| cleared: killed 1/, 'the dead run still marks its own row');
});

// Temperature, before and after, a named ceiling, and a host-side battery log
const timed = (t, o = {}) => run({ ...fast, session_id: 'S', runs_planned: 6, ...o, temp_before: t, order_in_session: o.order_in_session ?? ++orderNo });
let orderNo = 0;
test('a run that started above the ceiling is marked and kept out of the median', async () => {
  const { HOT_START_ABSOLUTE_C, HOT_START_OVER_FIRST_C } = await import('../web/summarize-core.mjs');
  assert.deepEqual([HOT_START_ABSOLUTE_C, HOT_START_OVER_FIRST_C], [35, 2]);
  orderNo = 0;
  const runs = [timed('30.5'), timed('31'), timed('41', { key_build_ms: 90000, prove_ms: 90000 }), timed('31'), timed('32'), timed('30')];
  const [l] = summarize(runs);
  assert.equal(l.median_ms, 2000);
  assert.equal(l.runs.length, 5);
  assert.match(l.excluded[0], /hot start: 41 C over 32.5 C/);
  assert.equal(l.verdict, 'pass');
  assert.match(line(l), /excluded from the median: hot start: 41 C/);
});

test('a run counts only at or below 35 C and within 2 C of the first reading of its session', () => {
  const hot = (first, later) => { orderNo = 0; return summarize([timed(first), timed(later), timed('20'), timed('20'), timed('20'), timed('20')])[0].excluded.length; };
  assert.equal(hot('30', '32'), 0);
  assert.equal(hot('30', '32.1'), 1, 'two degrees over the first reading');
  assert.equal(hot('33', '35'), 0, 'at the absolute ceiling');
  assert.equal(hot('34', '36'), 1, 'over 35 is out, the first at 34 is in');
  assert.equal(hot('30,5 C', '30,5 C'), 0, 'a comma and a unit are read');
  assert.equal(hot('33,5', '34'), 0);
});

test('a session that starts hot counts nothing: five runs at 41 C are short, not a pass', () => {
  orderNo = 0;
  const l = summarize(Array.from({ length: 5 }, () => timed('41', { runs_planned: 5 })))[0];
  assert.equal(l.excluded.length, 5);
  assert.match(l.verdict, /^short: 0 of 5/);
  orderNo = 0;
  assert.match(summarize([timed('36', { runs_planned: 5 }), ...Array.from({ length: 4 }, () => timed('36.5', { runs_planned: 5 }))])[0].verdict, /^short: 0 of 5/);
});

test('an empty or unreadable temperature on a verdict row keeps that run out of the median', () => {
  for (const t of ['', undefined, 'hot', '91 F']) {
    orderNo = 0;
    const runs = [timed('30'), timed('30'), timed(t), timed('30'), timed('30'), timed('30')];
    const [l] = summarize(runs);
    assert.deepEqual(l.excluded, ['temperature not recorded'], String(t));
    assert.equal(l.runs.length, 5);
  }
  orderNo = 0;
  const noBar = summarize([timed('', { row: 'prove-n24', runs_planned: 1 })])[0];
  assert.deepEqual(noBar.excluded, [], 'a row with no bar is not judged on temperature');
});

test('a run with too few counted runs left is short, not a pass', () => {
  orderNo = 0;
  const [l] = summarize([timed('30'), timed('45'), timed('30'), timed('30'), timed('30')].map((r) => ({ ...r, runs_planned: 5 })));
  assert.match(l.verdict, /^short: 4 of 5/);
});

test('a result records the temperature after the run as well as before', async () => {
  const { finishRecord } = await import('../web/runs.js');
  const r = finishRecord({ row: 'prove-n2', temp_before: '31' }, { outcome: 'ok' }, { tempText: ' 34.2 ', now: '2026-11-09T10:00:00.000Z', elapsed_ms: 5 });
  assert.deepEqual([r.temp_before, r.temp_after, r.temp_after_at, r.elapsed_ms], ['31', '34.2', '2026-11-09T10:00:00.000Z', 5]);
  assert.equal(finishRecord({}, {}, { tempText: '', now: 't', elapsed_ms: 1 }).temp_after, null);
});

test('the battery log reads the first temperature line only and tenths of a degree', async () => {
  const { parseBattery, logLine } = await import('../scripts/battery-log.mjs');
  const text = `Current Battery Service state:
  AC powered: false
  USB powered: true
  Wireless powered: false
  Dock powered: false
  status: 2
  health: 2
  present: true
  level: 87
  scale: 100
  voltage: 4123
  temperature: 309
  technology: Li-ion
01-01 12:00:00.000 I/ThermalService: temperature: 999 throttling
  temperature: 777
`;
  assert.deepEqual(parseBattery(text), { level: 87, temperature_c: 30.9, charging: true });
  assert.equal(parseBattery(text.replace('USB powered: true', 'USB powered: false')).charging, false);
  assert.equal(parseBattery('nothing useful here'), null);
  assert.equal(logLine(parseBattery(text), '2026-11-09T10:00:00.000Z'), '2026-11-09T10:00:00.000Z level=87 temperature_c=30.9 charging=true');
});

// The build stamp, for the wasm and for the page's own script
test('a result built from another commit than the report names is refused, a matching one is not', () => {
  const old = five({ ...fast, harness_commit: '131aa75', js_commit: '131aa75' });
  assert.match(summarize(old, { commit: '97e253d' })[0].verdict, /^REFUSED: .*not the commit the report names/);
  assert.equal(summarize(old, { commit: '131aa75' })[0].verdict, 'pass');
  assert.equal(summarize(old, { commit: '131aa75e0f' })[0].verdict, 'pass', 'a full hash names the short one');
  assert.match(summarize(old, { commit: '131aa75-dirty' })[0].verdict, /^REFUSED/);
  assert.equal(summarize(old)[0].verdict, 'pass', 'no commit named, nothing to compare to');
});

test('the page script must be stamped, and stamped as the wasm is', () => {
  assert.match(summarize(five({ ...fast, js_commit: undefined }))[0].verdict, /page script is not identified/);
  assert.match(summarize(five({ ...fast, js_commit: 'abcdef2' }))[0].verdict, /page script and the wasm are from different builds/);
  assert.match(summarize(five({ ...fast, js_files_match: false }))[0].verdict, /page script is not the one that was stamped/);
  assert.match(summarize(five({ ...fast, js_commit: 'abcdef3' }), { commit: 'abcdef3' })[0].verdict, /wasm.*not the commit/);
});

test('the stamp script hashes the page files, and the page can tell an edited one', async () => {
  const { execFileSync } = await import('node:child_process');
  const { readJsStamp, STAMPED } = await import('../web/stamp.mjs');
  const web = mkdtempSync(join(tmpdir(), 'kb-stamp-'));
  for (const f of STAMPED) writeFileSync(join(web, f), `// ${f}\n`);
  execFileSync('node', [fileURLToPath(new URL('../scripts/stamp-js.mjs', import.meta.url)), '97e253d', web]);
  const fetchFrom = (dir) => async (u) => { const b = readFileSync(join(dir, u.replace(/^\.\//, ''))); return { ok: true, json: async () => JSON.parse(b), arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) }; };
  const digest = async (buf) => new Uint8Array((await import('node:crypto')).createHash('sha256').update(new Uint8Array(buf)).digest());
  assert.deepEqual(await readJsStamp(fetchFrom(web), digest), { js_commit: '97e253d', js_files_match: true });
  writeFileSync(join(web, 'app.js'), '// edited\n');
  assert.deepEqual(await readJsStamp(fetchFrom(web), digest), { js_commit: '97e253d', js_files_match: false });
  assert.deepEqual(await readJsStamp(async () => ({ ok: false }), digest), { js_commit: 'unknown', js_files_match: false });
});

test('the script takes the commit the report names and fails when a result is from another', async () => {
  const { spawnSync } = await import('node:child_process');
  const d = mkdtempSync(join(tmpdir(), 'kb-commit-'));
  writeFileSync(join(d, 'x.json'), JSON.stringify({ results: five({ ...fast, harness_commit: '131aa75', js_commit: '131aa75' }) }));
  const bin = fileURLToPath(new URL('../scripts/summarize.mjs', import.meta.url));
  const bad = spawnSync('node', [bin, d, '--commit', '97e253d']);
  assert.match(bad.stdout.toString(), /not the commit the report names/);
  assert.equal(bad.status, 1);
  const good = spawnSync('node', [bin, d, '--commit', '131aa75']);
  assert.equal(good.status, 0);
  assert.match(good.stdout.toString(), /\| pass/);
  assert.equal(spawnSync('node', [bin, d]).status, 2);
});

// Progress is the stage and the seconds, nothing invented, and the worker's messages are unchanged
test('progress text is the stage number of the stages the job has, and the seconds so far', async () => {
  const { stagesFor, progressText } = await import('../web/progress.mjs');
  const prove = { kind: 'prove' };
  const replay = { kind: 'scan', corpus: './corpus/x' };
  const live = { kind: 'scan', live: { endpoint: 'https://x' } };
  assert.deepEqual(stagesFor(prove), ['key', 'prepare', 'prove', 'verify']);
  assert.deepEqual(stagesFor(replay), ['decode', 'decrypt', 'tree', 'witness']);
  assert.deepEqual(stagesFor(live), ['lightd-info', 'tree-state', 'download', 'decode', 'decrypt', 'tree', 'witness']);
  assert.equal(progressText('prove', prove, 12500), 'stage 3 of 4 (prove), 12 s');
  assert.equal(progressText('starting', prove, 400), 'starting, 0 s');
  assert.equal(progressText('download', live, 61000), 'stage 3 of 7 (download), 61 s');
});

test('the worker says exactly the stages the progress text counts, and no other kind of message', async () => {
  const { stagesFor } = await import('../web/progress.mjs');
  const src = readFileSync(new URL('../web/worker.js', import.meta.url), 'utf8');
  const said = [...new Set([...src.matchAll(/say\(\{ stage: '([\w-]+)'/g), ...src.matchAll(/timed\('([\w-]+)'/g)].map((m) => m[1]))].sort();
  const all = [...new Set([{ kind: 'prove' }, { kind: 'scan', corpus: 'x' }, { kind: 'scan', live: {} }].flatMap(stagesFor))].sort();
  assert.deepEqual(said, all);
  assert.deepEqual([...new Set([...src.matchAll(/say\(\{ (\w+)/g)].map((m) => m[1]))].sort(), ['done', 'failed', 'stage']);
});

test('every script the page loads is in the stamp', async () => {
  const { STAMPED } = await import('../web/stamp.mjs');
  const dir = fileURLToPath(new URL('../web/', import.meta.url));
  assert.deepEqual([...STAMPED].sort(), readdirSync(dir).filter((f) => /\.(m?js)$/.test(f)).sort());
});

// A worker that dies without a message, and a page that goes hidden during a run
test('a worker error with no message says what it knows instead of undefined', async () => {
  const { workerErrorReason, describeThrown } = await import('../web/errors.mjs');
  const bare = workerErrorReason({ type: 'error' }, 'hidden');
  assert.doesNotMatch(bare, /undefined/);
  assert.match(bare, /worker died without a message/);
  assert.match(bare, /event type error/);
  assert.match(bare, /page was hidden/);
  assert.match(workerErrorReason({ type: 'error', filename: 'http://x/worker.js', lineno: 12, colno: 3 }, 'visible'), /worker\.js:12/);
  assert.match(workerErrorReason({ type: 'error' }, 'visible'), /page was visible/);
  assert.match(workerErrorReason({ type: 'error', message: 'Uncaught boom' }, 'visible'), /^Uncaught boom/);
  assert.equal(describeThrown(undefined), 'the worker threw undefined');
  assert.equal(describeThrown(null), 'the worker threw null');
  assert.equal(describeThrown(new Error('x')), 'x');
  assert.equal(describeThrown('s'), 's');
});

test('a page that went hidden during a run is noticed, marked, and kept out of the median', async () => {
  const { watchHidden } = await import('../web/errors.mjs');
  const { finishRecord } = await import('../web/runs.js');
  const mk = () => { const l = {}; return { visibilityState: 'visible', addEventListener: (t, f) => { l[t] = f; }, removeEventListener: (t) => { delete l[t]; }, fire: (t) => l[t]?.(), l }; };
  const doc = mk(), win = mk();
  const w = watchHidden(doc, win);
  doc.fire('visibilitychange');
  assert.equal(w.hidden(), false, 'a change to visible is not hidden');
  doc.visibilityState = 'hidden';
  doc.fire('visibilitychange');
  assert.equal(w.hidden(), true);
  w.stop();
  assert.deepEqual([Object.keys(doc.l), Object.keys(win.l)], [[], []]);
  const w2 = watchHidden(mk(), win);
  win.fire('pagehide');
  assert.equal(w2.hidden(), true);
  assert.equal(watchHidden({ ...mk(), visibilityState: 'hidden' }, mk()).hidden(), true, 'already hidden at the start');
  const r = finishRecord({}, { outcome: 'ok' }, { tempText: '', now: 't', elapsed_ms: 1, hidden: true });
  assert.deepEqual([r.page_hidden_during_run, r.reason], [true, 'page hidden during run']);
  assert.equal(finishRecord({}, {}, { tempText: '', now: 't', elapsed_ms: 1, hidden: false }).page_hidden_during_run, false);
  orderNo = 0;
  const runs = [timed('30'), timed('30'), timed('30', { page_hidden_during_run: true, key_build_ms: 90000 }), timed('30'), timed('30'), timed('30')];
  const [l] = summarize(runs);
  assert.equal(l.runs.length, 5);
  assert.equal(l.median_ms, 2000);
  assert.deepEqual(l.excluded, ['page hidden during run']);
});

// A link fills the form and never a key; class 'other' cannot hide a fail
test('query parameters prefill the form, are shown, and a viewing key is refused', async () => {
  const { parsePrefill } = await import('../web/prefill.mjs');
  const p = parsePrefill('?device=A72%206GB&class=phone&runs=5&threads=off&prove=1&scan=0&pool=ironwood-v3&outputs=2,4&corpus=synthetic-10k.bin&endpoint=http%3A%2F%2Flocalhost%3A1234&start=3000000&end=3000099');
  assert.deepEqual(p.fields, { device: 'A72 6GB', 'device-class': 'phone', runs: '5', threads: 'off', 'do-prove': true, 'do-scan': false, pool: 'ironwood-v3', axis: '2,4', corpus: 'synthetic-10k.bin', endpoint: 'http://localhost:1234', start: '3000000', end: '3000099' });
  assert.deepEqual([p.refused, p.ignored, p.invalid], [[], [], []]);
  const k = parsePrefill('?ufvk=uview1abc&viewing_key=x&seed=y&device=A14&mystery=1&class=toaster&runs=0&corpus=../../etc/passwd&endpoint=javascript%3Aalert(1)');
  assert.deepEqual(k.fields, { device: 'A14' });
  assert.deepEqual(k.refused.sort(), ['seed', 'ufvk', 'viewing_key']);
  assert.deepEqual(k.ignored, ['mystery']);
  assert.deepEqual(k.invalid.sort(), ['class', 'corpus', 'endpoint', 'runs']);
  assert.ok(!JSON.stringify(k).includes('uview1abc'), 'the value of a refused parameter is never kept');
  assert.deepEqual(parsePrefill('').fields, {});
});

test('the page shows what a link filled, has no key field in the map, and a link starts nothing', async () => {
  const { PARAM_FIELDS } = await import('../web/prefill.mjs');
  assert.ok(!Object.values(PARAM_FIELDS).includes('ufvk'));
  for (const f of ['index.html', 'threads.html']) assert.match(readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8'), /id="prefill"/);
  const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  assert.match(app, /parsePrefill\(location\.search\)/);
  // the only place a run starts is the click on Run
  assert.deepEqual([...app.matchAll(/runAll\(/g)].length, 1);
  assert.match(app, /\$\('go'\)\.onclick = runAll/);
});

test("class 'other' on a row that has a bar is refused, never 'no bar'", () => {
  assert.match(summarize(five({ ...fast, key_build_ms: 350000, device_class: 'other' }))[0].verdict, /^REFUSED: class other hides the bar/);
  assert.match(summarize(fiveScan({ device_class: 'other' }))[0].verdict, /^REFUSED: class other hides the bar/);
  assert.equal(summarize(five({ ...fast, row: 'prove-n24', device_class: 'other' }))[0].verdict, 'no bar');
  assert.equal(summarize(five({ ...fast, pool: 'orchard-v2', device_class: 'other' }))[0].verdict, 'no bar');
  assert.equal(summarize(fiveScan({ device_class: 'other', live_or_replay_asked: 'replay' }))[0].verdict, 'no bar', 'a replay has no verdict either way');
});


// A key can ride in a value; one rule for what looks like a key, shared with check-no-keys
const KEYISH = 'uview1' + 'q'.repeat(30);
test('a key inside a parameter value is refused, whatever the name', async () => {
  const { parsePrefill } = await import('../web/prefill.mjs');
  for (const q of [`endpoint=${encodeURIComponent(`https://x.example/?ufvk=${KEYISH}`)}`, `view=${KEYISH}`, `u=${KEYISH}`, `vk1=${KEYISH}`, `sk=abc`, `device=${KEYISH}`, `private=1`, `device=${encodeURIComponent(encodeURIComponent(KEYISH))}`]) {
    const p = parsePrefill(`?${q}`);
    assert.deepEqual(p.fields, {}, q);
    assert.equal(p.refused.length + p.invalid.length, 1, q);
    assert.ok(!JSON.stringify(p).includes(KEYISH), q);
  }
});

test('the key rule is one implementation, used by the scanner and the prefill', async () => {
  const { looksLikeKey, KEY } = await import('../web/keys.mjs');
  assert.equal(looksLikeKey(KEYISH), true);
  assert.equal(looksLikeKey('A72 6GB'), false);
  assert.equal(looksLikeKey(KEYISH), true, 'no state between calls');
  assert.equal(scan === undefined, false);
  const d = mkdtempSync(join(tmpdir(), 'kb-k-'));
  writeFileSync(join(d, 'a.txt'), `x ${KEYISH} y`);
  assert.equal(scan(d).length, 1);
  assert.ok(KEY instanceof RegExp);
  const src = readFileSync(new URL('../scripts/check-no-keys.mjs', import.meta.url), 'utf8') + readFileSync(new URL('../web/prefill.mjs', import.meta.url), 'utf8');
  assert.equal((src.match(/uview\|uivk/g) ?? []).length, 0, 'the pattern is written once, in keys.mjs');
});

test('an endpoint is a bare origin and nothing else', async () => {
  const { bareOrigin } = await import('../web/endpoint.mjs');
  const { parsePrefill } = await import('../web/prefill.mjs');
  const { planRows } = await import('../web/plan.mjs');
  assert.equal(bareOrigin('https://ZEC.rocks:443/'), 'https://zec.rocks');
  assert.equal(bareOrigin('https://lwd.example:9067'), 'https://lwd.example:9067');
  for (const bad of ['https://x/path', 'https://x/?a=1', 'https://x/#f', 'https://u:p@x/', 'ftp://x', 'x.example:443', '', 'javascript:alert(1)']) {
    assert.equal(bareOrigin(bad), null, bad);
    if (bad) assert.deepEqual(parsePrefill(`?endpoint=${encodeURIComponent(bad)}`).fields, {}, bad);
  }
  assert.throws(() => planRows(form({ endpoint: 'https://x.example/?ufvk=a' })), /bare origin/);
  assert.equal(planRows(form({ endpoint: ' https://X.example/ ' })).rows[0].endpoint, 'https://x.example');
});

test('every parameter that was not applied leaves the address bar', async () => {
  const { stripUnapplied } = await import('../web/prefill.mjs');
  assert.equal(stripUnapplied('?device=A72&view=secret&mystery=1&class=toaster&runs=5', { device: 'A72', runs: '5' }), '?device=A72&runs=5');
  assert.equal(stripUnapplied('?ufvk=x', {}), '');
  assert.equal(stripUnapplied('', {}), '');
});


// The wiring of a run (hidden watch, clock, temperature after) is one module the page uses, so a test can fail it
test('a tracked run records the page being hidden, the clock and the temperature at its end', async () => {
  const { trackRun } = await import('../web/runner.mjs');
  const ev = () => { const l = {}; return { visibilityState: 'visible', addEventListener: (t, f) => { l[t] = f; }, removeEventListener: (t) => { delete l[t]; }, fire: (t) => l[t]?.(), l }; };
  const mk = (hideIt) => {
    const doc = ev(), win = ev(), shown = []; let clock = 1000, tick; let timers = 0;
    const t = trackRun({ row: { row: 'prove-n2', run_index: 2, runs_planned: 5 }, job: { kind: 'prove' }, doc, win, perf: () => clock, now: () => 'T', readTemp: () => ' 33,0 ', show: (x) => shown.push(x), setTimer: (f) => { tick = f; timers++; return 7; }, clearTimer: (h) => { timers -= h === 7 ? 1 : 0; } });
    t.stage('prove');
    clock += 12500; tick();
    if (hideIt) { doc.visibilityState = 'hidden'; doc.fire('visibilitychange'); }
    clock += 500;
    const r = t.finish({ outcome: 'ok' });
    return { r, shown, timers, doc, win };
  };
  const seen = mk(false);
  assert.deepEqual([seen.r.page_hidden_during_run, seen.r.temp_after, seen.r.elapsed_ms, seen.r.temp_after_at, seen.r.outcome], [false, '33,0', 13000, 'T', 'ok']);
  assert.match(seen.shown.at(-1), /prove-n2 run 2 of 5: stage 3 of 4 \(prove\), 12 s/);
  assert.equal(seen.timers, 0, 'the clock is stopped');
  assert.deepEqual([Object.keys(seen.doc.l), Object.keys(seen.win.l)], [[], []], 'the listeners are removed');
  const hid = mk(true);
  assert.deepEqual([hid.r.page_hidden_during_run, hid.r.reason], [true, 'page hidden during run']);
});

test('the page builds every run record through the tracker', () => {
  const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  assert.match(app, /import \{[^}]*trackRun[^}]*\} from '\.\/runner\.mjs'/);
  assert.ok(!/finishRecord|watchHidden/.test(app), 'the wiring is not repeated in app.js');
});

test('a verdict row whose runs do not say whether the page was hidden is refused', () => {
  assert.match(summarize(five({ ...fast, page_hidden_during_run: undefined }))[0].verdict, /^REFUSED: .*page visibility during the run is not recorded/);
  assert.equal(summarize(fiveScan({ live_or_replay_asked: 'replay', page_hidden_during_run: undefined }))[0].verdict, 'replay, not a verdict');
});

test("class 'other' with a dead run is refused, never 'incomplete'", () => {
  const runs = [...five({ ...fast, device_class: 'other' }).slice(0, 4), { ...run({ ...fast, device_class: 'other' }), outcome: 'killed' }];
  assert.match(summarize(runs)[0].verdict, /^REFUSED: class other hides the bar/);
  assert.match(summarize([...fiveScan({ device_class: 'other' }).slice(0, 4), { ...scanRun({ device_class: 'other' }), outcome: 'killed' }])[0].verdict, /^REFUSED: class other/);
});

test('more ok runs than planned in one session is refused, never a pass', () => {
  const slow = five({ key_build_ms: 150000, prove_ms: 151000, session_id: 'S' });
  const quick = five({ ...fast, session_id: 'S' });
  const [l] = summarize([...slow, ...quick]);
  assert.match(l.verdict, /^REFUSED: more runs than planned/);
});

test('a verdict needs an endpoint the table names as a verdict, compared as an origin', () => {
  for (const endpoint of ['https://lwd.example', 'https://my-tunnel.ngrok.app', 'http://192.168.1.5:9067', 'https://m1-hosted.example.evil.example', 'm1-hosted.example:443', 'https://m1-hosted.example:9067']) {
    assert.equal(summarize(fiveScan({ endpoint }))[0].verdict, 'endpoint not named by the protocol, not a verdict', endpoint);
  }
  assert.match(summarize(fiveScan({ endpoint: 'http://localhost:8090' }))[0].verdict, /local endpoint/);
  for (const endpoint of [HOSTED, 'https://M1-HOSTED.example:443/', HOSTED_GLOBAL]) assert.equal(summarize(fiveScan({ endpoint }))[0].verdict, 'pass', endpoint);
  assert.equal(summarize([...fiveScan({ endpoint: `${HOSTED}:443` }), ...fiveScan({ endpoint: 'https://M1-HOSTED.example/' })]).length, 1, 'one server, one row');
});

// The table is read before the local check
test('a pipeline proxy reads "pipeline proxy, not a verdict" and another local address still reads "local endpoint"', () => {
  for (const endpoint of ['http://localhost:1234', 'http://localhost:1235', 'http://localhost:1244']) {
    assert.equal(summarizeReal(fiveScan({ endpoint, ...declaredFor(endpoint) }))[0].verdict, 'pipeline proxy, not a verdict', endpoint);
  }
  for (const endpoint of ['http://localhost:9999', 'http://127.0.0.1:1234']) assert.match(summarizeReal(fiveScan({ endpoint }))[0].verdict, /^local endpoint, not a verdict$/, endpoint);
});

test('the public endpoints, direct, are not named by the table: no verdict', () => {
  for (const endpoint of ['https://zec.rocks', 'https://zec.global', 'https://zec.rocks:443']) {
    assert.equal(summarizeReal(fiveScan({ endpoint }))[0].verdict, 'endpoint not named by the protocol, not a verdict', endpoint);
  }
});

test('a verdict entry with no hostname gives no verdict, and nothing but the two hosted proxies is verdict-ready', () => {
  const placeholder = { origin: null, hostname: null, via: 'proxy', role: 'verdict', upstream: 'zec.rocks:443', files: {}, platform: null, edge_tls: null, region: null, image_digest: null };
  assert.equal(verdictReady(placeholder), false);
  assert.equal(findEndpoint(null), null);
  for (const endpoint of ['https://m1-hosted.example', 'https://zec.rocks', 'http://localhost:1234', null]) {
    assert.doesNotMatch(summarizeReal(fiveScan({ endpoint: endpoint ?? undefined }))[0].verdict, /^(pass|fail)$/, String(endpoint));
  }
  const ready = ENDPOINTS.filter(verdictReady).map(originOf);
  assert.deepEqual(ready, ['https://m1-rocks.konclave.xyz', 'https://m1-global.konclave.xyz']);
  assert.deepEqual(ENDPOINTS.filter((e) => !verdictReady(e)).map((e) => e.role), ['pipeline', 'pipeline', 'pipeline']);
});

// The shipped table: a live row through a hosted origin is judged on the range and the key, not on the endpoint
test('a live row through a hosted origin of the shipped table is not "endpoint not named by the protocol": it is judged on the range, then the key', () => {
  for (const [origin, upstream] of [['https://m1-rocks.konclave.xyz', 'zec.rocks:443'], ['https://m1-global.konclave.xyz', 'zec.global:443']]) {
    const rows = fiveScan({ endpoint: origin, ...declaredFor(origin) });
    assert.equal(rows[0].upstream_declared, upstream);
    // The shipped ranges have no heights yet: the range is what stops the row, with its own reason.
    assert.equal(summarizeReal(rows)[0].verdict, 'range not fixed by the protocol, not a verdict', origin);
    // With a range that is fixed, the key decides: the synthetic key is no verdict, the published one is a pass.
    const withRanges = (r, o = {}) => summarizeWith(r, { ranges: TEST_RANGES, publishedKey: TEST_PUBLISHED, ...o })[0].verdict;
    assert.equal(withRanges(rows), 'pass', origin);
    assert.match(withRanges(fiveScan({ endpoint: origin, ...declaredFor(origin), key_sha256: undefined })), /not a verdict/, origin);
    // A forged origin next to it is still not named.
    assert.equal(withRanges(fiveScan({ endpoint: `${origin}.evil.example` })), 'endpoint not named by the protocol, not a verdict');
  }
});

test('a direct entry can be a verdict once the table names it; a pipeline entry never is', () => {
  const direct = { origin: 'https://lwd.operator.example', hostname: 'lwd.operator.example', via: 'direct', role: 'verdict', upstream: 'lwd.operator.example:443', files: {} };
  const table = [...TEST_TABLE, direct];
  const rows = fiveScan({ endpoint: direct.origin, ...declaredFor(direct.origin, table) });
  assert.equal(summarizeWith(rows, { endpoints: table, ranges: TEST_RANGES, publishedKey: TEST_PUBLISHED })[0].verdict, 'pass');
  assert.equal(summarizeWith(rows, { endpoints: TEST_TABLE })[0].verdict, 'endpoint not named by the protocol, not a verdict');
});

test('a verdict row records the upstream and config the table declares, and a row without or against them is refused', () => {
  const ok = fiveScan({ endpoint: HOSTED });
  assert.equal(ok[0].upstream_declared, 'zec.rocks:443');
  assert.equal(summarize(ok)[0].verdict, 'pass');
  assert.match(summarize(fiveScan({ endpoint: HOSTED, upstream_declared: undefined }))[0].verdict, /^REFUSED: .*upstream is not the one the table declares/);
  assert.match(summarize(fiveScan({ endpoint: HOSTED, upstream_declared: 'zec.global:443' }))[0].verdict, /^REFUSED: .*upstream is not the one the table declares/);
  assert.match(summarize(fiveScan({ endpoint: HOSTED, proxy_config_declared: { 'hosted/compose.yml': 'b'.repeat(64) } }))[0].verdict, /^REFUSED: .*config is not the one the table declares/);
  // Not in the row key: the declaration is the same for every run of an endpoint.
  assert.equal(summarize([...ok, ...fiveScan({ endpoint: HOSTED, upstream_declared: 'zec.global:443' })]).length, 1);
  // A row that carries no verdict is not refused for lacking it (an old result reads "not named").
  assert.equal(summarize(fiveScan({ endpoint: 'https://zec.rocks', upstream_declared: undefined }))[0].verdict, 'endpoint not named by the protocol, not a verdict');
});

// A cleared dead run still marks its own row
test('a cleared dead run still takes the verdict from its own row, and only its own', () => {
  const dead = { ...run(fast), outcome: 'killed', session_id: 'S' };
  const cleared = [{ cleared_at: 't', run: dead }];
  const [l] = summarize(five({ ...fast, session_id: 'S' }), { cleared });
  assert.match(l.verdict, /^FAIL: runs missing or killed \(cleared\)/);
  assert.deepEqual(l.cleared, { killed: 1 });
  assert.match(line(l), /\| cleared: killed 1/);
  assert.match(summarize(five({ ...fast, session_id: 'T' }), { cleared })[0].verdict, /^REFUSED: more than one session/, 'a cleared session still counts as a session of the row');
  assert.equal(summarize(five({ ...fast, session_id: 'T', device_label: 'another phone' }), { cleared })[0].verdict, 'pass', 'another row is not touched');
  assert.match(summarize(five({ ...fast, session_id: 'S' }), { cleared: [{ cleared_at: 't', run: { ...run(fast), session_id: 'S' } }] })[0].verdict, /^REFUSED: ok runs of this row were cleared/, 'a cleared ok run is a try that was thrown away');
  const only = summarize([], { cleared });
  assert.equal(only.length, 1);
  assert.match(only[0].verdict, /\(cleared\)/);
});

// The commit the report names is checked on every row, and is required
test('a result from another commit is refused whatever else the row holds', () => {
  const old = (o = {}) => ({ ...run({ ...fast, harness_commit: '131aa75', js_commit: '131aa75', ...o }) });
  const dead = { ...old(), outcome: 'killed' };
  const l1 = summarize([...Array.from({ length: 4 }, () => old()), dead], { commit: '97e253d' })[0];
  assert.match(l1.verdict, /^REFUSED: .*not the commit the report names/);
  assert.equal(l1.commit_mismatch, true);
  const l2 = summarize([old({ harness_commit: '97e253d' }), ...Array.from({ length: 4 }, () => old({ harness_commit: '97e253d' }))], { commit: '97e253d' })[0];
  assert.match(l2.verdict, /^REFUSED: the page script is not the commit the report names/, 'the wasm matches, the script does not');
  const l3 = summarize(Array.from({ length: 5 }, () => old({ js_commit: '97e253d' })), { commit: '97e253d' })[0];
  assert.match(l3.verdict, /the wasm build is not the commit the report names/);
  assert.equal(summarize(Array.from({ length: 5 }, () => old()), { commit: '131aa75' })[0].commit_mismatch, undefined);
});

test('the script will not print a verdict without the commit the report names, and exits 1 on a mismatch of any row', async () => {
  const { spawnSync } = await import('node:child_process');
  const d = mkdtempSync(join(tmpdir(), 'kb-req-'));
  const o = (x = {}) => run({ ...fast, harness_commit: '131aa75', js_commit: '131aa75', ...x });
  writeFileSync(join(d, 'x.json'), JSON.stringify({ results: [...Array.from({ length: 4 }, () => o()), { ...o(), outcome: 'killed' }] }));
  const bin = fileURLToPath(new URL('../scripts/summarize.mjs', import.meta.url));
  const none = spawnSync('node', [bin, d]);
  assert.equal(none.status, 2);
  assert.match(none.stderr.toString(), /--commit/);
  assert.equal(none.stdout.toString(), '');
  const bad = spawnSync('node', [bin, d, '--commit', '97e253d']);
  assert.equal(bad.status, 1, 'a dead run in the row does not hide the mismatch');
});

test('the page refuses to start when its own stamp and the wasm stamp differ', async () => {
  const { stampsAgree } = await import('../web/stamp.mjs');
  const js = (o = {}) => ({ js_commit: '97e253d', js_files_match: true, ...o });
  const W = 'ab'.repeat(32);
  const meta = (o = {}) => ({ commit: '97e253d', wasm_sha256: W, glue_sha256: W, snippets_sha256: {}, ...o });
  assert.equal(stampsAgree(js(), meta()), null);
  assert.equal(stampsAgree(js({ js_commit: '97e253dabc' }), meta()), null, 'a full hash names the short one');
  assert.match(stampsAgree(js(), meta({ commit: '131aa75' })), /differ/);
  assert.match(stampsAgree(js({ js_files_match: false }), meta()), /not the stamped/);
  assert.match(stampsAgree(js({ js_commit: 'unknown' }), meta()), /not identified/);
  assert.match(stampsAgree(js(), {}), /not identified/);
  assert.equal(stampsAgree(js({ js_commit: '97e253d-dirty' }), meta({ commit: '97e253d-dirty' })), null, 'the same dirty build; the summary refuses a dirty verdict');
  assert.match(stampsAgree(js({ js_commit: '97e253d-dirty' }), meta()), /differ/);
  // The wasm is stamped by its bytes as well as by the commit.
  assert.match(stampsAgree(js(), { commit: '97e253d' }), /carries no wasm hash/);
  assert.match(stampsAgree(js(), meta({ wasm_sha256: 'xyz' })), /carries no wasm hash/);
  assert.match(stampsAgree(js(), meta({ glue_sha256: undefined })), /carries no glue hash/);
  assert.match(stampsAgree(js(), meta({ snippets_sha256: undefined })), /carries no snippets hash/);
});

const noComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');

test('the gate that stops a run on a stamp that differs is a function, and the page must act on it', async () => {
  const { startRefusal } = await import('../web/stamp.mjs');
  const js = { js_commit: '97e253d', js_files_match: true };
  const W = 'ab'.repeat(32);
  const metas = { single: { commit: '97e253d', wasm_sha256: W, glue_sha256: W, snippets_sha256: {} }, threads: { commit: '131aa75', wasm_sha256: W, glue_sha256: W, snippets_sha256: {} } };
  assert.equal(startRefusal(js, metas, 0), null);
  assert.match(startRefusal(js, metas, 1), /differ/, 'threads 1 uses the threads build, as context() does');
  assert.match(startRefusal(js, metas, 4), /differ/);
  assert.match(startRefusal({ js_commit: 'unknown', js_files_match: false }, metas, 0), /not identified/);
  assert.match(startRefusal(js, { single: {}, threads: {} }, 0), /not identified/);
  // app.js must call it and return on a reason: comments do not count
  const app = noComments(readFileSync(new URL('../web/app.js', import.meta.url), 'utf8'));
  assert.match(app, /const why = startRefusal\(jsStamp, metas, threads\);\s*if \(why\) \{[^;]*;\s*return;/);
  assert.equal(noComments('// startRefusal( x\nlet a = 1; // startRefusal(').includes('startRefusal'), false, 'the comment stripper strips');
});

test('the summary the page shows is the report summary, with the commit and the cleared trail', async () => {
  const { pageSummary } = await import('../web/summarize-core.mjs');
  const old = five({ ...fast, harness_commit: '131aa75', js_commit: '131aa75', session_id: 'S' });
  assert.match(pageSummary(old, [], { js_commit: '97e253d' }), /REFUSED: .*not the commit the report names/);
  assert.match(pageSummary(five({ ...fast, session_id: 'S' }), [], { js_commit: 'unknown' }), /\| pass/, 'an unknown stamp names no commit');
  const dead = { cleared_at: 't', run: { ...run(fast), outcome: 'killed', session_id: 'S' } };
  assert.match(pageSummary(five({ ...fast, session_id: 'S' }), [dead], { js_commit: 'abcdef1' }), /FAIL: runs missing or killed \(cleared\)[\s\S]*1 runs cleared, never counted: killed 1/);
  assert.equal(pageSummary([], [], { js_commit: 'abcdef1' }), 'No runs yet.');
  const app = noComments(readFileSync(new URL('../web/app.js', import.meta.url), 'utf8'));
  assert.match(app, /pageSummary\(results, cleared, jsStamp\)/);
});

test('dead runs are checked against the commit too, and so is a row made only of cleared ones', () => {
  const o = (x = {}) => run({ ...fast, harness_commit: '97e253d', js_commit: '97e253d', session_id: 'S', ...x });
  const oldDead = { ...o({ harness_commit: '131aa75', js_commit: '131aa75' }), outcome: 'killed' };
  const [l] = summarize([...Array.from({ length: 4 }, () => o()), oldDead], { commit: '97e253d' });
  assert.equal(l.commit_mismatch, true, 'a dead run from another build counts, ok runs alone would pass');
  for (const [field, text] of [['harness_commit', /wasm build/], ['js_commit', /page script/]]) {
    const dead1 = { ...o({ [field]: '131aa75' }), outcome: 'killed' };
    const [m] = summarize([...Array.from({ length: 4 }, () => o()), dead1], { commit: '97e253d' });
    assert.match(m.verdict, text, `only ${field} of the dead run differs`);
  }
  const only = summarize([], { commit: '97e253d', cleared: [{ cleared_at: 't', run: oldDead }] });
  assert.equal(only.length, 1);
  assert.equal(only[0].commit_mismatch, true);
  assert.match(only[0].verdict, /^REFUSED: .*not the commit the report names/);
  const mixed = summarize(Array.from({ length: 5 }, () => o()), { commit: '97e253d', cleared: [{ cleared_at: 't', run: oldDead }] });
  assert.equal(mixed[0].commit_mismatch, true, 'a cleared run of its own row and session');
  const clean = summarize([], { commit: '97e253d', cleared: [{ cleared_at: 't', run: { ...o(), outcome: 'killed' } }] });
  assert.equal(clean[0].commit_mismatch, undefined);
});

test('the script exits 1 for a row made only of cleared runs from another build', async () => {
  const { spawnSync } = await import('node:child_process');
  const d = mkdtempSync(join(tmpdir(), 'kb-clc-'));
  writeFileSync(join(d, 'x.json'), JSON.stringify({ results: [], cleared: [{ cleared_at: 't', run: { ...run({ ...fast, harness_commit: '131aa75', js_commit: '131aa75' }), outcome: 'killed' } }] }));
  const r = spawnSync('node', [fileURLToPath(new URL('../scripts/summarize.mjs', import.meta.url)), d, '--commit', '97e253d']);
  assert.equal(r.status, 1);
  assert.match(r.stdout.toString(), /REFUSED/);
});

test('a key in capitals is a key, in the prefill and in the scanner, and corpus is capped', async () => {
  const { looksLikeKey } = await import('../web/keys.mjs');
  const { parsePrefill } = await import('../web/prefill.mjs');
  const UP = 'UVIEW1' + 'Q'.repeat(60);
  assert.equal(looksLikeKey(UP), true);
  assert.equal(looksLikeKey('UView1' + 'q'.repeat(30)), true);
  for (const name of ['corpus', 'device', 'endpoint']) assert.deepEqual(parsePrefill(`?${name}=${UP}`).fields, {}, name);
  assert.deepEqual(parsePrefill('?corpus=' + 'a'.repeat(81)).fields, {});
  assert.deepEqual(parsePrefill('?corpus=' + 'a'.repeat(80)).fields, { corpus: 'a'.repeat(80) });
  const d = mkdtempSync(join(tmpdir(), 'kb-up-'));
  writeFileSync(join(d, 'a.txt'), `x ${UP} y`);
  assert.equal(scan(d).length, 1);
  assert.deepEqual(scan(fileURLToPath(new URL('..', import.meta.url))), [], 'the repo is still clean');
});

// Clear keeps the session's first reading
test('clearing runs does not reset the first temperature reading of the session', () => {
  const cold = { ...run({ ...fast, session_id: 'S', temp_before: '30', order_in_session: 1 }) };
  const hot = Array.from({ length: 5 }, (_, i) => run({ ...fast, session_id: 'S', temp_before: '34.5', order_in_session: i + 2, runs_planned: 5 }));
  const [l] = summarize(hot, { cleared: [{ cleared_at: 't', run: cold }] });
  assert.equal(l.excluded.length, 5);
  assert.match(l.excluded[0], /over 32 C/);
});

// The docs say --commit is required
test('the README and the script header say --commit is required', () => {
  const readme = docsText();
  const uses = readme.match(/node scripts\/summarize\.mjs[^\n`]*/g) ?? [];
  assert.ok(uses.length > 0);
  for (const u of uses) assert.match(u, /--commit/, u);
  const head = readFileSync(new URL('../scripts/summarize.mjs', import.meta.url), 'utf8').split('\n')[1];
  assert.match(head, /--commit/);
  assert.doesNotMatch(head, /\[--commit/);
  assert.match(head, /required/);
});

// The worker's failure text comes from describeThrown, shown by a worker that throws undefined
test('a worker that throws undefined says so, and the text is not e.message', async () => {
  const { cpSync, mkdirSync: mk } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'kb-wk-'));
  for (const f of ['worker.js', 'errors.mjs', 'grpcweb.js', 'observe.mjs', 'test-vault.mjs']) cpSync(fileURLToPath(new URL(`../web/${f}`, import.meta.url)), join(dir, f));
  mk(join(dir, 'pkg'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  writeFileSync(join(dir, 'pkg', 'konclave_benchmark.js'), 'export default async () => { throw undefined; };\n');
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ arrayBuffer: async () => new ArrayBuffer(8) });
  globalThis.self = { postMessage: (m) => sent.push(m), crossOriginIsolated: false };
  try {
    await import(pathToFileURL(join(dir, 'worker.js')).href);
    await globalThis.self.onmessage({ data: { kind: 'prove', threads: 0, pool: 'ironwood-v3', outputs: 2, wasm_sha256_stamped: FAKE_WASM_SHA, glue_sha256_stamped: FAKE_WASM_SHA, snippets_sha256_stamped: {} } });
  } finally { delete globalThis.self; globalThis.fetch = realFetch; }
  assert.deepEqual(sent, [{ failed: 'the worker threw undefined' }]);
});

test('after Clear the page still shows the trail, and the page and the script print the same text', async () => {
  const { pageSummary, report } = await import('../web/summarize-core.mjs');
  const { spawnSync } = await import('node:child_process');
  const dead = { cleared_at: 't', run: { ...run(fast), outcome: 'killed', session_id: 'S' } };
  const shown = pageSummary([], [dead], { js_commit: 'abcdef1' });
  assert.match(shown, /1 runs cleared, never counted: killed 1/);
  assert.match(shown, /FAIL: runs missing or killed \(cleared\)/);
  assert.equal(pageSummary([], [], { js_commit: 'abcdef1' }), 'No runs yet.');
  // the same input through the script
  const d = mkdtempSync(join(tmpdir(), 'kb-same-'));
  const results = [...five({ ...fast, session_id: 'S' }), ...five({ ...fast, session_id: 'T', harness_commit: '131aa75', js_commit: '131aa75' })];
  writeFileSync(join(d, 'x.json'), JSON.stringify({ results, cleared: [dead] }));
  const out = spawnSync('node', [fileURLToPath(new URL('../scripts/summarize.mjs', import.meta.url)), d, '--commit', 'abcdef1']).stdout.toString();
  assert.equal(out.trimEnd(), pageSummary(results, [dead], { js_commit: 'abcdef1' }));
  assert.equal(out.trimEnd(), report(results, [dead], 'abcdef1').text);
  const empty = mkdtempSync(join(tmpdir(), 'kb-empty-'));
  writeFileSync(join(empty, 'x.json'), JSON.stringify({ results: [], cleared: [dead] }));
  assert.equal(spawnSync('node', [fileURLToPath(new URL('../scripts/summarize.mjs', import.meta.url)), empty, '--commit', 'abcdef1']).stdout.toString().trimEnd(), pageSummary([], [dead], { js_commit: 'abcdef1' }));
});

test('a stored trail from another commit warns the operator before Run', async () => {
  const { trailWarning } = await import('../web/stamp.mjs');
  const mkc = (h, j) => ({ cleared_at: 't', run: { ...run(fast), harness_commit: h, js_commit: j } });
  assert.equal(trailWarning([], { js_commit: '97e253d' }), '');
  assert.equal(trailWarning([mkc('97e253d', '97e253d')], { js_commit: '97e253d' }), '');
  const w = trailWarning([mkc('131aa75', '131aa75'), mkc('97e253d', '97e253d')], { js_commit: '97e253d' });
  assert.match(w, /1 cleared run/);
  assert.match(w, /131aa75/);
  assert.match(w, /clear the site data/i);
  assert.match(trailWarning([mkc('97e253d', '131aa75')], { js_commit: '97e253d' }), /131aa75/, 'the script stamp counts too');
  assert.equal(trailWarning([mkc('131aa75', '131aa75')], { js_commit: 'unknown' }), '', 'a page with no stamp names no commit');
  for (const f of ['index.html', 'threads.html']) assert.match(readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8'), /id="trail-warning"/);
  const app = noComments(readFileSync(new URL('../web/app.js', import.meta.url), 'utf8'));
  assert.match(app, /trailWarning\(cleared, jsStamp\)/);
});

test('which thread counts run and which build each uses is written once', async () => {
  const { threadCounts, buildFor } = await import('../web/plan.mjs');
  assert.deepEqual([threadCounts(0), threadCounts(1), threadCounts(4)], [[0], [1], [1, 4]]);
  assert.deepEqual([buildFor(0), buildFor(1), buildFor(4)], ['single', 'threads', 'threads']);
  const { startRefusal } = await import('../web/stamp.mjs');
  const js = { js_commit: '97e253d', js_files_match: true };
  const wasm_sha256 = 'cd'.repeat(32), glue_sha256 = 'ef'.repeat(32), snippets_sha256 = {};
  assert.match(startRefusal(js, { single: { commit: '97e253d', wasm_sha256, glue_sha256, snippets_sha256 }, threads: { commit: '131aa75', wasm_sha256, glue_sha256, snippets_sha256 } }, 1), /differ/);
  assert.equal(startRefusal(js, { single: { commit: '131aa75', wasm_sha256, glue_sha256, snippets_sha256 }, threads: { commit: '97e253d', wasm_sha256, glue_sha256, snippets_sha256 } }, 4), null);
  for (const f of ['app.js', 'stamp.mjs']) {
    const src = noComments(readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8'));
    assert.doesNotMatch(src, /threads > 1/, f);
    assert.doesNotMatch(src, /\? metas\.threads|'threads' : 'single'/, f);
  }
  assert.match(noComments(readFileSync(new URL('../web/app.js', import.meta.url), 'utf8')), /threadCounts\(threads\)/);
});

// ---- The endpoint table and the proxy files ----
const ROOT = fileURLToPath(new URL('../', import.meta.url));
// proxyEntries: the proxies that anyone starts from proxy/ (compose); hostedEntries: the hosted ones (Dockerfile), read by deriveHosted.
const proxyEntries = (table) => table.filter((e) => e.files && Object.keys(e.files).some((f) => f.endsWith('compose.yml')));
const hostedEntries = (table) => table.filter((e) => e.files && Object.keys(e.files).some((f) => f.endsWith('Dockerfile')));

test('the proxy image is pinned by digest, the ports stay on this machine, and nothing reaches the docker socket or a dashboard', async () => {
  const { ENDPOINTS } = await import('../web/endpoints.mjs');
  const { deriveRoutes } = await import('./proxy-files.mjs');
  assert.ok(proxyEntries(ENDPOINTS).length >= 3);
  for (const e of proxyEntries(ENDPOINTS)) {
    const { compose, stat, dyn, published } = deriveRoutes(e.files, ROOT);
    for (const s of Object.values(compose.services)) {
      assert.match(s.image, /@sha256:[0-9a-f]{64}$/, `${e.origin}: the image is a tag that can float`);
      assert.deepEqual((s.volumes ?? []).filter((v) => /docker\.sock/.test(v)), []);
      assert.ok(!s.privileged && s.network_mode !== 'host', 'no privileged mode, no host network');
    }
    for (const p of Object.values(published)) assert.equal(p.bind, '127.0.0.1', 'a published port must be bound to this machine');
    assert.equal(stat.api, undefined);
    assert.equal(stat.providers.docker, undefined);
    assert.deepEqual(Object.keys(stat.providers), ['file']);
    // allowOrigins: see its own test below (which page is allowed on which proxy).
    // Nothing but the rate limit and the grpc-web middleware is in the path.
    // The rate limit, then the proxy: nothing else (no cache, retry or compression).
    for (const r of Object.values(dyn.http.routers)) assert.deepEqual(r.middlewares, ['rate-limit', 'grpc-web']);
    assert.deepEqual(Object.keys(dyn.http.middlewares).sort(), ['grpc-web', 'rate-limit']);
  }
  assert.match(readFileSync(join(ROOT, '.gitattributes'), 'utf8'), /^proxy\/\*\* -text$/m);
});

test('the table says what the proxy files route: origin to upstream, derived from compose, entry points, routers and services', async () => {
  const { ENDPOINTS } = await import('../web/endpoints.mjs');
  const { deriveRoutes } = await import('./proxy-files.mjs');
  const byCompose = new Map();
  for (const e of proxyEntries(ENDPOINTS)) {
    const k = Object.keys(e.files).find((f) => f.endsWith('compose.yml'));
    byCompose.set(k, [...(byCompose.get(k) ?? []), e]);
  }
  assert.ok(byCompose.size >= 2, 'the mainnet pair and the testnet variant');
  for (const entries of byCompose.values()) {
    const want = Object.fromEntries(entries.map((e) => [e.origin, e.upstream]));
    assert.deepEqual(deriveRoutes(entries[0].files, ROOT).routes, want);
  }
  // The pair the protocol names, by port, as the README states it.
  const bySource = Object.fromEntries(ENDPOINTS.map((e) => [e.origin, e.upstream]));
  assert.equal(bySource['http://localhost:1234'], 'zec.rocks:443');
  assert.equal(bySource['http://localhost:1235'], 'zec.global:443');
  // The check has teeth: a table that swaps an upstream is not what the files route.
  const swapped = ENDPOINTS.filter((e) => e.origin === 'http://localhost:1234' || e.origin === 'http://localhost:1235').map((e) => ({ ...e, upstream: e.origin.endsWith('1234') ? 'zec.global:443' : 'zec.rocks:443' }));
  assert.notDeepEqual(deriveRoutes(swapped[0].files, ROOT).routes, Object.fromEntries(swapped.map((e) => [e.origin, e.upstream])));
});

test('each proxy file has a sha256 in the table that a stranger can recompute', async () => {
  const { ENDPOINTS } = await import('../web/endpoints.mjs');
  const { sha256 } = await import('./proxy-files.mjs');
  assert.equal([...proxyEntries(ENDPOINTS), ...hostedEntries(ENDPOINTS)].length, ENDPOINTS.filter((e) => Object.keys(e.files).length).length, 'every entry with files is read');
  for (const e of [...proxyEntries(ENDPOINTS), ...hostedEntries(ENDPOINTS)]) {
    assert.ok(Object.keys(e.files).length === 3, 'compose or Dockerfile, static and dynamic');
    for (const [path, want] of Object.entries(e.files)) assert.equal(sha256(path, ROOT), want, path);
  }
});

test('the hosted proxy files route to the upstream the table declares, pin the image the table names, and the derivation refuses a change', async () => {
  const { deriveHosted } = await import('./proxy-files.mjs');
  const hosted = hostedEntries(ENDPOINTS);
  assert.deepEqual(hosted.map((e) => e.upstream).sort(), ['zec.global:443', 'zec.rocks:443']);
  assert.deepEqual(hosted.map((e) => e.role), ['verdict', 'verdict']);
  for (const e of hosted) {
    const d = deriveHosted(e.files, ROOT);
    assert.equal(d.upstream, e.upstream, e.origin);
    assert.equal(d.image_digest, e.image_digest, `${e.origin}: the table names the image the Dockerfile pins`);
    assert.deepEqual(d.allowOrigins, ['http://localhost:8090']);
    assert.equal(d.stat.accessLog, undefined);
    assert.ok(verdictReady(e), e.origin);
  }
  // Teeth: each change is refused, or no longer matches the table.
  const mutate = (e, file, from, to) => {
    const root = mkdtempSync(join(tmpdir(), 'kb-hosted-'));
    cpSync(join(ROOT, 'proxy'), join(root, 'proxy'), { recursive: true });
    const f = join(root, Object.keys(e.files).find((x) => x.endsWith(file)));
    const t = readFileSync(f, 'utf8'); assert.ok(t.includes(from), from); writeFileSync(f, t.replace(from, to));
    return () => deriveHosted(e.files, root);
  };
  const [rocks] = hosted;
  assert.equal(mutate(rocks, 'dynamic.yml', 'https://zec.rocks:443', 'https://zec.global:443')().upstream, 'zec.global:443');
  assert.throws(mutate(rocks, 'dynamic.yml', 'https://zec.rocks:443', 'http://zec.rocks:443'), /must be https/);
  assert.throws(mutate(rocks, 'traefik.yml', '["100.64.0.0/10"]', '["0.0.0.0/0"]'), /trustedIPs/);
  assert.throws(mutate(rocks, 'traefik.yml', 'aliasHeadersStrategy: delete', 'aliasHeadersStrategy: keep'), /aliasHeadersStrategy/);
  assert.throws(mutate(rocks, 'traefik.yml', 'providers:', 'accessLog:\n  filePath: /x\nproviders:'), /not an allowed key|accessLog/);
  assert.throws(mutate(rocks, 'dynamic.yml', 'burst: 40', 'burst: 4000'), /average 20, period 1s, burst 40/);
  assert.throws(mutate(rocks, 'dynamic.yml', 'average: 20', 'average: 2000'), /average 20, period 1s, burst 40/);
  assert.throws(mutate(rocks, 'dynamic.yml', 'requestHeaderName: X-Real-IP', 'requestHeaderName: X-Forwarded-For'), /keyed on X-Real-IP/);
  assert.throws(mutate(rocks, 'Dockerfile', 'COPY traefik.yml', 'COPY --chmod=777 traefik.yml'), /copy exactly/);
  assert.notEqual(mutate(rocks, 'Dockerfile', 'f4bb143d', '00000000')().image_digest, rocks.image_digest);
});

test('the hosted files are the files deployed: no line of ours is added, so the hash in the table is the hash of what runs', () => {
  for (const e of hostedEntries(ENDPOINTS)) for (const f of Object.keys(e.files)) assert.doesNotMatch(readFileSync(join(ROOT, f), 'utf8').split('\n')[0], /SPDX/, f);
  assert.deepEqual(new Set(hostedEntries(ENDPOINTS).flatMap((e) => Object.values(e.files))).size, 4, 'Dockerfile and traefik.yml are shared; the two dynamic.yml differ');
});

test('no verdict entry is local or plain http, every origin is a bare origin, and a verdict entry that names a host is complete', async () => {
  const { ENDPOINTS, originOf } = await import('../web/endpoints.mjs');
  const { isLocalEndpoint } = await import('../web/summarize-core.mjs');
  const { bareOrigin } = await import('../web/endpoint.mjs');
  const origins = ENDPOINTS.map(originOf).filter(Boolean);
  assert.equal(new Set(origins).size, origins.length);
  for (const o of origins) assert.equal(bareOrigin(o), o);
  for (const e of ENDPOINTS.filter((x) => x.role === 'verdict')) {
    // A verdict entry that names an origin or a host must be complete; the placeholder must be empty, and then it is not ready.
    if (originOf(e) || e.hostname) { assert.ok(verdictReady(e), `${originOf(e)}: a verdict entry that names a host is not complete`); assert.ok(!isLocalEndpoint(originOf(e)) && originOf(e).startsWith('https:')); }
    else { assert.equal(verdictReady(e), false); for (const f of ['platform', 'edge_tls', 'region', 'image_digest']) assert.equal(e[f], null, f); }
    for (const f of ['platform', 'edge_tls', 'region', 'image_digest']) assert.ok(f in e, f);
  }
  assert.ok(ENDPOINTS.some((e) => e.role === 'verdict'), 'the placeholder for the hosted proxy');
  assert.deepEqual(ENDPOINTS.filter((e) => ['http://localhost:1234', 'http://localhost:1235'].includes(e.origin)).map((e) => e.role), ['pipeline', 'pipeline']);
  assert.ok(ENDPOINTS.every((e) => ['proxy', 'direct'].includes(e.via)));
});

// ---- What a live run records: declarations from the table, observations from the upstream ----
test('a live row carries the declarations of the table, a replay none, and the declaration is not in the row key', async () => {
  const { planRows } = await import('../web/plan.mjs');
  const [pipe] = planRows(form({ endpoint: 'http://localhost:1234' })).rows;
  assert.equal(pipe.declared.upstream_declared, 'zec.rocks:443');
  assert.deepEqual(Object.keys(pipe.declared.proxy_config_declared), ['proxy/compose.yml', 'proxy/traefik.yml', 'proxy/conf/dynamic.yml']);
  assert.equal(planRows(form({ endpoint: 'http://localhost:1235' })).rows[0].declared.upstream_declared, 'zec.global:443');
  assert.deepEqual(planRows(form({ endpoint: 'https://lwd.example' })).rows[0].declared, {});
  assert.deepEqual(planRows(form()).rows[0].declared, {});
  const { rowKey } = await import('../web/summarize-core.mjs');
  assert.equal(rowKey({ ...scanRun(), upstream_declared: 'a' }), rowKey({ ...scanRun(), upstream_declared: 'b' }));
  assert.match(readFileSync(new URL('../web/app.js', import.meta.url), 'utf8'), /\.\.\.r\.declared/, 'the page copies the declarations into the run');
});

const info = { version: 'v0.4.18', vendor: 'zaino', chain_name: 'main', block_height: 3_100_000 };
test('GetLightdInfo is read through the proxy path, and the time it took is its own', async () => {
  const { server } = await mock(18921, corpus, { info });
  const { readLightdInfo } = await import('../web/observe.mjs');
  const t = [10, 40];
  const got = await readLightdInfo('http://127.0.0.1:18921', fetch, () => t.shift());
  server.close();
  assert.deepEqual(got.info, { version: 'v0.4.18', vendor: 'zaino', chain_name: 'main', block_height: 3_100_000, consensus_branch_id: '', git_commit: '', lightwallet_protocol_version: '' });
  assert.equal(got.preflight_ms, 30);
  await assert.rejects(() => lightdInfo('http://x', async () => new Response(new Uint8Array(0), { status: 200, headers: { 'grpc-status': '0' } })), /GetLightdInfo returned nothing/);
});

test('the tree states a run already fetched are what it records: roots at the start and the end, and the end block hash', async () => {
  const { server, start, count } = await mock(18922, corpus, { end: JSON.parse(readFileSync(new URL('../web/corpus/synthetic-10k.bin.end.json', import.meta.url), 'utf8')) });
  const { observations } = await import('../web/observe.mjs');
  const a = await treeState('http://127.0.0.1:18922', start - 1);
  const b = await treeState('http://127.0.0.1:18922', start + count - 1);
  server.close();
  const seen = observations(info, a, b);
  assert.deepEqual(Object.keys(seen).sort(), ['end_block_hash', 'end_block_hash_from', 'lightd_info', 'tree_state_end', 'tree_state_start']);
  assert.equal(seen.lightd_info.version, 'v0.4.18');
  assert.equal(seen.tree_state_start.height, start - 1);
  assert.equal(seen.tree_state_end.height, start + count - 1);
  assert.match(seen.end_block_hash, /^[0-9a-f]{64}$/);
  assert.equal(seen.tree_state_end.orchard, JSON.parse(readFileSync(new URL('../web/corpus/synthetic-10k.bin.end.json', import.meta.url), 'utf8')).orchard);
  assert.equal(seen.tree_state_start.orchard, '');
});

test('the worker reads GetLightdInfo before its clock and fetches the two tree states once each, not again for the record', () => {
  const src = readFileSync(new URL('../web/worker.js', import.meta.url), 'utf8');
  assert.equal([...src.matchAll(/treeState\(/g)].length, 2);
  assert.equal([...src.matchAll(/readLightdInfo\(/g)].length, 1);
  const scanSrc = src.slice(src.indexOf('async function scan('));
  assert.ok(scanSrc.indexOf('readLightdInfo(') < scanSrc.indexOf('p0 = now()'), 'the extra call is before the pipeline clock starts');
  assert.match(src, /preflight_ms = /);
  assert.match(src, /observations\(/);
});

test('the time of GetLightdInfo is an accounted stage: counted, a row passes; left out, the unaccounted-time rule refuses it', () => {
  const base = { total_ms: 60000, pipeline_ms: 60000, wasm_load_ms: 0, witness_ms: 0, elapsed_ms: 64000 };
  assert.match(summarize(fiveScan({ ...base, preflight_ms: null }))[0].verdict, /^REFUSED: the page saw time that no stage accounts for/);
  assert.equal(summarize(fiveScan({ ...base, preflight_ms: 4000 }))[0].verdict, 'fail');
});

test('a live run in the worker, against the mock, puts the observations and the preflight time in its result and makes no call twice', async () => {
  const { cpSync, mkdirSync: mk } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'kb-wk-live-'));
  for (const f of ['worker.js', 'errors.mjs', 'grpcweb.js', 'observe.mjs', 'test-vault.mjs']) cpSync(fileURLToPath(new URL(`../web/${f}`, import.meta.url)), join(dir, f));
  mk(join(dir, 'pkg'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  // A stand-in for the wasm: it takes what the worker gives it and times nothing real.
  writeFileSync(join(dir, 'pkg', 'konclave_benchmark.js'), `export default async () => ({ memory: { buffer: new ArrayBuffer(8) } });
export const thread_count = () => 1, build_flavour = () => 'fake';
export class Scan { static new_live() { return new Scan(); } push() {} set_expected_end() {} starts_empty() { return false; } set_filter() {} set_tree_insert() {} set_ufvk() {} decode() {} decrypt() { return 0; } tree() {} witness() { return 0; } summary() { return '{}'; } }
`);
  const end = JSON.parse(readFileSync(new URL('../web/corpus/synthetic-10k.bin.end.json', import.meta.url), 'utf8'));
  const { server, start, count, requests } = await mock(18923, corpus, { end, info });
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (u, o) => (/konclave_benchmark(_bg\.wasm|\.js)$/.test(String(u)) ? Promise.resolve({ arrayBuffer: async () => new ArrayBuffer(8) }) : realFetch(u, o));
  globalThis.self = { postMessage: (m) => sent.push(m), crossOriginIsolated: false };
  try {
    await import(pathToFileURL(join(dir, 'worker.js')).href);
    await globalThis.self.onmessage({ data: { kind: 'scan', threads: 0, range_kind: 'daily', wasm_sha256_stamped: FAKE_WASM_SHA, glue_sha256_stamped: FAKE_WASM_SHA, snippets_sha256_stamped: {}, live: { endpoint: 'http://127.0.0.1:18923', start, end: start + count - 1 } } });
  } finally { delete globalThis.self; globalThis.fetch = realFetch; server.close(); }
  const done = sent.find((m) => m.done)?.done;
  assert.ok(done, JSON.stringify(sent.at(-1)));
  assert.deepEqual(requests, ['GetLightdInfo', 'GetTreeState', 'GetBlockRange', 'GetTreeState']);
  assert.equal(done.lightd_info.vendor, 'zaino');
  assert.equal(done.lightd_info.chain_name, 'main');
  assert.equal(done.lightd_info.block_height, 3_100_000);
  assert.equal(done.tree_state_start.height, start - 1);
  assert.equal(done.tree_state_end.orchard, end.orchard);
  assert.match(done.end_block_hash, /^[0-9a-f]{64}$/);
  assert.ok(done.preflight_ms >= 0, 'the GetLightdInfo time is in an accounted field');
  assert.equal(done.total_ms, Object.values(done.stages_ms).reduce((a, b) => a + b, 0), 'and in no stage');
  assert.deepEqual(Object.keys(done.stages_ms).sort(), ['decode', 'decrypt', 'download', 'end_tree_state', 'tree', 'tree_state']);
  assert.ok(sent.some((m) => m.stage === 'lightd-info'));
});

// ---- scripts/proxy-latency.mjs ----
// A direct gRPC/HTTP2 server and a stand-in gRPC-web proxy that adds a fixed delay to every call. Neither is a real chain.
async function latencyRig(delayMs, port) {
  const { createServer: h2server } = await import('node:http2');
  const { createServer } = await import('node:http');
  const { frame } = await import('../web/grpcweb.js');
  // The request is BlockRange { start { height }, end { height } }; the test keeps both heights under 128, one byte each.
  const answer = (method, body) => {
    if (method === 'GetLatestBlock') return [Buffer.from([0x08, 0x2a])];
    const n = body[body.length - 1] - body[3] + 1;
    return Array.from({ length: n }, () => Buffer.alloc(200, 7));
  };
  const hits = [];
  const direct = h2server();
  direct.on('stream', (st, headers) => {
    const method = headers[':path'].split('/').pop();
    hits.push(['direct', method]);
    const chunks = [];
    st.on('data', (c) => chunks.push(c));
    st.on('end', () => {
      const msgs = answer(method, Buffer.concat(chunks).subarray(5));
      st.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
      for (const m of msgs) st.write(Buffer.from(frame(m)));
      st.on('wantTrailers', () => st.sendTrailers({ 'grpc-status': '0' }));
      st.end();
    });
  });
  const proxy = createServer((req, res) => {
    const method = req.url.split('/').pop();
    hits.push(['proxy', method]);
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => setTimeout(() => {
      const msgs = answer(method, Buffer.concat(chunks).subarray(5));
      const trailer = Buffer.concat([Buffer.from([0x80, 0, 0, 0, 16]), Buffer.from('grpc-status: 0\r\n')]);
      res.writeHead(200, { 'content-type': 'application/grpc-web+proto' }).end(Buffer.concat([...msgs.map((m) => Buffer.from(frame(m))), trailer]));
    }, delayMs));
  });
  await new Promise((ok) => direct.listen(port, '127.0.0.1', ok));
  await new Promise((ok) => proxy.listen(port + 1, '127.0.0.1', ok));
  return { hits, proxyOrigin: `http://127.0.0.1:${port + 1}`, directOrigin: `http://127.0.0.1:${port}`, close: () => { direct.close(); proxy.close(); } };
}

test('the latency script prints the proxied path minus a direct path, alternates the two, and gets the delay of the proxy', async () => {
  const { measure } = await import('../scripts/proxy-latency.mjs');
  const rig = await latencyRig(50, 18931);
  const out = await measure({ proxyOrigin: rig.proxyOrigin, directOrigin: rig.directOrigin, runs: 6, range: [100, 110], host: 'testhost', upstream: 'x:443', config: { f: 'h' }, ownMock: true });
  rig.close();
  assert.equal(out.label, 'proxied path minus a direct path, measured from testhost');
  assert.equal(out.runs, 6);
  assert.deepEqual(out.range, { start: 100, end: 110, blocks: 11 });
  // ABBA: proxy first on even runs, direct first on odd ones, so a drift in the network falls on both.
  assert.deepEqual(out.order, ['proxy,direct', 'direct,proxy', 'proxy,direct', 'direct,proxy', 'proxy,direct', 'direct,proxy']);
  const calls = rig.hits.filter(([, m]) => m === 'GetBlockRange').map(([w]) => w);
  assert.equal(calls.length, 14, 'one warm-up pair plus 6 runs of each path');
  for (const k of ['latest_block', 'block_range']) {
    const d = out.difference_ms[k];
    assert.ok(d > 35 && d < 90, `${k}: ${d} ms for a 50 ms delay`);
    for (const path of ['proxy', 'direct']) for (const f of ['median', 'min', 'max', 'n']) assert.ok(out[path][k][f] >= 0, `${path}.${k}.${f}`);
  }
  assert.equal(out.proxy.block_range.messages, 11);
  assert.equal(out.direct.block_range.messages, 11);
  assert.equal(out.upstream_declared, 'x:443');
  assert.match(out.said, /not from the phone/);
});

test('the latency script takes an entry from the table and nothing else: no free upstream, no unknown or hosted-less entry', async () => {
  const { spawnSync } = await import('node:child_process');
  const script = fileURLToPath(new URL('../scripts/proxy-latency.mjs', import.meta.url));
  const run1 = (...a) => spawnSync(process.execPath, [script, ...a], { encoding: 'utf8' });
  for (const args of [['--entry', 'http://localhost:9999', '--range', '1-2'], ['--entry', 'https://zec.rocks', '--range', '1-2'], ['--upstream', 'zec.rocks:443', '--range', '1-2'], ['--entry', 'http://localhost:1234', '--upstream', 'evil:443', '--range', '1-2'], ['--entry', 'http://localhost:1234'], ['--entry', 'http://localhost:1234', '--range', '9-2'], []]) {
    const r = run1(...args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /usage|entry|range|upstream/);
  }
  const { entryFor } = await import('../scripts/proxy-latency.mjs');
  assert.equal(entryFor('http://localhost:1234').upstream, 'zec.rocks:443');
  assert.throws(() => entryFor('http://localhost:9999'), /not in the endpoint table/);
  assert.throws(() => entryFor('https://zec.rocks'), /not in the endpoint table/);
  // The placeholder for the hosted proxy has no host name yet: nothing to measure.
  assert.throws(() => entryFor(null), /not in the endpoint table/);
});

// A copy of proxy/ in a temp directory, changed by `edit`, read the way the table's entry reads it. The derivation must refuse what the
// Traefik would load differently from what the reader sees. Hashes are not the defence here: an editor refreshes them.
async function derivedFrom(edit, entryOrigin = 'http://localhost:1234') {
  const { cpSync, readdirSync: ls, statSync } = await import('node:fs');
  const { deriveRoutes } = await import('./proxy-files.mjs');
  const root = mkdtempSync(join(tmpdir(), 'kb-proxy-'));
  cpSync(join(ROOT, 'proxy'), join(root, 'proxy'), { recursive: true });
  const at = (f) => join(root, f);
  const change = (f, from, to) => { const t = readFileSync(at(f), 'utf8'); assert.ok(t.includes(from), `${f} has ${from}`); writeFileSync(at(f), t.replace(from, to)); };
  edit({ at, change, root });
  const e = ENDPOINTS.find((x) => x.origin === entryOrigin);
  return deriveRoutes(e.files, root);
}

test('the derivation refuses every way the proxy files can route differently from what the table says', async () => {
  await derivedFrom(() => {}); // untouched: reads fine
  const rule1 = /rule: .*/.exec(readFileSync(join(ROOT, 'proxy/conf/dynamic.yml'), 'utf8'))[0];
  const sneak = '    sneak:\n      rule: PathPrefix(`/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetBlockRange`)\n      service: zec-global\n      middlewares: [grpc-web]\n      entryPoints: [rocks]\n';
  const bypasses = {
    'a router of longer rule before the others': ({ change }) => change('proxy/conf/dynamic.yml', '  routers:\n', `  routers:\n${sneak}`),
    'a router of longer rule after the others': ({ change }) => change('proxy/conf/dynamic.yml', '  middlewares:\n    grpc-web:', `${sneak}  middlewares:\n    grpc-web:`),
    'a second router on an entry point with the same rule': ({ change }) => change('proxy/conf/dynamic.yml', '  middlewares:\n    grpc-web:', '    again:\n      rule: PathPrefix(`/`)\n      service: zec-global\n      middlewares: [grpc-web]\n      entryPoints: [rocks]\n  middlewares:\n    grpc-web:'),
    'a router with another rule': ({ change }) => change('proxy/conf/dynamic.yml', rule1, 'rule: Host(`x.example`)'),
    'an entry point with no router': ({ change }) => change('proxy/traefik.yml', '  global:\n    address: :81\n', '  global:\n    address: :81\n  spare:\n    address: :82\n'),
    'a command that changes the arguments': ({ change }) => change('proxy/compose.yml', '    restart: "no"\n', '    restart: "no"\n    command: ["--configFile=/etc/other.yml"]\n'),
    'an environment that sets the static config': ({ change }) => change('proxy/compose.yml', '    restart: "no"\n', '    restart: "no"\n    environment:\n      - TRAEFIK_ENTRYPOINTS_ROCKS_ADDRESS=:81\n'),
    'a conf directory other than the one hashed': ({ change }) => change('proxy/compose.yml', './conf:/etc/traefik/conf:ro', './conf-other:/etc/traefik/conf:ro'),
    'an extra volume': ({ change }) => change('proxy/compose.yml', '      - ./conf:/etc/traefik/conf:ro\n', '      - ./conf:/etc/traefik/conf:ro\n      - ./more:/etc/traefik/more:ro\n'),
    'a directory provider': ({ change }) => change('proxy/traefik.yml', '    filename: /etc/traefik/conf/dynamic.yml', '    directory: /etc/traefik/conf'),
    'a provider with a watch key beside the filename': ({ change }) => change('proxy/traefik.yml', '    filename: /etc/traefik/conf/dynamic.yml', '    filename: /etc/traefik/conf/dynamic.yml\n    watch: false'),
    'a file in conf/ that is not hashed': ({ at }) => writeFileSync(at('proxy/conf/extra.yml'), 'http: {}\n'),
    'an upstream over plain http': ({ change }) => change('proxy/conf/dynamic.yml', 'https://zec.rocks:443', 'http://zec.rocks:443'),
    'an entry point that redirects to another': ({ change }) => change('proxy/traefik.yml', '  rocks:\n    address: :80\n', '  rocks:\n    address: :80\n    http:\n      redirections:\n        entryPoint:\n          to: ":81"\n'),
    'a router key in another case beside service': ({ change }) => change('proxy/conf/dynamic.yml', '      service: zec-rocks\n', '      service: zec-rocks\n      Service: zec-global\n'),
    'a service key given twice': ({ change }) => change('proxy/conf/dynamic.yml', '      service: zec-rocks\n', '      service: zec-global\n      service: zec-rocks\n'),
    'a tcp section with a router on the same entry point': ({ change }) => change('proxy/conf/dynamic.yml', '\nhttp:\n', '\ntcp:\n  routers:\n    t:\n      rule: HostSNI(`*`)\n      service: ts\n      entryPoints: [rocks]\n  services:\n    ts:\n      loadBalancer:\n        servers:\n          - address: zec.global:443\nhttp:\n'),
    'a udp section': ({ change }) => change('proxy/conf/dynamic.yml', '\nhttp:\n', '\nudp:\n  routers: {}\nhttp:\n'),
    'http redirections': ({ change }) => change('proxy/conf/dynamic.yml', '  middlewares:\n    grpc-web:', '  redirections: {}\n  middlewares:\n    grpc-web:'),
    'an unknown key in traefik.yml': ({ change }) => change('proxy/traefik.yml', 'accessLog: {}\n', 'accessLog: {}\nserversTransport:\n  insecureSkipVerify: true\n'),
    'an unknown key in compose.yml': ({ change }) => change('proxy/compose.yml', 'services:\n', 'x-extra: 1\nservices:\n'),
    'an unknown key in an entry point': ({ change }) => change('proxy/traefik.yml', '  global:\n    address: :81\n', '  global:\n    address: :81\n    transport:\n      lifeCycle: {}\n'),
    'an unknown key in a router': ({ change }) => change('proxy/conf/dynamic.yml', '      service: zec-rocks\n', '      service: zec-rocks\n      priority: 99999\n'),
    'an unknown key in a service': ({ change }) => change('proxy/conf/dynamic.yml', '    zec-rocks:\n      loadBalancer:\n', '    zec-rocks:\n      mirroring: {}\n      loadBalancer:\n'),
    'an unknown key in a load balancer': ({ change }) => change('proxy/conf/dynamic.yml', '    zec-rocks:\n      loadBalancer:\n', '    zec-rocks:\n      loadBalancer:\n        passHostHeader: false\n'),
    'a flow list over two lines that hides a tcp section': ({ at }) => {
      const t = readFileSync(at('proxy/conf/dynamic.yml'), 'utf8').split('\n');
      const block = (from) => { const a = t.findIndex((l) => l === from); const b = t.findIndex((l, i) => i > a && /^  \w/.test(l)); return t.slice(a, b < 0 ? t.length : b).join('\n'); };
      const routers = block('  routers:').replace('entryPoints: [global]', 'entryPoints: [global,\n        global]');
      const head = t.slice(0, t.findIndex((l) => l === 'http:') + 1).join('\n');
      const tcp = 'tcp:\n  routers:\n    all:\n      rule: HostSNI(`*`)\n      service: g\n      entryPoints: [rocks]\n';
      writeFileSync(at('proxy/conf/dynamic.yml'), `${head}\n${block('  middlewares:')}\n${block('  services:')}\n${routers}\n${tcp}`);
    },
    'a plain scalar continued on the next line': ({ change }) => change('proxy/conf/dynamic.yml', `${rule1}\n      service: zec-rocks`, `${rule1}\n        || Host(\`x\`)\n      service: zec-rocks`),
    'an anchor': ({ change }) => change('proxy/conf/dynamic.yml', '    grpc-web:\n', '    grpc-web: &b\n'),
    'a hijacking router with a priority': ({ change }) => change('proxy/conf/dynamic.yml', '  middlewares:\n    grpc-web:', '    hijack:\n      rule: PathPrefix(`/`)\n      service: zec-global\n      middlewares: [grpc-web]\n      entryPoints: [rocks]\n      priority: 99999\n  middlewares:\n    grpc-web:'),
    'an image that is not the pinned traefik': ({ change }) => change('proxy/compose.yml', /image: .*/.exec(readFileSync(join(ROOT, 'proxy/compose.yml'), 'utf8'))[0], `image: ghcr.io/someone/anything@sha256:${'0'.repeat(64)}`),
    'a second service that takes the published port': ({ change }) => change('proxy/compose.yml', '      - "127.0.0.1:1234:80"\n', '      - "127.0.0.1:1299:80"\n  other:\n    image: traefik:v3.7.17@sha256:' + '0'.repeat(64) + '\n    network_mode: bridge\n    ports:\n      - "127.0.0.1:1234:80"\n    volumes:\n      - ./traefik.yml:/etc/traefik/traefik.yml:ro\n      - ./conf:/etc/traefik/conf:ro\n'),
    'a second service that publishes nothing the first does': ({ change }) => change('proxy/compose.yml', '    volumes:\n', '    volumes:\n      - ./traefik.yml:/etc/traefik/traefik.yml:ro\n      - ./conf:/etc/traefik/conf:ro\n  other:\n    image: traefik:v3.7.17@sha256:' + '0'.repeat(64) + '\n    ports:\n      - "127.0.0.1:1398:90"\n    volumes:\n'),
    'a flow list that never closes, alone on its line': ({ change }) => change('proxy/conf/dynamic.yml', 'entryPoints: [global]', 'entryPoints: [global,'),
    'a flow map the reader does not read': ({ change }) => change('proxy/traefik.yml', 'accessLog: {}', 'accessLog: {filters: {statusCodes: [500]}}'),
    'a tag on a value': ({ change }) => change('proxy/traefik.yml', 'address: :80', 'address: !!str :80'),
    'the same container port published twice': ({ change }) => change('proxy/compose.yml', '      - "127.0.0.1:1235:81"\n', '      - "127.0.0.1:1235:81"\n      - "127.0.0.1:1299:81"\n'),
    'a middleware beside grpc-web in its entry': ({ change }) => change('proxy/conf/dynamic.yml', '      grpcWeb:\n', '      redirectRegex:\n        regex: x\n      grpcWeb:\n'),
    'a key beside allowOrigins in grpcWeb': ({ change }) => change('proxy/conf/dynamic.yml', '        allowOrigins:', '        allowCredentials: true\n        allowOrigins:'),
    'a weight beside a server url': ({ change }) => change('proxy/conf/dynamic.yml', '          - url: https://zec.rocks:443\n', '          - url: https://zec.rocks:443\n            weight: 0\n'),
    'two keys that differ only in case where nothing else closes the level': ({ change }) => change('proxy/traefik.yml', '  level: INFO\n', '  level: INFO\n  Level: DEBUG\n'),
    // The routers allow only the four calls the harness makes, and the rate limit is in front of them.
    'the version check left on': ({ change }) => change('proxy/traefik.yml', 'checkNewVersion: false', 'checkNewVersion: true'),
    'no version check setting': ({ change }) => change('proxy/traefik.yml', '  checkNewVersion: false\n', ''),
    'usage reporting on': ({ change }) => change('proxy/traefik.yml', 'sendAnonymousUsage: false', 'sendAnonymousUsage: true'),
    'a router that matches every path': ({ change }) => change('proxy/conf/dynamic.yml', rule1, 'rule: PathPrefix(`/`)'),
    'a fifth method': ({ change }) => change('proxy/conf/dynamic.yml', rule1, `${rule1.slice(0, -1)} || Path(\`/cash.z.wallet.sdk.rpc.CompactTxStreamer/SendTransaction\`)"`),
    'a rule with no method matcher': ({ change }) => change('proxy/conf/dynamic.yml', '(Method(`POST`) || Method(`OPTIONS`)) && ', ''),
    'a method other than POST and the preflight': ({ change }) => change('proxy/conf/dynamic.yml', 'Method(`OPTIONS`)', 'Method(`GET`)'),
    'a router with the rate limit missing': ({ change }) => change('proxy/conf/dynamic.yml', 'middlewares: [rate-limit, grpc-web]\n      entryPoints: [rocks]', 'middlewares: [grpc-web]\n      entryPoints: [rocks]'),
    'a router with the rate limit after the proxy': ({ change }) => change('proxy/conf/dynamic.yml', 'middlewares: [rate-limit, grpc-web]\n      entryPoints: [rocks]', 'middlewares: [grpc-web, rate-limit]\n      entryPoints: [rocks]'),
    'a key beside the rate limit': ({ change }) => change('proxy/conf/dynamic.yml', '        average:', '        redis:\n          endpoints: ["127.0.0.1:6379"]\n        average:'),
    'a rate limit that is not a number': ({ change }) => change('proxy/conf/dynamic.yml', /average: .*/.exec(readFileSync(join(ROOT, 'proxy/conf/dynamic.yml'), 'utf8'))[0], 'average: lots'),
    'a rate limit of zero, which means none': ({ change }) => change('proxy/conf/dynamic.yml', /average: .*/.exec(readFileSync(join(ROOT, 'proxy/conf/dynamic.yml'), 'utf8'))[0], 'average: 0'),
    'a third middleware': ({ change }) => change('proxy/conf/dynamic.yml', '  services:\n', '    extra:\n      headers:\n        customRequestHeaders:\n          x: y\n  services:\n'),
    'an image that is not the maintained line': ({ change }) => change('proxy/compose.yml', /image: .*/.exec(readFileSync(join(ROOT, 'proxy/compose.yml'), 'utf8'))[0], `image: traefik:v3.1@sha256:${'0'.repeat(64)}`),
    'a second server in a service': ({ change }) => change('proxy/conf/dynamic.yml', '          - url: https://zec.rocks:443\n', '          - url: https://zec.rocks:443\n          - url: https://zec.global:443\n'),
  };
  for (const [name, edit] of Object.entries(bypasses)) await assert.rejects(derivedFrom(edit), (e) => e.name === 'Error', name); // the reader's own refusal, not a failed edit
});

// One definition of "this entry may carry a verdict", used by the summary and by the shape test above.
test('an entry gives a verdict only when it names its host, its hashed files and where it runs', () => {
  const full = hostedEntry('https://ready.example', 'zec.rocks:443');
  assert.equal(verdictReady(full), true);
  const direct = { origin: 'https://lwd.operator.example', hostname: 'lwd.operator.example', via: 'direct', role: 'verdict', upstream: 'lwd.operator.example:443', files: {} };
  assert.equal(verdictReady(direct), true);
  const bad = {
    'origin set, no hostname, no files': { ...full, hostname: null, files: {}, platform: null, edge_tls: null, region: null, image_digest: null },
    'origin set, hostname null': { ...full, hostname: null },
    'hostname set, no files': { ...full, files: {} },
    'hostname set, platform null': { ...full, platform: null },
    'hostname set, edge null': { ...full, edge_tls: null },
    'hostname set, region null': { ...full, region: null },
    'hostname set, image digest null': { ...full, image_digest: null },
    'origin is not the host': { ...full, origin: 'https://other.example' },
    'a pipeline entry': { ...full, role: 'pipeline' },
    'a digest that is a tag': { ...full, image_digest: 'latest' },
    'a digest too short': { ...full, image_digest: 'sha256:abc' },
    'a blank platform': { ...full, platform: ' ' },
    'a blank region': { ...full, region: '' },
    'a host in capitals': { ...full, hostname: 'Ready.Example', origin: 'https://Ready.Example' },
    'a host with a path': { ...full, hostname: 'ready.example/x', origin: null },
    'no entry': null,
  };
  for (const [name, e] of Object.entries(bad)) {
    assert.equal(verdictReady(e), false, name);
    if (!e || !originOf(e)) continue;
    const table = [...TEST_TABLE, e];
    const origin = originOf(e);
    assert.equal(summarizeWith(fiveScan({ endpoint: origin, ...declaredFor(origin, table) }), { endpoints: table })[0].verdict, e.role === 'pipeline' ? 'pipeline proxy, not a verdict' : 'endpoint not named by the protocol, not a verdict', name);
  }
});

test('a verdict row is refused when it lacks what the upstream said, or the host the table declares', () => {
  for (const f of ['lightd_info', 'tree_state_start', 'tree_state_end', 'end_block_hash']) {
    assert.match(summarize(fiveScan({ endpoint: HOSTED, [f]: undefined }))[0].verdict, /^REFUSED: what the upstream said is not recorded/, f);
  }
  assert.match(summarize(fiveScan({ endpoint: HOSTED, proxy_host_declared: { platform: 'other', edge_tls: 'test', region: 'test', image_digest: null } }))[0].verdict, /^REFUSED: .*hosting declared in the table/);
  assert.match(summarize(fiveScan({ endpoint: HOSTED, proxy_host_declared: undefined }))[0].verdict, /^REFUSED: .*hosting declared in the table/);
  // A row that is not a verdict is not asked for any of it.
  assert.equal(summarizeReal(fiveScan({ endpoint: 'https://zec.rocks', lightd_info: undefined }))[0].verdict, 'endpoint not named by the protocol, not a verdict');
});

// The time of GetLightdInfo is really the run's preflight_ms
test('the worker records the time GetLightdInfo took as a number, and a slow one shows', async () => {
  const { cpSync, mkdirSync: mk } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'kb-wk-pre-'));
  for (const f of ['worker.js', 'errors.mjs', 'grpcweb.js', 'observe.mjs', 'test-vault.mjs']) cpSync(fileURLToPath(new URL(`../web/${f}`, import.meta.url)), join(dir, f));
  mk(join(dir, 'pkg'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  writeFileSync(join(dir, 'pkg', 'konclave_benchmark.js'), `export default async () => ({ memory: { buffer: new ArrayBuffer(8) } });
export const thread_count = () => 1, build_flavour = () => 'fake';
export class Scan { static new_live() { return new Scan(); } push() {} set_expected_end() {} starts_empty() { return false; } set_filter() {} set_tree_insert() {} set_ufvk() {} decode() {} decrypt() { return 0; } tree() {} witness() { return 0; } summary() { return '{}'; } }
`);
  const end = JSON.parse(readFileSync(new URL('../web/corpus/synthetic-10k.bin.end.json', import.meta.url), 'utf8'));
  const { server, start, count } = await mock(18924, corpus, { end, info, infoDelayMs: 300 });
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (u, o) => (/konclave_benchmark(_bg\.wasm|\.js)$/.test(String(u)) ? Promise.resolve({ arrayBuffer: async () => new ArrayBuffer(8) }) : realFetch(u, o));
  globalThis.self = { postMessage: (m) => sent.push(m), crossOriginIsolated: false };
  try {
    await import(pathToFileURL(join(dir, 'worker.js')).href);
    await globalThis.self.onmessage({ data: { kind: 'scan', threads: 0, range_kind: 'daily', wasm_sha256_stamped: FAKE_WASM_SHA, glue_sha256_stamped: FAKE_WASM_SHA, snippets_sha256_stamped: {}, live: { endpoint: 'http://127.0.0.1:18924', start, end: start + count - 1 } } });
  } finally { delete globalThis.self; globalThis.fetch = realFetch; server.close(); }
  const done = sent.find((m) => m.done)?.done;
  assert.ok(done, JSON.stringify(sent.at(-1)));
  assert.equal(typeof done.preflight_ms, 'number');
  assert.ok(done.preflight_ms >= 250 && done.preflight_ms < 5000, `preflight_ms ${done.preflight_ms}`);
  // Not in a stage, and the pipeline clock did not start before it ended.
  assert.ok(Object.values(done.stages_ms).every((ms) => ms < 250 + 1000));
  assert.match(readFileSync(new URL('../web/worker.js', import.meta.url), 'utf8'), /preflight_ms = lightd\.preflight_ms/);
});

// The tree states and the end hash by value
test('the observations hold the tree states and the end block hash exactly as the server sent them', async () => {
  const endFile = JSON.parse(readFileSync(new URL('../web/corpus/synthetic-10k.bin.end.json', import.meta.url), 'utf8'));
  const { server, start, count } = await mock(18925, corpus, { end: endFile });
  const { observations } = await import('../web/observe.mjs');
  const a = await treeState('http://127.0.0.1:18925', start - 1);
  const b = await treeState('http://127.0.0.1:18925', start + count - 1);
  server.close();
  const hash = (h) => h.toString(16).padStart(64, '0'); // the mock's block hash for a height
  const seen = observations(info, a, b);
  assert.deepEqual(seen.tree_state_start, { height: start - 1, hash: hash(start - 1), orchard: '', ironwood: '' });
  assert.deepEqual(seen.tree_state_end, { height: start + count - 1, hash: hash(start + count - 1), orchard: endFile.orchard, ironwood: endFile.ironwood });
  assert.equal(seen.end_block_hash, hash(start + count - 1));
  assert.notEqual(seen.end_block_hash, seen.tree_state_start.hash);
  assert.equal(seen.end_block_hash_from, 'GetTreeState at the end of the range');
});

// A host with no scheme is a host too
test('no web source but the table names a host of the table, with or without a scheme', async () => {
  const { ENDPOINTS: table } = await import('../web/endpoints.mjs');
  const names = [...new Set(table.flatMap((e) => [e.upstream?.replace(/:\d+$/, ''), e.hostname]).filter(Boolean))];
  assert.ok(names.includes('zec.rocks') && names.includes('testnet.zec.rocks'));
  const dir = fileURLToPath(new URL('../web/', import.meta.url));
  for (const f of readdirSync(dir).filter((x) => /\.(m?js|html)$/.test(x) && x !== 'endpoints.mjs')) {
    const text = readFileSync(join(dir, f), 'utf8');
    for (const n of names) assert.ok(!text.includes(n), `${f} names ${n}`);
  }
});

test('the latency script refuses a direct entry and any entry outside the table it is given', async () => {
  const { entryFor } = await import('../scripts/proxy-latency.mjs');
  const direct = { origin: 'https://lwd.operator.example', hostname: 'lwd.operator.example', via: 'direct', role: 'verdict', upstream: 'lwd.operator.example:443', files: {} };
  assert.throws(() => entryFor(direct.origin, [...ENDPOINTS, direct]), /not in the endpoint table as a proxy/);
  assert.equal(entryFor('http://localhost:1235', ENDPOINTS).upstream, 'zec.global:443');
  assert.throws(() => entryFor('http://localhost:1235', [direct]), /not in the endpoint table/);
});

// The allowed origins, and why each is there
test('allowOrigins names the harness page, and the WebZjs test page only on the pipeline proxy of mainnet', async () => {
  const { deriveRoutes } = await import('./proxy-files.mjs');
  for (const e of proxyEntries(ENDPOINTS)) {
    const allow = deriveRoutes(e.files, ROOT).dyn.http.middlewares['grpc-web'].grpcWeb.allowOrigins;
    assert.equal(allow[0], 'http://localhost:8090', `${e.origin}: the harness page`);
    assert.ok(allow.slice(1).every((o) => o === 'http://localhost:8091'));
    if (e.upstream.startsWith('testnet.')) assert.deepEqual(allow, ['http://localhost:8090']);
    if (allow.includes('http://localhost:8091')) assert.equal(e.role, 'pipeline');
  }
  const dyn = readFileSync(join(ROOT, 'proxy/conf/dynamic.yml'), 'utf8');
  assert.match(dyn, /8091: the WebZjs no-threads test page/);
  assert.doesNotMatch(readFileSync(join(ROOT, 'proxy/compose.yml'), 'utf8') + dyn, /harness origins/);
});

test('the README points to the table for the ports and does not repeat them', () => {
  const readme = docsText();
  assert.doesNotMatch(readme, /1234[^\n]{0,40}zec\.rocks|1235[^\n]{0,40}zec\.global|1244[^\n]{0,40}testnet\.zec\.rocks/);
  assert.doesNotMatch(readme, /allowOrigins[^\n]{0,40}8090/);
  assert.match(readme, /GetTreeState at the end of the range/);
  assert.match(readme, /refused when the server's chain name is not `main` or the end block hash is not the end tree state's/);
});

// A verdict row is on mainnet, and what it recorded agrees with itself
test('a verdict row whose upstream says it is not mainnet is refused', () => {
  const chain = (chain_name) => ({ lightd_info: { ...OBSERVED.lightd_info, chain_name } });
  assert.equal(summarize(fiveScan({ endpoint: HOSTED, ...chain('main') }))[0].verdict, 'pass');
  for (const c of ['test', 'regtest', '', undefined]) assert.match(summarize(fiveScan({ endpoint: HOSTED, ...chain(c) }))[0].verdict, /^REFUSED: .*the upstream is not on mainnet/, String(c));
  assert.match(summarize(fiveScan({ endpoint: HOSTED, lightd_info: {} }))[0].verdict, /not on mainnet/);
  // A row that carries no verdict is not asked.
  assert.equal(summarizeReal(fiveScan({ endpoint: 'http://localhost:1244', ...chain('test') }))[0].verdict, 'pipeline proxy, not a verdict');
  assert.match(summarize(fiveScan({ endpoint: HOSTED, end_block_hash: 'c' }))[0].verdict, /the end block hash is not the end tree state's/);
});

test('the pages call the 50,000-block range a first scan, not a sync', () => {
  for (const f of ['index.html', 'threads.html']) {
    const html = readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(html, /first sync/i, f);
    assert.match(html, /a first scan \(50,000 blocks\)/, f);
    assert.match(html, /one day of blocks \(3,456\)/, f);
  }
});

// The line a reader gets prints the bar, the proof alone beside key + proof, and the stage medians, from the one builder.
test('a proof row prints its bar, key plus proof, the proof alone and the stage medians', () => {
  const rows = five({ key_build_ms: 111000, prepare_ms: 20, prove_ms: 130000, verify_ms: 20, pipeline_ms: 241040 });
  const text = line(summarize(rows)[0]);
  assert.match(text, /median 241\.02 s/);
  assert.match(text, /bar 180\.00 s/);
  assert.match(text, /proof alone 130\.00 s/);
  assert.match(text, /stages \(median\): key 111\.00 s, prepare 0\.02 s, prove 130\.00 s, verify 0\.02 s/);
  assert.match(line(summarize(five({ ...fast, row: 'prove-n24' }))[0]), /no bar/);
});

test('a scan row prints its bar and the median of each stage it timed', () => {
  const stages_ms = { tree_state: 200, download: 9000, end_tree_state: 100, decode: 300, decrypt: 20000, tree: 400 };
  const text = line(summarize(fiveScan({ stages_ms, total_ms: 30000, pipeline_ms: 30000 }))[0]);
  assert.match(text, /bar 30\.00 s/);
  assert.match(text, /stages \(median\): tree_state 0\.20 s, download 9\.00 s, end_tree_state 0\.10 s, decode 0\.30 s, decrypt 20\.00 s, tree 0\.40 s/);
});

test('the script prints the bar, the proof alone and the stages, and the page shows the same text', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-i1-'));
  const results = five({ key_build_ms: 111000, prepare_ms: 15, prove_ms: 130000, verify_ms: 20, pipeline_ms: 241035 });
  writeFileSync(join(dir, 'a.json'), JSON.stringify({ results }));
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/summarize.mjs', import.meta.url)), dir, '--commit', 'abcdef1'], { encoding: 'utf8' });
  assert.match(out, /bar 180\.00 s \| proof alone 130\.00 s \| stages \(median\): key 111\.00 s/);
  assert.equal(out.trimEnd(), report(results, [], 'abcdef1').text);
});

// Build.sh stamps each flavour's wasm by its sha256; the page hands that stamp to the run, and the summary refuses a run whose wasm is not it.
test('stamp-meta writes the wasm sha256 of the flavour into its meta.json, and build.sh uses it', async () => {
  const { createHash } = await import('node:crypto');
  const { execFileSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'kb-i3-'));
  const bytes = Buffer.from([0, 97, 115, 109, 1, 2, 3]);
  writeFileSync(join(dir, 'konclave_benchmark_bg.wasm'), bytes);
  const glue = Buffer.from('export default 1;');
  writeFileSync(join(dir, 'konclave_benchmark.js'), glue);
  mkdirSync(join(dir, 'snippets', 'rayon-1', 'src'), { recursive: true });
  const snip = Buffer.from('export const x = 1;');
  writeFileSync(join(dir, 'snippets', 'rayon-1', 'src', 'helpers.js'), snip);
  execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/stamp-meta.mjs', import.meta.url)), dir, 'abc1234', 'threads', 'rustc x', '"orchard":"0.16.0"']);
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  assert.deepEqual(meta, { commit: 'abc1234', crates: { orchard: '0.16.0' }, flavour: 'threads', rustc: 'rustc x', wasm_sha256: createHash('sha256').update(bytes).digest('hex'), glue_sha256: createHash('sha256').update(glue).digest('hex'), snippets_sha256: { 'snippets/rayon-1/src/helpers.js': createHash('sha256').update(snip).digest('hex') } });
  assert.match(readFileSync(new URL('../build.sh', import.meta.url), 'utf8'), /node scripts\/stamp-meta\.mjs "\$1" "\$COMMIT" "\$2" "\$3"/);
});

test('a run whose wasm is not the one stamped, or that has no stamp of its wasm, is refused', () => {
  const v = (o) => summarize(five({ ...fast, ...o }))[0].verdict;
  assert.equal(v({}), 'pass');
  assert.match(v({ wasm_sha256_stamped: 'b' }), /the wasm that ran is not the one build\.sh stamped/);
  assert.match(v({ wasm_sha256_stamped: undefined }), /no wasm hash/);
  assert.match(v({ wasm_sha256_stamped: null }), /no wasm hash/);
  assert.match(v({ glue_sha256_stamped: 'x' }), /the glue that ran is not the one build\.sh stamped/);
  assert.match(v({ glue_sha256_stamped: undefined }), /no glue hash/);
});

test('the page records the wasm stamp with every run and hands it to the worker, which refuses another wasm', async () => {
  const app = noComments(readFileSync(new URL('../web/app.js', import.meta.url), 'utf8'));
  assert.match(app, /wasm_sha256_stamped: meta\.wasm_sha256 \?\? null/);
  assert.match(app, /wasm_sha256_stamped: metas\[buildFor\(t\)\]\.wasm_sha256, glue_sha256_stamped: metas\[buildFor\(t\)\]\.glue_sha256/);
  assert.match(app, /glue_sha256_stamped: meta\.glue_sha256 \?\? null/);
  const { cpSync, mkdirSync: mk } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'kb-wk-i3-'));
  for (const f of ['worker.js', 'errors.mjs', 'grpcweb.js', 'observe.mjs', 'test-vault.mjs']) cpSync(fileURLToPath(new URL(`../web/${f}`, import.meta.url)), join(dir, f));
  mk(join(dir, 'pkg'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  writeFileSync(join(dir, 'pkg', 'konclave_benchmark.js'), `export default async () => ({ memory: { buffer: new ArrayBuffer(8) } });
export const thread_count = () => 1, build_flavour = () => 'fake';
export class Prove { build_key() {} prepare() { return 2; } prove() {} verify() {} }
`);
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (u, o) => (/konclave_benchmark(_bg\.wasm|\.js)$/.test(String(u)) ? Promise.resolve({ arrayBuffer: async () => new ArrayBuffer(8) }) : realFetch(u, o));
  globalThis.self = { postMessage: (m) => sent.push(m), crossOriginIsolated: false };
  try {
    await import(pathToFileURL(join(dir, 'worker.js')).href);
    await globalThis.self.onmessage({ data: { kind: 'prove', threads: 0, pool: 'ironwood-v3', outputs: 2, wasm_sha256_stamped: '00'.repeat(32), glue_sha256_stamped: FAKE_WASM_SHA, snippets_sha256_stamped: {} } });
  } finally { delete globalThis.self; globalThis.fetch = realFetch; }
  assert.equal(sent.some((m) => m.done), false);
  assert.match(sent.find((m) => m.failed)?.failed ?? '', /is not the one build\.sh stamped/);
  // and the glue: right wasm, other glue
  const again = await proveInWorker({ constructor: '' }, { glue_sha256_stamped: '11'.repeat(32) });
  assert.match(again.failed ?? '', /the glue .* is not the one build\.sh stamped/);
});

// Cold comes from the wasm's own state, and the worker keeps one formula for the proof number.
async function proveInWorker(Prove, job = {}) {
  const { cpSync, mkdirSync: mk } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'kb-wk-cold-'));
  for (const f of ['worker.js', 'errors.mjs', 'grpcweb.js', 'observe.mjs', 'test-vault.mjs']) cpSync(fileURLToPath(new URL(`../web/${f}`, import.meta.url)), join(dir, f));
  mkdirSync(join(dir, 'pkg'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  writeFileSync(join(dir, 'pkg', 'konclave_benchmark.js'), `export default async () => ({ memory: { buffer: new ArrayBuffer(8) } });
export const thread_count = () => 1, build_flavour = () => 'fake';
export class Prove { constructor() { ${Prove.constructor} } build_key() { this.k = true; } prepare() { return 2; } prove() { this.r = (this.r ?? 0) + 1; } verify() {} has_key() { return !!this.k; } rounds() { return this.r ?? 0; } }
`);
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ arrayBuffer: async () => new ArrayBuffer(8) });
  globalThis.self = { postMessage: (m) => sent.push(m), crossOriginIsolated: false };
  try {
    await import(pathToFileURL(join(dir, 'worker.js')).href);
    await globalThis.self.onmessage({ data: { kind: 'prove', threads: 0, pool: 'ironwood-v3', outputs: 2, wasm_sha256_stamped: FAKE_WASM_SHA, glue_sha256_stamped: FAKE_WASM_SHA, snippets_sha256_stamped: {}, ...job } });
  } finally { delete globalThis.self; globalThis.fetch = realFetch; }
  return sent.find((m) => m.done)?.done ?? sent.at(-1);
}

test('a proof run is cold when the wasm held no key before, and not when it did; the proof number has one formula', async () => {
  const fresh = await proveInWorker({ constructor: '' });
  assert.equal(fresh.cold, true);
  assert.equal('key_plus_first_proof_ms' in fresh, false, 'the proof number is computed in summarize-core only');
  const reused = await proveInWorker({ constructor: 'this.k = true;' });
  assert.equal(reused.cold, false);
  assert.match(summarize(five({ ...fast, cold: reused.cold }))[0].verdict, /not cold/);
});

test('the proof verdict is key build plus circuit preparation plus the first proof, and the README says so', () => {
  // 100 + 5 + 76 s is over the 180 s bar only because preparation is counted.
  assert.equal(summarize(five({ key_build_ms: 100000, prepare_ms: 5000, prove_ms: 76000, pipeline_ms: 181000 }))[0].verdict, 'fail');
  assert.equal(summarize(five({ key_build_ms: 100000, prepare_ms: 0, prove_ms: 76000, pipeline_ms: 176000 }))[0].verdict, 'pass');
  assert.match(docsText(), /key build, circuit preparation and the first proof/);
});

test('the node tests need the synthetic corpus, and the README says how to make it', () => {
  const readme = docsText();
  const tests = readme.slice(readme.indexOf('## Tests'));
  assert.match(tests, /web\/corpus\/synthetic-10k\.bin/);
  assert.match(tests, /gen_corpus/);
});

test('the latency script comment names the daily range of the protocol, 3,456 blocks', () => {
  const src = readFileSync(new URL('../scripts/proxy-latency.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /1,150/);
  assert.match(src, /3,456 blocks/);
});

test('the test YAML reader keeps a # inside quotes and still cuts a comment after them', async () => {
  const { parseYaml } = await import('./proxy-files.mjs');
  assert.deepEqual(parseYaml('a: "x # y"\nb: \'p # q\'  # a comment\nc: [ "m # n", o ] # c\nd: plain # note\n'), { a: 'x # y', b: 'p # q', c: ['m # n', 'o'], d: 'plain' });
});

// A result never holds any part of a viewing key. Amounts and note counts are kept only for the published test key.
const KEYHASH = 'ee'.repeat(32);
async function scanInWorker(summary, job = {}) {
  const { cpSync, mkdirSync: mk } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'kb-wk-key-'));
  for (const f of ['worker.js', 'errors.mjs', 'grpcweb.js', 'observe.mjs', 'test-vault.mjs']) cpSync(fileURLToPath(new URL(`../web/${f}`, import.meta.url)), join(dir, f));
  mk(join(dir, 'pkg'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  writeFileSync(join(dir, 'pkg', 'konclave_benchmark.js'), `export default async () => ({ memory: { buffer: new ArrayBuffer(8) } });
export const thread_count = () => 1, build_flavour = () => 'fake';
export class Scan { constructor() {} starts_empty() { return false; } set_filter() {} set_tree_insert() {} set_ufvk() {} decode() {} decrypt() { return 7; } tree() {} witness() { return 3; } summary() { return ${JSON.stringify(JSON.stringify(summary))}; } }
`);
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u) => (/konclave_benchmark(_bg\.wasm|\.js)$/.test(String(u)) ? { arrayBuffer: async () => new ArrayBuffer(8) } : String(u).endsWith('.sha256') ? { ok: true, text: async () => 'c0' } : { arrayBuffer: async () => new ArrayBuffer(1) });
  globalThis.self = { postMessage: (m) => sent.push(m), crossOriginIsolated: false };
  try {
    await import(pathToFileURL(join(dir, 'worker.js')).href);
    await globalThis.self.onmessage({ data: { kind: 'scan', threads: 0, range_kind: 'other', corpus: './corpus/x.bin', wasm_sha256_stamped: FAKE_WASM_SHA, glue_sha256_stamped: FAKE_WASM_SHA, snippets_sha256_stamped: {}, ...job } });
  } finally { delete globalThis.self; globalThis.fetch = realFetch; }
  return sent.find((m) => m.done)?.done ?? sent.at(-1);
}
const AMOUNTS = { corpus_sha256: 'c0', received_zat: 5000, spent_in_range_zat: 100, found: { orchard_external: 1, orchard_internal: 0, ironwood_external: 2, ironwood_internal: 0 }, blocks: 8, start_height: 1 };

test('a typed viewing key that is not the published one leaves no amount, note count or part of the key in the result', async () => {
  const done = await scanInWorker({ ...AMOUNTS, key_sha256: KEYHASH }, { ufvk: 'uv' + 'iew1typedkeytypedkeytypedkey' });
  assert.equal(done.outcome, undefined);
  assert.equal(done.key_sha256, KEYHASH);
  for (const f of ['received_zat', 'spent_in_range_zat', 'found', 'notes', 'witnesses']) assert.equal(f in done, false, f);
  assert.equal(done.amounts_omitted, 'not the published test key');
  assert.equal(JSON.stringify(done).includes('uview1'), false);
  // The synthetic key, with nothing typed, keeps what it found: that is what the harness plants.
  const synthetic = await scanInWorker({ ...AMOUNTS, key_sha256: null });
  assert.equal(synthetic.received_zat, 5000);
  assert.equal(synthetic.notes, 7);
});

test('the published test key keeps its amounts, once its hash is in web/test-vault.mjs', async () => {
  const { keepsAmounts, redactUnpublished, TEST_KEY_SHA256 } = await import('../web/test-vault.mjs');
  assert.equal(keepsAmounts(KEYHASH, null), false, 'no published key yet: no typed key counts');
  assert.equal(keepsAmounts(KEYHASH, KEYHASH), true);
  assert.equal(keepsAmounts(KEYHASH, 'ff'.repeat(32)), false);
  assert.equal(keepsAmounts(null, null), true, 'the synthetic key');
  const kept = redactUnpublished({ ...AMOUNTS, notes: 7, key_sha256: KEYHASH }, KEYHASH);
  assert.equal(kept.received_zat, 5000);
  assert.equal(redactUnpublished({ ...AMOUNTS, notes: 7, key_sha256: KEYHASH }, null).received_zat, undefined);
  // The hash in the module is the hash of the key in config/test-vault.json, and null while there is none.
  const cfg = new URL('../config/test-vault.json', import.meta.url);
  const { existsSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const published = existsSync(cfg) ? JSON.parse(readFileSync(cfg, 'utf8')).ufvk : null;
  assert.equal(TEST_KEY_SHA256, published ? createHash('sha256').update(published).digest('hex') : null);
});

test('a row scanned with a key that is not the published one is never a verdict', () => {
  const typed = { key_sha256: KEYHASH };
  assert.equal(summarize(fiveScan(typed))[0].verdict, 'not the published test key, not a verdict');
  assert.equal(summarize(fiveScan(typed), { publishedKey: KEYHASH })[0].verdict, 'pass');
  assert.equal(summarize(fiveScan(typed), { publishedKey: 'ff'.repeat(32) })[0].verdict, 'not the published test key, not a verdict');
  assert.match(summarize([...fiveScan(typed).slice(0, 4), scanRun({ key_sha256: 'dd'.repeat(32) })], { publishedKey: KEYHASH })[0].verdict, /mixes key_sha256/);
});

// Only printable text from a result file reaches the report, the page and the terminal.
test('the report prints only printable characters from result files', async () => {
  const { printable } = await import('../web/summarize-core.mjs');
  // Control characters, the C1 range, line and paragraph separators, zero-width and bidirectional marks: by code point, so no editor rewrites them.
  const cp = (...n) => String.fromCharCode(...n);
  const hostile = `X${cp(0x1b)}]0;T${cp(7)}${cp(0x1b)}[2J${cp(13)}${cp(0x85)}${cp(0x202e)}${cp(0x2028)}${cp(0x200b)}${cp(0x2066)}${cp(0x7f)}|`;
  const unprintable = (t) => [...t].some((c) => { const n = c.codePointAt(0); return n < 32 || (n >= 0x7f && n <= 0x9f) || (n >= 0x200b && n <= 0x200f) || (n >= 0x2028 && n <= 0x202e) || (n >= 0x2066 && n <= 0x2069); });
  assert.equal(printable('ok text, 12.5 s | \u00e9 \u65e5\u672c'), 'ok text, 12.5 s | \u00e9 \u65e5\u672c');
  assert.equal(unprintable(printable(hostile)), false);
  assert.equal(unprintable(hostile), true, 'the check can tell');
  const rows = five({ ...fast, device_label: hostile, user_agent: `Firefox/158 ${hostile}`, session_id: hostile });
  const cleared = [{ cleared_at: 't', run: { ...run(fast), outcome: `killed${hostile}`, device_label: hostile, session_id: hostile } }];
  const { text } = report(rows, cleared, 'abcdef1');
  assert.equal(unprintable(text.replace(/\n/g, '')), false);
  assert.match(text, /^X\?\]0;T\?/);
  // the script prints that same text
  const dir = mkdtempSync(join(tmpdir(), 'kb-print-'));
  writeFileSync(join(dir, 'a.json'), JSON.stringify({ results: rows, cleared }));
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/summarize.mjs', import.meta.url)), dir, '--commit', 'abcdef1'], { encoding: 'utf8' });
  assert.equal(unprintable(out.replace(/\n/g, '')), false);
  assert.equal(out.trimEnd(), text);
});

// A local proxy reaches the chain, so only the repo's own mock is read without --read-approved.
test('save-range and the latency script read nothing but the repo\'s own mock without --read-approved, a local proxy included', async () => {
  const { requireReadApproval } = await import('../scripts/read-guard.mjs');
  const { measure, parseCli } = await import('../scripts/proxy-latency.mjs');
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (u) => { calls.push(String(u)); throw new Error('no network in this test'); };
  try {
    const prefix = join(mkdtempSync(join(tmpdir(), 'kb-a3-')), 'r');
    // The proxies of the endpoint table, and a port the table does not name, are all refused: none is known to be the mock.
    for (const e of ['http://localhost:1234', 'http://127.0.0.1:1235', 'http://localhost:1244', 'http://localhost:9999', 'https://zec.rocks']) {
      await assert.rejects(() => saveRange(e, 3000000, 3000001, prefix), /read-approved/, e);
    }
    // The mock is the only exception, and only on this machine and outside the table.
    for (const e of ['http://localhost:1234', 'http://localhost:1244', 'https://zec.rocks']) {
      await assert.rejects(() => saveRange(e, 3000000, 3000001, prefix, { ownMock: true }), /read-approved/, `${e} with ownMock`);
    }
    // the same ports spelled another way are the same proxies
    for (const e of ['http://127.0.0.1:1234', 'http://[::1]:1234', 'http://0.0.0.0:1234', 'http://127.0.0.2:1235', 'http://LOCALHOST:1244', 'http://localhost.:1234']) {
      await assert.rejects(() => saveRange(e, 3000000, 3000001, prefix, { ownMock: true }), /read-approved/, `${e} with ownMock`);
    }
    assert.doesNotThrow(() => requireReadApproval('http://127.0.0.1:18905', { ownMock: true }));
    assert.doesNotThrow(() => requireReadApproval('http://localhost:1234', { readApproved: true }));
    await assert.rejects(() => measure({ proxyOrigin: 'http://localhost:1234', directOrigin: 'https://127.0.0.1:1', runs: 1, range: [1, 2], host: 'h', upstream: 'zec.rocks:443' }), /read-approved/);
    assert.deepEqual(calls, [], 'nothing was sent');
  } finally { globalThis.fetch = real; }
  const argv = ['--entry', 'http://localhost:1234', '--range', '1-2'];
  assert.throws(() => parseCli(argv), /--read-approved/);
  assert.equal(parseCli([...argv, '--read-approved']).readApproved, true);
});

// The hosted proxy is a relay for four calls and no others, whatever the origin header says.
test('every router allows exactly the calls the harness makes, and the rate limit sits in front', async () => {
  const { deriveRoutes, ALLOWED_METHODS, ROUTER_RULE } = await import('./proxy-files.mjs');
  // The four are the ones the code calls: grpcweb.js (GetLightdInfo, GetTreeState, GetBlockRange) and the latency script (GetLatestBlock).
  const used = new Set([...(readFileSync(join(ROOT, 'web/grpcweb.js'), 'utf8') + readFileSync(join(ROOT, 'scripts/proxy-latency.mjs'), 'utf8')).matchAll(/'(Get[A-Za-z]+)'/g)].map((m) => m[1]));
  assert.deepEqual([...ALLOWED_METHODS].sort(), [...used].sort());
  assert.match(ROUTER_RULE, /^\(Method\(`POST`\) \|\| Method\(`OPTIONS`\)\) && \(/);
  for (const e of proxyEntries(ENDPOINTS)) {
    const { dyn } = deriveRoutes(e.files, ROOT);
    for (const r of Object.values(dyn.http.routers)) assert.equal(r.rule, ROUTER_RULE, e.origin);
    const rl = dyn.http.middlewares['rate-limit'].rateLimit;
    assert.deepEqual(Object.keys(rl).sort(), ['average', 'burst', 'period']);
    assert.ok(Number(rl.average) > 0 && Number(rl.burst) >= Number(rl.average), 'a rate that limits, and a burst that holds one run');
  }
});

test('the README says allowOrigins is not access control', () => {
  const readme = docsText();
  assert.match(readme, /`allowOrigins` is not access control/);
  assert.match(readme, /rateLimit/);
});

// The proxy runs the maintained v3 line, by digest.
test('the proxy image is the maintained Traefik v3.7 line, pinned by digest, in every compose file', () => {
  for (const f of ['proxy/compose.yml', 'proxy/testnet/compose.yml']) {
    assert.match(readFileSync(join(ROOT, f), 'utf8'), /image: traefik:v3\.7\.\d+@sha256:[0-9a-f]{64}\n/, f);
  }
});

// ---- Security lows ----
// The service worker adds the policy; it never takes away a stricter one the host sent.
test('the service worker keeps a stricter policy that the host sends, and adds its own when there is none', async () => {
  const src = readFileSync(new URL('../web/coi-sw.js', import.meta.url), 'utf8');
  const listeners = {};
  const fakeSelf = { location: { origin: 'http://x' }, addEventListener: (t, f) => { listeners[t] = f; }, skipWaiting() {}, clients: { claim() {} } };
  const serveWith = async (csp) => {
    const fakeFetch = async () => new Response('x', { headers: csp ? { 'content-security-policy': csp } : {} });
    new Function('self', 'fetch', src)(fakeSelf, fakeFetch);
    let out;
    listeners.fetch({ request: { url: 'http://x/threads.html', mode: 'navigate' }, respondWith: (p) => { out = p; } });
    return (await out).headers;
  };
  const strict = "default-src 'none'; connect-src https://proxy.example";
  const withHost = await serveWith(strict);
  assert.ok(withHost.get('content-security-policy').includes(strict), 'the host\'s own policy is still sent');
  assert.ok(withHost.get('content-security-policy').includes("script-src 'self' 'wasm-unsafe-eval'"), 'and the page\'s own is added');
  const { CSP } = await import('../scripts/serve.mjs');
  assert.equal((await serveWith(null)).get('content-security-policy'), CSP);
  assert.equal((await serveWith(null)).get('cross-origin-opener-policy'), 'same-origin');
});

test('the static server answers a malformed address with 400 and stays up', async () => {
  const { serve } = await import('../scripts/serve.mjs');
  const s = await serve(18941);
  try {
    for (const bad of ['/%E0', '/%', '/%E0%A4%A']) assert.equal((await fetch(`http://127.0.0.1:18941${bad}`)).status, 400, bad);
    assert.equal((await fetch('http://127.0.0.1:18941/index.html')).status, 200, 'still serving');
    assert.ok([403, 404].includes((await fetch('http://127.0.0.1:18941/..%2f..%2fCargo.toml')).status), 'a path out of web/ is still not served');
  } finally { s.close(); }
});

test('the key field turns off the spell checker and autofill, and no free field may hold a key when a run starts', async () => {
  for (const f of ['index.html', 'threads.html']) {
    const html = readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8');
    const tag = /<input[^>]*id="ufvk"[^>]*>/.exec(html)[0];
    for (const a of ['spellcheck="false"', 'autocomplete="off"', 'autocapitalize="none"', 'autocorrect="off"']) assert.ok(tag.includes(a), `${f}: ${a}`);
  }
  const { keyInFreeFields } = await import('../web/keys.mjs');
  const key = 'uv' + 'iew1' + 'q'.repeat(40);
  assert.equal(keyInFreeFields({ device: 'Pixel 8', temp: '31', corpus: 'synthetic-10k.bin' }), null);
  assert.equal(keyInFreeFields({ device: `Pixel ${key}`, temp: '31' }), 'device');
  assert.equal(keyInFreeFields({ device: 'x', temp: key }), 'temp');
  assert.equal(keyInFreeFields({ device: 'x', corpus: encodeURIComponent(key) }), 'corpus');
  const app = noComments(readFileSync(new URL('../web/app.js', import.meta.url), 'utf8'));
  assert.match(app, /const inKey = keyInFreeFields\(\{[^}]*device:[^}]*temp:[^}]*corpus:[^}]*\}\);\s*if \(inKey\) \{[^;]*;\s*return;\s*\}/);
  assert.ok(app.indexOf('keyInFreeFields(') < app.indexOf('planRows(readForm())'), 'checked before the rows are planned');
});

test('the README says the endpoint can come from the link too', () => {
  assert.match(docsText(), /typed in or filled from a link/);
});

test('the host check also catches a scheme-less //host, and the check on keys also finds a spending key, from the one key module', async () => {
  const { namesHost, SCHEMELESS } = await import('./hosts.mjs');
  assert.equal(namesHost("fetch('//attacker.example/x')"), true);
  assert.equal(namesHost("new URL('https:' + '//attacker.example')"), true);
  assert.equal(namesHost('// a comment about the page'), false);
  assert.equal(namesHost("const u = 'https://zec.rocks'"), true);
  const dir = fileURLToPath(new URL('../web/', import.meta.url));
  for (const f of readdirSync(dir).filter((x) => /\.(m?js|html)$/.test(x) && x !== 'endpoints.mjs')) {
    assert.equal(SCHEMELESS.test(readFileSync(join(dir, f), 'utf8')), false, `${f} names a host without a scheme`);
  }
  const { KEY, looksLikeKey } = await import('../web/keys.mjs');
  for (const planted of ['secret-extended-key-main1' + 'q'.repeat(40), 'secret-extended-key-test1' + 'q'.repeat(40), 'usk1' + 'q'.repeat(40), 'zxsk1' + 'q'.repeat(40)]) {
    const e = mkdtempSync(join(tmpdir(), 'kb-sk-'));
    writeFileSync(join(e, 'a.txt'), planted);
    assert.equal(scan(e).length, 1, planted.slice(0, 12));
    assert.equal(looksLikeKey(planted), true, 'a link or a field with a spending key is refused too');
  }
  assert.equal(new RegExp(KEY.source, KEY.flags).test('secret-extended-key-main1' + 'q'.repeat(40)), true);
  assert.doesNotMatch(readFileSync(new URL('../scripts/check-no-keys.mjs', import.meta.url), 'utf8'), /uview|secret-extended/, 'the scanner has no key rule of its own');
});

// A tap on Run before start() has installed its handler did nothing and said nothing. The button starts disabled.
test('the Run button is disabled until start() has read the stamp and installed its handler', () => {
  for (const f of ['index.html', 'threads.html']) assert.match(readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8'), /<button id="go" disabled>Run<\/button>/, f);
  const app = noComments(readFileSync(new URL('../web/app.js', import.meta.url), 'utf8'));
  const at = (re) => app.search(re);
  assert.ok(at(/jsStamp = await readJsStamp/) > 0);
  assert.ok(at(/\$\('go'\)\.onclick = runAll;/) > at(/jsStamp = await readJsStamp/), 'the handler comes after the stamp is read');
  assert.ok(at(/\$\('go'\)\.disabled = false;\s*\$\('stop'\)\.onclick/) > at(/\$\('go'\)\.onclick = runAll;/), 'the button is enabled once the handler is there');
});


// A dead run keeps its row's bar: the range it was asked for is on the record, whatever the wasm never got to write.
test('a first-scan row whose runs died reads FAIL, as before, and a session of dead runs counts', () => {
  const one = (o = {}) => scanRun({ ...FIRST_SCAN, row: 'scan-first-sync-x', runs_planned: 5, total_ms: 31000, ...o });
  const dead = (o) => died(one(o));
  const v = (rows, opts) => summarize(rows, opts).map((l) => l.verdict);
  const fail = 'FAIL: runs missing or killed';
  assert.deepEqual(v([dead(), one(), one(), one(), one()]), [fail], 'the first run killed');
  assert.deepEqual(v([one(), one(), one(), one(), dead()]), [fail], 'the last run killed');
  assert.deepEqual(v([dead(), dead(), dead(), dead(), dead()]), [fail], 'the tab dies every time');
  assert.deepEqual(v([died(one(), 'failed'), died(one({ run_index: 2 }), 'stopped')]), [fail], 'one failed run, then Stop');
  // A session of dead runs is an attempt: the session that passes after it is not alone.
  const s1 = [0, 1, 2, 3, 4].map(() => dead({ session_id: 'S1' }));
  const s2 = [0, 1, 2, 3, 4].map(() => one({ session_id: 'S2' }));
  const refused = 'REFUSED: more than one session in this row; name the one that carries the verdict with --session <id>';
  assert.deepEqual(v([...s1, ...s2]), [refused, refused]);
  assert.deepEqual(v([...s1, ...s2], { session: 'S2' }), ['not the named session, not a verdict', 'pass']);
  // The same for a proof row, which always did.
  assert.deepEqual(v([...five({ ...fast, session_id: 'P1' }).map((r) => died(r)), ...five({ ...fast, session_id: 'P2' })]), [refused, refused]);
});

test('one function decides the bar and the verdict of a scan row: the range asked, matched to the table, for every run', () => {
  const src = readFileSync(new URL('../web/summarize-core.mjs', import.meta.url), 'utf8');
  assert.equal((src.match(/matchRange|askedEntry/g) ?? []).length <= 4, true);
  assert.doesNotMatch(src, /function rangeText/, 'no second implementation beside barFor');
  // A row with no recorded request has no range, however its runs look.
  const bare = fiveScan({}).map((r) => { const { range_asked, ...rest } = r; return rest; });
  assert.match(summarize(bare)[0].verdict, /^range not fixed/);
  assert.equal(summarize(fiveScan({}))[0].bar_ms, 30000);
  assert.equal(summarize(fiveScan({ ...FIRST_SCAN, row: 'scan-first-sync-x' }))[0].bar_ms, 600000);
  assert.equal(summarize(fiveScan({ range_asked: { ...ASKED_DAILY, id: 'made-up' } }))[0].bar_ms, null);
});

test('a replay of a scan row reads "replay, not a verdict", whatever range its file has', () => {
  const replay = (o = {}) => scanRun({ live_or_replay_asked: 'replay', endpoint: null, range_asked: null, start_height: 1, blocks: 156, ...o });
  assert.equal(summarize([replay()])[0].verdict, 'replay, not a verdict');
  assert.equal(summarize([replay({ row: 'scan-first-sync-synthetic-10k.bin', range_kind: 'first-sync' })])[0].verdict, 'replay, not a verdict');
});

test('a live row scanned with the synthetic key never carries a verdict, nor does any key but the published one', () => {
  assert.equal(summarize(fiveScan({ key_sha256: null }))[0].verdict, 'not the published test key, not a verdict');
  assert.equal(summarize(fiveScan({ key_sha256: undefined }))[0].verdict, 'not the published test key, not a verdict');
  assert.equal(summarize(fiveScan({}), { publishedKey: null })[0].verdict, 'not the published test key, not a verdict', 'nothing is published yet');
  assert.equal(summarize(fiveScan({}))[0].verdict, 'pass');
  assert.match(docsText(), /live row scanned with the synthetic key is never a verdict/);
});

// Clear cannot be a way round the one-session rule: a cleared run belongs to its session.
test('cleared runs of a verdict row count as their session, and a re-run after Clear is refused', () => {
  const refused = 'REFUSED: more than one session in this row; name the one that carries the verdict with --session <id>';
  const clearedOf = (rows) => rows.map((r) => ({ cleared_at: 't', run: r }));
  const fail1 = five({ key_build_ms: 111000, prove_ms: 130000, session_id: 'S1' });
  const pass2 = five({ ...fast, session_id: 'S2' });
  // S1 failed five times and was cleared; S2 passes
  const lines = summarize(pass2, { cleared: clearedOf(fail1) });
  assert.deepEqual(lines.map((l) => l.verdict), [refused]);
  assert.match(report(pass2, clearedOf(fail1), 'abcdef1').text, /5 runs cleared, never counted: ok 5/);
  assert.equal(summarize(pass2, { cleared: clearedOf(fail1), session: 'S2' })[0].verdict, 'pass');
  assert.equal(summarize(pass2, { cleared: clearedOf(fail1), session: 'S1' })[0].verdict, 'not the named session, not a verdict');
  // a dead S1 cleared, S2 passes
  assert.deepEqual(summarize(pass2, { cleared: clearedOf(five({ ...fast, session_id: 'S1' }).map((r) => died(r))) }).map((l) => l.verdict), [refused, 'FAIL: runs missing or killed (cleared)'], 'and the cleared dead runs are listed beside it');
  // the same session: five fail, Clear, five again
  const same = summarize(five({ ...fast, session_id: 'S1' }), { cleared: clearedOf(five({ key_build_ms: 111000, prove_ms: 130000, session_id: 'S1' })) });
  assert.match(same[0].verdict, /^REFUSED: ok runs of this row were cleared and the row was run again/);
  // cleared runs of another row do not matter
  assert.equal(summarize(pass2, { cleared: clearedOf(five({ ...fast, session_id: 'S1', device_label: 'other phone' })) })[0].verdict, 'pass');
});

test('--session names a row by its exact name or group, refuses an ambiguous or loose match, and a bare id covers the rest', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-m3-'));
  const a = [...five({ ...fast, session_id: 'S1' }), ...five({ ...fast, session_id: 'S2' })];
  const b = [...five({ ...fast, device_label: 'A14 second', session_id: 'S3' }), ...five({ ...fast, device_label: 'A14 second', session_id: 'S4' })];
  writeFileSync(join(dir, 'a.json'), JSON.stringify({ results: [...a, ...b] }));
  const { spawnSync } = await import('node:child_process');
  const go = (...extra) => spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/summarize.mjs', import.meta.url)), dir, '--commit', 'abcdef1', ...extra], { encoding: 'utf8' });
  const lines = (r) => r.stdout.split('\n').filter(Boolean);
  const gA = 'A14 | Firefox 158 | prove-n2 | ironwood-v3 | threads 0 |  | endpoint - | filter none';
  const gB = gA.replace('A14', 'A14 second');
  const ok = go('--session', `${gA}=S2`, '--session', `${gB}=S3`);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(lines(ok).find((l) => /^A14 \|.*session S2/.test(l)), /\| pass/);
  assert.match(lines(ok).find((l) => /^A14 \|.*session S1/.test(l)), /not the named session/);
  assert.match(lines(ok).find((l) => /^A14 second.*session S3/.test(l)), /\| pass/);
  // a prefix is not a row: "A14" must not take the row of "A14 second" with it
  const loose = go('--session', 'A14=S1');
  assert.equal(loose.status, 2);
  assert.match(loose.stderr, /no row named A14/);
  const prefix = go('--session', 'A14 | Firefox 158 | prove-n2=S1');
  assert.equal(prefix.status, 2);
  // a row name that two rows share is ambiguous: the group names one
  const shared = go('--session', 'prove-n2=S2');
  assert.equal(shared.status, 2);
  assert.match(shared.stderr, /prove-n2 is ambiguous: 2 rows/);
  // two entries that name one row with different ids
  const clash = go('--session', `${gA}=S1`, '--session', `${gA}=S2`);
  assert.equal(clash.status, 2);
  assert.match(clash.stderr, /named twice with different sessions/);
  // a bare id covers the rows not named
  const bare = go('--session', 'S4', '--session', `${gA}=S1`);
  assert.equal(bare.status, 0, bare.stderr);
  assert.match(lines(bare).find((l) => /^A14 second.*session S4/.test(l)), /\| pass/);
  assert.match(lines(bare).find((l) => /^A14 \|.*session S1/.test(l)), /\| pass/);
  assert.match(go('--session', `${gA}=nope`).stderr, /no run of session nope in row A14/);
});

test('naming a session in the summary matches a row exactly, so a prefix names nothing, and a row named twice throws', async () => {
  const rows = [...five({ ...fast, session_id: 'S1' }), ...five({ ...fast, session_id: 'S2' })];
  const refused = 'REFUSED: more than one session in this row; name the one that carries the verdict with --session <id>';
  assert.deepEqual(summarize(rows, { session: [{ row: 'A14', id: 'S1' }] }).map((l) => l.verdict), [refused, refused], 'A14 is a prefix of the row, not the row');
  assert.deepEqual(summarize(rows, { session: [{ row: 'prove-n2', id: 'S1' }] }).map((l) => l.verdict), [refused, refused], 'a bare row name is for resolveSessions to turn into a group; the summary takes a group only');
  const group = 'A14 | Firefox 158 | prove-n2 | ironwood-v3 | threads 0 |  | endpoint - | filter none';
  assert.deepEqual(summarize(rows, { session: [{ row: group, id: 'S2' }] }).map((l) => l.verdict), ['not the named session, not a verdict', 'pass'], 'the exact group');
  assert.throws(() => summarize(rows, { session: [{ row: group, id: 'S1' }, { row: group, id: 'S2' }] }), /named twice with different sessions/);
  const { resolveSessions } = await import('../web/summarize-core.mjs');
  assert.deepEqual(resolveSessions(rows, [{ row: 'prove-n2', id: 'S2' }]).sessions, [{ row: group, id: 'S2' }], 'the one rule: a name becomes its group, and the summary then takes exactly that');
  assert.match(resolveSessions([...rows, ...five({ ...fast, device_label: 'B', session_id: 'S5' })], [{ row: 'prove-n2', id: 'S2' }]).errors[0], /ambiguous/);
});

// The operator picks a verdict range by its id; heights are typed only for a range of no id.
test('the page picks a live range by its id, records the request on every run, and types heights only for "other"', async () => {
  const { planRows } = await import('../web/plan.mjs');
  const live = (o) => form({ endpoint: 'http://localhost:1234', start: '5', end: '9', ...o });
  assert.throws(() => planRows(live({ rangeKind: 'daily' })), /not fixed by the protocol yet/, 'the shipped table has no heights');
  const [first] = planRows(live({ rangeKind: 'first-scan' }), TEST_RANGES).rows;
  assert.equal(first.row, 'scan-first-sync-3100000-3149999', 'the heights are the entry\'s, not the typed ones');
  assert.deepEqual(first.job.live, { endpoint: 'http://localhost:1234', start: 3100000, end: 3149999 });
  assert.deepEqual(first.range_asked, ASKED_FIRST);
  assert.equal(first.job.range_kind, 'first-sync');
  const [info] = planRows(live({ rangeKind: 'first-scan-43d' }), TEST_RANGES).rows;
  assert.deepEqual(info.range_asked, { id: 'first-scan-43d', kind: 'information', start: 2800000, end: 2950000, blocks: 150001 });
  const [other] = planRows(live({ rangeKind: 'other' }), TEST_RANGES).rows;
  assert.deepEqual([other.row, other.range_asked], ['scan-other-5-9', { id: 'other', kind: 'other', start: 5, end: 9, blocks: 5 }]);
  // a replay needs no heights, and records no request
  const [replay] = planRows(form({ rangeKind: 'daily' })).rows;
  assert.deepEqual([replay.row, replay.range_asked, replay.job.range_kind], ['scan-daily-synthetic-10k.bin', null, 'daily']);
  const app = noComments(readFileSync(new URL('../web/app.js', import.meta.url), 'utf8'));
  assert.match(app, /range_asked: r\.range_asked/);
  for (const f of ['index.html', 'threads.html']) {
    const html = readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8');
    assert.deepEqual([...html.match(/<select id="range-kind">.*?<\/select>/)[0].matchAll(/value="([^"]+)"/g)].map((m) => m[1]), ['other', 'daily', 'first-scan', 'first-scan-43d'], f);
  }
});

test('neither Traefik static file checks for a new version or reports usage', () => {
  for (const f of ['proxy/traefik.yml', 'proxy/testnet/traefik.yml']) {
    const text = readFileSync(join(ROOT, f), 'utf8');
    assert.match(text, /\n  sendAnonymousUsage: false\n  checkNewVersion: false\n/, f);
  }
});

// A link can only name an endpoint the table knows: it cannot send a person's browser to a server of the link's choosing.
test('a link fills the endpoint only with an origin of the endpoint table', async () => {
  const { parsePrefill } = await import('../web/prefill.mjs');
  const ep = (v) => parsePrefill(`?endpoint=${encodeURIComponent(v)}`);
  for (const known of ['http://localhost:1234', 'http://localhost:1235', 'http://localhost:1244', 'HTTP://LOCALHOST:1234/']) assert.equal(ep(known).fields.endpoint, 'http://localhost:1234'.replace('1234', new URL(known).port), known);
  for (const other of ['https://attacker.example', 'http://127.0.0.1:631', 'http://localhost:9999', 'https://zec.rocks', 'http://127.0.0.1:1234']) {
    const p = ep(other);
    assert.equal(p.fields.endpoint, undefined, other);
    assert.deepEqual(p.invalid, ['endpoint'], other);
  }
});

test('the README limits say a link fills the endpoint only from the endpoint table', () => {
  assert.match(readFileSync(new URL('../README.md', import.meta.url), 'utf8'), /A link can fill the endpoint field only with an origin of the endpoint table/);
});

test('every proxy file starts with its SPDX line (the hashes are checked by the sha256 test)', async () => {
  const { execFileSync } = await import('node:child_process');
  const root = fileURLToPath(new URL('../', import.meta.url));
  // proxy/hosted/ is the other way round: its files are the files deployed, byte for byte, so they carry no line of ours.
  const files = execFileSync('git', ['ls-files', 'proxy'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean).filter((f) => !f.startsWith('proxy/hosted/'));
  assert.equal(files.length, 6);
  for (const f of files) assert.equal(readFileSync(join(root, f), 'utf8').split('\n')[0], '# SPDX-License-Identifier: MIT OR Apache-2.0', f);
});

test('docs/method.md exists, is linked from the README and says the battery is not measured', () => {
  const m = readFileSync(new URL('../docs/method.md', import.meta.url), 'utf8');
  for (const h of ['## What is timed', '## Devices', '## How a run counts', '## What a verdict is', '## How a community result is sent', '## Battery']) assert.ok(m.includes(h), h);
  assert.match(m, /nothing has been measured/);
  assert.match(m, /No verdict run has been made/);
  assert.match(m, /objections by 16 November 2026 \(UTC\)/);
  assert.match(m, /the browser is read from its user agent/);
  assert.match(m, /the tree state before the range, the download and the tree state at its end/);
  assert.match(readFileSync(new URL('../README.md', import.meta.url), 'utf8'), /\]\(docs\/method\.md\)/);
});

// Free text is short: the page refuses a long field before a run, and the summary refuses a record that carries one, with its own reason.
test('a free text field longer than its limit is refused by the page and by the summary, each with its reason', async () => {
  const { tooLongField, FORM_LIMITS } = await import('../web/plan.mjs');
  const { TEXT_LIMITS } = await import('../web/summarize-core.mjs');
  // The limits are written out here, not read from the table under test.
  assert.deepEqual(TEXT_LIMITS, { device_label: 80, temp_before: 16, user_agent: 300, session_id: 64, row: 120, endpoint: 200 }, 'only fields a record really has');
  assert.deepEqual([FORM_LIMITS.device, FORM_LIMITS.temp, FORM_LIMITS.corpus, FORM_LIMITS.endpoint], [80, 16, 80, 200], 'the page reads the same table, and the corpus name is the form\'s own');
  assert.equal(tooLongField({ device: 'x'.repeat(80), temp: '3'.repeat(16), corpus: 'c'.repeat(80) }), null);
  assert.equal(tooLongField({ device: 'x'.repeat(81) }), 'device');
  assert.equal(tooLongField({ device: 'ok', temp: '3'.repeat(17) }), 'temp');
  assert.equal(tooLongField({ corpus: 'c'.repeat(81) }), 'corpus');
  const app = noComments(readFileSync(new URL('../web/app.js', import.meta.url), 'utf8'));
  assert.match(app, /const tooLong = tooLongField\(\{[^}]*device:[^}]*temp:[^}]*corpus:[^}]*\}\);\s*if \(tooLong\) \{[^;]*;\s*return;\s*\}/);
  assert.ok(app.indexOf('tooLongField(') < app.indexOf('planRows(readForm())'));
  assert.match(app, /user_agent: navigator\.userAgent\.slice\(0, TEXT_LIMITS\.user_agent\)/, 'the page caps the agent it records');
  const reason = 'REFUSED: a free text field of the record is over its limit';
  assert.equal(summarize(five({ ...fast, device_label: 'x'.repeat(81) }))[0].verdict, reason);
  assert.equal(summarize(five({ ...fast, user_agent: `Firefox/158 ${'y'.repeat(300)}` }))[0].verdict, reason);
  assert.equal(summarize(five({ ...fast, session_id: 's'.repeat(65) }))[0].verdict, reason);
  assert.equal(summarize(five({ ...fast, temp_before: '3'.repeat(17) }))[0].verdict, reason);
  assert.equal(summarize(five({ ...fast, device_label: 'x'.repeat(80) }))[0].verdict, 'pass');
  assert.equal(summarize(five({ ...fast, row: `prove-n2${'z'.repeat(121)}` }))[0].verdict, reason, 'the row name is a field of the record');
  assert.equal(summarize(fiveScan({ endpoint: `https://${'h'.repeat(200)}.example` }))[0].verdict, reason, 'and so is the endpoint');
  const { parsePrefill } = await import('../web/prefill.mjs');
  assert.equal(parsePrefill(`?device=${'d'.repeat(80)}`).fields.device?.length, 80);
  assert.deepEqual(parsePrefill(`?device=${'d'.repeat(81)}`).invalid, ['device']);
  assert.deepEqual(parsePrefill(`?corpus=${'c'.repeat(81)}`).invalid, ['corpus']);
});

// Comments and test names carry no review references: a plain reason instead. The pattern is built from pieces so this file does not
// match itself. A short phrase is allowed only in its own context (the milestone name, a test host name, the Unicode control range, a
// Rust enum value), never as a bare token.
const REVIEW_REF = new RegExp([
  '(?<![\\w.])(?:[BCFIMO]|NB|R)-?\\d{1,2}(?!\\w|\\.\\w)', // a capital and a number on its own, also as "X.", "X," or the end of a range
  '(?<![\\w.-])R\\d-[A-Z]\\d', // a round and an item
  '(?<![\\w.-])n\\d(?!\\w)', // a note number
  '\\b[Aa]ud' + 'its?\\b', '\\b[Rr]ou' + 'nd \\d', '\\b(?:Guard|Practice) \\d', 'Tes' + 'ter:', 'design v' + '2',
].join('|'), 'g');
const ALLOWED_CONTEXT = new RegExp(['the M' + '1 benchmark', 'M' + '1-HOSTED\\.example', 'the C' + '1 range', 'Revision::R' + '0'].join('|'), 'g');
const reviewRefs = (line) => [...line.replace(ALLOWED_CONTEXT, '').matchAll(REVIEW_REF)].map((m) => m[0]);

test('no comment or test name carries a review reference', async () => {
  const { execFileSync } = await import('node:child_process');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n')
    // proxy/hosted/ is left out: its files are the bytes deployed and are not edited here (the hash says so).
    .filter((f) => f && !/^web\/corpus\/|^Cargo\.lock$|^LICENSE|^proxy\/hosted\/|\.(svg|bin)$/.test(f));
  assert.ok(files.length > 50, 'the file list is read');
  for (const f of ['src/corpus.rs', 'examples/gen_corpus.rs', 'examples/pack_corpus.rs', 'web/plan.mjs', 'tests/scan.rs', 'proxy/compose.yml', '.github/workflows/ci.yml', 'docs/method.md', 'README.md']) assert.ok(files.includes(f), `${f} is read`);
  const bad = [];
  for (const f of files) {
    readFileSync(join(root, f), 'utf8').split('\n').forEach((l, i) => { for (const m of reviewRefs(l)) bad.push(`${f}:${i + 1}: ${m}`); });
  }
  assert.deepEqual(bad, []);
});

test('CI checks that the published corpus hash is still tracked, before it regenerates the corpus', () => {
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const i = ci.indexOf('git ls-files --error-unmatch web/corpus/synthetic-10k.bin.sha256');
  assert.ok(i > 0 && i < ci.indexOf('--example gen_corpus'));
});

test('the review reference rule catches the usual forms and allows only its contexts', () => {
  for (const planted of ['// B' + '1: x', 'test("I-' + '2 x")', '# R' + '3-I' + '1', 'n' + '6 says', 'the au' + 'dit found', 'ro' + 'und 3 of review',
    'fixed in I' + '2.', 'I-' + '1.', 'closed M' + '1-M' + '3', 'see M' + '1: x', '// M' + '1 minor', 'C' + '1 found', '(R' + '0)', 'I' + '1/I' + '2', 'the M' + '1 benchmark, and I' + '2.']) {
    assert.ok(reviewRefs(planted).length > 0, planted);
  }
  for (const fine of ['the M' + '1 benchmark', 'https://M' + '1-HOSTED.example:443/', 'the C' + '1 range', 'Revision::R' + '0', 'prove-n2', 'i64 and f64', 'version 0.16.0', 'SHA-256']) {
    assert.deepEqual(reviewRefs(fine), [], fine);
  }
});

// The scanner looks everywhere a key could be committed; only build output that cannot hold one is skipped, by exact path.
test('the key scanner skips only build output by path, and a key in a folder named corpus or pkg is found', () => {
  const root = mkdtempSync(join(tmpdir(), 'kb-scan-'));
  const planted = 'uview1' + 'q'.repeat(40);
  const put = (f) => { mkdirSync(join(root, f, '..'), { recursive: true }); writeFileSync(join(root, f), planted); };
  for (const f of ['docs/corpus/x.txt', 'src/pkg/x.txt', 'corpus/x.txt', 'pkg/x.txt', 'web/corpus/x.txt', 'examples/target/x.txt', 'a/node_modules/x.txt']) put(f);
  assert.equal(scan(root).length, 7, 'all seven are in the tree and none is build output');
  const out = mkdtempSync(join(tmpdir(), 'kb-scan-'));
  for (const f of ['target/x.txt', 'node_modules/x.txt', 'web/pkg/x.txt', 'web/pkg-mt/x.txt', '.git/x.txt']) { mkdirSync(join(out, f, '..'), { recursive: true }); writeFileSync(join(out, f), planted); }
  assert.equal(scan(out).length, 0, 'the build output at the root is skipped');
});

// Scratch repositories only: the key is planted where history can hide it, one place at a time, and the real repository is never written.
const PLANTED = 'secret-extended-key-' + 'main1' + 'q'.repeat(40);
async function scratch() {
  const { execFileSync, spawnSync } = await import('node:child_process');
  const repo = mkdtempSync(join(tmpdir(), 'kb-hist-'));
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...a], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const gitTry = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: repo, encoding: 'utf8' });
  const put = (f, text) => writeFileSync(join(repo, f), text);
  const commit = (m) => { git('add', '-A'); git('commit', '-q', '-m', m); };
  git('init', '-q');
  put('a.txt', 'one\n');
  commit('one');
  const check = () => spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/check-history.mjs', import.meta.url)), repo], { encoding: 'utf8' });
  return { repo, git, gitTry, put, commit, check };
}

test('the history scan is clean on a clean history and finds a key committed and removed later', async () => {
  const r = await scratch();
  assert.equal(r.check().status, 0, r.check().stderr);
  r.put('a.txt', `key ${PLANTED}\n`); r.commit('two');
  r.put('a.txt', 'gone\n'); r.commit('three');
  const out = r.check();
  assert.equal(out.status, 1);
  assert.match(out.stderr, /blob [0-9a-f]{7,40} a\.txt \(in commit [0-9a-f]+/);
  assert.equal(out.stderr.includes('qqqqqq'), false, 'the key itself is not printed');
});

test('the history scan looks in every branch, so a key on a side branch is found', async () => {
  const r = await scratch();
  r.git('checkout', '-q', '-b', 'side');
  r.put('b.txt', PLANTED); r.commit('side');
  r.git('checkout', '-q', 'main');
  assert.equal(r.check().status, 1, 'a branch the current one does not reach');
});

test('the history scan finds a key in a commit message, a binary file, an annotated tag, a merge resolution and the stash', async () => {
  const msg = await scratch();
  msg.put('a.txt', 'two\n'); msg.git('add', '-A'); msg.git('commit', '-q', '-m', `debug output ${PLANTED}`);
  assert.equal(msg.check().status, 1, 'commit message');
  assert.match(msg.check().stderr, /commit [0-9a-f]+ \(commit message\)/);

  const bin = await scratch();
  bin.put('blob.bin', Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(PLANTED), Buffer.from([0, 0])])); bin.commit('binary');
  const binOut = bin.check();
  assert.equal(binOut.status, 1, 'binary file');
  assert.match(binOut.stderr, /blob [0-9a-f]{7,40} blob\.bin/, 'it says where, so it was found and did not fall over');
  assert.doesNotMatch(binOut.stderr, /TypeError|at .*\.mjs/, 'no stack trace');

  const attr = await scratch();
  attr.put('.gitattributes', '*.dat -diff\n'); attr.put('x.dat', PLANTED); attr.commit('attributes');
  assert.equal(attr.check().status, 1, 'a file marked -diff');

  const tag = await scratch();
  tag.git('tag', '-a', 'v1', '-m', `release note ${PLANTED}`);
  assert.equal(tag.check().status, 1, 'annotated tag message');
  assert.match(tag.check().stderr, /tag object [0-9a-f]+ \(tag message\)/);

  const merge = await scratch();
  merge.git('checkout', '-q', '-b', 'left'); merge.put('a.txt', 'left\n'); merge.commit('left');
  merge.git('checkout', '-q', 'main'); merge.put('a.txt', 'right\n'); merge.commit('right');
  assert.notEqual(merge.gitTry('merge', 'left').status, 0, 'the merge conflicts');
  merge.put('a.txt', `resolved ${PLANTED}\n`); merge.git('add', '-A'); merge.git('commit', '-q', '-m', 'merge');
  assert.equal(merge.check().status, 1, 'merge resolution');

  const stash = await scratch();
  stash.put('a.txt', `work ${PLANTED}\n`);
  stash.git('stash', 'push', '-q');
  assert.equal(stash.git('status', '--porcelain').trim(), '', 'the work is only in the stash');
  assert.equal(stash.check().status, 1, 'stash');
});

test('the history scan does not fall over on a binary file, and reads UTF-16, every stash entry and tags that point at a blob or a tree', async () => {
  const png = await scratch();
  png.put('logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13, 0, 0, 0, 0, 0xff, 0x00]));
  png.commit('a binary with no key in it');
  const clean = png.check();
  assert.equal(clean.status, 0, clean.stderr);
  assert.doesNotMatch(clean.stderr, /TypeError/);

  const wide = await scratch();
  wide.put('wide.txt', Buffer.from(PLANTED, 'utf16le')); wide.commit('utf-16');
  assert.equal(wide.check().status, 1, 'a key written as UTF-16');

  const stash = await scratch();
  stash.put('a.txt', `older ${PLANTED}\n`); stash.git('stash', 'push', '-q');
  stash.put('a.txt', 'newer, no key\n'); stash.git('stash', 'push', '-q');
  assert.match(stash.git('stash', 'list'), /stash@\{1\}/);
  const out = stash.check();
  assert.equal(out.status, 1, 'the key is only in stash@{1}');
  assert.match(out.stderr, /blob [0-9a-f]{7,40} a\.txt/);

  const blobTag = await scratch();
  const { execFileSync } = await import('node:child_process');
  const oid = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: blobTag.repo, input: PLANTED, encoding: 'utf8' }).trim();
  blobTag.git('tag', 'on-a-blob', oid);
  assert.equal(blobTag.check().status, 1, 'a tag on a blob');

  const treeTag = await scratch();
  const toid = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: treeTag.repo, input: PLANTED, encoding: 'utf8' }).trim();
  treeTag.git('update-index', '--add', '--cacheinfo', `100644,${toid},hidden.txt`);
  const tree = treeTag.git('write-tree').trim();
  treeTag.git('reset', '-q');
  treeTag.git('tag', 'on-a-tree', tree);
  assert.equal(treeTag.check().status, 1, 'a tag on a tree');
});

test('the history scan reads objects, not the text of the log', () => {
  const src = readFileSync(new URL('../scripts/check-history.mjs', import.meta.url), 'utf8');
  for (const part of ["'rev-list'", "'--all'", "'--objects'", "'cat-file'", "'--batch'", "'stash'"]) assert.ok(src.includes(part), part);
  assert.match(docsText(), /every object reachable from a local ref/);
});

// Projection data: per scan row, kept outside every verdict, for projecting larger blocks later.
test('a scan row prints a projection line of rates and sizes, and no verdict or row key depends on it', () => {
  const withData = (o = {}) => fiveScan({ stages_ms: { decrypt: 2000, decode: 10, tree: 10 }, total_ms: 2020, pipeline_ms: 2020, actions_by_pool: { orchard: 100, ironwood: 50 }, compact_bytes: 3456000, compact_bytes_by_block: { min: 10, median: 900, max: 4000 }, ...o });
  const rows = withData();
  const { text, lines } = report(rows, [], 'abcdef1');
  const proj = text.split('\n').filter((l) => /projection \(not a verdict\)/.test(l));
  assert.equal(proj.length, 1);
  assert.match(proj[0], /trial decryption 75\.0 actions\/s/);
  assert.match(proj[0], /0\.04 actions\/block/);
  assert.match(proj[0], /1000 compact bytes\/block/);
  assert.doesNotMatch(proj[0], /pass|fail|REFUSED/);
  // median over the runs, not the first
  const mixed = [withData({ stages_ms: { decrypt: 1000, decode: 1, tree: 1 }, total_ms: 1002, pipeline_ms: 1002 })[0], ...withData().slice(1)];
  assert.match(report(mixed, [], 'abcdef1').text, /trial decryption 75\.0 actions\/s/);
  // the same runs without the new fields: same verdicts, same row keys, same lines but for the projection one
  const strip = rows.map((r) => { const { compact_bytes, compact_bytes_by_block, ...rest } = r; return rest; });
  const a = summarize(rows), b = summarize(strip);
  assert.deepEqual(a.map((l) => [l.row, l.verdict, l.bar_ms, l.median_ms]), b.map((l) => [l.row, l.verdict, l.bar_ms, l.median_ms]));
  assert.equal(report(strip, [], 'abcdef1').text.includes('projection'), true, 'actions per second and per block need only what was always recorded');
  const bare = rows.map((r) => { const { compact_bytes, compact_bytes_by_block, stages_ms, actions_by_pool, blocks, ...rest } = r; return rest; });
  assert.equal(report(bare, [], 'abcdef1').text.includes('projection'), false, 'nothing to project, no line');
  assert.equal(a[0].verdict, 'pass');
  // a proof row has none
  assert.equal(report(five(fast), [], 'abcdef1').text.includes('projection'), false);
  assert.match(docsText(), /projection \(not a verdict\)/);
  // only the runs that count for the median feed it, and a refused row prints none
  const hot = withData().map((r, i) => (i < 3 ? { ...r, temp_before: '40', stages_ms: { decrypt: 100, decode: 1, tree: 1 }, total_ms: 102, pipeline_ms: 102, elapsed_ms: 102 } : r));
  assert.match(report(hot, [], 'abcdef1').text, /trial decryption 75\.0 actions\/s/, 'the hot run, left out of the median, is left out of the projection');
  assert.match(report(hot, [], 'abcdef1').text, /excluded from the median/);
  assert.match(report(hot, [], 'abcdef1').text, /trial decryption 75\.0/, 'two runs count, and the three hot ones are not in the projection');
  assert.equal(summarize(withData({ wasm_sha256_stamped: 'zz' }))[0].verdict.startsWith('REFUSED'), true);
  assert.equal(report(withData({ wasm_sha256_stamped: 'zz' }), [], 'abcdef1').text.includes('projection'), false, 'no projection beside a refused row');
  // a number that is not a number is not used
  for (const bad of [null, '1e9', -5, NaN]) assert.match(report(withData({ compact_bytes: bad }), [], 'abcdef1').text, /projection \(not a verdict\) \| [^\n]*$/m);
  for (const bad of [null, '1e9', -5, NaN]) assert.doesNotMatch(report(withData({ compact_bytes: bad }), [], 'abcdef1').text, /compact bytes\/block/, String(bad));
});

test('the snippets the threads glue imports are stamped, hashed by the worker and refused when they differ', async () => {
  const stamped = { 'snippets/s/h.js': FAKE_WASM_SHA };
  const same = await proveInWorker({ constructor: '' }, { snippets_sha256_stamped: stamped });
  assert.deepEqual(same.snippets_sha256, stamped, 'the run records what it hashed');
  const other = await proveInWorker({ constructor: '' }, { snippets_sha256_stamped: { 'snippets/s/h.js': '22'.repeat(32) } });
  assert.match(other.failed ?? '', /the snippet snippets\/s\/h\.js .* is not the one build\.sh stamped/);
  const v = (o) => summarize(five({ ...fast, ...o }))[0].verdict;
  assert.match(v({ snippets_sha256: { a: 'x' }, snippets_sha256_stamped: { a: 'y' } }), /the snippets that ran are not the ones build\.sh stamped/);
  assert.match(v({ snippets_sha256_stamped: undefined }), /no snippets hash/);
  assert.equal(v({ snippets_sha256: { a: 'x' }, snippets_sha256_stamped: { a: 'x' } }), 'pass');
});

test('the page hands the stamp of the snippets to the worker, with the wasm and the glue', () => {
  const app = noComments(readFileSync(new URL('../web/app.js', import.meta.url), 'utf8'));
  assert.match(app, /snippets_sha256_stamped: metas\[buildFor\(t\)\]\.snippets_sha256/);
  assert.match(app, /snippets_sha256_stamped: meta\.snippets_sha256 \?\? null/);
});

// README: what the page shows about a range that is not fixed.
test('the README says what the page shows while no range is fixed and no endpoint is verdict-ready', () => {
  const readme = docsText();
  assert.doesNotMatch(readme, /Until a range is fixed every live scan row reads/);
  assert.match(readme, /Until a range is fixed the page refuses a range picked by id/);
  assert.match(readme, /shows the endpoint's reason first/);
  assert.doesNotMatch(readme, /with a longer label or user agent \(`TEXT_LIMITS` in `web\/summarize-core\.mjs`\) is not counted/);
  assert.match(readme, /is refused with that reason/);
  assert.doesNotMatch(readme, /wasm of its JS glue/);
  assert.doesNotMatch(readFileSync(new URL('../web/summarize-core.mjs', import.meta.url), 'utf8'), /may be The one table/);
});

test('check-no-keys says to run it on a fresh clone when it finds something, and the README says how', async () => {
  const { spawnSync } = await import('node:child_process');
  const d = mkdtempSync(join(tmpdir(), 'kb-fresh-'));
  writeFileSync(join(d, 'a.txt'), 'uview1' + 'q'.repeat(40));
  const out = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/check-no-keys.mjs', import.meta.url)), d], { encoding: 'utf8' });
  assert.equal(out.status, 1);
  assert.match(out.stderr, /fresh clone/);
  assert.match(docsText(), /git clone \. \/tmp\/kb-fresh && node scripts\/check-no-keys\.mjs \/tmp\/kb-fresh/);
});

// The bare tree roots of a scan (src/scan.rs summary), kept in every result next to the serialised states
test('a verdict row is refused without well-formed bare tree roots, and the roots change no verdict, row key or timer', () => {
  const ok = fiveScan({ endpoint: HOSTED });
  assert.equal(ok[0].tree_roots.orchard.end.length, 64);
  const base = summarize(ok);
  assert.equal(base[0].verdict, 'pass');
  for (const bad of [undefined, null, { orchard: { start: 'a'.repeat(64), end: 'b'.repeat(64) } }, { ...ok[0].tree_roots, ironwood: { start: null, end: null } }, { ...ok[0].tree_roots, orchard: { start: 'zz'.repeat(32), end: 'b'.repeat(64) } }, { ...ok[0].tree_roots, orchard: { start: 'A'.repeat(64), end: 'b'.repeat(64) } }, { ...ok[0].tree_roots, orchard: { start: 'a'.repeat(63), end: 'b'.repeat(64) } }]) {
    assert.match(summarize(fiveScan({ endpoint: HOSTED, tree_roots: bad }))[0].verdict, /^REFUSED: the bare tree roots are not recorded/, JSON.stringify(bad));
  }
  // A row that is not a verdict is not asked for it.
  assert.equal(summarizeReal(fiveScan({ endpoint: 'https://zec.rocks', tree_roots: undefined }))[0].verdict, 'endpoint not named by the protocol, not a verdict');
  // Different roots, same verdict, row key, bar and median.
  const other = summarize(fiveScan({ endpoint: HOSTED, tree_roots: { orchard: { start: '1'.repeat(64), end: '2'.repeat(64) }, ironwood: { start: '3'.repeat(64), end: '4'.repeat(64) } } }));
  assert.deepEqual(other.map((l) => [l.row, l.verdict, l.bar_ms, l.median_ms]), base.map((l) => [l.row, l.verdict, l.bar_ms, l.median_ms]));
});

test('the worker only passes a summary tree_roots through (the real wasm is checked in tests/browser.mjs) and leaves every timer and key alone', async () => {
  const roots = { orchard: { start: '0a'.repeat(32), end: '0b'.repeat(32) }, ironwood: { start: null, end: null } };
  const without = await scanInWorker({ ...AMOUNTS, key_sha256: null });
  const withRoots = await scanInWorker({ ...AMOUNTS, key_sha256: null, tree_roots: roots });
  assert.deepEqual(withRoots.tree_roots, roots);
  const { tree_roots, ...rest } = withRoots;
  assert.deepEqual(Object.keys(rest).sort(), Object.keys(without).sort());
  assert.deepEqual(Object.keys(withRoots.stages_ms), Object.keys(without.stages_ms));
});

// ---- tree insertion mode: chunked is the default, per-block is information ----
const PER_BLOCK = { tree_insert_asked: 'per-block', tree_insert: 'per-block' };

test('a per-block row keeps its bar and its time but never a verdict, whatever the time', () => {
  for (const total_ms of [1000, 99e6]) {
    const [l] = summarize(fiveScan({ ...PER_BLOCK, total_ms }));
    assert.equal(l.verdict, 'per-block tree insertion, information only, not a verdict');
    assert.equal(l.bar_ms, 30000, 'the bar is printed as information');
    assert.match(line(l), /bar 30\.00 s/);
    assert.match(line(l), /per-block tree insertion, information only, not a verdict/);
  }
  const first = summarize(fiveScan({ row: 'scan-first-sync-x', ...FIRST_SCAN, ...PER_BLOCK, total_ms: 700000 }))[0];
  assert.equal(first.bar_ms, 600000);
  assert.match(first.verdict, /per-block tree insertion, information only, not a verdict/);
  // The same row, chunked, still has its verdict.
  assert.equal(summarize(fiveScan({ row: 'scan-first-sync-x', ...FIRST_SCAN, total_ms: 700000 }))[0].verdict, 'fail');
  // One run is enough to say so: a per-block row is never short, never a pass.
  assert.match(summarize([scanRun({ ...PER_BLOCK })])[0].verdict, /per-block tree insertion/);
});

test('per-block and chunked runs are two rows, and a row that mixes the two is refused', () => {
  assert.equal(summarize([...fiveScan(), ...fiveScan(PER_BLOCK)]).length, 2);
  const mixed = summarize([...fiveScan(), scanRun({ runs_planned: 5, tree_insert: 'per-block' })])[0].verdict;
  assert.match(mixed, /^REFUSED: /);
  assert.match(mixed, /the tree insertion recorded is not the one asked for/);
  assert.match(mixed, /this row mixes tree_insert/);
});

test('every scan result names its tree insertion, and it is the one the row asked for', () => {
  const { tree_insert, ...without } = scanRun({ runs_planned: 1 });
  assert.match(summarize([without])[0].verdict, /^REFUSED: .*the tree insertion mode is not recorded/);
  assert.match(summarize([scanRun({ tree_insert: 'every-now-and-then' })])[0].verdict, /the tree insertion mode is not recorded/);
  assert.match(summarize([scanRun({ tree_insert_asked: 'per-block' })])[0].verdict, /^REFUSED: .*not the one asked for/);
  assert.equal(summarize(fiveScan({ tree_insert: 'chunk-10000' }))[0].verdict, 'pass');
  // Only chunk-10000 is chunked: another size, chunk-1 (which is per-block insertion) included, is refused.
  for (const tree_insert of ['chunk-500', 'chunk-1', 'chunk-10001']) assert.match(summarize(fiveScan({ tree_insert, tree_insert_asked: 'chunked' }))[0].verdict, /^REFUSED: .*the tree insertion recorded is not the one asked for/, tree_insert);
  assert.match(summarize(fiveScan({ tree_insert: 'per-block', tree_insert_asked: 'chunked' }))[0].verdict, /not the one asked for/);
  assert.match(summarize(fiveScan({ tree_insert: 'chunk-10000', tree_insert_asked: 'per-block' }))[0].verdict, /not the one asked for/);
  // What was asked must be recorded, and be one of the two.
  const { tree_insert_asked, ...noAsk } = scanRun({ runs_planned: 5 });
  assert.match(summarize([0, 1, 2, 3, 4].map(() => ({ ...noAsk, run_id: `na${++id}` })))[0].verdict, /^REFUSED: .*the tree insertion asked for is not recorded/);
  for (const bad of ['', 'Chunked', 'chunk-10000', 'every-block', null]) assert.match(summarize(fiveScan({ tree_insert_asked: bad }))[0].verdict, /the tree insertion asked for is not recorded/, String(bad));
  // The label the summary accepts is the one the code writes.
  assert.match(readFileSync(new URL('../src/tree.rs', import.meta.url), 'utf8'), /pub const CHUNK_BLOCKS: usize = 10_000;/);
  assert.equal(CHUNKED_TREE_INSERT, `chunk-${10000}`);
});

test('a link or the form sets the tree insertion, the row and the job carry it, and the page and worker pass it on', async () => {
  const { parsePrefill } = await import('../web/prefill.mjs');
  const { planRows } = await import('../web/plan.mjs');
  assert.deepEqual(parsePrefill('?tree=per-block').fields, { 'tree-insert': 'per-block' });
  assert.deepEqual(parsePrefill('?tree=chunked').fields, { 'tree-insert': 'chunked' });
  assert.deepEqual(parsePrefill('?tree=sometimes').invalid, ['tree']);
  assert.equal(planRows(form()).rows[0].tree_insert, 'chunked');
  assert.equal(planRows(form()).rows[0].job.tree_insert, 'chunked');
  const [row] = planRows(form({ treeInsert: 'per-block' })).rows;
  assert.deepEqual([row.tree_insert, row.job.tree_insert], ['per-block', 'per-block']);
  const [live] = planRows(form({ treeInsert: 'per-block', endpoint: 'https://lwd.example:9067' })).rows;
  assert.deepEqual([live.tree_insert, live.job.tree_insert], ['per-block', 'per-block']);
  const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  assert.match(app, /treeInsert: \$\('tree-insert'\)\.value/);
  assert.match(app, /tree_insert_asked: r\.tree_insert/, 'every record, a dead one too, says what was asked');
  assert.match(readFileSync(new URL('../web/index.html', import.meta.url), 'utf8'), /id="tree-insert"/);
  const worker = readFileSync(new URL('../web/worker.js', import.meta.url), 'utf8');
  assert.match(worker, /s\.set_tree_insert\(ev\.tree_insert === 'per-block' \? 'per-block' : 'chunked'\)/);
  assert.ok(worker.indexOf('set_tree_insert(') < worker.indexOf("timed('decode'"), 'set before the first stage');
});

// scripts/fix-ranges.mjs: the heights of the verdict ranges by the published rule, read from a mock chain whose block times the test gives.
const FIX = fileURLToPath(new URL('../scripts/fix-ranges.mjs', import.meta.url));
const CUT = Date.UTC(2026, 10, 17) / 1000;
const RANGES_SRC = fileURLToPath(new URL('../web/ranges.mjs', import.meta.url));
const fixChain = (port, timeAt, tip) => mock(port, null, { chain: { tip, time: timeAt } });
const fixMod = () => import('../scripts/fix-ranges.mjs');
const runFix = (args) => spawnSync(process.execPath, [FIX, ...args], { encoding: 'utf8' });

test('fix-ranges: T is the last block before the cutoff, at the boundary (equal to the cutoff is not before it)', async () => {
  const { findRanges } = await fixMod();
  for (const [port, edge, want] of [[18921, 0, 2_899_999], [18922, -1, 2_900_000]]) {
    // time(h) = CUT + 25 (h - 2,900,000) + edge at h = 2,900,000: the block there is at the cutoff, or one second before it.
    const { server } = await fixChain(port, (h) => CUT + 25 * (h - 2_900_000) + (h === 2_900_000 ? edge : 0), 2_900_150);
    try {
      const r = await findRanges(`http://127.0.0.1:${port}`, { ownMock: true });
      assert.equal(r.T, want);
      assert.ok(r.time < CUT && r.next_time >= CUT);
      assert.deepEqual(r.ranges.map((e) => [e.id, e.start_height, e.end_height]), [['daily', want - 3455, want], ['first-scan', want - 49999, want], ['first-scan-43d', r.ranges[2].start_height, want]]);
      assert.equal(new Date((CUT - 3_749_760) * 1000).toISOString(), '2026-10-04T14:24:00.000Z');
      assert.equal(r.hash, want.toString(16).padStart(64, '0'));
      // The information row starts at the block after the last one before cutoff minus 43.4 days.
      const u = r.ranges[2].start_height - 1;
      assert.ok(CUT + 25 * (u - 2_900_000) < CUT - 3_749_760 && CUT + 25 * (u + 1 - 2_900_000) >= CUT - 3_749_760);
    } finally { server.close(); }
  }
});

test('fix-ranges: block times that are not monotonic: T is the highest block below the cutoff, not the first crossing', async () => {
  const { findRanges } = await fixMod();
  // The block 2,900,003 is five seconds before the cutoff while 2,900,000 to 2,900,002 are after it.
  const { server } = await fixChain(18923, (h) => (h === 2_900_003 ? CUT - 5 : CUT + 25 * (h - 2_900_000)), 2_900_150);
  try {
    assert.equal((await findRanges('http://127.0.0.1:18923', { ownMock: true })).T, 2_900_003);
  } finally { server.close(); }
});

test('fix-ranges: refuses a tip before the cutoff, or one with fewer than 11 or fewer than 100 blocks past T', async () => {
  const { findRanges } = await fixMod();
  const time = (h) => CUT + 25 * (h - 2_900_000);
  for (const [port, tip, re] of [[18924, 2_899_990, /still before/], [18925, 2_900_005, /fewer than 11 blocks/], [18928, 2_900_098, /wait for 100/]]) {
    const { server } = await fixChain(port, time, tip);
    try { await assert.rejects(() => findRanges(`http://127.0.0.1:${port}`, { ownMock: true }), re); } finally { server.close(); }
  }
});

test('fix-ranges: reads nothing without --read-approved, and writes nothing when it refuses', async () => {
  const { server } = await fixChain(18926, (h) => CUT + 25 * (h - 2_900_000), 2_900_150);
  const dir = mkdtempSync(join(tmpdir(), 'fix-'));
  try {
    const { findRanges } = await fixMod();
    await assert.rejects(() => findRanges('https://m1-rocks.konclave.xyz'), /read-approved/);
    await assert.rejects(() => findRanges('http://127.0.0.1:18926'), /read-approved/);
    const file = join(dir, 'ranges.mjs');
    cpSync(RANGES_SRC, file);
    const r = runFix(['http://127.0.0.1:18926', '--write', '--ranges-file', file]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /read-approved/);
    assert.equal(readFileSync(file, 'utf8'), readFileSync(RANGES_SRC, 'utf8'));
  } finally { server.close(); }
});

test('fix-ranges: --write changes only the six heights, and rangeFixed holds after it', async () => {
  const { server } = await fixChain(18927, (h) => CUT + 25 * (h - 2_900_000), 2_900_150);
  const dir = mkdtempSync(join(tmpdir(), 'fix-'));
  try {
    const file = join(dir, 'ranges.mjs');
    cpSync(RANGES_SRC, file);
    const before = readFileSync(file, 'utf8');
    // Without --write the file stays as it was.
    const dry = await new Promise((ok) => { const c = spawn(process.execPath, [FIX, 'http://127.0.0.1:18927', '--own-mock', '--ranges-file', file]); let out = ''; c.stdout.on('data', (d) => { out += d; }); c.on('close', (code) => ok({ code, out })); });
    assert.equal(dry.code, 0);
    assert.match(dry.out, /T 2899999 /);
    assert.equal(readFileSync(file, 'utf8'), before);
    const w = await new Promise((ok) => { const c = spawn(process.execPath, [FIX, 'http://127.0.0.1:18927', '--own-mock', '--write', '--ranges-file', file]); let out = ''; c.stdout.on('data', (d) => { out += d; }); c.on('close', (code) => ok({ code, out })); });
    assert.equal(w.code, 0);
    const after = readFileSync(file, 'utf8');
    assert.match(w.out, /^\+ .*first-scan'/m);
    const strip = (t) => t.replace(/start_height: (null|\d+), end_height: (null|\d+)/g, 'H');
    assert.equal(strip(after), strip(before));
    const mod = await import(`${pathToFileURL(file).href}?w`);
    assert.equal(mod.RANGES.length, 3);
    for (const e of mod.RANGES) assert.ok(mod.rangeFixed(e), e.id);
    assert.deepEqual(mod.RANGES.slice(0, 2).map((e) => [e.start_height, e.end_height]), [[2_899_999 - 3455, 2_899_999], [2_899_999 - 49999, 2_899_999]]);
  } finally { server.close(); }
});
