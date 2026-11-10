// SPDX-License-Identifier: MIT OR Apache-2.0
// The published test key, by its hash. A result holds no part of any viewing key typed in: the wasm records the sha256 of the key text
// (key_sha256), and the amounts and note counts of a scan are kept only when that hash is the one below (the sha256 of the "ufvk" text in
// config/test-vault.json). Any other typed key is "not the published test key, not a verdict" and its amounts are left out.
// When config/test-vault.json is filled in, put the sha256 of its "ufvk" here (a test compares the two).
export const TEST_KEY_SHA256 = 'e764ece3db9c140b9b5ae2444431851e0717e882680121c3427d4b7757751cc8';

export const NOT_PUBLISHED = 'not the published test key, not a verdict';

// Whether a hash is the published test key's: false for the synthetic key (no hash) and for every key while none is published.
export const isPublishedKey = (keySha256, published = TEST_KEY_SHA256) => published != null && keySha256 === published;

// A scan keeps its amounts when it used the synthetic key (no hash) or the published test key. published is a parameter so a test can give another.
export const keepsAmounts = (keySha256, published = TEST_KEY_SHA256) => keySha256 == null || (published != null && keySha256 === published);

// What a scan with another typed key must not store: what it received and spent, how many notes it found, how many witnesses it made.
export function redactUnpublished(result, published = TEST_KEY_SHA256) {
  if (keepsAmounts(result.key_sha256, published)) return result;
  const { received_zat, spent_in_range_zat, found, notes, witnesses, ...rest } = result;
  return { ...rest, amounts_omitted: 'not the published test key' };
}
