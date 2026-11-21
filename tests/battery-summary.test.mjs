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
