// SPDX-License-Identifier: MIT OR Apache-2.0
// The verdict rules, in one place: the page shows them to whoever runs it, and scripts/summarize.mjs prints them from
// saved JSON. Every number in a report comes out of here, from the raw JSON only.
// One table of bars, one comparison. A run that is missing or failed is printed, and a row short of its runs has no verdict.

// The application's bars, pending confirmation on the forum. A bar that is null prints the time with no verdict.
export const BARS = { prove_phone_ms: 180000, prove_laptop_ms: 90000, daily_ms: 30000, first_sync_ms: 600000 };

import { bareOrigin } from './endpoint.mjs';
import { ENDPOINTS, findEndpoint, declaredFor, verdictReady } from './endpoints.mjs';
import { TEST_KEY_SHA256, isPublishedKey, NOT_PUBLISHED } from './test-vault.mjs';
import { RANGES, askedEntry, didAsked, NOT_FIXED, INFORMATION } from './ranges.mjs';

// The endpoint table (web/endpoints.mjs) decides which live endpoint may carry a verdict: an entry with role 'verdict' and a host name.
// Any other live endpoint is reported, never a verdict. opts.endpoints lets a test give another table.
const tableOf = (opts) => opts?.endpoints ?? ENDPOINTS;
const rangesOf = (opts) => opts?.ranges ?? RANGES;
const entryOf = (r, opts) => findEndpoint(bareOrigin(r.endpoint ?? ''), tableOf(opts));

// A verdict row is five ok runs or it is short: one lucky run is not a result.
export const MIN_VERDICT_RUNS = 5;

// A run counts only if it started at or below an absolute 35 C (battery) AND within 2 C of the first reading of its session: a hot
// phone throttles, and a session that began warm is not allowed to drift or to start over the line.
export const HOT_START_ABSOLUTE_C = 35;
export const HOT_START_OVER_FIRST_C = 2;

// The time of each stage a run timed, by name: a proof has its four phases, a scan the entries of stages_ms. Witnesses are not a stage.
const stagesOf = (r) => (r.kind === 'prove' ? { key: r.key_build_ms, prepare: r.prepare_ms, prove: r.prove_ms, verify: r.verify_ms } : r.stages_ms ?? {});

export const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export function browser(ua = '') {
  const m = /(Firefox|Chrome)\/(\d+)/.exec(ua);
  return m ? `${m[1]} ${m[2]}` : 'unknown';
}

// What a row is timed on. For a proof it is the wait a member really has: the key build plus the first proof.
export function timed(r) {
  return r.kind === 'prove' ? r.key_build_ms + (r.prepare_ms ?? 0) + r.prove_ms : r.total_ms;
}

// The only rows with a bar: a 2-output Ironwood proof, and a live scan of the daily or the first-scan range the protocol fixed (RANGES), one
// thread, on a named class. The range is the one the row was asked for (range_asked, on every run, dead or alive), matched to the table.
function barFor(r, range) {
  if (/^prove-n2$/.test(r.row) && r.pool === 'ironwood-v3') {
    return r.device_class === 'laptop' ? BARS.prove_laptop_ms : r.device_class === 'phone' ? BARS.prove_phone_ms : null;
  }
  const kind = range?.entry?.kind;
  if ((kind === 'daily' || kind === 'first-sync') && r.device_class === 'phone') return kind === 'daily' ? BARS.daily_ms : BARS.first_sync_ms;
  return null;
}

const hasScanShape = (r) => /^scan-(daily|first-sync)-/.test(r.row);
const isRangeRow = (r) => /^scan-(daily|first-sync|information)-/.test(r.row);

// The one decision about the range of a live scan row, for its bar and for its verdict: the entry of the table that every run of the row was
// asked for (the id and both heights are the entry's), and, for each run that ended ok, that the wasm recorded that range. entry is null when
// the row is not on a fixed range; text is what the row then says, or INFORMATION for the information range, and null for a verdict range.
function rangeOf(runs, opts) {
  const asked = runs[0].range_asked ?? null;
  const entry = asked && runs.every((r) => JSON.stringify(r.range_asked ?? null) === JSON.stringify(asked)) ? askedEntry(asked, rangesOf(opts)) : null;
  if (!entry || !runs.filter((r) => r.outcome === 'ok').every((r) => didAsked(r, asked, entry))) return { entry: null, text: NOT_FIXED };
  return { entry, text: entry.kind === 'information' ? INFORMATION : null };
}

