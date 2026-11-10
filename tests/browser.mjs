// SPDX-License-Identifier: MIT OR Apache-2.0
// Real browser checks on this machine, nothing beyond it.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.js CHROMIUM=/path/to/chrome node tests/browser.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { serve } from '../scripts/serve.mjs';
import { mock } from '../scripts/mock-lightwalletd.mjs';
import { refusals } from '../scripts/summarize.mjs';

const P = Number(process.env.KB_PORT ?? 18910);
const pw = await import(process.env.PLAYWRIGHT_MODULE);
const browser = await (pw.chromium ?? pw.default.chromium).launch({ executablePath: process.env.CHROMIUM });
const corpus = readFileSync(new URL('../web/corpus/synthetic-10k.bin', import.meta.url));
const plain = await serve(P + 1);
const isolated = await serve(P + 2, { isolated: true });
const end = JSON.parse(readFileSync(new URL('../web/corpus/synthetic-10k.bin.end.json', import.meta.url), 'utf8'));
const lwd = await mock(P + 3, corpus, { end });
const lwdBad = await mock(P + 4, corpus);
const external = [];

// Each section uses the page it just opened, and a threads page keeps a large shared memory: the contexts of earlier sections are closed first,
// or a long run ends in net::ERR_INSUFFICIENT_RESOURCES.
const newContext = async () => { for (const c of browser.contexts()) await c.close(); return browser.newContext(); };

async function open(url) {
  const ctx = await newContext();
  const page = await ctx.newPage();
  // On the context, so a dedicated or service worker's request is seen where Playwright exposes it.
  ctx.on('request', (r) => { const h = new URL(r.url()).hostname; if (/^https?:/.test(r.url()) && h !== 'localhost' && h !== '127.0.0.1') external.push(r.url()); });
  await page.goto(url);
  await page.fill('#device', 'test laptop');
  await page.selectOption('#device-class', 'laptop');
  return page;
}
// The page keeps Run disabled until start() has read the stamp and installed its handler, and writes #commit and #isolated before that:
// waiting for the button is waiting for the page to be ready for a tap.
const ready = (pg) => pg.waitForFunction(() => !document.getElementById('go').disabled, null, { timeout: 30000 });
const results = async (page) => JSON.parse(await page.inputValue('#out')).results;
const finished = (page, timeout = 300000) => page.waitForFunction(() => document.getElementById('stage').textContent === 'finished', null, { timeout });
const check = (name, ok) => { assert.ok(ok, name); console.log(`ok - ${name}`); };

// Scan, replay, one thread
let page = await open(`http://localhost:${P+1}/index.html`);
await page.uncheck('#do-prove');
await page.check('#do-scan');
await page.fill('#runs', '2');
await ready(page); await page.click('#go');
await finished(page);
let r = await results(page);
check('replay runs and lists every run', r.length === 2 && r.every((x) => x.outcome === 'ok'));
check('stages are all there', ['decode', 'decrypt', 'tree'].every((s) => r[0].stages_ms[s] >= 0) && r[0].witness_ms > 0);
check('the stages cover the time they ran, timed apart', r.every((x) => Math.abs(x.pipeline_ms - x.total_ms) < Math.max(250, 0.05 * x.pipeline_ms)));
// On what the page really wrote: an honest run is accounted for, and the same run with its work hidden is not.
const unaccounted = (rows) => refusals(rows).filter((w) => /no stage accounts/.test(w));
check('the page clock accounts for an honest scan', unaccounted(r).length === 0);
check('the same run with its stages emptied is refused', unaccounted(r.map((x) => ({ ...x, pipeline_ms: 0, total_ms: 0, preflight_ms: 0, witness_ms: 0 }))).length === 1);
check('the page names its isolation mode and a session', r.every((x) => /not isolated/.test(x.isolation_mode) && x.session_id && x.session_id === r[0].session_id));
check('the result is shown on the page', /prove|scan/.test(await page.textContent('#summary')));
check('the page applies no filter by default', r.every((x) => x.filter === null));
const served = new Uint8Array(await (await fetch(`http://localhost:${P + 1}/pkg/konclave_benchmark_bg.wasm`)).arrayBuffer());
const servedHash = createHash('sha256').update(served).digest('hex');
check('the hash in the JSON is the file served', r.every((x) => x.wasm_sha256 === servedHash));
check('the JSON says two keys and both pools', r[0].ivk_count === 2 && r[0].actions_by_pool.orchard > 0 && r[0].actions_by_pool.ironwood > 0);
check('the corpus check is outside the total', r[0].preflight_ms >= 0 && r[0].stages_ms.hash === undefined);
check('notes found equal witnesses', r[0].notes > 0 && r[0].notes === r[0].witnesses);
check('it reports one thread and which build', r[0].threads === 1 && r[0].flavour === 'single' && r[0].wasm_sha256.length === 64);
console.log(`  replay ${r[0].total_ms} ms ${JSON.stringify(r[0].stages_ms)} witness ${r[0].witness_ms} ${r[0].actions_by_pool.orchard + r[0].actions_by_pool.ironwood} actions`);

