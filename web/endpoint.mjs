// SPDX-License-Identifier: MIT OR Apache-2.0
// An endpoint is an origin: scheme, host, optional port. No path, query, fragment or userinfo, so nothing else (a key, a token) can ride in it.
// Returns the normalised origin (lowercase host, no trailing slash, default port dropped), or null.
export function bareOrigin(text) {
  let u;
  try { u = new URL(String(text).trim()); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.pathname !== '/' || u.search || u.hash || u.username || u.password) return null;
  // A URL with a bare ? at its end has an empty search, but the text still holds the ?.
  if (/[?#@]/.test(String(text).trim().replace(/^https?:\/\//i, ''))) return null;
  return u.origin;
}
