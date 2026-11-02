import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  firstBinOnPath, openProductLogin, terminalLauncher,
} from '../login-launcher.js';

function tempRoot(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('firstBinOnPath finds the Windows .cmd form npm installs', () => {
  const root = tempRoot('vibe-login-win-');
  try {
    const dir = join(root, 'npm');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'claude.cmd'), '@echo off\r\n');
    assert.equal(firstBinOnPath(['claude'], {
      environment: { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
      platform: 'win32',
      home: root,
    }), 'claude');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('firstBinOnPath keeps the POSIX execute-bit rule', () => {
  const root = tempRoot('vibe-login-posix-');
  try {
    const dir = join(root, 'bin');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'codex'), '#!/bin/sh\n', { mode: 0o644 });
    const environment = { PATH: dir };
    assert.equal(firstBinOnPath(['codex'], {
      environment, platform: 'linux', home: root,
    }), null, 'a file without the execute bit is not a command');

    chmodSync(join(dir, 'codex'), 0o700);
    assert.equal(firstBinOnPath(['codex'], {
      environment, platform: 'linux', home: root,
    }), 'codex');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('terminalLauncher keeps Terminal.app on macOS and gives Windows its own window', () => {
  const macOS = terminalLauncher('codex login', { platform: 'darwin' });
  assert.equal(macOS.cmd, 'osascript');
  assert.deepEqual(macOS.args.slice(0, 1), ['-e']);
  assert.match(macOS.args[1], /^tell application "Terminal" to do script "codex login"$/);

  const windows = terminalLauncher('codex login', { platform: 'win32' });
  assert.equal(windows.cmd, 'cmd');
  assert.deepEqual(windows.args, ['/c', 'start', '', 'cmd', '/k', 'codex login']);

  // The empty start title is what stops cmd from treating the quoted command as
  // the window title; without it a path with spaces is eaten.
  assert.equal(windows.args[2], '');
});

test('terminalLauncher picks the first installed Linux terminal, or none', () => {
  const seen = [];
  const linux = terminalLauncher('claude', {
    platform: 'linux',
    binOnPath: (name) => { seen.push(name); return name === 'konsole'; },
  });
  assert.equal(linux.cmd, 'konsole');
  assert.deepEqual(linux.args.slice(0, 4), ['-e', 'sh', '-lc', 'claude; exec "${SHELL:-sh}"']);
  assert.deepEqual(seen, ['x-terminal-emulator', 'gnome-terminal', 'konsole']);

  assert.equal(terminalLauncher('claude', { platform: 'linux', binOnPath: () => false }), null);
  assert.equal(terminalLauncher('claude', { platform: 'freebsd', binOnPath: () => true }), null);
});

test('openProductLogin falls back to the product page when nothing can be opened', () => {
  const opened = [];
  const openExternal = (url) => opened.push(url);

  assert.deepEqual(
    openProductLogin({ bin: null, command: 'codex login', url: 'https://example.invalid', openExternal }),
    { action: 'url' },
  );
  assert.deepEqual(
    openProductLogin({
      bin: 'codex', command: 'codex login', url: 'https://example.invalid',
      platform: 'linux', binOnPath: () => false, openExternal,
    }),
    { action: 'url' },
  );
  assert.deepEqual(opened, ['https://example.invalid', 'https://example.invalid']);
});

test('openProductLogin runs the login in a terminal and survives a failed launch', () => {
  const opened = [];
  const launches = [];
  const spawnImpl = (cmd, args) => {
    launches.push([cmd, args]);
    return { on() {} };
  };

  const result = openProductLogin({
    bin: 'claude',
    command: 'claude',
    url: 'https://example.invalid',
    hint: '已開啟 claude',
    platform: 'darwin',
    spawnImpl,
    openExternal: (url) => opened.push(url),
  });
  assert.deepEqual(result, { action: 'terminal', hint: '已開啟 claude' });
  assert.equal(launches.length, 1);
  assert.equal(launches[0][0], 'osascript');
  assert.equal(opened.length, 0);

  // A spawn that throws (or an automation denial reported through 'error') must
  // land on the page instead of leaving the click with nothing to show.
  const throwing = openProductLogin({
    bin: 'claude', command: 'claude', url: 'https://example.invalid',
    platform: 'darwin',
    spawnImpl: () => { throw new Error('no terminal'); },
    openExternal: (url) => opened.push(url),
  });
  assert.deepEqual(throwing, { action: 'url' });

  openProductLogin({
    bin: 'claude', command: 'claude', url: 'https://example.invalid',
    platform: 'darwin',
    spawnImpl: () => ({ on: (event, cb) => { if (event === 'error') cb(new Error('denied')); } }),
    openExternal: (url) => opened.push(url),
  });
  assert.deepEqual(opened, ['https://example.invalid', 'https://example.invalid']);
});