// A row that has a bar for some class: the class decides which, so 'other' must not be let to decide none.
function hasBarShape(r) {
  return (/^prove-n2$/.test(r.row) && r.pool === 'ironwood-v3') || hasScanShape(r);
}

// Why a set of runs cannot carry a verdict, whatever its times say. Empty when it can.
// A stamp names a commit when it is a short or full hex hash: '97e253d' and its full hash are the same commit, and
// '97e253d-dirty' is none. A report names the commit it was built from (--commit on the script).
export function commitMatches(have, named) {
  const hex = /^[0-9a-f]{7,40}$/i;
  if (!hex.test(have ?? '') || !hex.test(named ?? '')) return false;
  const a = have.toLowerCase(), b = named.toLowerCase();
  return a.startsWith(b) || b.startsWith(a);
}

export function refusals(ok, opts = {}) {
  const why = [];
  const each = (test, text) => { if (ok.some(test)) why.push(text); };
  each((r) => r.filter != null, 'a filter hides what it skips');
  each((r) => /-dirty$|^unknown$/.test(r.harness_commit), 'the build is not a clean commit');
  each((r) => !withinLimits(r), 'a free text field of the record is over its limit');
  each((r) => !r.wasm_sha256, 'the build is not identified');
  // build.sh stamps the wasm's sha256 in meta.json and the run records it; the wasm that ran must be the wasm that was stamped.
  each((r) => !r.wasm_sha256_stamped, 'the build stamp has no wasm hash');
  each((r) => r.wasm_sha256_stamped && r.wasm_sha256 && r.wasm_sha256 !== r.wasm_sha256_stamped, 'the wasm that ran is not the one build.sh stamped');
  each((r) => !r.glue_sha256_stamped, 'the build stamp has no glue hash');
  each((r) => !r.snippets_sha256_stamped, 'the build stamp has no snippets hash');
  each((r) => r.snippets_sha256_stamped && JSON.stringify(r.snippets_sha256 ?? null) !== JSON.stringify(r.snippets_sha256_stamped), 'the snippets that ran are not the ones build.sh stamped');
  each((r) => r.glue_sha256_stamped && r.glue_sha256 !== r.glue_sha256_stamped, 'the glue that ran is not the one build.sh stamped');
  // The page's script measures and judges as much as the wasm does, so it carries a stamp too, and the two must agree.
  each((r) => !r.js_commit || r.js_commit === 'unknown', 'the page script is not identified');
  each((r) => r.js_commit && r.js_commit !== 'unknown' && r.harness_commit && r.js_commit !== r.harness_commit, 'the page script and the wasm are from different builds');
  each((r) => r.js_commit && r.js_files_match !== true, 'the page script is not the one that was stamped');

  // Whether the page was hidden during the run is written by the page; its absence must not read as 'visible'.
  each((r) => r.page_hidden_during_run === undefined && r.live_or_replay_asked !== 'replay' && hasBarShape(r), 'page visibility during the run is not recorded');
  each((r) => r.live_or_replay_asked === 'live' && !r.endpoint, 'the endpoint is not recorded');
  // What the table declares for a verdict endpoint is recorded with the run (declaredFor, the one place that says it); a run that lacks it, or
  // differs, is not that row's evidence. These are declarations, not observations: the upstream itself is only seen through what it said.
  const verdictEntry = (r) => { const e = r.live_or_replay_asked === 'live' && r.endpoint ? entryOf(r, opts) : null; return verdictReady(e) ? e : null; };
  const declared = (r) => declaredFor(bareOrigin(r.endpoint), tableOf(opts));
  const differs = (r, f) => JSON.stringify(r[f] ?? null) !== JSON.stringify(declared(r)[f] ?? null);
  each((r) => verdictEntry(r) && differs(r, 'upstream_declared'), 'the recorded upstream is not the one the table declares');
  each((r) => verdictEntry(r) && differs(r, 'proxy_config_declared'), 'the recorded proxy config is not the one the table declares');
  each((r) => verdictEntry(r) && differs(r, 'proxy_host_declared'), 'the recorded hosting declared in the table is not the one the table declares');
  // What the upstream said, seen by the page that ran: without it nobody can compare the served range with another endpoint.
  each((r) => verdictEntry(r) && r.lightd_info && r.lightd_info.chain_name !== 'main', 'the upstream is not on mainnet');
  each((r) => verdictEntry(r) && r.tree_state_end && r.end_block_hash && r.end_block_hash !== r.tree_state_end.hash, "the end block hash is not the end tree state's");
  each((r) => verdictEntry(r) && !(r.lightd_info && r.tree_state_start && r.tree_state_end && r.end_block_hash), 'what the upstream said is not recorded');
  each((r) => r.kind === 'prove' && r.verified !== true, 'a proof was not verified');
  each((r) => r.kind === 'prove' && (r.cold !== true || !(r.key_build_ms > 0)), 'a run was not cold: the key build was not timed');
  each((r) => r.kind === 'scan' && !((r.actions_by_pool?.orchard ?? 0) + (r.actions_by_pool?.ironwood ?? 0) > 0), 'a range with no actions');
  each((r) => {
    const stages = r.kind === 'prove' ? r.key_build_ms + r.prepare_ms + r.prove_ms + r.verify_ms : r.total_ms;
    return !(r.pipeline_ms >= 0) || Math.abs(r.pipeline_ms - stages) > Math.max(500, 0.05 * r.pipeline_ms);
  }, 'the stages do not add up to the time they ran');
  each((r) => r.threads_asked > 0 && r.threads !== r.threads_asked, 'the thread pool is not the size asked');
  each((r) => r.threads_asked > 0 && r.cross_origin_isolated !== true, 'threads on a page that is not isolated');
  // The page's own clock, started before the worker exists. Stages can be moved past the worker's clock; nothing moves
  // past this one, so whatever it saw and no field accounts for is work the row does not report.
  each((r) => {
    const accounted = (r.wasm_load_ms ?? 0) + (r.preflight_ms ?? 0) + (r.pipeline_ms ?? 0) + (r.witness_ms ?? 0);
    return !(r.elapsed_ms >= 0) || r.elapsed_ms - accounted > Math.max(500, 0.05 * r.elapsed_ms);
  }, 'the page saw time that no stage accounts for');
  for (const f of ['key_sha256', 'corpus_sha256']) if (new Set(ok.map((r) => r[f] ?? null)).size > 1) why.push(`this row mixes ${f}`);
  return why;
}

