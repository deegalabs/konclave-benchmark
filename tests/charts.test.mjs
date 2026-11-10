// SPDX-License-Identifier: MIT OR Apache-2.0
// node --test tests/charts.test.mjs : synthetic fixtures only, no corpus, no network, no browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pageUrl, SCENARIOS, runScenario } from '../scripts/scenario.mjs';
import { plotModel, writeCharts, emptySvg } from '../scripts/charts.mjs';
import { BARS } from '../web/summarize-core.mjs';
import { ENDPOINTS, declaredFor } from '../web/endpoints.mjs';

const CHARTS = fileURLToPath(new URL('../scripts/charts.mjs', import.meta.url));
const COMMIT = 'abcdef1';
const HOSTED = 'https://m1-hosted.example';
const TABLE = [...ENDPOINTS, { origin: HOSTED, hostname: 'm1-hosted.example', via: 'proxy', role: 'verdict', upstream: 'zec.rocks:443', files: { 'hosted/compose.yml': 'a'.repeat(64) }, platform: 'test', edge_tls: 'test', region: 'test', image_digest: `sha256:${'b'.repeat(64)}` }];
const RANGES = [
  { id: 'daily', kind: 'daily', blocks: 3456, start_height: 3000000, end_height: 3003455 },
  { id: 'first-scan', kind: 'first-sync', blocks: 50000, start_height: 3100000, end_height: 3149999 },
  { id: 'first-scan-43d', kind: 'information', blocks: null, start_height: 2800000, end_height: 2950000 },
];
const PUBLISHED = 'ab'.repeat(32);
const TEST = { endpoints: TABLE, ranges: RANGES, publishedKey: PUBLISHED, commit: COMMIT };

let id = 0;
const stamps = { js_commit: COMMIT, js_files_match: true, harness_commit: COMMIT, wasm_sha256: 'a', wasm_sha256_stamped: 'a', glue_sha256: 'g', glue_sha256_stamped: 'g', snippets_sha256: {}, snippets_sha256_stamped: {} };
const prove = (over = {}) => {
  const key = over.key_build_ms ?? 30000, pr = over.prove_ms ?? 50000;
  return { kind: 'prove', row: 'prove-n2', pool: 'ironwood-v3', device_label: 'Phone A', device_class: 'phone', user_agent: 'Firefox/158', outcome: 'ok', runs_planned: 5, temp_before: '30', page_hidden_during_run: false, ...stamps, key_build_ms: key, prove_ms: pr, prepare_ms: 0, verify_ms: 0, threads_asked: 0, started_at: 't', run_id: `r${++id}`, verified: true, cold: true, ...over, pipeline_ms: key + pr, elapsed_ms: key + pr };
};
const five = (mk, o = {}) => [0, 1, 2, 3, 4].map(() => mk(o));
const OBSERVED = { lightd_info: { chain_name: 'main' }, tree_state_start: { height: 1, hash: 'a' }, tree_state_end: { height: 2, hash: 'b' }, end_block_hash: 'b' };
const scan = (over = {}) => ({ ...prove(), kind: 'scan', row: 'scan-daily-3000000-3003455', pool: undefined, key_build_ms: undefined, prove_ms: undefined, device_label: 'Phone A', total_ms: 20000, pipeline_ms: 20000, elapsed_ms: 20000, live_or_replay_asked: 'live', endpoint: HOSTED, ...declaredFor(HOSTED, TABLE), ...OBSERVED, actions_by_pool: { orchard: 1, ironwood: 1 }, key_sha256: PUBLISHED, range_kind: 'daily', start_height: 3000000, blocks: 3456, range_asked: { id: 'daily', kind: 'daily', start: 3000000, end: 3003455, blocks: 3456 }, ...over });

test('a pass and a fail are drawn per device, with the bar from the code and the same verdict as the summary', () => {
  const results = [...five(prove), ...five(prove, { device_label: 'Phone B', key_build_ms: 111000, prove_ms: 130000 })];
  const { devices, skipped } = plotModel(results, TEST);
  assert.deepEqual([...devices.keys()], ['Phone A', 'Phone B']);
  const [a] = devices.get('Phone A'), [b] = devices.get('Phone B');
  assert.deepEqual([a.verdict, a.median_ms, a.bar_ms, a.runs], ['pass', 80000, BARS.prove_phone_ms, 5]);
  assert.deepEqual([b.verdict, b.median_ms], ['fail', 241000]);
  assert.equal(skipped.length, 0);
});