// The class is what picks a bar, so a run without one does not start
page = await open(`http://localhost:${P + 1}/index.html`);
await page.selectOption('#device-class', '');
await ready(page); await page.click('#go');
await page.waitForFunction(() => document.getElementById('log').textContent.includes('device class'));
check('a run with no device class does not start', (await results(page)).length === 0);

// Threads on a page that cannot have them
page = await open(`http://localhost:${P+1}/index.html`);
await page.uncheck('#do-prove');
await page.check('#do-scan');
await page.selectOption('#threads', 'on');
await ready(page); await page.click('#go');
await page.waitForFunction(() => document.getElementById('log').textContent.includes('Refused'));
r = await results(page);
check('threads on a plain page refuse', r.length === 1 && r[0].outcome === 'refused' && r[0].cross_origin_isolated === false && r[0].threads === 1);

// Threads under real headers
page = await open(`http://localhost:${P+2}/threads.html`);
await page.uncheck('#do-prove');
await page.check('#do-scan');
await page.selectOption('#threads', 'on');
await page.fill('#nthreads', '4');
await page.fill('#runs', '1');
await ready(page); await page.click('#go');
await finished(page);
r = await results(page);
const th = r.at(-1);
check('threads under server headers say so', /server/.test(th.isolation_mode));
check('threads run with the count asked', th.outcome === 'ok' && th.threads === 4 && th.flavour === 'threads' && th.cross_origin_isolated === true && th.worker_isolated === true);
check('threads find the same notes', th.notes > 0 && th.notes === th.witnesses);
console.log(`  threads ${th.total_ms} ms ${JSON.stringify(th.stages_ms)}`);

// The threads are real. One thread and four, in the threads build, on the same page.
const threadedRow = async (kind, n) => {
  const q = await open(`http://localhost:${P + 2}/threads.html`);
  if (kind === 'prove') { await q.fill('#axis', '1'); } else { await q.uncheck('#do-prove'); await q.check('#do-scan'); }
  await q.selectOption('#threads', 'on');
  await q.fill('#nthreads', String(n));
  await q.fill('#runs', '1');
  await ready(q); await q.click('#go');
  await finished(q);
  const all = await results(q);
  if (n > 1) assert.deepEqual(all.map((y) => y.threads_asked), [1, n], 'a threads row runs its control first');
  const x = all.at(-1);
  assert.equal(x.outcome, 'ok', x.error);
  assert.equal(x.threads, n);
  return x;
};
// The ratio needs cores: on a host with fewer than 2 the check says so instead of crying wolf.
const cores = (await import('node:os')).availableParallelism();
if (cores < 2) console.log(`  skipped: the threads ratio needs 2 or more cores, this host has ${cores}`);
const [p1, p4, s1, s4] = cores < 2 ? [{ prove_ms: 2 }, { prove_ms: 1 }, { stages_ms: { decrypt: 2 } }, { stages_ms: { decrypt: 1 } }] : [await threadedRow('prove', 1), await threadedRow('prove', 4), await threadedRow('scan', 1), await threadedRow('scan', 4)];
console.log(`  proof ${p1.prove_ms} ms at 1, ${p4.prove_ms} at 4; decrypt ${s1.stages_ms.decrypt} at 1, ${s4.stages_ms.decrypt} at 4`);
if (cores >= 2) {
  check('four threads really prove faster than one', p4.prove_ms < 0.75 * p1.prove_ms);
  check('four threads really decrypt faster than one', s4.stages_ms.decrypt < 0.75 * s1.stages_ms.decrypt);
  check('a threaded proof verifies', p4.verified === true);
}

