// SPDX-License-Identifier: MIT OR Apache-2.0
// Why a run ended without a result, and whether the page was in view while it ran. A locked screen kills a worker without a message:
// the reason must say what is known, not the word 'undefined'.

export function describeThrown(e) {
  if (e && e.message) return String(e.message);
  if (e === undefined || e === null) return `the worker threw ${e}`;
  return String(e);
}

// e is a worker's error event. visibility is document.visibilityState when it fired.
export function workerErrorReason(e, visibility) {
  const message = e?.message;
  const where = e?.filename ? ` at ${String(e.filename).split('/').pop()}:${e.lineno ?? '?'}${e.colno != null ? `:${e.colno}` : ''}` : '';
  const base = message ? String(message) : 'the worker died without a message';
  return `${base} (event type ${e?.type ?? 'unknown'}${where}; the page was ${visibility ?? 'of unknown visibility'} when it ended)`;
}

// Watches a run: true if the page was hidden at any moment from now until stop(). doc and win are the document and the window.
export function watchHidden(doc, win) {
  let hidden = doc.visibilityState === 'hidden';
  const onVisibility = () => { if (doc.visibilityState === 'hidden') hidden = true; };
  const onHide = () => { hidden = true; };
  doc.addEventListener('visibilitychange', onVisibility);
  win.addEventListener('pagehide', onHide);
  return {
    hidden: () => hidden,
    stop: () => { doc.removeEventListener('visibilitychange', onVisibility); win.removeEventListener('pagehide', onHide); },
  };
}
