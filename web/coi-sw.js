// SPDX-License-Identifier: MIT OR Apache-2.0
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  // Only the threads page is isolated: index.html stays the plain page, whichever was opened first.
  if (e.request.mode === 'navigate' && !url.pathname.endsWith('/threads.html')) return;
  e.respondWith(fetch(e.request).then((r) => {
    const headers = new Headers(r.headers);
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    // A worker takes its policy from its own response, so the policy goes on as a header here (the pages' meta does not reach it). Appended, never
    // set: a stricter policy the host sends stays, and both are enforced.
    headers.append('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' https: http://localhost:* http://127.0.0.1:*; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'");
    return new Response(r.body, { status: r.status, statusText: r.statusText, headers });
  }));
});
