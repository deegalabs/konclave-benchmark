// SPDX-License-Identifier: MIT OR Apache-2.0
// Storage measurement page. View-only: the only account is imported from a viewing key. Nothing here calls propose,
// transfer, send or broadcast, and no spending key is ever created or imported.
import init, { initThreadPool, WebWallet } from './pkg/webzjs_wallet.js';

const log = (...a) => console.log('[storage]', ...a);

// Read the top-level fields of a protobuf message: { field number: { count, bytes } } plus the raw length-delimited
// payloads of the fields in `keep`. Only wire types 0, 1, 2 and 5 occur in MemoryWallet.
function readVarint(buf, i) {
  let v = 0n, s = 0n;
  for (;;) {
    const b = buf[i++];
    v |= BigInt(b & 0x7f) << s;
    if (!(b & 0x80)) return [v, i];
    s += 7n;
  }
}
function topLevel(buf, keep) {
  const fields = {}, kept = {};
  let i = 0;
  while (i < buf.length) {
    const start = i;
    let tag; [tag, i] = readVarint(buf, i);
    const f = Number(tag >> 3n), wt = Number(tag & 7n);
    let len;
    if (wt === 0) { [, i] = readVarint(buf, i); }
    else if (wt === 1) i += 8;
    else if (wt === 5) i += 4;
    else if (wt === 2) {
      let l; [l, i] = readVarint(buf, i); len = Number(l);
      if (keep.includes(f)) (kept[f] ||= []).push(buf.subarray(i, i + len));
      i += len;
    } else throw new Error(`unexpected wire type ${wt}`);
    fields[f] ||= { count: 0, bytes: 0 };
    fields[f].count++;
    fields[f].bytes += i - start;
  }
  return { fields, kept };
}
// WalletBlock field 1 is the height (varint) per memory_wallet.proto at the store revision WebZjs pins.
function blockHeights(blocks) {
  return blocks.map(b => Number(readVarint(b, 1)[0]));
}

// Same store the web wallet app uses: idb-keyval defaults (db "keyval-store", store "keyval", key "wallet").
function idbPut(key, value) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('keyval-store');
    open.onupgradeneeded = () => open.result.createObjectStore('keyval');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('keyval', 'readwrite');
      tx.objectStore('keyval').put(value, key);
      tx.oncomplete = () => { open.result.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  });
}

window.__progress = { stage: 'loaded', t: performance.now() };
const progress = (stage, extra = {}) => { window.__progress = { stage, t: performance.now(), ...extra }; log(stage, JSON.stringify(extra)); };

window.runStorage = async ({ ufvk, birthday, endpoint, maxSyncErrors = 3 }) => {
  const t0 = performance.now();
  progress('init');
  await init();
  await initThreadPool(navigator.hardwareConcurrency || 4);
  const usageBefore = (await navigator.storage.estimate()).usage;

  progress('wallet');
  const wallet = new WebWallet('main', endpoint, 1, 1, null);
  const accountId = await wallet.create_account_view_ufvk('storage-test', ufvk, birthday);
  const tipAtStart = Number(await wallet.get_latest_block());
  const summary0 = await wallet.get_wallet_summary();
  progress('account', { accountId, tipAtStart, scannedAtStart: summary0 ? summary0.fully_scanned_height : null });

  // sync() holds the wallet write lock until it returns, so no summary is read while it runs; the driver watches the console.
  const tSync = performance.now();
  const errors = [];
  let calls = 0, summary = null;
  for (;;) {
    calls++;
    progress('sync', { call: calls, errors: errors.length });
    try { await wallet.sync(); } catch (e) {
      errors.push(String(e));
      progress('sync-error', { error: String(e) });
      if (errors.length >= maxSyncErrors) throw new Error(`sync failed ${errors.length} times: ${errors.join(' | ')}`);
      continue;
    }
    summary = await wallet.get_wallet_summary();
    const tip = Number(await wallet.get_latest_block());
    progress('synced-call', { scanned: summary.fully_scanned_height, tip });
    if (summary.fully_scanned_height >= tip) break;
    if (calls >= 5) break;
  }
  const syncMs = performance.now() - tSync;

  progress('serialise');
  const bytes = await wallet.db_to_bytes();
  const { fields, kept } = topLevel(bytes, [3]);
  const heights = blockHeights(kept[3] || []);
  const history = await wallet.get_transaction_history(accountId, 1000, 0);

  progress('idb-save');
  await idbPut('wallet', bytes);
  const est = [];
  for (let k = 0; k < 3; k++) {
    await new Promise(r => setTimeout(r, 1000));
    const e = await navigator.storage.estimate();
    est.push({ usage: e.usage, quota: e.quota, usageDetails: e.usageDetails ?? null });
  }
  progress('done');
  return {
    birthday,
    accountId,
    endpoint,
    tipAtStart,
    scannedAtStart: summary0 ? summary0.fully_scanned_height : null,
    scannedAtEnd: summary.fully_scanned_height,
    chainTipAtEnd: summary.chain_tip_height,
    syncCalls: calls,
    syncErrors: errors,
    syncMs,
    totalMs: performance.now() - t0,
    dbToBytes: bytes.length,
    noteCount: fields[5] ? fields[5].count : 0,
    noteCountSource: 'received_note_table records (field 5) in the db_to_bytes protobuf',
    transactionCount: history.transactions ? history.transactions.length : null,
    blockRecords: fields[3] ? fields[3].count : 0,
    blockRecordMinHeight: heights.length ? Math.min(...heights) : null,
    blockRecordMaxHeight: heights.length ? Math.max(...heights) : null,
    protobufTopLevelFields: fields,
    storageUsageBeforeBytes: usageBefore,
    storageEstimateAfterIdbSave: est,
    hardwareConcurrency: navigator.hardwareConcurrency,
    crossOriginIsolated: self.crossOriginIsolated,
    userAgent: navigator.userAgent,
  };
};
progress('ready');
