// SPDX-License-Identifier: MIT OR Apache-2.0
// Optional, on the host: writes the phone's battery level, temperature, charging state, charge counter and current to a file every 10 s, with the time,
// so a run's temperature does not depend on anyone typing it. The page cannot read a battery; this can.
// usage: node scripts/battery-log.mjs battery.log [adb serial]
// It is never run by the tests: they only read the parser. It talks to the phone through the adb on this machine.
import { appendFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const INTERVAL_MS = 10000;

// Only the first 'temperature:' line: dumpsys can go on to print log lines that also say temperature.
// Android gives tenths of a degree, so 309 is 30.9 C. It is the battery's temperature, a proxy for the phone's.
export function parseBattery(text) {
  const first = (re) => re.exec(text)?.[1];
  const temp = first(/^\s*temperature:\s*(-?\d+)\s*$/m);
  const level = first(/^\s*level:\s*(\d+)\s*$/m);
  if (temp === undefined || level === undefined) return null;
  const charging = ['AC', 'USB', 'Wireless', 'Dock'].some((k) => new RegExp(`^\\s*${k} powered:\\s*true\\s*$`, 'm').test(text));
  // The charge counter (µAh) and the current (mA, negative while discharging), from the service's own lines only: the battery event
  // history that dumpsys prints below them is never read, since it holds times of use and other apps (docs/method.md, Battery).
  // Either is null on a phone that does not print it.
  const counter = first(/^\s*Charge counter:\s*(-?\d+)\s*$/m);
  const current = first(/^\s*current now:\s*(-?\d+)\s*$/m);
  return { level: Number(level), temperature_c: Number(temp) / 10, charging,
    charge_counter_uah: counter === undefined ? null : Number(counter), current_now_ma: current === undefined ? null : Number(current) };
}

export const logLine = (b, at) => `${at} level=${b.level} temperature_c=${b.temperature_c} charging=${b.charging} charge_counter_uah=${b.charge_counter_uah ?? 'none'} current_now_ma=${b.current_now_ma ?? 'none'}`;

function poll(serial) {
  return new Promise((resolve) => {
    const args = [...(serial ? ['-s', serial] : []), 'shell', 'dumpsys', 'battery'];
    execFile('adb', args, { timeout: 8000 }, (err, out) => resolve(err ? null : parseBattery(out)));
  });
}

// pathToFileURL, not pathname: a path with a space must still run.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [file, serial] = process.argv.slice(2);
  if (!file) { console.error('usage: node scripts/battery-log.mjs battery.log [adb serial]'); process.exit(2); }
  const tick = async () => {
    const at = new Date().toISOString();
    const b = await poll(serial);
    appendFileSync(file, `${b ? logLine(b, at) : `${at} unreadable`}\n`);
  };
  tick();
  setInterval(tick, INTERVAL_MS);
}