test('a row the summary refuses, shorts or calls not-a-verdict is never drawn', () => {
  const cases = {
    'a dirty build': five(prove, { harness_commit: `${COMMIT}-dirty` }),
    'a different commit than the report names': five(prove, { harness_commit: '1234567', js_commit: '1234567' }),
    'four of five runs': five(prove).slice(0, 4).map((r) => ({ ...r, runs_planned: 4 })),
    'threads on': five(prove, { threads_asked: 4, threads: 4, cross_origin_isolated: true }),
    'a proof not verified': five(prove, { verified: false }),
    'a hot start': five(prove, { temp_before: '40' }),
    'a replay scan': five(scan, { live_or_replay_asked: 'replay' }),
    'a scan with the synthetic key': five(scan, { key_sha256: null }),
    'a scan on an endpoint the table does not name': five(scan, { endpoint: 'https://zec.rocks' }),
    'a pipeline proxy': five(scan, { endpoint: 'http://localhost:1234' }),
  };
  for (const [name, results] of Object.entries(cases)) {
    const { devices, skipped } = plotModel(results, TEST);
    assert.equal(devices.size, 0, `${name} was drawn`);
    assert.equal(skipped.length, 1, name);
  }
});

test('a scan is drawn only on a fixed range and a verdict endpoint: the shipped tables draw none', () => {
  const rows = five(scan);
  assert.equal(plotModel(rows, TEST).devices.get('Phone A')[0].bar_ms, BARS.daily_ms);
  assert.equal(plotModel(rows, { commit: COMMIT }).devices.size, 0);
});

test('a row on two sessions is not drawn until the report names one', () => {
  const rows = [...five(prove, { session_id: 's1' }), ...five(prove, { session_id: 's2' })];
  assert.equal(plotModel(rows, TEST).devices.size, 0);
  assert.equal(plotModel(rows, { ...TEST, session: [{ row: null, id: 's1' }] }).devices.get('Phone A').length, 1);
});

test('--only keeps one scenario', () => {
  const rows = [...five(prove), ...five(scan)];
  assert.equal(plotModel(rows, TEST, 'prove').devices.get('Phone A').length, 1);
  assert.equal(plotModel(rows, TEST, 'prove').devices.get('Phone A')[0].kind, 'prove');
  assert.equal(plotModel(rows, TEST, 'daily').devices.get('Phone A')[0].kind, 'scan');
  assert.equal(plotModel(rows, TEST, 'first-sync').devices.size, 0);
  assert.throws(() => plotModel(rows, TEST, 'nope'), /--only/);
});

test('the svg has the threshold line, the words pass or fail, and escapes a hostile label', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-charts-'));
  const results = [...five(prove, { device_label: '<script>alert(1)</script>‮ & "x"' }), ...five(prove, { device_label: 'Slow', key_build_ms: 111000, prove_ms: 130000 })];
  const { files } = writeCharts({ results, out: dir, ...TEST });
  assert.equal(files.length, 2);
  const [hostile, slow] = files.map((f) => readFileSync(f, 'utf8'));
  assert.doesNotMatch(hostile, /<script|‮/);
  assert.match(hostile, /&lt;script&gt;/);
  assert.match(hostile, /stroke-dasharray/);
  assert.match(hostile, /PASS/);
  assert.match(slow, /FAIL/);
  assert.match(slow, /bar of 180\.0 s/);
});

test('the placeholder is written only when there is no result at all', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-charts-'));
  const { files } = writeCharts({ results: [], out: dir, ...TEST });
  assert.deepEqual(readdirSync(dir), ['no-verdict-yet.svg']);
  assert.equal(readFileSync(files[0], 'utf8'), emptySvg());
  assert.match(emptySvg(), /180\.0 s phone, 90\.0 s laptop; daily scan 30\.0 s; first scan 600\.0 s/);
  assert.doesNotMatch(emptySvg(), /PASS|FAIL/);
});

