// SPDX-License-Identifier: MIT OR Apache-2.0
// What a live run records about the upstream, as the upstream said it. The table's upstream is a declaration; these are observations,
// and anyone can compare them with any endpoint: the version and chain, the trees before the range and at its end, the end block hash.
import { lightdInfo } from './grpcweb.js';

// GetLightdInfo and the time it took. It is called before the run's pipeline clock starts and its time is the run's preflight_ms,
// which the summary's unaccounted-time rule counts, so the extra call never moves a timer and never leaves a gap.
export async function readLightdInfo(endpoint, fetchImpl = fetch, now = () => performance.now()) {
  const t = now();
  const info = await lightdInfo(endpoint, fetchImpl);
  return { info, preflight_ms: Math.round(now() - t) };
}

// The record, from the tree states the run already fetched (the one before the range and the one at its end): no call is made here.
// The trees are the serialised states the server sent (what the scan starts from and is checked against), as hex. The end block hash is
// the hash field of GetTreeState at the end of the range, as the server wrote it (hex, display order), not that of the last block downloaded.
const tree = (st) => ({ height: st.height, hash: st.hash, orchard: st.orchard_hex, ironwood: st.ironwood_hex });
export function observations(info, startState, endState) {
  return { lightd_info: info, tree_state_start: tree(startState), tree_state_end: tree(endState), end_block_hash: endState.hash, end_block_hash_from: 'GetTreeState at the end of the range' };
}
