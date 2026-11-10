// SPDX-License-Identifier: MIT OR Apache-2.0
// The page's side of one run, in one place: the stage and seconds shown, the watch for the page going hidden, and the record at the end
// (temperature after, elapsed time, hidden). Everything it touches is passed in, so a test can drive it without a browser.
import { watchHidden } from './errors.mjs';
import { progressText } from './progress.mjs';
import { finishRecord } from './runs.js';

export function trackRun({ row, job, doc, win, perf, now, readTemp, show, setTimer, clearTimer }) {
  const t0 = perf();
  const view = watchHidden(doc, win);
  let stage = 'starting';
  const shown = () => show(`${row.row} run ${row.run_index} of ${row.runs_planned}: ${progressText(stage, job, perf() - t0)}`);
  const timer = setTimer(shown, 1000);
  shown();
  const stop = () => { view.stop(); clearTimer(timer); };
  return {
    stage: (name) => { stage = name; shown(); },
    stop,
    finish: (fields) => {
      const record = finishRecord(row, fields, { elapsed_ms: Math.round(perf() - t0), tempText: readTemp(), now: now(), hidden: view.hidden() });
      stop();
      return record;
    },
  };
}
