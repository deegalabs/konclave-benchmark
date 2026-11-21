// SPDX-License-Identifier: MIT OR Apache-2.0
// Recomputes the phone battery table from the battery logs (scripts/battery-log.mjs output) and the block markers.
// usage: node scripts/battery-summary.mjs <folder with <name>-<date>.log files and markers.log>
// A marker line is "<ISO time> <name> <text>"; a block runs from "<block> block starts" to "<block> block ends",
// the idle baseline from "idle baseline starts" to "idle baseline ends". Net energy of a block = its energy minus
// the baseline's rate times the block's length, read two ways: the charge counter and current now summed over time.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const LINE = /^(\S+Z) level=(\d+) temperature_c=([\d.]+) charging=(true|false) charge_counter_uah=(-?\d+|null) current_now_ma=(-?\d+|null)/;

export function parseLog(text) {
  return text.split('\n').map((l) => LINE.exec(l)).filter(Boolean).map((m) => ({
    t: Date.parse(m[1]), level: Number(m[2]), temp: Number(m[3]), charging: m[4] === 'true',
    counter: m[5] === 'null' ? null : Number(m[5]), current: m[6] === 'null' ? null : Number(m[6]),
  }));
}

export function blockEnergy(rows, a, b) {
  const seg = rows.filter((r) => r.t >= a && r.t <= b);
  if (seg.length < 2) return null;
  const min = (seg.at(-1).t - seg[0].t) / 60000;
  const counterMah = seg[0].counter != null && seg.at(-1).counter != null ? (seg[0].counter - seg.at(-1).counter) / 1000 : null;
  let currentMah = 0;
  for (let i = 1; i < seg.length; i++) currentMah += (-(seg[i - 1].current + seg[i].current) / 2) * ((seg[i].t - seg[i - 1].t) / 3600000);
  return { min, counterMah, currentMah, level: [seg[0].level, seg.at(-1).level], maxTemp: Math.max(...seg.map((r) => r.temp)), charging: seg.some((r) => r.charging), samples: seg.length };
}

export function summarize(dir) {
  const markers = readFileSync(join(dir, 'markers.log'), 'utf8').split('\n').filter(Boolean).map((l) => {
    const [ts, name, ...rest] = l.split(' ');
    return { t: Date.parse(ts), name, text: rest.join(' ') };
  });
  const out = {};
  for (const f of readdirSync(dir).filter((x) => /^[a-z0-9]+-\d{4}-\d{2}-\d{2}\.log$/.test(x))) {
    const name = f.split('-')[0];
    const rows = parseLog(readFileSync(join(dir, f), 'utf8'));
    const at = (pat) => markers.find((m) => m.name === name && m.text.includes(pat))?.t;
    const spans = [['baseline', at('idle baseline starts'), at('idle baseline ends')],
      ...['proof', 'replay', 'firstscan'].map((b) => [b, at(`${b} block starts`), at(`${b} block ends`)])];
    const res = spans.map(([block, a, b]) => ({ block, ...(a && b ? blockEnergy(rows, a, b) : {}) }));
    const base = res[0];
    for (const r of res.slice(1)) {
      if (!r.min || !base.min) continue;
      r.netCounterMah = r.counterMah != null && base.counterMah != null ? r.counterMah - (base.counterMah / base.min) * r.min : null;
      r.netCurrentMah = r.currentMah - (base.currentMah / base.min) * r.min;
    }
    out[name] = res;
  }
  return out;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: node scripts/battery-summary.mjs <folder>'); process.exit(2); }
  const f = (x, d = 1) => (x == null ? '-' : x.toFixed(d));
  for (const [name, res] of Object.entries(summarize(dir))) {
    for (const r of res) {
      if (!r.min) { console.log(`${name} | ${r.block} | no data`); continue; }
      console.log(`${name} | ${r.block} | ${f(r.min)} min | level ${r.level[0]} -> ${r.level[1]} | max ${f(r.maxTemp)} C | charging ${r.charging} | counter ${f(r.counterMah)} mAh | current ${f(r.currentMah)} mAh${r.block === 'baseline' ? '' : ` | net counter ${f(r.netCounterMah)} mAh | net current ${f(r.netCurrentMah)} mAh`}`);
    }
  }
}
