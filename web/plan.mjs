// SPDX-License-Identifier: MIT OR Apache-2.0
// What the form asks for, as rows to run. Pure, so a test can read the rows the page would build without a browser.
import { bareOrigin } from './endpoint.mjs';
import { declaredFor } from './endpoints.mjs';
import { RANGES, rangeFixed } from './ranges.mjs';
import { TEXT_LIMITS } from './summarize-core.mjs';

// f.rangeKind is a range id of the table (daily, first-scan, first-scan-43d) or 'other': the heights of a table range are the table's, and
// only 'other' takes the heights typed in the form. ranges is a parameter so a test can give a table that is fixed.
export function planRows(f, ranges = RANGES) {
  const threads = f.threads === 'on' ? (Number(f.nthreads) || f.hardwareConcurrency) : 0;
  const runs = Number(f.runs);
  const rows = [];
  if (f.prove) {
    for (const n of String(f.axis).split(',').map(Number).filter(Boolean)) {
      rows.push({ row: `prove-n${n}`, pool: f.pool, job: { kind: 'prove', pool: f.pool, outputs: n } });
    }
  }
  if (f.scan) {
    const typed = String(f.endpoint).trim();
    // An origin only, so a key typed or pasted after a path or a query never reaches a server or a result.
    const endpoint = typed ? bareOrigin(typed) : '';
    if (typed && !endpoint) throw new Error('the endpoint must be a bare origin: scheme, host and port, no path, query or user');
    const ufvk = String(f.ufvk).trim() || null;
    const filter = f.filter ? Number(f.filter) : null;
    // Chunked is the default; per-block is an information row (web/summarize-core.mjs).
    const tree_insert = f.treeInsert === 'per-block' ? 'per-block' : 'chunked';
    const entry = ranges.find((e) => e.id === f.rangeKind) ?? null;
    const range_kind = entry ? entry.kind : 'other';
    if (endpoint) {
      if (entry && !rangeFixed(entry)) throw new Error(`the range ${entry.id} is not fixed by the protocol yet (web/ranges.mjs)`);
      const live = { endpoint, start: entry ? entry.start_height : Number(f.start), end: entry ? entry.end_height : Number(f.end) };
      const range_asked = { id: entry ? entry.id : 'other', kind: range_kind, start: live.start, end: live.end, blocks: live.end - live.start + 1 };
      // The endpoint is part of the row: two servers are two rows, and the summary can tell a local one from a public one.
      // declared: what the table says it reaches, recorded as a declaration (upstream_declared), never as an observation, and not part of the row key.
      rows.push({ row: `scan-${range_kind}-${live.start}-${live.end}`, range_asked, filter, tree_insert, endpoint, live_or_replay_asked: 'live', declared: declaredFor(endpoint), job: { kind: 'scan', range_kind, live, filter, tree_insert, ufvk } });
    } else {
      rows.push({ row: `scan-${range_kind}-${f.corpus}`, range_asked: null, filter, tree_insert, endpoint: null, live_or_replay_asked: 'replay', declared: {}, job: { kind: 'scan', range_kind, corpus: `./corpus/${f.corpus}`, filter, tree_insert, ufvk } });
    }
  }
  return { rows, runs, threads };
}

// Which thread counts a run goes through: one thread beside the pool, as its control, or just the count asked for.
export const threadCounts = (threads) => (threads > 1 ? [1, threads] : [threads]);
// Which wasm build serves a thread count: 0 is the single build, anything else the threads build (a count of 1 included).
export const buildFor = (t) => (t ? 'threads' : 'single');

// How long each free field of the form may be. A key is refused by its shape (web/keys.mjs); a long text is refused by its length, so a field
// cannot carry a page of text into every result.
export const FORM_LIMITS = { device: TEXT_LIMITS.device_label, temp: TEXT_LIMITS.temp_before, corpus: 80, endpoint: TEXT_LIMITS.endpoint, start: 10, end: 10, filter: 10, axis: 40, runs: 3, nthreads: 3 };

// The first field over its limit, by name; null when none is. The text is never returned.
export function tooLongField(fields) {
  for (const [name, value] of Object.entries(fields)) if (String(value ?? '').length > (FORM_LIMITS[name] ?? 80)) return name;
  return null;
}