test('results with nothing judged make a chart that says so, never "no result"', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-charts-'));
  const { files } = writeCharts({ results: five(prove, { harness_commit: 'x-dirty' }), out: dir, ...TEST });
  assert.deepEqual(readdirSync(dir), ['nothing-to-draw.svg']);
  const svg = readFileSync(files[0], 'utf8');
  assert.match(svg, /No row has a pass or a fail yet: 1 row/);
  assert.doesNotMatch(svg, /no result|No verdict run yet/);
});

test('a row the summary judges FAIL for runs killed or missing is drawn as FAIL, with the summary reason', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-charts-'));
  for (const results of [five(prove, { outcome: 'killed' }), [...five(prove).slice(0, 4), prove({ outcome: 'killed' })]]) {
    const { devices } = plotModel(results, TEST);
    assert.equal(devices.get('Phone A')[0].outcome, 'fail');
    const { files } = writeCharts({ results, out: dir, ...TEST });
    assert.deepEqual(files.map((f) => f.split('/').pop()), ['phone-a.svg']);
    assert.match(readFileSync(files[0], 'utf8'), /FAIL: runs missing or killed/);
  }
});

test('a row refused for mixed builds keeps its scenario, so --only and the scenario json keep it', () => {
  const rows = [...five(prove).slice(0, 4), prove({ wasm_sha256: 'b', wasm_sha256_stamped: 'b' })];
  assert.equal(plotModel(rows, TEST, 'prove').skipped.length, 1);
  assert.equal(plotModel(rows, TEST, 'daily').skipped.length, 0);
  const dir = mkdtempSync(join(tmpdir(), 'kb-sc-in-')), out = mkdtempSync(join(tmpdir(), 'kb-sc-out-'));
  writeFileSync(join(dir, 'a.json'), JSON.stringify({ schema: 1, results: rows, cleared: [] }));
  const w = runScenario('prove', ['--results', dir, '--commit', COMMIT, '--out', out], () => {});
  assert.equal(JSON.parse(readFileSync(w.json, 'utf8')).rows.length, 1);
});

test('each --commit guard stands alone, and a refused scenario writes nothing', () => {
  assert.throws(() => writeCharts({ results: [], out: mkdtempSync(join(tmpdir(), 'kb-g-')) }), /--commit is required/);
  const dir = mkdtempSync(join(tmpdir(), 'kb-g-in-')), out = join(mkdtempSync(join(tmpdir(), 'kb-g-out-')), 'o');
  writeFileSync(join(dir, 'a.json'), JSON.stringify({ results: five(prove) }));
  assert.throws(() => runScenario('prove', ['--results', dir, '--out', out], () => {}), /--commit is required/);
  assert.equal(existsSync(out), false);
  const cli = spawnSync('node', [CHARTS, dir], { encoding: 'utf8' });
  assert.equal(cli.status, 2);
  assert.match(cli.stderr, /usage: node scripts\/charts\.mjs/);
});

test('a prove chart says key build, circuit preparation and first proof', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-charts-'));
  const { files } = writeCharts({ results: five(prove), out: dir, ...TEST });
  assert.match(readFileSync(files[0], 'utf8'), /key build \+ circuit preparation \+ first proof/);
});

test('input errors are one line, not a stack trace', () => {
  const script = fileURLToPath(new URL('../scripts/scenario-proxy-overhead.mjs', import.meta.url));
  const bad = join(mkdtempSync(join(tmpdir(), 'kb-bad-')), 'x.json');
  writeFileSync(bad, '{"label": "x"}');
  const notJson = join(dirname(bad), 'y.json');
  writeFileSync(notJson, '{bad');
  const cases = [[CHARTS, join(dirname(bad), 'missing'), '--commit', COMMIT], [CHARTS, dirname(bad), '--commit', COMMIT], [script, '--from', bad, '--out', dirname(bad)], [script, '--from', notJson, '--out', dirname(bad)]];
  for (const c of cases) {
    const r = spawnSync('node', c, { encoding: 'utf8' });
    assert.equal(r.status, 2, c.join(' '));
    assert.equal(r.stderr.trim().split('\n').length, 1, r.stderr);
    assert.doesNotMatch(r.stderr, /^\s+at |node:internal/m);
  }
});