// A server on this machine (a mock, a proxy, a saved range served back) says nothing about a real light client.
export function isLocalEndpoint(endpoint) {
  let host;
  try { host = new URL(endpoint).hostname.toLowerCase(); } catch { return false; }
  host = host.replace(/^\[|\]$/g, '');
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0' || /^127\.\d+\.\d+\.\d+$/.test(host);
}

// What the operator or a host logger typed: '30.9', '30,9 C', ' 31 '. Anything else is not a reading.
export function parseTemp(text) {
  const m = /^\s*(-?\d+(?:[.,]\d+)?)\s*(?:°\s*)?c?\s*$/i.exec(String(text ?? ''));
  return m ? Number(m[1].replace(',', '.')) : null;
}

// Why a run that ended ok is still not in the median. null when it is.
function exclusion(r, firstBySession) {
  if (r.page_hidden_during_run === true) return 'page hidden during run';
  const t = parseTemp(r.temp_before);
  if (t === null) return hasBarShape(r) && r.live_or_replay_asked !== 'replay' ? 'temperature not recorded' : null;
  const first = firstBySession.get(r.session_id ?? '') ?? t;
  const ceiling = Math.min(HOT_START_ABSOLUTE_C, first + HOT_START_OVER_FIRST_C);
  return t > ceiling ? `hot start: ${t} C over ${ceiling} C` : null;
}

