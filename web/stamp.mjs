// SPDX-License-Identifier: MIT OR Apache-2.0
// The page's own script is stamped like the wasm: build.sh runs scripts/stamp-js.mjs, which writes stamp.json with the commit
// and the hash of each file below. The page hashes what it was served and compares, so JS and wasm cannot silently differ.
import { commitMatches } from './summarize-core.mjs';
import { threadCounts, buildFor } from './plan.mjs';

export const STAMPED = ['app.js', 'coi-sw.js', 'coi.js', 'endpoint.mjs', 'endpoints.mjs', 'errors.mjs', 'grpcweb.js', 'keys.mjs', 'observe.mjs', 'plan.mjs', 'prefill.mjs', 'progress.mjs', 'ranges.mjs', 'runner.mjs', 'runs.js', 'stamp.mjs', 'summarize-core.mjs', 'test-vault.mjs', 'worker.js'];

export const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

// fetchFn and digest are passed in so a test runs it on files and the page on its own origin.
export async function readJsStamp(fetchFn, digest) {
  const none = { js_commit: 'unknown', js_files_match: false };
  try {
    const res = await fetchFn('./stamp.json');
    if (!res.ok) return none;
    const stamp = await res.json();
    let match = true;
    for (const f of STAMPED) {
      const got = hex(await digest(await (await fetchFn(`./${f}`)).arrayBuffer()));
      if (stamp.files?.[f] !== got) match = false;
    }
    return { js_commit: stamp.commit ?? 'unknown', js_files_match: match };
  } catch { return none; }
}

// Whether this page's script and the wasm it will run are one build. null when they are; else why not. The page refuses to start a run on a reason.
export function stampsAgree(js, meta) {
  const ident = (c) => c && c !== 'unknown';
  if (!ident(js?.js_commit) || !ident(meta?.commit)) return 'the page script or the wasm build is not identified (build with build.sh)';
  // The wasm is stamped by its bytes too (build.sh, scripts/stamp-meta.mjs): a run hands the hash to the worker, which refuses another wasm.
  if (!/^[0-9a-f]{64}$/.test(meta.wasm_sha256 ?? '')) return 'the wasm build carries no wasm hash (build with build.sh)';
  if (!/^[0-9a-f]{64}$/.test(meta.glue_sha256 ?? '')) return 'the wasm build carries no glue hash (build with build.sh)';
  if (!meta.snippets_sha256 || typeof meta.snippets_sha256 !== 'object') return 'the wasm build carries no snippets hash (build with build.sh)';
  if (js.js_files_match !== true) return 'the page script is not the stamped files';
  if (js.js_commit !== meta.commit && !commitMatches(js.js_commit, meta.commit)) return `the page script (${js.js_commit}) and the wasm (${meta.commit}) differ`;
  return null;
}

// Whether a run may start: the page script and every wasm it will load (a threads count of 1 still uses the threads build, as context() does)
// must be one build. null when it may; else why not.
export function startRefusal(js, metas, threads) {
  for (const f of new Set(threadCounts(threads).map(buildFor))) {
    const why = stampsAgree(js, metas[f]);
    if (why) return why;
  }
  return null;
}

// The trail of cleared runs outlives the session, and the summary checks every cleared run against the commit. So when the stored trail
// holds runs from another commit than this page's, say so before Run. '' when there is nothing to say.
export function trailWarning(cleared, js) {
  const page = js?.js_commit;
  if (!page || page === 'unknown' || !cleared?.length) return '';
  const same = (c) => c === page || commitMatches(c, page);
  const foreign = cleared.filter((c) => !same(c.run?.harness_commit) || !same(c.run?.js_commit));
  if (!foreign.length) return '';
  const commits = [...new Set(foreign.flatMap((c) => [c.run?.harness_commit, c.run?.js_commit]).filter((x) => x && !same(x)))];
  return `Warning: ${foreign.length} cleared run${foreign.length === 1 ? '' : 's'} stored in this browser come from another commit (${commits.join(', ') || 'unknown'}) than this page (${page}). Every report made from this browser will be refused for it. For a new session, clear the site data of this page in the browser settings.`;
}