test('the command needs --commit and draws what the summary lets through', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-charts-in-')), out = mkdtempSync(join(tmpdir(), 'kb-charts-out-'));
  writeFileSync(join(dir, 'a.json'), JSON.stringify({ schema: 1, results: five(prove), cleared: [] }));
  assert.equal(spawnSync('node', [CHARTS, dir, '--out', out]).status, 2);
  const ok = spawnSync('node', [CHARTS, dir, '--commit', COMMIT, '--out', out], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(readdirSync(out), ['phone-a.svg']);
  const wrong = spawnSync('node', [CHARTS, dir, '--commit', '7654321', '--out', out], { encoding: 'utf8' });
  assert.match(wrong.stderr, /REFUSED.*commit/);
  assert.equal(readdirSync(out).includes('nothing-to-draw.svg'), true);
});

// The scenario scripts: the link they print is one the page applies whole, the files they write come from the same summary, and the
// proxy script draws what proxy-latency.mjs wrote and reads nothing; without --read-approved it still refuses before any call.
import { proxySvg } from '../scripts/scenario-proxy-overhead.mjs';
import { parsePrefill } from '../web/prefill.mjs';

test('every scenario link is applied whole by the page, and a key in a link is refused', () => {
  for (const [name, sc] of Object.entries(SCENARIOS)) {
    const url = pageUrl({ ...sc.params, device: 'Phone A', class: 'phone' });
    const p = parsePrefill(new URL(url).search);
    assert.deepEqual([p.refused, p.ignored, p.invalid], [[], [], []], name);
    assert.equal(p.fields['do-prove'], name === 'prove');
  }
  assert.throws(() => pageUrl({ ufvk: 'x' }), /would not apply/);
  assert.throws(() => pageUrl({ endpoint: 'https://zec.rocks' }), /would not apply/);
});

test('a scenario script writes its summary rows and chart from saved results, and refuses with no commit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-sc-in-')), out = mkdtempSync(join(tmpdir(), 'kb-sc-out-'));
  writeFileSync(join(dir, 'a.json'), JSON.stringify({ schema: 1, results: [...five(prove), ...five(scan)], cleared: [] }));
  const log = [];
  assert.throws(() => runScenario('prove', ['--results', dir], (x) => log.push(x)), /--commit is required/);
  const w = runScenario('prove', ['--results', dir, '--commit', COMMIT, '--out', out], (x) => log.push(x));
  assert.match(log[0], /^Open: http:\/\/localhost:8090\/\?prove=1&scan=0/);
  const rows = JSON.parse(readFileSync(w.json, 'utf8')).rows;
  assert.deepEqual(rows.map((r) => r.kind), ['prove']);
  assert.deepEqual(readdirSync(out).sort(), ['phone-a.svg', 'prove.json']);
  assert.match(readFileSync(join(out, 'phone-a.svg'), 'utf8'), /PASS/);
});

const LAT = { proxy: { latest_block: { n: 3, median: 50, min: 40, max: 60 }, block_range: { n: 3, median: 900, min: 800, max: 1000 } }, direct: { latest_block: { n: 3, median: 30, min: 25, max: 35 }, block_range: { n: 3, median: 700, min: 650, max: 760 } } };
test('the proxy chart draws the saved output and says it is information only', () => {
  const svg = proxySvg({ label: 'proxied path minus a direct path, measured from <host>', runs: 3, range: { start: 1, end: 10, blocks: 10 }, proxy_origin: 'http://localhost:1234', ...LAT, difference_ms: { latest_block: 20, block_range: 200 } });
  assert.match(svg, /information only/);
  assert.match(svg, /difference 20\.0 ms/);
  assert.match(svg, /difference 200\.0 ms/);
  assert.match(svg, /&lt;host&gt;/);
  assert.doesNotMatch(svg, /PASS|FAIL|bar of/);
});

test('the proxy scenario refuses to read the chain without --read-approved', () => {
  const script = fileURLToPath(new URL('../scripts/scenario-proxy-overhead.mjs', import.meta.url));
  const r = spawnSync('node', [script, '--entry', 'http://localhost:1244', '--range', '1-10', '--out', mkdtempSync(join(tmpdir(), 'kb-px-'))], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--read-approved is required/);
});

test('the placeholder the README shows is the script output on an empty folder, not a drawing', () => {
  assert.equal(readFileSync(new URL('../charts/no-verdict-yet.svg', import.meta.url), 'utf8'), emptySvg());
  assert.match(readFileSync(new URL('../README.md', import.meta.url), 'utf8'), /charts\/no-verdict-yet\.svg/);
});
