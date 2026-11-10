// SPDX-License-Identifier: MIT OR Apache-2.0
// One SVG chart per device from saved result JSON, in plain SVG text (no chart library, no package.json). It makes no rule of its own:
// summarize() in web/summarize-core.mjs decides every verdict and every bar, and a row is drawn only when that summary says 'pass' or 'fail'.
// A row the summary judges 'FAIL: runs missing or killed' is drawn as a FAIL with that reason, without a bar. A row it refuses, marks short, or calls "not a verdict" is never drawn: it is counted in a note on the chart and listed on stderr.
// usage: node scripts/charts.mjs <results dir> --commit <the commit the report names> [--session <id>] [--out charts] [--only prove|daily|first-sync]
// With no result at all it writes <out>/no-verdict-yet.svg, a placeholder that carries the bars from BARS; with results but no row judged, <out>/nothing-to-draw.svg.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { summarize, rowKey, browser, printable, resolveSessions, outcomeOf, BARS } from '../web/summarize-core.mjs';
import { collect, collectCleared, parseSessionArgs } from './summarize.mjs';

export const ONLY = { prove: (l) => l.kind === 'prove', daily: (l) => /^scan-daily-/.test(l.row_name ?? ''), 'first-sync': (l) => /^scan-first-sync-/.test(l.row_name ?? '') };

// What to draw: the rows the summary gave a pass or a fail, grouped by device label; and every other row with the summary's own reason.
// opts is what summarize() takes (commit, session, cleared; endpoints, ranges and publishedKey for a test). only narrows to one scenario.
export function plotModel(results, opts = {}, only = null) {
  if (only && !ONLY[only]) throw new Error(`--only is one of ${Object.keys(ONLY).join(', ')}`);
  const sample = new Map();
  for (const r of [...results, ...(opts.cleared ?? []).map((c) => c.run).filter(Boolean)]) if (r.row && !sample.has(rowKey(r))) sample.set(rowKey(r), r);
  const devices = new Map();
  const skipped = [];
  for (const l of summarize(results, opts)) {
    if (only && !ONLY[only](l)) continue;
    const s = sample.get(l.row);
    const outcome = outcomeOf(l);
    // A fail with no median or bar, or one for runs killed or missing, has no time to draw against a bar: it is drawn as the words.
    const timeVerdict = l.verdict === 'pass' || l.verdict === 'fail';
    if (!outcome || !s) { skipped.push({ row: l.row, verdict: l.verdict }); continue; }
    const label = String(s.device_label);
    devices.set(label, [...(devices.get(label) ?? []), { name: l.row_name, pool: s.pool ?? null, browser: browser(s.user_agent), kind: l.kind, outcome, reason: timeVerdict ? null : l.verdict, median_ms: l.median_ms, bar_ms: l.bar_ms, verdict: l.verdict, runs: (l.runs ?? []).length }]);
  }
  return { devices, skipped };
}

export const esc = (t) => printable(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const sec = (ms) => `${(ms / 1000).toFixed(1)} s`;
const W = 720, LEFT = 20, AREA = 560, LINE_AT = 0.6, ROW = 64, HEAD = 56;
const FONT = 'font-family="sans-serif"';

const title = (row) => (row.kind === 'prove'
  ? `Prove: key build + circuit preparation + first proof, threads off | ${row.name} | ${row.pool ?? ''} | ${row.browser}`
  : `Scan: ${/daily/.test(row.name) ? 'daily, 3,456 blocks' : 'first scan, 50,000 blocks'} | ${row.browser}`);

// One device. Each row has its own bar, so each row is drawn on its own scale: the threshold line sits at the same x in every row,
// and a bar that ends left of it passed, right of it failed. The words say it too, so colour is not the only signal.
export function deviceSvg(device, rows, skipped = 0, commit = '') {
  const h = HEAD + rows.length * ROW + 40;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}" viewBox="0 0 ${W} ${h}" role="img" aria-label="${esc(device)}">`,
    `<rect width="${W}" height="${h}" fill="#fff"/>`,
    `<text x="${LEFT}" y="28" font-size="18" font-weight="bold" ${FONT}>${esc(device)}</text>`,
    `<text x="${LEFT}" y="46" font-size="11" fill="#555" ${FONT}>median of the counted runs against the bar; dashed line = the bar${commit ? `; report commit ${esc(commit)}` : ''}</text>`];
  rows.forEach((r, i) => {
    const y = HEAD + i * ROW;
    if (r.reason) {
      parts.push(`<text x="${LEFT}" y="${y}" font-size="12" ${FONT}>${esc(title(r))}</text>`,
        `<rect x="${LEFT}" y="${y + 8}" width="8" height="18" fill="#c0392b"/>`,
        `<text x="${LEFT + 16}" y="${y + 22}" font-size="12" ${FONT}>${esc(`${r.reason}: no time is drawn for this row`)}</text>`);
      return;
    }
    const len = Math.min(r.median_ms / r.bar_ms, 1.6) * LINE_AT * AREA;
    const lx = LEFT + LINE_AT * AREA;
    const colour = r.verdict === 'pass' ? '#2a8f3f' : '#c0392b';
    parts.push(`<text x="${LEFT}" y="${y}" font-size="12" ${FONT}>${esc(title(r))}</text>`,
      `<rect x="${LEFT}" y="${y + 8}" width="${len.toFixed(1)}" height="18" fill="${colour}"/>`,
      `<line x1="${lx}" y1="${y + 3}" x2="${lx}" y2="${y + 32}" stroke="#000" stroke-width="2" stroke-dasharray="4 3"/>`,
      `<text x="${LEFT}" y="${y + 46}" font-size="12" ${FONT}>${esc(`${sec(r.median_ms)} against a bar of ${sec(r.bar_ms)}: ${r.verdict.toUpperCase()}, ${r.runs} counted runs${r.median_ms / r.bar_ms > 1.6 ? ' (bar drawn cut at 1.6 times the bar)' : ''}`)}</text>`);
  });
  const note = skipped ? `${skipped} other row${skipped === 1 ? '' : 's'} of this report not drawn: no pass or fail from the summary. Run scripts/summarize.mjs for each reason.` : 'Every row of this report that has a pass or a fail is drawn.';
  parts.push(`<text x="${LEFT}" y="${h - 14}" font-size="11" fill="#555" ${FONT}>${esc(note)}</text>`, '</svg>\n');
  return parts.join('\n');
}

