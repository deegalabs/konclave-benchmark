// SPDX-License-Identifier: MIT OR Apache-2.0
// What looks like a key, written once: scripts/check-no-keys.mjs scans the tree with it, web/prefill.mjs refuses a link with it and the page
// refuses a run while a free field holds one. Case-insensitive: bech32 allows an all-capitals string, which decodes to the same key.
// Unified viewing keys of every network and revision (uview, uviewtest, uviewregtest, uivk, uvf, uvi) and Sapling ones, and spending keys:
// the Sapling extended spending key (secret-extended-key-main, -test, -regtest, zxsk) and unified spending keys (usk).
export const KEY = /\b(uview|uivk|uvf|uvi|zxview|zview|usk|zxsk|secret-extended-key-)[a-z]*1[0-9a-z]{20,}/gi;

// A fresh regex each call, so a global flag keeps no state between calls. Decodes a few times: a key may be percent-encoded twice.
export function looksLikeKey(text) {
  let t = String(text);
  for (let i = 0; i < 4; i++) {
    if (new RegExp(KEY.source, KEY.flags.replace('g', '')).test(t)) return true;
    try { const d = decodeURIComponent(t); if (d === t) break; t = d; } catch { break; }
  }
  return false;
}

// The first free field of a form whose text looks like a key, by name; null when none does. The name is returned, never the text.
export function keyInFreeFields(fields) {
  for (const [name, value] of Object.entries(fields)) if (looksLikeKey(value ?? '')) return name;
  return null;
}
