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