// The placeholder, with the bars as the code holds them and no result.
export function emptySvg() {
  const bars = `prove ${sec(BARS.prove_phone_ms)} phone, ${sec(BARS.prove_laptop_ms)} laptop; daily scan ${sec(BARS.daily_ms)}; first scan ${sec(BARS.first_sync_ms)}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="110" viewBox="0 0 ${W} 110" role="img" aria-label="no verdict run yet">
<rect width="${W}" height="110" fill="#fff" stroke="#999"/>
<text x="${LEFT}" y="38" font-size="18" font-weight="bold" ${FONT}>No verdict run yet</text>
<text x="${LEFT}" y="62" font-size="12" ${FONT}>${esc(`Bars in the code (web/summarize-core.mjs BARS): ${bars}.`)}</text>
<text x="${LEFT}" y="84" font-size="11" fill="#555" ${FONT}>Drawn by scripts/charts.mjs from result files only. This one has no result.</text>
</svg>
`;
}

// Results exist but the summary judged no row a pass or a fail.
export function nothingSvg(n) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="90" viewBox="0 0 ${W} 90" role="img" aria-label="nothing to draw">
<rect width="${W}" height="90" fill="#fff" stroke="#999"/>
<text x="${LEFT}" y="38" font-size="16" font-weight="bold" ${FONT}>${esc(`No row has a pass or a fail yet: ${n} row${n === 1 ? '' : 's'} in this report`)}</text>
<text x="${LEFT}" y="62" font-size="11" fill="#555" ${FONT}>Run scripts/summarize.mjs for what the summary says of each.</text>
</svg>
`;
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'device';

// Writes the charts and returns what it wrote. Throws when the commit is missing: the summary refuses to name a verdict without it.
export function writeCharts({ results, cleared = [], commit, session, out, only = null, ...rest }) {
  if (!commit) throw new Error('--commit is required: without it the build stamps cannot be checked');
  const { devices, skipped } = plotModel(results, { cleared, commit, session, ...rest }, only);
  mkdirSync(out, { recursive: true });
  const files = [];
  const used = new Set();
  for (const [device, rows] of devices) {
    let name = slug(device);
    for (let n = 2; used.has(name); n++) name = `${slug(device)}-${n}`;
    used.add(name);
    const file = join(out, `${name}.svg`);
    writeFileSync(file, deviceSvg(device, rows, skipped.length, commit));
    files.push(file);
  }
  if (!files.length) {
    const none = results.length === 0 && cleared.length === 0;
    const file = join(out, none ? 'no-verdict-yet.svg' : 'nothing-to-draw.svg');
    writeFileSync(file, none ? emptySvg() : nothingSvg(skipped.length));
    files.push(file);
  }
  return { files, skipped };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2);
  const sessions = parseSessionArgs(args);
  let v;
  try { v = parseArgs({ args, options: { commit: { type: 'string' }, out: { type: 'string', default: 'charts' }, only: { type: 'string' } }, allowPositionals: true, strict: true }); } catch (e) { console.error(e.message); process.exit(2); }
  const dir = v.positionals[0] ?? 'results';
  if (!v.values.commit) { console.error('usage: node scripts/charts.mjs <results dir> --commit <commit> [--session <id>] [--out charts] [--only prove|daily|first-sync]\n--commit is required'); process.exit(2); }
  try {
    const results = collect(dir);
    const cleared = collectCleared(dir);
    const named = resolveSessions(results, sessions);
    if (named.errors.length) { for (const e of named.errors) console.error(printable(e)); process.exit(2); }
    const { files, skipped } = writeCharts({ results, cleared, commit: v.values.commit, session: named.sessions.length ? named.sessions : undefined, out: v.values.out, only: v.values.only ?? null });
    for (const f of files) console.log(f);
    for (const s of skipped) console.error(printable(`not drawn | ${s.row} | ${s.verdict}`));
  } catch (e) { console.error(printable(`cannot chart ${dir}: ${String(e.message).split('\n')[0]}`)); process.exit(2); }
}
