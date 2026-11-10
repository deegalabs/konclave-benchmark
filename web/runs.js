// SPDX-License-Identifier: MIT OR Apache-2.0
// The write-ahead record: saved before a run starts and cleared when it ends, so a killed tab leaves a failed run
// instead of nothing. Storage is passed in, so a test can use a plain object.
const KEY = 'kb.open-run';
const SESSION = 'kb.session';

export function openRun(store, row) {
  store.setItem(KEY, JSON.stringify({ ...row, started_at: new Date().toISOString(), stage: 'starting' }));
}
export function markStage(store, stage) {
  const raw = store.getItem(KEY);
  if (raw) store.setItem(KEY, JSON.stringify({ ...JSON.parse(raw), stage }));
}
export function closeRun(store) {
  store.removeItem(KEY);
}
// A record still open when the page loads is a run that never ended.
export function recoverKilled(store) {
  const raw = store.getItem(KEY);
  if (!raw) return null;
  store.removeItem(KEY);
  return { ...JSON.parse(raw), outcome: 'killed', noted_at: new Date().toISOString() };
}
export function loadSession(store) {
  try { return JSON.parse(store.getItem(SESSION) ?? '[]'); } catch { return []; }
}
export function saveSession(store, results) {
  store.setItem(SESSION, JSON.stringify(results));
}

// Clear does not delete: the runs move to a trail that stays in the copied JSON and is named in the summary.
// A run that was bad cannot vanish by a tap; it is listed as cleared and never counted.
const CLEARED = 'kb.cleared';
export function loadCleared(store) {
  try { return JSON.parse(store.getItem(CLEARED) ?? '[]'); } catch { return []; }
}
export function clearRuns(store, results, at = new Date().toISOString()) {
  store.setItem(CLEARED, JSON.stringify([...loadCleared(store), ...results.map((run) => ({ cleared_at: at, run }))]));
  saveSession(store, []);
  return [];
}
export function exportJson(results, cleared) {
  return JSON.stringify({ schema: 1, results, cleared }, null, 1);
}

// The record of a finished run: what the page knew at the start (row), what the worker said (fields) and what the page
// sees now. Temperature after is whatever the operator or a host logger put in the field by then. Adds fields only.
export function finishRecord(row, fields, env) {
  return { ...row, ...fields, elapsed_ms: env.elapsed_ms, temp_after: String(env.tempText ?? '').trim() || null, temp_after_at: env.now, ...(env.hidden === undefined ? {} : { page_hidden_during_run: env.hidden === true, ...(env.hidden ? { reason: 'page hidden during run' } : {}) }) };
}
