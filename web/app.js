// SPDX-License-Identifier: MIT OR Apache-2.0
import { pageSummary, TEXT_LIMITS } from './summarize-core.mjs';
import { readJsStamp, startRefusal, trailWarning } from './stamp.mjs';
import { workerErrorReason } from './errors.mjs';
import { parsePrefill, prefillText, stripUnapplied } from './prefill.mjs';
import { keyInFreeFields } from './keys.mjs';
import { planRows, tooLongField, threadCounts, buildFor } from './plan.mjs';
import { trackRun } from './runner.mjs';
import { openRun, markStage, closeRun, recoverKilled, loadSession, saveSession, loadCleared, clearRuns, exportJson } from './runs.js';

const $ = (id) => document.getElementById(id);
const store = window.localStorage;
let results = loadSession(store);
let cleared = loadCleared(store);
let metas = { single: {}, threads: {} };
let jsStamp = { js_commit: 'unknown', js_files_match: false };
let worker = null;
let stopped = false;
let current = null;
let tracker = null;
let urlParams = {};
// One id per page load: a session file can be matched to the runs it holds, and the summary keeps each session's runs in a row of their own.
const session_id = crypto.randomUUID();

function log(t) { $('log').textContent += `${t}\n`; }
function show() {
  $('out').value = exportJson(results, cleared);
  // The result, readable, by the same rules the report uses. Nothing is sent anywhere: copying is the only way out.
  $('summary').textContent = pageSummary(results, cleared, jsStamp);
  $('trail-warning').textContent = trailWarning(cleared, jsStamp);
  $('count').textContent = `${results.length} runs in this session`;
}
function add(r) { results.push(r); saveSession(store, results); show(); }

// The build that runs this row, not whichever was built last: the two flavours are stamped apart.
// How this page got (or did not get) the headers threads need. Shown on the page and kept in every result.
function isolationMode() {
  if (!self.crossOriginIsolated) return 'not isolated: single thread only';
  return navigator.serviceWorker?.controller ? 'isolated by this page\'s service worker' : 'isolated by the server\'s headers';
}

function context(threads = 0) {
  const meta = metas[buildFor(threads)];
  return {
    harness_commit: meta.commit ?? 'unknown', crate_line: meta.crates ?? null, flavour_built: meta.flavour ?? null, rustc: meta.rustc ?? null, wasm_sha256_stamped: meta.wasm_sha256 ?? null, glue_sha256_stamped: meta.glue_sha256 ?? null, snippets_sha256_stamped: meta.snippets_sha256 ?? null, device_label: $('device').value.trim(),
    session_id, url_params: urlParams, ...jsStamp, isolation_mode: isolationMode(),
    device_class: $('device-class').value, android: /Android (\d+)/.exec(navigator.userAgent)?.[1] ?? null,
    temp_before: $('temp').value.trim() || null, charging: $('charging').checked,
    user_agent: navigator.userAgent.slice(0, TEXT_LIMITS.user_agent), hardware_concurrency: navigator.hardwareConcurrency,
    cross_origin_isolated: self.crossOriginIsolated === true,
  };
}

function runOnce(job, row) {
  return new Promise((resolve) => {
    row.run_id = crypto.randomUUID();
    row.started_at = new Date().toISOString();
    current = row;
    openRun(store, row);
    worker = new Worker('./worker.js', { type: 'module' });
    // Stage and seconds, the hidden watch and the end record are the tracker's; the worker sends nothing more than it did.
    tracker = trackRun({ row, job, doc: document, win: window, perf: () => performance.now(), now: () => new Date().toISOString(), readTemp: () => $('temp').value, show: (t) => { $('stage').textContent = t; }, setTimer: setInterval, clearTimer: clearInterval });
    const finish = (fields) => { const r = tracker.finish(fields); tracker = null; closeRun(store); worker.terminate(); worker = null; current = null; add(r); resolve(r); };
    worker.onmessage = ({ data }) => {
      if (data.stage) { markStage(store, data.stage); tracker.stage(data.stage); }
      else if (data.done) finish({ ...data.done, outcome: 'ok' });
      else if (data.failed) finish({ outcome: 'failed', error: data.failed });
    };
    worker.onerror = (e) => finish({ outcome: 'failed', error: workerErrorReason(e, document.visibilityState) });
    worker.postMessage(job);
  });
}

function readForm() {
  return {
    threads: $('threads').value, nthreads: $('nthreads').value, hardwareConcurrency: navigator.hardwareConcurrency, runs: $('runs').value,
    prove: $('do-prove').checked, axis: $('axis').value, pool: $('pool').value,
    scan: $('do-scan').checked, endpoint: $('endpoint').value, ufvk: $('ufvk').value, filter: $('filter').value, treeInsert: $('tree-insert').value, rangeKind: $('range-kind').value,
    corpus: $('corpus').value, start: $('start').value, end: $('end').value,
  };
}