// A row names the build that ran it. The stamps of the two flavours are the real ones (what build.sh wrote), so the gate has one reason to
// stop a run at a time: first a commit that is not the page script's, then the real commit with the flavours told apart by their rustc.
const realMeta = (dir) => JSON.parse(readFileSync(new URL(`../web/${dir}/meta.json`, import.meta.url), 'utf8'));
const stampedPage = async (threadsMeta, singleMeta) => {
  const pg = await (await newContext()).newPage();
  pg.context().on('request', (q) => { const h = new URL(q.url()).hostname; if (/^https?:/.test(q.url()) && h !== 'localhost' && h !== '127.0.0.1') external.push(q.url()); });
  await pg.route('**/pkg-mt/meta.json', (route) => route.fulfill({ json: threadsMeta }));
  await pg.route('**/pkg/meta.json', (route) => route.fulfill({ json: singleMeta }));
  await pg.goto(`http://localhost:${P + 2}/threads.html`);
  await pg.fill('#device', 'test laptop');
  await pg.selectOption('#device-class', 'laptop');
  await pg.uncheck('#do-prove');
  await pg.check('#do-scan');
  await pg.selectOption('#threads', 'on');
  await pg.fill('#runs', '1');
  await ready(pg);
  return pg;
};
page = await stampedPage({ ...realMeta('pkg-mt'), commit: 'THREADS-BUILD' }, { ...realMeta('pkg'), commit: 'SINGLE-BUILD' });
await page.click('#go');
await page.waitForFunction(() => document.getElementById('log').textContent.includes('Refused'), null, { timeout: 30000 });
check('a wasm stamp of another commit than the page script refuses the run, and nothing runs', /differ/.test(await page.textContent('#log')) && (await results(page)).length === 0);
const stampCommit = JSON.parse(readFileSync(new URL('../web/stamp.json', import.meta.url), 'utf8')).commit;
check('the real stamps are of the commit the page script is stamped with', realMeta('pkg').commit === stampCommit && realMeta('pkg-mt').commit === stampCommit);
page = await stampedPage({ ...realMeta('pkg-mt'), rustc: 'THREADS-RUSTC' }, { ...realMeta('pkg'), rustc: 'SINGLE-RUSTC' });
await page.click('#go');
await finished(page);
r = await results(page);
check('a threads row carries the threads build, told apart by its rustc', r.length === 2 && r.every((x) => x.rustc === 'THREADS-RUSTC' && x.flavour_built === 'threads' && x.harness_commit === stampCommit));
check('every run records the wasm stamp of its flavour, and it is the hash of the wasm that ran', r.every((x) => x.wasm_sha256_stamped === realMeta('pkg-mt').wasm_sha256 && x.wasm_sha256 === x.wasm_sha256_stamped));

// A wasm whose bytes are not the stamped ones does not run: the worker refuses it and the row is a failed run.
page = await open(`http://localhost:${P + 1}/index.html`);
await page.route('**/pkg/konclave_benchmark_bg.wasm', (route) => route.fulfill({ body: Buffer.from('not the stamped wasm'), contentType: 'application/wasm' }));
await page.uncheck('#do-prove');
await page.check('#do-scan');
await page.fill('#runs', '1');
await ready(page);
await page.click('#go');
await finished(page);
r = await results(page);
check('a wasm that is not the stamped one fails the run', r.length === 1 && r[0].outcome === 'failed' && /not the one build\.sh stamped/.test(r[0].error));

