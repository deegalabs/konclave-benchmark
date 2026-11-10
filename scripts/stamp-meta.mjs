// SPDX-License-Identifier: MIT OR Apache-2.0
// Writes <dir>/meta.json for one wasm flavour: the commit, the crate line, the flavour, the compiler and the sha256 of the wasm and of its JS glue in <dir> (the worker imports both).
// build.sh runs it after each wasm-pack build. The page hands the wasm hash to the run, which refuses a wasm whose bytes differ, and every
// result records it, so a wasm rebuilt outside build.sh cannot run under the stamp of an earlier build.
// usage: node scripts/stamp-meta.mjs <dir> <commit> <flavour> <rustc> <crates as JSON members, e.g. "orchard":"0.16.0">
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const [dir, commit, flavour, rustc, crates = ''] = process.argv.slice(2);
if (!dir || !commit || !flavour || !rustc) { console.error('usage: node scripts/stamp-meta.mjs <dir> <commit> <flavour> <rustc> <crates>'); process.exit(2); }
const sha = (f) => createHash('sha256').update(readFileSync(join(dir, f))).digest('hex');
const wasm_sha256 = sha('konclave_benchmark_bg.wasm');
const glue_sha256 = sha('konclave_benchmark.js');
// The threads glue imports a helper from snippets/ (wasm-bindgen-rayon): every file there is stamped by its path under the flavour's folder.
const snippets_sha256 = {};
const walk = (rel) => { for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) { const r = `${rel}/${e.name}`; if (e.isDirectory()) walk(r); else snippets_sha256[r] = sha(r); } };
if (existsSync(join(dir, 'snippets'))) walk('snippets');
writeFileSync(join(dir, 'meta.json'), `${JSON.stringify({ commit, crates: JSON.parse(`{${crates}}`), flavour, rustc, wasm_sha256, glue_sha256, snippets_sha256 })}\n`);
