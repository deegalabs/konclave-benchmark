// SPDX-License-Identifier: MIT OR Apache-2.0
// What the four scenario scripts share (scenario-prove, scenario-daily, scenario-first-scan, scenario-proxy-overhead). Thin on purpose: the
// measuring is done by the page (a browser is needed for prove and scan) or by scripts/proxy-latency.mjs; the rules are web/summarize-core.mjs's.
// A scenario script prints the page link with its prefill parameters, and, when given the results saved from the page, writes the summary JSON and the chart.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { summarize, resolveSessions, printable } from '../web/summarize-core.mjs';
import { parsePrefill } from '../web/prefill.mjs';
import { collect, collectCleared, parseSessionArgs } from './summarize.mjs';
import { ONLY, writeCharts } from './charts.mjs';

// The page link of a scenario. It is checked with the page's own parsePrefill, so a link this prints is one the page applies whole.
// There is no prefill parameter for the range (web/prefill.mjs): a scan scenario says which range to pick in the page.
export function pageUrl(params, base = 'http://localhost:8090/') {
  const q = new URLSearchParams(params);
  const p = parsePrefill(q.toString());
  const bad = [...p.refused, ...p.ignored, ...p.invalid];
  if (bad.length) throw new Error(`the page would not apply: ${bad.join(', ')}`);
  return `${base}?${q.toString()}`;
}

export const SCENARIOS = {
  prove: { only: 'prove', params: { prove: '1', scan: '0', pool: 'ironwood-v3', outputs: '2', threads: 'off', runs: '5' }, range: null },
  daily: { only: 'daily', params: { prove: '0', scan: '1', threads: 'off', runs: '5' }, range: 'one day of blocks (3,456)' },
  'first-scan': { only: 'first-sync', params: { prove: '0', scan: '1', threads: 'off', runs: '5' }, range: 'a first scan (50,000 blocks)' },
};

// The command line of a scenario script. Without --results it only prints the link; with --results (the folder of JSON copied from the page) it
// also needs --commit, and writes <out>/<name>.json (the summary rows of this scenario) and the charts.
export function runScenario(name, argv, log = console.log) {
  const sc = SCENARIOS[name];
  const args = [...argv];
  const sessions = parseSessionArgs(args);
  const { values } = parseArgs({ args, options: { device: { type: 'string' }, class: { type: 'string' }, endpoint: { type: 'string' }, base: { type: 'string' }, results: { type: 'string' }, commit: { type: 'string' }, out: { type: 'string', default: 'charts' } }, strict: true });
  const params = { ...sc.params };
  for (const k of ['device', 'class', 'endpoint']) if (values[k]) params[k] = values[k];
  log(`Open: ${pageUrl(params, values.base)}`);
  log(sc.range ? `Then pick "${sc.range}" in "This range is" (no link parameter sets it), tap Run, and copy the results from the page into a .json file.` : 'Tap Run, and copy the results from the page into a .json file.');
  if (sc.range && !values.endpoint) log('No --endpoint: the page will replay the saved corpus, which is never a verdict. A live row needs an endpoint of web/endpoints.mjs.');
  if (!values.results) return null;
  if (!values.commit) throw new Error('--commit is required with --results: without it the build stamps cannot be checked');
  const results = collect(values.results);
  const named = resolveSessions(results, sessions);
  if (named.errors.length) throw new Error(named.errors.map(printable).join('\n'));
  const session = named.sessions.length ? named.sessions : undefined;
  const lines = summarize(results, { cleared: collectCleared(values.results), commit: values.commit, session }).filter(ONLY[sc.only]);
  mkdirSync(values.out, { recursive: true });
  const json = join(values.out, `${name}.json`);
  writeFileSync(json, `${JSON.stringify({ scenario: name, commit: values.commit, rows: lines }, null, 2)}\n`);
  const { files } = writeCharts({ results, cleared: collectCleared(values.results), commit: values.commit, session, out: values.out, only: sc.only });
  for (const f of [json, ...files]) log(f);
  return { json, files };
}

export function main(name) {
  try { runScenario(name, process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
}