// Run stays disabled while the page reads its stamp, so a tap cannot be lost
page = await (await newContext()).newPage();
let release;
const held = new Promise((ok) => { release = ok; });
await page.route('**/stamp.json', async (route) => { await held; await route.continue(); });
await page.goto(`http://localhost:${P + 1}/index.html`);
check('Run is disabled while the page reads its stamp', await page.isDisabled('#go'));
release();
await ready(page);
check('and enabled once the page is ready', !(await page.isDisabled('#go')));

// A key pasted into a free field stops the run
page = await open(`http://localhost:${P + 1}/index.html`);
await page.fill('#device', `phone uview1${'q'.repeat(40)}`);
await ready(page);
await page.click('#go');
await page.waitForFunction(() => document.getElementById('log').textContent.includes('looks like a key'));
check('a key in the device field refuses the run, and the page does not echo it', (await results(page)).length === 0 && !(await page.textContent('#log')).includes('qqqq'));

// A range picked by its id is refused while the table has no heights: nothing runs and nothing is recorded
page = await open(`http://localhost:${P + 1}/index.html`);
await page.uncheck('#do-prove');
await page.check('#do-scan');
await page.selectOption('#range-kind', 'first-scan');
await page.fill('#endpoint', `http://localhost:${P + 3}`);
await ready(page);
await page.click('#go');
await page.waitForFunction(() => document.getElementById('log').textContent.includes('is not fixed by the protocol yet'));
check('a range picked by id is refused while its heights are not fixed, and nothing is recorded', (await results(page)).length === 0);

// Runs stored in this browser from another commit warn before Run, and the warning goes with the stored runs
page = await open(`http://localhost:${P + 1}/index.html`);
await page.evaluate(() => localStorage.setItem('kb.cleared', JSON.stringify([{ cleared_at: 't', run: { row: 'prove-n2', outcome: 'ok', harness_commit: 'deadbee', js_commit: 'deadbee' } }])));
await page.reload();
await ready(page);
await page.waitForFunction(() => document.getElementById('trail-warning').textContent.includes('deadbee'));
check('a stored run of another commit is warned about before Run', /another commit \(deadbee\)/.test(await page.textContent('#trail-warning')));
await page.evaluate(() => localStorage.removeItem('kb.cleared'));
await page.reload();
await ready(page);
check('and the warning is gone once the stored runs are', (await page.textContent('#trail-warning')) === '');

// A server that leaves a block out
const lwdDrop = await mock(P + 5, corpus, { end, dropBlock: lwd.start + 3 });
page = await open(`http://localhost:${P + 1}/index.html`);
await page.uncheck('#do-prove');
await page.check('#do-scan');
await page.fill('#endpoint', `http://localhost:${P + 5}`);
await page.fill('#start', String(lwd.start));
await page.fill('#end', String(lwd.start + lwd.count - 1));
await page.fill('#runs', '1');
await ready(page); await page.click('#go');
await finished(page);
r = await results(page);
check('a live range missing a block fails', r[0].outcome === 'failed' && /asked for/.test(r[0].error));
lwdDrop.server.close();

// Threads on a static host: the page's own service worker supplies the headers
page = await open(`http://localhost:${P+1}/threads.html`);
await page.waitForFunction(() => self.crossOriginIsolated === true, null, { timeout: 30000 });
check('the threads page isolates itself on a plain host', await page.evaluate(() => self.crossOriginIsolated === true));
await ready(page);
check('and says it is the service worker', /service worker/.test(await page.textContent('#isolated')));

// Live, against the mock on this machine
page = await open(`http://localhost:${P+1}/index.html`);
await page.uncheck('#do-prove');
await page.check('#do-scan');
await page.fill('#endpoint', `http://localhost:${P+3}`);
await page.fill('#start', String(lwd.start));
await page.fill('#end', String(lwd.start + lwd.count - 1));
await page.fill('#runs', '1');
await ready(page); await page.click('#go');
await finished(page);
r = await results(page);
check('live row', r[0].outcome === 'ok' && r[0].live_or_replay === 'live' && r[0].stages_ms.download >= 0 && r[0].stages_ms.end_tree_state >= 0 && r[0].stages_ms.tree_state >= 0 && r[0].corpus_sha256 === null);
check('the mock saw both calls', lwd.requests.includes('GetTreeState') && lwd.requests.includes('GetBlockRange'));

