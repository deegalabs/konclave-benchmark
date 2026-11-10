// SPDX-License-Identifier: MIT OR Apache-2.0
// A static host cannot set COOP and COEP, so this page registers a service worker that adds them, then reloads once.
// Only this page does: index.html stays a plain page with no thread support.
if (!self.crossOriginIsolated && navigator.serviceWorker && !sessionStorage.getItem('kb.coi-tried')) {
  sessionStorage.setItem('kb.coi-tried', '1');
  navigator.serviceWorker.register('./coi-sw.js').then(() => navigator.serviceWorker.ready).then(() => location.reload());
}
