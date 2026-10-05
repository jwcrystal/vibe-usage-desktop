// log.js — event logging shared by the standalone server (launchd) and the
// Electron desktop main process. pi-ai notify-style: one event per line,
// [component] message key=value, and credentials are never logged — the
// providers' "nothing secret reaches a result" rule extends to logs.
//
// Destinations: stdout always (npm start sees it live; launchd captures it
// in ~/.vibe-usage/logs/vibe-usage-server.log); plus an optional size-capped
// file via configureLogFile (the desktop app points it at desktop.log — its
// stdout is lost when launched from Finder). Past CAP_BYTES the file is
// truncated to its trailing half so long-running processes never grow
// unbounded (the pre-existing launchd .err file had reached 3.8MB).
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const CAP_BYTES = 5 * 1024 * 1024;
let logFile = null;

/** Route future events to `path` as well. Unwritable path = stdout only. */
export function configureLogFile(path) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    logFile = path;
  } catch {
    logFile = null;
  }
}

export function logEvent(component, message, fields) {
  const kv = fields
    ? ' ' + Object.entries(fields).map(([k, v]) => `${k}=${String(v)}`).join(' ')
    : '';
  const line = `[${component}]${message ? ' ' + message : ''}${kv}`;
  console.log(line);
  if (!logFile) return;
  try {
    if (existsSync(logFile) && statSync(logFile).size > CAP_BYTES) {
      const tail = readFileSync(logFile).subarray(Math.floor(CAP_BYTES / 2));
      const nl = tail.indexOf(10);
      writeFileSync(logFile, nl >= 0 ? tail.subarray(nl + 1) : tail);
    }
    appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Disk trouble must never take the server down — drop the line.
  }
}
