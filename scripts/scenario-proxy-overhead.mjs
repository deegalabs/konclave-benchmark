// SPDX-License-Identifier: MIT OR Apache-2.0
// Scenario "proxy overhead": what the gRPC-web proxy costs per call, from this host, with a chart. Information, never a verdict.
// usage: node scripts/scenario-proxy-overhead.mjs --entry <proxy origin of web/endpoints.mjs> --range <start>-<end> --read-approved [--runs N] [--out charts]
//        node scripts/scenario-proxy-overhead.mjs --from <proxy-latency JSON> [--out charts]      (charts a saved output, reads nothing)
// The measuring is scripts/proxy-latency.mjs, run as it is: it reads the chain, so it still refuses to run without --read-approved.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { printable } from '../web/summarize-core.mjs';
import { esc } from './charts.mjs';

const ms = (x) => `${Number(x).toFixed(1)} ms`;
const FONT = 'font-family="sans-serif"';

// A chart of what proxy-latency.mjs wrote: for each call, the median of the proxied and of the direct path with their minimum and maximum,
// and the difference it computed. Each call has its own scale. Nothing here is a rule or a bar.
export function proxySvg(j) {
  const spreadOk = (x) => x && ['median', 'min', 'max'].every((k) => Number.isFinite(x[k]));
  const ok = j && typeof j.label === 'string' && Number.isInteger(j.runs) && j.range && [j.range.start, j.range.end, j.range.blocks].every(Number.isFinite)
    && ['latest_block', 'block_range'].every((k) => spreadOk(j.proxy?.[k]) && spreadOk(j.direct?.[k]) && Number.isFinite(j.difference_ms?.[k]));
  if (!ok) throw new Error('not an output of scripts/proxy-latency.mjs (missing label, runs, range, proxy, direct or difference_ms)');
  const W = 720, LEFT = 20, AREA = 460, calls = [['latest_block', 'GetLatestBlock'], ['block_range', 'GetBlockRange']];
  const h = 100 + calls.length * 120;
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}" viewBox="0 0 ${W} ${h}" role="img" aria-label="proxy overhead">`, `<rect width="${W}" height="${h}" fill="#fff"/>`,
    `<text x="${LEFT}" y="28" font-size="16" font-weight="bold" ${FONT}>Proxy overhead, information only</text>`,
    `<text x="${LEFT}" y="48" font-size="11" fill="#555" ${FONT}>${esc(j.label)}</text>`,
    `<text x="${LEFT}" y="64" font-size="11" fill="#555" ${FONT}>${esc(`${j.runs} alternating runs, range ${j.range.start}-${j.range.end} (${j.range.blocks} blocks), entry ${j.proxy_origin}; bar = median, line = minimum to maximum`)}</text>`];
  calls.forEach(([key, name], i) => {
    const y = 90 + i * 120;
    const top = Math.max(j.proxy[key].max, j.direct[key].max);
    const x = (v) => LEFT + (v / top) * AREA;
    out.push(`<text x="${LEFT}" y="${y}" font-size="13" font-weight="bold" ${FONT}>${name}: difference ${esc(ms(j.difference_ms[key]))} (proxied median minus direct median)</text>`);
    [['proxied', j.proxy[key]], ['direct', j.direct[key]]].forEach(([path, s], k) => {
      const yy = y + 12 + k * 40;
      out.push(`<rect x="${LEFT}" y="${yy}" width="${Math.max(1, x(s.median) - LEFT).toFixed(1)}" height="16" fill="${k ? '#7f8c8d' : '#2c6fbb'}"/>`,
        `<line x1="${x(s.min).toFixed(1)}" y1="${yy + 8}" x2="${x(s.max).toFixed(1)}" y2="${yy + 8}" stroke="#000"/>`,
        `<text x="${LEFT + AREA + 10}" y="${yy + 13}" font-size="11" ${FONT}>${esc(`${path} ${ms(s.median)} (${ms(s.min)} to ${ms(s.max)})`)}</text>`);
    });
  });
  out.push('</svg>\n');
  return out.join('\n');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const argv = process.argv.slice(2);
  let from, out = 'charts', passthrough = argv;
  try {
    const { values } = parseArgs({ args: argv, options: { from: { type: 'string' }, out: { type: 'string' }, entry: { type: 'string' }, range: { type: 'string' }, runs: { type: 'string' }, 'read-approved': { type: 'boolean' } }, strict: true });
    from = values.from;
    out = values.out ?? out;
    passthrough = ['entry', 'range', 'runs'].flatMap((k) => (values[k] ? [`--${k}`, values[k]] : [])).concat(values['read-approved'] ? ['--read-approved'] : []);
  } catch (e) { console.error(e.message); process.exit(2); }
  mkdirSync(out, { recursive: true });
  const json = from ?? join(out, 'proxy-overhead.json');
  if (!from) {
    const script = fileURLToPath(new URL('./proxy-latency.mjs', import.meta.url));
    const r = spawnSync(process.execPath, [script, ...passthrough, '--out', json], { stdio: 'inherit' });
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
  try {
    const text = proxySvg(JSON.parse(readFileSync(json, 'utf8')));
    const svg = join(out, 'proxy-overhead.svg');
    writeFileSync(svg, text);
    console.log(json);
    console.log(svg);
  } catch (e) { console.error(printable(`cannot chart ${json}: ${String(e.message).split('\n')[0]}`)); process.exit(2); }
}