async function runAll() {
  if (!$('device').value.trim()) { log('Name the device first.'); return; }
  if (!$('device-class').value) { log('Choose the device class first.'); return; }
  // Only the key field may hold a key: a key pasted into another field would be saved with every result (the name is shown, never the text).
  const f = readForm();
  const inKey = keyInFreeFields({ device: $('device').value, temp: $('temp').value, corpus: f.corpus, endpoint: f.endpoint, start: f.start, end: f.end, filter: f.filter, axis: f.axis, runs: f.runs, nthreads: f.nthreads });
  if (inKey) { log(`Refused: the ${inKey} field holds something that looks like a key. Clear it.`); return; }
  const tooLong = tooLongField({ device: $('device').value, temp: $('temp').value, corpus: f.corpus, endpoint: f.endpoint, start: f.start, end: f.end, filter: f.filter, axis: f.axis, runs: f.runs, nthreads: f.nthreads });
  if (tooLong) { log(`Refused: the ${tooLong} field is too long.`); return; }
  let plan;
  try { plan = planRows(readForm()); } catch (e) { log(`Refused: ${e.message}.`); return; }
  const { rows, runs, threads } = plan;
  if (threads && !self.crossOriginIsolated) {
    // Never a parallel number from a page that cannot have one.
    add({ ...context(threads), row: 'threads-refused', run_index: 1, runs_planned: 1, threads_asked: threads, outcome: 'refused', error: 'threads asked for, but this page is not cross-origin isolated', threads: 1 });
    log('Refused: this page is not cross-origin isolated, so threads cannot run. Open threads.html.');
    return;
  }
  // One page, one build: the script and every wasm this run will load must carry the same commit.
  const why = startRefusal(jsStamp, metas, threads);
  if (why) { log(`Refused: ${why}.`); return; }
  stopped = false;
  $('go').disabled = true;
  let order = 0;
  // Every threads row has a one-thread control of the same build beside it, or "faster" means nothing.
  const counts = threadCounts(threads);
  for (const r of rows) for (const t of counts) {
    for (let i = 1; i <= runs && !stopped; i++) {
      const row = { ...context(t), row: r.row, range_asked: r.range_asked ?? null, pool: r.pool, filter: r.filter, tree_insert_asked: r.tree_insert, live_or_replay_asked: r.live_or_replay_asked, endpoint: r.endpoint, ...r.declared, run_index: i, runs_planned: runs, order_in_session: ++order, threads_asked: t };
      const res = await runOnce({ ...r.job, threads: t, wasm_sha256_stamped: metas[buildFor(t)].wasm_sha256, glue_sha256_stamped: metas[buildFor(t)].glue_sha256, snippets_sha256_stamped: metas[buildFor(t)].snippets_sha256 }, row);
      const shown = res.outcome !== 'ok' ? `${res.outcome}: ${res.error}` : res.kind === 'prove'
        ? `key ${(res.key_build_ms / 1000).toFixed(1)} s, proof ${(res.prove_ms / 1000).toFixed(1)} s, ${res.n_actions} actions`
        : `${(res.total_ms / 1000).toFixed(1)} s, ${res.notes} notes, ${JSON.stringify(res.stages_ms)}`;
      log(`${r.row} run ${i}/${runs}: ${shown}`);
    }
  }
  $('go').disabled = false;
  $('stage').textContent = stopped ? 'stopped' : 'finished';
}

// A link fills the form; it never starts a run and never carries a key. A refused parameter is dropped from the address too.
function applyPrefill() {
  const p = parsePrefill(location.search);
  for (const [id, v] of Object.entries(p.fields)) {
    const el = $(id);
    if (el.type === 'checkbox') el.checked = v === true;
    else { el.value = v; if (el.value !== v) { p.invalid.push(id); delete p.fields[id]; } }
  }
  urlParams = p.fields;
  $('prefill').textContent = prefillText(p);
  // Everything that was not applied leaves the address bar, not only the refused names.
  history.replaceState(null, '', `${location.pathname}${stripUnapplied(location.search, p.fields)}${location.hash}`);
}

async function start() {
  applyPrefill();
  const read = (dir) => fetch(`./${dir}/meta.json`).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  metas = { single: await read('pkg'), threads: await read('pkg-mt') };
  jsStamp = await readJsStamp((u) => fetch(u), (b) => crypto.subtle.digest('SHA-256', b));
  $('commit').textContent = `wasm ${metas.single.commit ?? 'unknown'} (threads ${metas.threads.commit ?? 'unknown'}), page script ${jsStamp.js_commit}${jsStamp.js_files_match ? '' : ' (NOT the stamped files)'}`;
  $('isolated').textContent = isolationMode();
  const killed = recoverKilled(store);
  if (killed) { add(killed); log(`A run did not end: ${killed.row} run ${killed.run_index}, last stage ${killed.stage}. Recorded as killed.`); }
  show();
  $('go').onclick = runAll;
  // Run is disabled in the page until the stamp is read and this handler is installed: an earlier tap would do nothing and say nothing.
  $('go').disabled = false;
  $('stop').onclick = () => {
    stopped = true;
    if (worker) { tracker?.stop(); tracker = null; worker.terminate(); worker = null; closeRun(store); add({ ...context(), ...current, outcome: 'stopped' }); current = null; }
    $('go').disabled = false;
    $('stage').textContent = 'stopped';
  };
  $('copy').onclick = () => navigator.clipboard.writeText($('out').value);
  // Clear moves the runs to a trail that the summary and the copied JSON keep; nothing is deleted.
  $('clear').onclick = () => { results = clearRuns(store, results); cleared = loadCleared(store); show(); };
}
start();
