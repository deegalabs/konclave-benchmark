// SPDX-License-Identifier: MIT OR Apache-2.0
// A link can fill the form so a phone does not need typing, and nothing more: it starts no run (Run still needs a tap), and it
// can never carry a viewing key, because a key in a link lands in the browser's history. Pure, so a test can read it.
export const PARAM_FIELDS = {
  device: 'device', class: 'device-class', runs: 'runs', threads: 'threads', prove: 'do-prove', scan: 'do-scan', pool: 'pool',
  outputs: 'axis', corpus: 'corpus', endpoint: 'endpoint', start: 'start', end: 'end', tree: 'tree-insert',
};

import { looksLikeKey } from './keys.mjs';
import { bareOrigin } from './endpoint.mjs';
import { findEndpoint } from './endpoints.mjs';
import { TEXT_LIMITS } from './summarize-core.mjs';
import { FORM_LIMITS } from './plan.mjs';

// Refused by name, whatever it holds: anything that could be a key or a secret. A value that looks like a key is refused too,
// whatever the name: a key can ride inside another parameter's value.
const REFUSED = /ufvk|view|vk|fvk|^u$|^sk|key|seed|mnemonic|secret|private|pass/i;

const bool = (v) => (/^(1|on|true|yes)$/i.test(v) ? true : /^(0|off|false|no)$/i.test(v) ? false : undefined);
const CHECK = {
  device: (v) => (v.length > 0 && v.length <= TEXT_LIMITS.device_label ? v : undefined),
  class: (v) => (['phone', 'laptop', 'other'].includes(v) ? v : undefined),
  runs: (v) => (/^[1-9]\d{0,2}$/.test(v) ? v : undefined),
  threads: (v) => (v === 'on' || v === 'off' ? v : undefined),
  prove: bool,
  scan: bool,
  pool: (v) => (['ironwood-v3', 'orchard-v2'].includes(v) ? v : undefined),
  outputs: (v) => (/^\d+(,\d+)*$/.test(v) ? v : undefined),
  // A file name in ./corpus, never a path.
  corpus: (v) => (/^[\w][\w.-]*$/.test(v) && v.length <= FORM_LIMITS.corpus && !v.includes('..') ? v : undefined),
  // An origin of the endpoint table and nothing else: a link cannot point the page at a server of its own choosing. A person who needs
  // another endpoint types it in (the page shows what it will contact before Run).
  endpoint: (v) => { const o = bareOrigin(v); return o && findEndpoint(o) ? o : undefined; },
  tree: (v) => (v === 'chunked' || v === 'per-block' ? v : undefined),
  start: (v) => (/^\d{1,10}$/.test(v) ? v : undefined),
  end: (v) => (/^\d{1,10}$/.test(v) ? v : undefined),
};

// fields: element id -> value to set. refused: names only, never values. ignored: unknown names. invalid: known names with a bad value.
export function parsePrefill(search) {
  const out = { fields: {}, refused: [], ignored: [], invalid: [] };
  for (const [name, value] of new URLSearchParams(search)) {
    if (REFUSED.test(name) || looksLikeKey(name) || looksLikeKey(value)) { out.refused.push(name); continue; }
    if (!(name in PARAM_FIELDS)) { out.ignored.push(name); continue; }
    const v = CHECK[name](value.trim());
    if (v === undefined) out.invalid.push(name);
    else out.fields[PARAM_FIELDS[name]] = v;
  }
  return out;
}

// What the page says about a link, before Run.
export function prefillText(p) {
  const set = Object.entries(p.fields).map(([k, v]) => `${k}=${v}`);
  const parts = [];
  if (set.length) parts.push(`Filled from the link: ${set.join(', ')}.`);
  if (p.refused.length) parts.push(`Refused, a link never carries a key: ${p.refused.join(', ')}. Remove it from your link.`);
  if (p.ignored.length) parts.push(`Ignored, not a setting: ${p.ignored.join(', ')}.`);
  if (p.invalid.length) parts.push(`Not used, bad value: ${p.invalid.join(', ')}.`);
  return parts.length ? `${parts.join(' ')} Nothing runs until you tap Run.` : '';
}

// The query that should stay in the address bar: only what was applied. Whatever else came in (a refused key, a name nobody reads, a
// bad value) goes, so nothing a person pasted lingers in the browser's history.
export function stripUnapplied(search, applied) {
  const q = new URLSearchParams(search);
  const keep = new URLSearchParams();
  for (const [name, value] of q) {
    const id = PARAM_FIELDS[name];
    if (id && id in applied && !REFUSED.test(name) && !looksLikeKey(value)) keep.append(name, value);
  }
  const out = keep.toString();
  return out ? `?${out}` : '';
}