// The first temperature typed in each session, by the order the runs were made.
function firstReadings(results) {
  const by = new Map();
  const order = (r) => [r.order_in_session ?? Infinity, r.started_at ?? ''];
  for (const r of results) {
    if (parseTemp(r.temp_before) === null) continue;
    const k = r.session_id ?? '';
    const cur = by.get(k);
    if (!cur || order(r)[0] < order(cur)[0] || (order(r)[0] === order(cur)[0] && order(r)[1] < order(cur)[1])) by.set(k, r);
  }
  return new Map([...by].map(([k, r]) => [k, parseTemp(r.temp_before)]));
}

// How long the free text of a record may be. The one table: the form and the link read it too. A record over a limit is refused with its own reason.
export const TEXT_LIMITS = { device_label: 80, temp_before: 16, user_agent: 300, session_id: 64, row: 120, endpoint: 200 };
const withinLimits = (r) => Object.entries(TEXT_LIMITS).every(([f, n]) => String(r[f] ?? '').length <= n);

const REQUIRED = ['harness_commit', 'device_label', 'device_class', 'user_agent', 'started_at', 'run_id'];

// Why runs cannot be of the commit the report names: every run counts, a dead or cleared one included. Empty when no commit is named.
function commitWhy(runs, commit) {
  if (!commit) return [];
  const why = [];
  if (runs.some((r) => !commitMatches(r.harness_commit, commit))) why.push('the wasm build is not the commit the report names');
  if (runs.some((r) => !commitMatches(r.js_commit, commit))) why.push('the page script is not the commit the report names');
  return why;
}

// What makes two runs one row. The endpoint is its origin, so the same server spelled two ways is one row.
const rowParts = (r) => [r.device_label, browser(r.user_agent), r.row, r.pool ?? '', `threads ${r.threads_asked ?? 0}`, r.live_or_replay_asked ?? '', `endpoint ${r.endpoint ? (bareOrigin(r.endpoint) ?? r.endpoint) : '-'}`];
export function rowKey(r) {
  return [...rowParts(r), `session ${r.session_id ?? '-'}`, `filter ${r.filter ?? 'none'}`].join(' | ');
}
// The same row whichever session made it: what must have one session to carry a verdict.
export const rowGroup = (r) => [...rowParts(r), `filter ${r.filter ?? 'none'}`].join(' | ');

