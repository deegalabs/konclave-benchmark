// SPDX-License-Identifier: MIT OR Apache-2.0
// Prints every row's verdict from saved page JSON. usage: node scripts/summarize.mjs results --commit <the commit the report names> [--session <id>] (--commit is required)
// A row with runs from more than one session is refused unless --session names the one that carries the verdict.
// The rules live in web/summarize-core.mjs, which the page uses too, so the page and this script cannot disagree.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { summarize, report, printable, resolveSessions } from '../web/summarize-core.mjs';

export * from '../web/summarize-core.mjs';

export function collect(dir) {
  const out = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) out.push(...(JSON.parse(readFileSync(join(dir, f), 'utf8')).results ?? []));
  return out;
}

// The page's Clear keeps a trail; it is read apart and never counted.
export function collectCleared(dir) {
  const out = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) out.push(...(JSON.parse(readFileSync(join(dir, f), 'utf8')).cleared ?? []));
  return out;
}

// --session <id> for every row, or --session <row>=<id> for one row; repeatable. Takes the flags out of args. Exits 2 on a flag with no id.
export function parseSessionArgs(args) {
  const sessions = [];
  for (let at = args.indexOf('--session'); at >= 0; at = args.indexOf('--session')) {
    const v = args[at + 1];
    if (!v) { console.error('--session needs a session id'); process.exit(2); }
    const eq = v.lastIndexOf('=');
    sessions.push(eq > 0 ? { row: v.slice(0, eq), id: v.slice(eq + 1) } : { row: null, id: v });
    args.splice(at, 2);
  }
  return sessions;
}

// pathToFileURL, not pathname: a path with a space or a Windows drive must still run the script, not exit 0 silently.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--commit');
  const commit = at >= 0 ? args[at + 1] : undefined;
  if (at >= 0) args.splice(at, 2);
  const sessions = parseSessionArgs(args);
  const dir = args[0] ?? 'results';
  // No verdict is printed for a report that does not say which commit it is: a build stamp has nothing to be checked against.
  if (!commit) { console.error('usage: node scripts/summarize.mjs <results dir> --commit <the commit the report names>\n--commit is required: without it the build stamps cannot be checked'); process.exit(2); }
  const results = collect(dir);
  const named = resolveSessions(results, sessions);
  if (named.errors.length) { for (const e of named.errors) console.error(printable(e)); process.exit(2); }
  const { lines, text } = report(results, collectCleared(dir), commit, named.sessions.length ? named.sessions : undefined);
  console.log(text);
  // A result from another commit than the report names is a failed run of this script, not only a line of text.
  if (lines.some((l) => l.commit_mismatch)) process.exitCode = 1;
}
