// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Every form control the page script reads by id exists on both pages. A control added to index.html and not to
// threads.html made readForm throw on the threads page (app.js), so Run did nothing there.
test('index.html and threads.html carry the same form controls', () => {
  const ids = (f) => new Set([...readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8').matchAll(/<(?:input|select)[^>]*\bid="([^"]+)"/g)].map((m) => m[1]));
  const plain = ids('index.html'), threads = ids('threads.html');
  assert.deepEqual([...plain].filter((id) => !threads.has(id)), [], 'controls missing from threads.html');
});

test('the hosted landing page names the one release pages/releases.txt lists: its tag, zip and sha256', () => {
  const rows = readFileSync(new URL('../pages/releases.txt', import.meta.url), 'utf8')
    .split('\n').filter((l) => l.trim() && !l.startsWith('#')).map((l) => l.trim().split(/\s+/));
  // Each deploy replaces the whole site, so the workflow publishes one tag and the list holds one row.
  assert.equal(rows.length, 1);
  const [tag, zip, sha] = rows[0];
  assert.match(sha, /^[0-9a-f]{64}$/);
  const landing = readFileSync(new URL('../pages/index.html', import.meta.url), 'utf8');
  assert.ok(landing.includes(`href="./${tag}/"`), 'the build link');
  assert.ok(landing.includes(zip), 'the zip name');
  assert.ok(landing.includes(sha), 'the zip sha256');
  for (const m of landing.matchAll(/href="\.\/([^"/]+)\/"/g)) assert.equal(m[1], tag, 'no link to another tag');
});