export function summarize(input, opts = {}) {
  // Saving a session twice must not count a run twice.
  const seen = new Set();
  const results = input.filter((r) => { if (!r.run_id) return true; if (seen.has(r.run_id)) return false; seen.add(r.run_id); return true; });
  // A cleared run still counts as the session's first reading: Clear must not move the ceiling.
  const first = firstReadings([...results, ...(opts.cleared ?? []).map((c) => c.run).filter(Boolean)]);
  // Runs cleared from the page: never counted, but a dead one still marks the row and session it came from.
  const clearedBy = new Map();
  for (const c of opts.cleared ?? []) { if (!c.run?.row) continue; const k = rowKey(c.run); clearedBy.set(k, [...(clearedBy.get(k) ?? []), c.run]); }
  const countBy = (rs) => rs.reduce((o, r) => ({ ...o, [r.outcome ?? 'unknown']: (o[r.outcome ?? 'unknown'] ?? 0) + 1 }), {});
  const rows = new Map();
  for (const r of results) {
    // A refused start (threads on a page that is not isolated) is a row of its own, shown, never dropped.
    if (!r.row) continue;
    // threads_asked and the rest exist on every record, a killed or stopped one included, so it stays in its own row.
    const k = rowKey(r);
    if (!rows.has(k)) rows.set(k, []);
    rows.get(k).push(r);
  }
  const lines = [];
  for (const [k, runs] of rows) {
    const complete = (r) => REQUIRED.every((f) => r[f]);
    const ok = runs.filter((r) => r.outcome === 'ok' && complete(r));
    const marked = ok.map((r) => [r, exclusion(r, first)]);
    const counted = marked.filter(([, why]) => !why).map(([r]) => r);
    const excluded = marked.filter(([, why]) => why).map(([, why]) => why);
    const bad = runs.filter((r) => r.outcome !== 'ok' || !complete(r));
    const planned = Math.max(...runs.map((r) => r.runs_planned ?? runs.length));
    if (new Set(ok.map((r) => r.wasm_sha256)).size > 1) { lines.push({ row: k, row_name: runs[0].row, kind: runs[0].kind, verdict: 'REFUSED', why: 'this row mixes builds' }); continue; }
    const missing = planned - runs.length;
    const clr = clearedBy.get(k) ?? [];
    const clearedDead = clr.filter((r) => r.outcome !== 'ok').length > 0;
    const sample = runs[0];
    const med = counted.length ? median(counted.map(timed)) : null;
    let verdict;
    // Class 'other' has no bar, but on a row that has one for phones and laptops it would turn a fail into 'no bar'.
    const hidesBar = sample.device_class === 'other' && sample.live_or_replay_asked !== 'replay' && !sample.threads_asked && hasBarShape(sample);
    const live = sample.live_or_replay_asked === 'live';
    const entry = live ? entryOf(sample, opts) : null;
    // A live scan row is judged on the range it was asked for, whatever became of its runs. A proof has no range.
    const range = live && isRangeRow(sample) ? rangeOf(runs, opts) : null;
    const bar = barFor(sample, range);
    if (hidesBar) verdict = 'REFUSED: class other hides the bar; choose phone or laptop';
    else if (sample.live_or_replay_asked === 'replay' && hasBarShape(sample) && sample.device_class === 'phone') verdict = 'replay, not a verdict';
    else if (bar === null && !range?.text) verdict = bad.length || missing > 0 || clearedDead ? 'incomplete' : 'no bar';
    else if (sample.threads_asked) verdict = 'threads, reported, not a verdict';
    else if (sample.live_or_replay_asked === 'replay') verdict = 'replay, not a verdict';
    // The table before the local check: a pipeline proxy is on this machine and says what it is. A server on this machine that the table
    // does not name, or a verdict entry that is local, stays "local endpoint".
    else if (live && entry?.role === 'pipeline') verdict = 'pipeline proxy, not a verdict';
    else if (live && isLocalEndpoint(sample.endpoint)) verdict = 'local endpoint, not a verdict';
    else if (live && !verdictReady(entry)) verdict = 'endpoint not named by the protocol, not a verdict';
    // Only the published test key is scanned for a verdict: the result holds a hash of the key, never the key (web/test-vault.mjs).
    else if (range?.text) verdict = range.text;
    // A live row scanned with the synthetic key (no hash) is not a verdict either: nothing checks its balance.
    else if (live && ok.some((r) => !isPublishedKey(r.key_sha256, opts.publishedKey ?? TEST_KEY_SHA256))) verdict = NOT_PUBLISHED;
    else if (missing < 0) verdict = 'REFUSED: more runs than planned in one session';
    else if (bad.length || missing > 0) verdict = 'FAIL: runs missing or killed';
    else if (clearedDead) verdict = 'FAIL: runs missing or killed (cleared)';
    else if (counted.length < MIN_VERDICT_RUNS) verdict = `short: ${counted.length} of ${MIN_VERDICT_RUNS} ok runs, no verdict`;
    else verdict = med <= bar ? 'pass' : 'fail';
    // Whether the row got as far as a verdict of its own, before anything below can refuse it: its session then counts as an attempt at the row.
    const capable = /^(pass|fail|FAIL|short)/.test(verdict);
    // Clear is not a way round the rule: ok runs of this row and session that were cleared, and a row run again, are two tries.
    if (capable && clr.some((r) => r.outcome === 'ok')) verdict = 'REFUSED: ok runs of this row were cleared and the row was run again; a verdict row is one try in one session';
    // Whatever the row would have said: a set of runs that cannot be trusted says that instead.
    if (!(bad.length || missing > 0) && refusals(ok, opts).length) verdict = `REFUSED: ${refusals(ok, opts).join('; ')}`;
    // The commit the report names is checked on every run of the row, a dead one included, and beats everything else the row says.
    // The cleared runs of this row and session are runs of this row too.
    const why = commitWhy([...runs, ...clr], opts.commit);
    const commit_mismatch = why.length > 0;
    if (commit_mismatch) verdict = `REFUSED: ${why.join('; ')}`;
    const witnesses = counted.filter((r) => r.witness_ms != null).map((r) => r.witness_ms);
    const para = counted.map((r) => (r.kind === 'prove' ? r.prove_ms : r.stages_ms?.decrypt)).filter((x) => x != null);
    const stage_medians_ms = {};
    for (const name of new Set(counted.flatMap((r) => Object.keys(stagesOf(r))))) {
      const xs = counted.map((r) => stagesOf(r)[name]).filter((x) => Number.isFinite(x));
      if (xs.length) stage_medians_ms[name] = median(xs);
    }
    const projection = projectionOf(counted);
    lines.push({ row: k, projection, row_name: sample.row, group: rowGroup(sample), session_id: sample.session_id ?? null, capable, kind: sample.kind, stage_medians_ms, runs: counted.map(timed), excluded, median_ms: med, parallel_ms: para.length ? median(para) : null, witness_median_ms: witnesses.length ? median(witnesses) : null, bad: bad.map((r) => r.outcome), missing, bar_ms: bar, verdict, ...(commit_mismatch ? { commit_mismatch } : {}), ...(clr.length ? { cleared: countBy(clr) } : {}) });
  }
  // A row whose every run was cleared is still a row: the dead ones are its record.
  for (const [k, clr] of clearedBy) {
    if (rows.has(k) || !clr.some((r) => r.outcome !== 'ok')) continue;
    const why = commitWhy(clr, opts.commit);
    lines.push({ row: k, row_name: clr[0].row, kind: clr[0].kind, runs: [], excluded: [], median_ms: null, bad: [], missing: 0, verdict: why.length ? `REFUSED: ${why.join('; ')}` : 'FAIL: runs missing or killed (cleared)', ...(why.length ? { commit_mismatch: true } : {}), cleared: countBy(clr) });
  }
  // Cleared runs belong to their session: clearing runs cannot take a session out of the count.
  const clearedSessions = new Map();
  for (const c of opts.cleared ?? []) if (c.run?.row && hasBarShape(c.run)) clearedSessions.set(rowGroup(c.run), new Set([...(clearedSessions.get(rowGroup(c.run)) ?? []), c.run.session_id ?? null]));
  oneSession(lines, opts.session, clearedSessions);
  checkThreads(lines);
  return lines;
}