// The server's end state does not match the blocks it sent
page = await open(`http://localhost:${P+1}/index.html`);
await page.uncheck('#do-prove');
await page.check('#do-scan');
await page.fill('#endpoint', `http://localhost:${P+4}`);
await page.fill('#start', String(lwd.start));
await page.fill('#end', String(lwd.start + lwd.count - 1));
await page.fill('#runs', '1');
await ready(page); await page.click('#go');
await finished(page);
r = await results(page);
check('a live range whose end root differs fails', r[0].outcome === 'failed' && /root/.test(r[0].error));

// A corpus that is whole but not the one on record
page = await (await newContext()).newPage();
await page.route('**/*.sha256', (route) => route.fulfill({ body: 'f'.repeat(64) }));
await page.goto(`http://localhost:${P + 1}/index.html`);
await page.fill('#device', 'test laptop');
await page.selectOption('#device-class', 'laptop');
await page.uncheck('#do-prove');
await page.check('#do-scan');
await page.fill('#runs', '1');
await ready(page); await page.click('#go');
await finished(page);
r = await results(page);
check('a corpus that differs from its record is refused', r[0].outcome === 'failed' && /record says/.test(r[0].error));

page = await open(`http://localhost:${P+1}/index.html`);
await page.uncheck('#do-prove');
await page.check('#do-scan');
await page.selectOption('#range-kind', 'daily');
await page.fill('#runs', '1');
await ready(page); await page.click('#go');
await finished(page);
r = await results(page);
check('a daily range from empty trees is refused', r[0].outcome === 'failed' && /daily/.test(r[0].error));

// After a visit to threads.html the plain page stays plain
page = await open(`http://localhost:${P+1}/threads.html`);
await page.waitForFunction(() => self.crossOriginIsolated === true, null, { timeout: 30000 });
await page.goto(`http://localhost:${P+1}/index.html`);
check('index.html stays not isolated', (await page.evaluate(() => self.crossOriginIsolated)) === false);

// Reload in the middle of a run, in a real page
page = await open(`http://localhost:${P+1}/index.html`);
await page.fill('#axis', '1');
await page.fill('#runs', '1');
await ready(page); await page.click('#go');
await page.waitForFunction(() => document.getElementById('stage').textContent.includes('key'), null, { timeout: 60000 });
await page.reload();
await page.waitForFunction(() => document.getElementById('log').textContent.includes('did not end'));
r = await results(page);
check('a page reloaded mid-run records a killed run', r.at(-1).outcome === 'killed' && r.at(-1).stage === 'key');

// Proof
page = await open(`http://localhost:${P+1}/index.html`);
await page.fill('#axis', '2');
await page.fill('#runs', '2');
await ready(page); await page.click('#go');
await finished(page);
r = await results(page);
check('the page clock accounts for an honest proof', unaccounted(r).length === 0);
check('proof verifies and reports key and proof apart', r[0].outcome === 'ok' && r[0].verified && r[0].n_actions === 2 && r[0].key_build_ms > 0 && r[0].prove_ms > 0);
// A key kept from an earlier run would make the second build near nothing.
check('every run is cold: the second key build costs what the first did', r.length === 2 && r.every((x) => x.cold === true) && r[1].key_build_ms > 0.5 * r[0].key_build_ms);
check('the proof stages cover the time they ran', r.every((x) => Math.abs(x.pipeline_ms - (x.key_build_ms + x.prepare_ms + x.prove_ms + x.verify_ms)) < Math.max(250, 0.05 * x.pipeline_ms)));
console.log(`  proof key ${r[0].key_build_ms} ms, proof ${r[0].prove_ms} ms`);

console.log(`  other requests: ${JSON.stringify(external)}`);
check('no request left this machine', external.length === 0);
await browser.close();
plain.close(); isolated.close(); lwd.server.close();
process.exit(0);
