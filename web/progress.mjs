// SPDX-License-Identifier: MIT OR Apache-2.0
// What the page shows while a run goes: the stage number and the seconds so far. halo2 reports nothing inside a proof, so there is
// no bar to fill and none is drawn. The worker's messages are the ones it always sent; this only counts them.
export function stagesFor(job) {
  if (job.kind === 'prove') return ['key', 'prepare', 'prove', 'verify'];
  return [...(job.live ? ['lightd-info', 'tree-state', 'download'] : []), 'decode', 'decrypt', 'tree', 'witness'];
}

export function progressText(stage, job, elapsedMs) {
  const stages = stagesFor(job);
  const n = stages.indexOf(stage) + 1;
  const s = `${Math.floor(elapsedMs / 1000)} s`;
  return n ? `stage ${n} of ${stages.length} (${stage}), ${s}` : `${stage}, ${s}`;
}
