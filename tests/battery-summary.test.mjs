// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLog, blockEnergy } from '../scripts/battery-summary.mjs';

const log = [
  '2026-11-21T00:00:00.000Z level=80 temperature_c=30.0 charging=false charge_counter_uah=4000000 current_now_ma=-300',
  '2026-11-21T00:30:00.000Z level=75 temperature_c=31.0 charging=false charge_counter_uah=3850000 current_now_ma=-300',
  'a line from the event history is never read: level=10 temperature_c=99',
].join('\n');

test('a block reads the counter drop and the current summed over time', () => {
  const rows = parseLog(log);
  assert.equal(rows.length, 2);
  const e = blockEnergy(rows, Date.parse('2026-11-21T00:00:00Z'), Date.parse('2026-11-21T00:30:00Z'));
  assert.equal(e.min, 30);
  assert.equal(e.counterMah, 150);
  assert.equal(e.currentMah, 150);
  assert.deepEqual(e.level, [80, 75]);
  assert.equal(e.maxTemp, 31);
});

test('a block with fewer than two readings has no energy', () => {
  assert.equal(blockEnergy(parseLog(log), Date.parse('2026-11-21T01:00:00Z'), Date.parse('2026-11-21T02:00:00Z')), null);
});

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { summarize } from '../scripts/battery-summary.mjs';

// One phone: a 10-minute baseline at 60 mA, then a 10-minute block whose current climbs from 100 to 300 mA.
// Counter: baseline -10,000 uAh, block -30,000 uAh. Expected: block current 200 mAh/h x 1/6 h = 33.33 mAh by trapezoid
// (a single endpoint would give 16.7 or 50), net current 33.33 - 10 = 23.33, net counter 30 - 10 = 20.
function fixture({ extraMarker = false, chargingInBlock = false, nullCounter = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'battery-'));
  const t0 = Date.parse('2026-11-21T00:00:00Z');
  const iso = (min) => new Date(t0 + min * 60000).toISOString();
  const line = (min, counter, current, charging = false) => `${iso(min)} level=80 temperature_c=30.0 charging=${charging} charge_counter_uah=${nullCounter && min === 20.5 ? 'null' : counter} current_now_ma=${current}`;
  writeFileSync(join(dir, 'p1-2026-11-21.log'), [line(0, 4000000, -60), line(10, 3990000, -60), line(10.5, 3989000, -100), line(20.5, 3959000, -300, chargingInBlock)].join('\n'));
  writeFileSync(join(dir, 'p1-notes.log'), 'not a battery log');
  writeFileSync(join(dir, 'markers.log'), [
    `${iso(0)} p1 idle baseline starts`, `${iso(10)} p1 idle baseline ends`,
    `${iso(10.5)} p1 proof block starts`, `${iso(20.5)} p1 proof block ends`,
    ...(extraMarker ? [`${iso(30)} p1 proof block starts`] : []),
  ].join('\n'));
  return dir;
}

test('summarize nets a block against the baseline, by trapezoid, for each log file named <name>-<date>.log', () => {
  const out = summarize(fixture());
  assert.deepEqual(Object.keys(out), ['p1']);
  assert.deepEqual(out.p1.map((r) => r.block), ['baseline', 'proof']);
  const [base, proof] = out.p1;
  assert.equal(base.block, 'baseline');
  assert.ok(Math.abs(base.currentMah - 10) < 1e-9);
  assert.ok(Math.abs(proof.currentMah - 100 / 3) < 1e-9);
  assert.ok(Math.abs(proof.netCurrentMah - (100 / 3 - 10)) < 1e-9);
  assert.ok(Math.abs(proof.netCounterMah - 20) < 1e-9);
  assert.equal(proof.charging, false);
});

test('a charging reading inside a block is reported', () => {
  assert.equal(summarize(fixture({ chargingInBlock: true })).p1[1].charging, true);
});

test('a missing counter reading leaves the counter figures empty, never a number', () => {
  const proof = summarize(fixture({ nullCounter: true })).p1[1];
  assert.equal(proof.counterMah, null);
  assert.equal(proof.netCounterMah, null);
});

test('a missing current reading is left out of the sum and counted, not read as zero', () => {
  const e = blockEnergy(parseLog([
    '2026-11-21T00:00:00Z level=80 temperature_c=30.0 charging=false charge_counter_uah=1 current_now_ma=-600',
    '2026-11-21T00:10:00Z level=80 temperature_c=30.0 charging=false charge_counter_uah=1 current_now_ma=null',
    '2026-11-21T00:20:00Z level=80 temperature_c=30.0 charging=false charge_counter_uah=1 current_now_ma=-600',
  ].join('\n')), Date.parse('2026-11-21T00:00:00Z'), Date.parse('2026-11-21T00:20:00Z'));
  assert.equal(e.currentMah, 0);
  assert.equal(e.currentGaps, 2);
});

test('two markers for the same block stop the summary instead of picking one', () => {
  assert.throws(() => summarize(fixture({ extraMarker: true })), /2 markers match "proof block starts"/);
});

test('a block with one reading has no energy, not a zero', () => {
  const rows = parseLog(log);
  assert.equal(blockEnergy(rows, Date.parse('2026-11-21T00:00:00Z'), Date.parse('2026-11-21T00:10:00Z')), null);
});

test('a laptop log reads the drop in RemainingCapacity, takes its blocks from the markers, and nets it against the baseline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'battery-laptop-'));
  writeFileSync(join(dir, 'lap-2026-11-21.log'), [
    '2026-11-21T00:00:00Z remaining_mwh=50000 charging=False discharging=True',
    '2026-11-21T00:20:00Z remaining_mwh=45000 charging=False discharging=True',
    '2026-11-21T00:21:00Z remaining_mwh=44900 charging=False discharging=True',
    '2026-11-21T00:41:00Z remaining_mwh=36900 charging=True discharging=False',
  ].join('\r\n'));
  writeFileSync(join(dir, 'markers.log'), [
    '2026-11-21T00:00:00Z lap idle baseline starts', '2026-11-21T00:20:00Z lap idle baseline ends',
    '2026-11-21T00:21:00Z lap proof-screen-on block starts', '2026-11-21T00:41:00Z lap proof-screen-on block ends',
  ].join('\n'));
  const [base, block] = summarize(dir).lap;
  assert.equal(base.energyMwh, 5000);
  assert.equal(block.block, 'proof-screen-on');
  assert.equal(block.energyMwh, 8000);
  assert.equal(block.netMwh, 3000);
  assert.equal(block.charging, true);
});

test('the committed battery folder reproduces the README figures', () => {
  const out = summarize(new URL('../results/m1/battery', import.meta.url).pathname);
  const net = (name, block, key) => out[name].find((r) => r.block === block)[key];
  assert.equal(Math.round(net('s24', 'proof', 'netCounterMah') / 45 * 10) / 10, 8.5);
  assert.equal(Math.round(net('a72', 'replay', 'netCounterMah') / 10 * 10) / 10, 12.0);
  assert.equal(Math.round(net('a14', 'firstscan', 'netCurrentMah')), 107);
  assert.equal(Math.round(net('dell', 'proof', 'netMwh') / 29), 117);
  assert.equal(Math.round(net('dell', 'proof-screen-on', 'netMwh') / 9), 176);
  assert.equal(Math.round(net('dell', 'replay', 'netMwh') / 22), 178);
  assert.equal(Math.round(net('dell', 'replay-screen-on', 'netMwh') / 9), 227);
});
