// SPDX-License-Identifier: MIT OR Apache-2.0
// Driver for the storage measurement (M1 run sheet, "Storage (option A)"). View-only: it passes the published test vault
// viewing key to the page and nothing else; it never sends, proposes or broadcasts.
//
// Usage: node storage/run.mjs --birthday 3558848 --out storage/out/run.json --webzjs-commit <sha> [--label smoke|reported]
//          [--endpoint http://localhost:1234] [--port 8091] [--stall-minutes 10] [--chrome <path>]
// Needs playwright-core on NODE_PATH (or installed beside this file) and a Chromium (Playwright's cache is found by default).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { start } from './serve.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const here = path.dirname(fileURLToPath(import.meta.url));

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const birthday = Number(arg('birthday'));
if (!Number.isInteger(birthday) || birthday <= 0) { console.error('--birthday <height> is required'); process.exit(2); }
const out = arg('out', path.join(here, 'out', `run-${birthday}.json`));
const endpoint = arg('endpoint', 'http://localhost:1234');
const port = Number(arg('port', '8091')); // proxy/conf/dynamic.yml allows http://localhost:8090 and :8091
const stallMs = Number(arg('stall-minutes', '10')) * 60_000;
const label = arg('label', 'unlabelled');
const webzjsCommit = arg('webzjs-commit', 'unknown');
const chromePath = arg('chrome', process.env.CHROMIUM_PATH);
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(endpoint)) { console.error('endpoint must be the local proxy'); process.exit(2); }

const vault = JSON.parse(fs.readFileSync(path.join(here, '..', 'config', 'test-vault.json'), 'utf8'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kbp-storage-profile-'));
fs.mkdirSync(path.dirname(out), { recursive: true });
const logPath = out.replace(/\.json$/, '') + '.log';
const logFd = fs.openSync(logPath, 'w');
const logLine = (s) => fs.writeSync(logFd, `${new Date().toISOString()} ${s}\n`);

let srv, ctx, lastActivity = Date.now(), result = null, failure = null;
try {
  srv = await start(port);
  ctx = await chromium.launchPersistentContext(profile, {
    executablePath: chromePath || undefined,
    headless: true,
    args: ['--no-first-run', '--disable-extensions'],
  });
  const page = await ctx.newPage();
  const touch = (s) => { lastActivity = Date.now(); logLine(s); };
  page.on('console', (m) => touch(`console.${m.type()} ${m.text().slice(0, 400)}`));
  page.on('pageerror', (e) => touch(`pageerror ${String(e).slice(0, 400)}`));
  page.on('requestfailed', (r) => touch(`requestfailed ${r.url()} ${r.failure()?.errorText}`));
  // Only the page, its package and the local proxy may be reached.
  await ctx.route('**/*', (route) => {
    const u = new URL(route.request().url());
    const ok = (u.hostname === 'localhost' || u.hostname === '127.0.0.1') && [String(port), new URL(endpoint).port].includes(u.port)
      || u.protocol === 'blob:' || u.protocol === 'data:';
    if (!ok) { logLine(`blocked ${u.origin}`); return route.abort(); }
    return route.continue();
  });
  const browserVersion = ctx.browser()?.version() ?? null;
  await page.goto(`http://localhost:${port}/`);
  await page.waitForFunction(() => typeof window.runStorage === 'function', null, { timeout: 120_000 });

  const run = page.evaluate((a) => window.runStorage(a), { ufvk: vault.ufvk, birthday, endpoint });
  const watchdog = new Promise((_, rej) => {
    const t = setInterval(() => {
      if (Date.now() - lastActivity > stallMs) { clearInterval(t); rej(new Error(`no console activity for ${stallMs / 60000} minutes`)); }
    }, 5000);
    run.finally(() => clearInterval(t)).catch(() => {});
  });
  const started = Date.now();
  result = await Promise.race([run, watchdog]);
  result.wallClockMs = Date.now() - started;
  result.browserVersion = browserVersion || (await page.evaluate(() => navigator.userAgent));
} catch (e) {
  failure = String(e && e.message || e);
  logLine(`FAILURE ${failure}`);
} finally {
  const doc = {
    label,
    webzjsCommit,
    webzjsNote: 'unreleased open PR red-dev-inc/WebZjs#27, threads on, view-only, desktop, local proxy to zec.rocks',
    vaultFile: 'config/test-vault.json',
    startedAt: new Date().toISOString(),
    ok: !failure,
    failure,
    result,
    log: path.basename(logPath),
  };
  fs.writeFileSync(out, JSON.stringify(doc, null, 2) + '\n');
  try { await ctx?.close(); } catch {}
  srv?.close();
  fs.rmSync(profile, { recursive: true, force: true });
  fs.closeSync(logFd);
  console.log(`${failure ? 'FAILED' : 'ok'}: ${out}`);
  process.exit(failure ? 1 : 0);
}