// One verdict session per row: a row (same device, browser, row, pool, endpoint, threads, filter) that has verdict-capable runs from more than
// one session is refused unless the report names the session, so a second try cannot be picked over a first. The sessions not named stay printed.
// opts.session is one id for every row, or a list of { row, id } naming a session for one row (a row of no entry falls back to the bare id).
function oneSession(lines, session, clearedSessions) {
  const names = session === undefined ? [] : typeof session === 'string' ? [{ row: null, id: session }] : session;
  // An entry names a row by its exact group (the row key without session), which resolveSessions makes of a name and refuses when the name
  // is ambiguous: the one rule. Two entries that name one row with different ids are an error, not a first-wins.
  const namedFor = (l) => {
    const mine = names.filter((n) => n.row !== null && n.row === l.group);
    if (new Set(mine.map((n) => n.id)).size > 1) throw new Error(`the row ${l.group} is named twice with different sessions`);
    return (mine[0] ?? names.find((n) => n.row === null))?.id;
  };
  const by = new Map();
  for (const l of lines) if (l.capable) by.set(l.group, [...(by.get(l.group) ?? []), l]);
  for (const [group, ls] of by) {
    if (new Set([...ls.map((l) => l.session_id), ...(clearedSessions.get(group) ?? [])]).size < 2) continue;
    for (const l of ls) {
      if (l.verdict.startsWith('REFUSED')) continue;
      const named = namedFor(l);
      if (named === undefined) l.verdict = 'REFUSED: more than one session in this row; name the one that carries the verdict with --session <id>';
      else if (l.session_id !== named) l.verdict = 'not the named session, not a verdict';
    }
  }
}

