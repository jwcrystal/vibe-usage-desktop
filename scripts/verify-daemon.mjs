#!/usr/bin/env node
// Cross-platform daemon verification. Runs the bundled CLI (via Electron in
// Node mode, exactly like the tray toggle does) through a full service cycle:
//
//   uninstall (clean slate) -> install -> status -> sync -> uninstall
//
// then restores the initial state (reinstalls if the daemon was installed
// before). Run on each target platform:
//
//   macOS / Linux:  node scripts/verify-daemon.mjs
//   Windows:        node scripts\verify-daemon.mjs
//
// The sync step needs the local server reachable on 127.0.0.1:3456 (start the
// app or the standalone server first); it is SKIPped otherwise.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'cli', 'bin', 'vibe-usage.js');
const IS_WIN = process.platform === 'win32';

if (!existsSync(CLI)) {
  console.error('FAIL: bundled CLI not found — run `sh scripts/sync-cli.sh` first.');
  process.exit(1);
}

function cli(args) {
  const r = spawnSync('npx', ['electron', CLI, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    shell: IS_WIN, // npx is npx.cmd on Windows
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  return { ok: r.status === 0, out };
}

function serviceState() {
  if (process.platform === 'darwin') {
    return existsSync(join(homedir(), 'Library', 'LaunchAgents', 'ai.vibecafe.vibe-usage.plist'));
  }
  if (process.platform === 'linux') {
    return existsSync(join(homedir(), '.config', 'systemd', 'user', 'vibe-usage.service'));
  }
  if (IS_WIN) {
    if (existsSync(join(homedir(), '.vibe-usage', 'daemon-task.xml'))) return true;
    const r = spawnSync('schtasks', ['/Query', '/TN', 'vibe-usage'], { stdio: 'ignore', shell: IS_WIN });
    return r.status === 0;
  }
  return false;
}

async function serverUp() {
  try { const r = await fetch('http://127.0.0.1:3456/'); return r.status === 200; } catch { return false; }
}

const results = [];
function report(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ' — ' + detail.split('\n')[0].slice(0, 120) : ''}`);
}

const initial = serviceState();
console.log(`platform=${process.platform}  initial daemon state=${initial ? 'installed' : 'not installed'}`);

console.log('\n[1/5] clean slate: uninstall');
let r = cli(['daemon', 'uninstall']);
report('uninstall (idempotent) exits 0', r.ok, r.out);
report('state now uninstalled', !serviceState());

console.log('\n[2/5] install');
r = cli(['daemon', 'install']);
report('install exits 0', r.ok, r.out);
report('state now installed', serviceState());

console.log('\n[3/5] status');
r = cli(['daemon', 'status']);
report('status exits 0', r.ok, r.out);

console.log('\n[4/5] one-shot sync (data path through the local server)');
if (await serverUp()) {
  r = cli(['sync']);
  report('sync exits 0', r.ok, r.out);
} else {
  console.log('  - SKIP: no server on 127.0.0.1:3456 (start the app first)');
}

console.log('\n[5/5] uninstall again');
r = cli(['daemon', 'uninstall']);
report('uninstall exits 0', r.ok, r.out);
report('state now uninstalled', !serviceState());

if (initial) {
  console.log('\nrestoring initial state: reinstall');
  r = cli(['daemon', 'install']);
  report('restore install', r.ok && serviceState(), r.out);
}

const failed = results.filter((x) => !x.ok);
console.log(`\n${failed.length === 0 ? 'ALL PASS' : failed.length + ' FAILED'} (${results.length - failed.length}/${results.length})`);
if (failed.length && initial) console.log('note: initial daemon state was restored despite failures');
process.exit(failed.length ? 1 : 0);
