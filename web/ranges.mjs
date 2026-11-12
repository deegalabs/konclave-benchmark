// SPDX-License-Identifier: MIT OR Apache-2.0
// The ranges the protocol fixes, in one place. A live scan row gets a verdict only when the range the run recorded (start_height and blocks,
// written by the wasm) is one of these, fixed. The heights stay null until the range is fixed and published, so until then no live scan row
// carries a verdict; a row on any other range reads "range not fixed by the protocol, not a verdict".
//   daily           3,456 blocks, under the daily bar
//   first-scan      50,000 blocks, under the first-scan bar
//   first-scan-43d  150,000 blocks (43.4 days at 3,456 blocks a day), information only
// blocks is what the protocol says a range holds; a fixed entry must be that long.
export const RANGES = [
  { id: 'daily', kind: 'daily', blocks: 3456, start_height: null, end_height: null },
  { id: 'first-scan', kind: 'first-sync', blocks: 50000, start_height: null, end_height: null },
  { id: 'first-scan-43d', kind: 'information', blocks: 150000, start_height: null, end_height: null },
];

// Whether an entry is fixed: both heights given and, where the protocol names a length, that length.
export const rangeFixed = (e) => Number.isInteger(e.start_height) && Number.isInteger(e.end_height) && e.end_height >= e.start_height
  && (e.blocks == null || e.end_height - e.start_height + 1 === e.blocks);

// The fixed entry a request named: the page records on every run, dead or alive, the range it was asked for (range_asked: id, kind, start,
// end), and this finds the table's entry only when the id and both heights are the entry's. Null for anything else.
export const askedEntry = (asked, ranges = RANGES) => ranges.find((e) => rangeFixed(e) && asked && asked.id === e.id && asked.start === e.start_height && asked.end === e.end_height) ?? null;

// Whether a run that ended ok did what was asked: the heights and block count the wasm recorded, and the kind it was given.
export const didAsked = (r, asked, entry) => r.start_height === asked.start && r.blocks === asked.end - asked.start + 1 && r.range_kind === entry.kind;

export const NOT_FIXED = 'range not fixed by the protocol, not a verdict';
export const INFORMATION = 'information only, not a verdict';