// The control: a threads row is only real if it beats one thread of the same build, on the same row. It never gets a
// verdict, but a threads number that fails this, or has no control, says so beside it.
function checkThreads(lines) {
  const by = (l) => l.row.replace(/threads \d+/, 'threads');
  const n = (l) => Number(/threads (\d+)/.exec(l.row)?.[1] ?? 0);
  for (const l of lines) {
    if (n(l) < 2) continue;
    const control = lines.find((c) => by(c) === by(l) && n(c) === 1);
    if (!control || control.parallel_ms == null || l.parallel_ms == null) l.threads_check = 'no control';
    else l.threads_check = l.parallel_ms < 0.9 * control.parallel_ms ? 'faster than one thread' : 'NOT FASTER than one thread';
    l.verdict = l.threads_check === 'faster than one thread' ? l.verdict : `REFUSED: threads ${l.threads_check}`;
  }
}


// Projection data of a scan row, outside every verdict: how fast trial decryption went in actions per second, how many actions and how many
// compact bytes a block held, each the median over the runs that count for the row's median and have the numbers. Null when there is nothing to project. It is never read by
// the verdict, the bar or the row key.
function projectionOf(ok) {
  const med = (xs) => (xs.length ? median(xs) : null);
  const scans = ok.filter((r) => r.kind === 'scan');
  const num = (x) => typeof x === 'number' && Number.isFinite(x);
  const actions = (r) => (r.actions_by_pool?.orchard ?? 0) + (r.actions_by_pool?.ironwood ?? 0);
  const perSecond = med(scans.filter((r) => num(r.stages_ms?.decrypt) && r.stages_ms.decrypt > 0 && actions(r) > 0).map((r) => actions(r) / (r.stages_ms.decrypt / 1000)));
  const perBlock = med(scans.filter((r) => num(r.blocks) && r.blocks > 0 && r.actions_by_pool).map((r) => actions(r) / r.blocks));
  const bytesPerBlock = med(scans.filter((r) => num(r.blocks) && r.blocks > 0 && Number.isInteger(r.compact_bytes) && r.compact_bytes >= 0).map((r) => r.compact_bytes / r.blocks));
  return perSecond === null && perBlock === null && bytesPerBlock === null ? null : { decrypt_actions_per_s: perSecond, actions_per_block: perBlock, compact_bytes_per_block: bytesPerBlock };
}

// Only printable text from a result file is printed: letters, marks, numbers, punctuation, symbols and the plain space. Anything else
// (control characters, separators, zero-width and direction marks) becomes '?'. The one place; report() applies it to every line.
export const printable = (text) => String(text).replace(/[^\p{L}\p{M}\p{N}\p{P}\p{S} ]/gu, '?');

// What a row's verdict is, for anything that draws it: 'pass', 'fail' (a time over the bar, or runs missing or killed), or null when the
// summary gave no pass or fail (refused, short, not a verdict, no bar). The one place that reads the verdict strings this way.
export const outcomeOf = (l) => (l.verdict === 'pass' ? 'pass' : l.verdict === 'fail' || String(l.verdict).startsWith('FAIL') ? 'fail' : null);

// One line per row, as the page and the script print it.
export function line(l) {
  const s = (ms) => (ms / 1000).toFixed(2);
  const bad = l.bad?.length ? ` | not counted: ${l.bad.join(', ')}` : '';
  const witness = l.witness_median_ms == null ? '' : ` | witnesses, at spend, apart: ${s(l.witness_median_ms)} s`;
  const cleared = l.cleared ? ` | cleared: ${Object.entries(l.cleared).map(([k, n]) => `${k} ${n}`).join(', ')}` : '';
  const excluded = l.excluded?.length ? ` | excluded from the median: ${l.excluded.join('; ')}` : '';
  const threads = l.threads_check ? ` | ${l.threads_check}` : '';
  // The bar the row is judged against, the proof alone beside key + proof (the median above), and each stage's median.
  const bar = l.bar_ms == null ? ' | no bar' : ` | bar ${s(l.bar_ms)} s`;
  const proofAlone = l.kind === 'prove' && l.parallel_ms != null ? ` | proof alone ${s(l.parallel_ms)} s` : '';
  const stageList = Object.entries(l.stage_medians_ms ?? {});
  const stages = stageList.length ? ` | stages (median): ${stageList.map(([n, ms]) => `${n} ${s(ms)} s`).join(', ')}` : '';
  return `${l.row} | median ${l.median_ms == null ? '-' : `${s(l.median_ms)} s`}${bar}${proofAlone}${stages} | runs ${(l.runs ?? []).map(s).join(', ')}${witness}${threads} | ${l.verdict}${l.missing > 0 ? ` | ${l.missing} missing` : ''}${bad}${excluded}${cleared}`;
}

