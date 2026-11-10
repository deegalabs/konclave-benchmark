// SPDX-License-Identifier: MIT OR Apache-2.0
// One worker per run: a run shares no wasm state with any other, so nothing resumes and a key build is really timed.
import { treeState, blocks } from './grpcweb.js';
import { readLightdInfo, observations } from './observe.mjs';
import { describeThrown } from './errors.mjs';
import { redactUnpublished } from './test-vault.mjs';

const say = (o) => self.postMessage(o);
const now = () => performance.now();

const sha256 = async (bytes) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');

async function load(threads, stamped, gluestamped, snippetsStamped) {
  const dir = threads ? './pkg-mt/' : './pkg/';
  const t0 = now();
  // The glue the worker imports is hashed too, before it is imported, and must be the stamped one.
  const glue_sha256 = await sha256(await (await fetch(`${dir}konclave_benchmark.js`)).arrayBuffer());
  if (glue_sha256 !== gluestamped) throw new Error(`the glue served (${glue_sha256.slice(0, 12)}) is not the one build.sh stamped (${String(gluestamped).slice(0, 12)})`);
  // The helper files the threads glue imports are hashed too, each against its stamp.
  const snippets_sha256 = {};
  for (const [path, want] of Object.entries(snippetsStamped ?? {})) {
    snippets_sha256[path] = await sha256(await (await fetch(`${dir}${path}`)).arrayBuffer());
    if (snippets_sha256[path] !== want) throw new Error(`the snippet ${path} (${snippets_sha256[path].slice(0, 12)}) is not the one build.sh stamped (${String(want).slice(0, 12)})`);
  }
  const mod = await import(`${dir}konclave_benchmark.js`);
  const bytes = await (await fetch(`${dir}konclave_benchmark_bg.wasm`)).arrayBuffer();
  const wasm_sha256 = await sha256(bytes);
  // The page hands over the hash build.sh stamped for this flavour: a wasm with other bytes is not the build the run claims.
  if (wasm_sha256 !== stamped) throw new Error(`the wasm served (${wasm_sha256.slice(0, 12)}) is not the one build.sh stamped (${String(stamped).slice(0, 12)})`);
  const wasm = await mod.default({ module_or_path: bytes });
  if (threads) {
    // A helper that cannot start reports nowhere and the promise never settles: a hung row must end as a failed run.
    const limit = new Promise((_, no) => setTimeout(() => no(new Error('the thread pool did not start in 60 s')), 60000));
    await Promise.race([mod.initThreadPool(threads), limit]);
  }
  return { mod, wasm, wasm_sha256, glue_sha256, snippets_sha256, load_ms: Math.round(now() - t0) };
}

async function prove(ev, lib) {
  const p = new lib.mod.Prove(ev.pool);
  // Cold is read from the wasm's own state: no key in this instance before the build, and this the first proof it made.
  const had_key = p.has_key();
  say({ stage: 'key' });
  const p0 = now();
  let t = now();
  p.build_key();
  const key_build_ms = Math.round(now() - t);
  say({ stage: 'prepare' });
  t = now();
  const n_actions = p.prepare(ev.outputs);
  const prepare_ms = Math.round(now() - t);
  say({ stage: 'prove' });
  t = now();
  p.prove();
  const prove_ms = Math.round(now() - t);
  say({ stage: 'verify' });
  t = now();
  p.verify();
  const verify_ms = Math.round(now() - t);
  const pipeline_ms = Math.round(now() - p0);
  return { kind: 'prove', pipeline_ms, pool: ev.pool, n_actions, key_build_ms, prepare_ms, prove_ms, verify_ms, cold: !had_key && p.rounds() === 1, verified: true };
}

async function scan(ev, lib) {
  const stages_ms = {};
  // Checking the corpus is a preflight, outside the timer: nothing that is not the scan's own work is in the total.
  let preflight_ms = null;
  const timed = (name, f) => { say({ stage: name }); const t = now(); const r = f(); stages_ms[name] = Math.round(now() - t); return r; };
  let s;
  let p0;
  let seen = null;
  if (ev.live) {
    // One call more than a wallet needs, before the pipeline clock: its time is preflight_ms, accounted, never in a stage.
    say({ stage: 'lightd-info' });
    const lightd = await readLightdInfo(ev.live.endpoint, fetch, now);
    preflight_ms = lightd.preflight_ms;
    say({ stage: 'tree-state' });
    p0 = now();
    const st = await treeState(ev.live.endpoint, ev.live.start - 1);
    s = lib.mod.Scan.new_live(BigInt(ev.live.start), st.orchard, st.ironwood);
    stages_ms.tree_state = Math.round(now() - p0);
    say({ stage: 'download' });
    const tt = now();
    let received = 0;
    for await (const m of blocks(ev.live.endpoint, ev.live.start, ev.live.end)) { s.push(m); received++; }
    if (received !== ev.live.end - ev.live.start + 1) throw new Error(`asked for ${ev.live.end - ev.live.start + 1} blocks, got ${received}`);
    // Download covers fetching the blocks and handing each to the module, which is how a wallet receives them.
    stages_ms.download = Math.round(now() - tt);
    const te = now();
    const endState = await treeState(ev.live.endpoint, ev.live.end);
    if (endState.height !== ev.live.end) throw new Error(`asked for the tree at ${ev.live.end}, got ${endState.height}`);
    s.set_expected_end(endState.orchard, endState.ironwood);
    // The two tree states above, kept as they came: nothing is fetched again for the record.
    seen = observations(lightd.info, st, endState);
    stages_ms.end_tree_state = Math.round(now() - te);
  } else {
    const t = now();
    const bytes = new Uint8Array(await (await fetch(ev.corpus)).arrayBuffer());
    s = new lib.mod.Scan(bytes);
    // The corpus's own hash shows it is whole; the .sha256 beside it (written with it by gen_corpus or pack_corpus) is compared with it here.
    const pinned = await fetch(`${ev.corpus}.sha256`);
    const want = pinned.ok ? (await pinned.text()).trim() : null;
    const got = JSON.parse(s.summary()).corpus_sha256;
    if (want !== got) throw new Error(`this corpus is ${got}, its record says ${want}`);
    preflight_ms = Math.round(now() - t);
    p0 = now();
  }
  // A day's sync continues from a wallet's state, so a daily range that starts from nothing measures something else.
  if (ev.range_kind === 'daily' && s.starts_empty()) throw new Error('a daily range must start from the tree state before it');
  if (ev.filter != null) s.set_filter(ev.filter);
  if (ev.ufvk) s.set_ufvk(ev.ufvk);
  timed('decode', () => s.decode());
  const notes = timed('decrypt', () => s.decrypt());
  timed('tree', () => s.tree());
  const total_ms = Object.values(stages_ms).reduce((a, b) => a + b, 0);
  // Timed apart from the stages, so a stage that stops covering its work shows up as a gap.
  const pipeline_ms = Math.round(now() - p0);
  // A wallet computes a witness when it spends, not when it scans, so this time is reported and never in the total.
  say({ stage: 'witness' });
  const w0 = now();
  const witnesses = s.witness();
  const witness_ms = Math.round(now() - w0);
  const summary = JSON.parse(s.summary());
  // A typed key that is not the published test key leaves no amount and no note count in the result (web/test-vault.mjs).
  return redactUnpublished({ kind: 'scan', range_kind: ev.range_kind, live_or_replay: ev.live ? 'live' : 'replay', start_state: s.starts_empty() ? 'empty trees' : 'tree state before the range, empty wallet', notes, witnesses, stages_ms, total_ms, pipeline_ms, preflight_ms, witness_ms, ...(seen ?? {}), ...summary });
}

let used = false;

self.onmessage = async ({ data: ev }) => {
  // One job per worker is what makes a run cold, so a second job is refused rather than quietly reusing the key.
  if (used) { say({ failed: 'a worker runs one job' }); return; }
  used = true;
  try {
    const lib = await load(ev.threads, ev.wasm_sha256_stamped, ev.glue_sha256_stamped, ev.snippets_sha256_stamped);
    const threads = lib.mod.thread_count();
    const flavour = lib.mod.build_flavour();
    const r = ev.kind === 'prove' ? await prove(ev, lib) : await scan(ev, lib);
    const wasm_memory_bytes = lib.wasm.memory.buffer.byteLength;
    say({ done: { ...r, worker_isolated: self.crossOriginIsolated === true, fresh_worker: true, threads, flavour, wasm_sha256: lib.wasm_sha256, glue_sha256: lib.glue_sha256, snippets_sha256: lib.snippets_sha256, wasm_load_ms: lib.load_ms, wasm_memory_bytes } });
  } catch (e) {
    say({ failed: describeThrown(e) });
  }
};