// A separate line, never part of the row's verdict: what a larger block could be projected from.
export function projectionLines(l) {
  const p = l.projection;
  // None beside a row that is refused: a number from a build that is not the stamped one is not data to project from.
  if (!p || String(l.verdict).startsWith('REFUSED')) return [];
  const parts = [];
  if (p.decrypt_actions_per_s != null) parts.push(`trial decryption ${p.decrypt_actions_per_s.toFixed(1)} actions/s`);
  if (p.actions_per_block != null) parts.push(`${p.actions_per_block.toFixed(2)} actions/block`);
  if (p.compact_bytes_per_block != null) parts.push(`${Math.round(p.compact_bytes_per_block)} compact bytes/block`);
  return [`  projection (not a verdict) | ${l.row} | ${parts.join(' | ')}`];
}

// The runs that were cleared from the page. They are never counted; the report says how many there were.
export function clearedLines(cleared) {
  if (!cleared?.length) return [];
  const by = {};
  for (const c of cleared) by[c.run?.outcome ?? 'unknown'] = (by[c.run?.outcome ?? 'unknown'] ?? 0) + 1;
  return [`${cleared.length} runs cleared, never counted: ${Object.entries(by).map(([k, n]) => `${k} ${n}`).join(', ')}`];
}

// The report's text, built once: the page shows it and scripts/summarize.mjs prints it, so they cannot differ. The cleared trail is
// always in it; 'No runs yet.' only when there is neither a result nor a cleared run. commit is the one the report names, or undefined.
export function report(results, cleared, commit, session) {
  const lines = summarize(results, { cleared, commit, session });
  const all = [...lines.flatMap((l) => [line(l), ...projectionLines(l)]), ...clearedLines(cleared)].map(printable);
  return { lines, text: all.length ? all.join('\n') : 'No runs yet.' };
}

// What the page prints, for the commit the page itself is stamped with.
export function pageSummary(results, cleared, jsStamp) {
  const commit = jsStamp?.js_commit && jsStamp.js_commit !== 'unknown' ? jsStamp.js_commit : undefined;
  return report(results, cleared, commit).text;
}

// Turns what --session said into what the report uses, or says why it cannot: each named row must exist (by exact name or exact group),
// match one row only, have a run of the session it names, and not be named twice with different sessions. A bare id needs a run of that session.
// Returns { errors, sessions }; sessions names rows by their group.
export function resolveSessions(results, names) {
  const errors = [];
  const sessions = [];
  const groups = new Map();
  for (const r of results) if (r.row) groups.set(rowGroup(r), new Set([...(groups.get(rowGroup(r)) ?? []), r.row]));
  for (const n of names) {
    if (n.row === null) {
      if (!results.some((r) => r.session_id === n.id)) errors.push(`no run of session ${n.id}`);
      else sessions.push(n);
      continue;
    }
    const hit = [...groups].filter(([g, rows]) => g === n.row || rows.has(n.row)).map(([g]) => g);
    if (hit.length === 0) errors.push(`no row named ${n.row}`);
    else if (hit.length > 1) errors.push(`the row name ${n.row} is ambiguous: ${hit.length} rows; name one by its group:\n  ${hit.join('\n  ')}`);
    else if (!results.some((r) => r.session_id === n.id && rowGroup(r) === hit[0])) errors.push(`no run of session ${n.id} in row ${n.row}`);
    else sessions.push({ row: hit[0], id: n.id });
  }
  for (const a of sessions) for (const b of sessions) if (a.row !== null && a.row === b.row && a.id !== b.id) errors.push(`the row ${a.row} is named twice with different sessions`);
  return { errors: [...new Set(errors)], sessions };
}
