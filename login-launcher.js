// login-launcher.js — open a product's own login command from a quota card.
//
// The quota card's 登入/安裝 button starts the official CLI so its browser OAuth
// can write the credential file the quota providers read. macOS could hardcode
// Terminal.app through osascript; Windows and Linux each need their own way in.
// Every branch keeps the original fallback: when no terminal can be opened the
// product page opens instead, so a missing terminal never blocks the user.
import { spawn } from 'node:child_process';
import { accessSync, constants, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

// The default Windows executable suffixes, used when PATHEXT is unset (a GUI app
// started from a shortcut inherits a minimal environment).
const WINDOWS_DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/** PATH-style delimiter for the platform; tests drive win32 from macOS. */
export function pathDelimiter(platform = process.platform) {
  return platform === 'win32' ? ';' : delimiter;
}

/**
 * Candidate file names for `name`: the bare name everywhere, plus every PATHEXT
 * suffix in its declared case and lowercase on Windows. npm installs `claude`
 * as `claude.cmd` there, so the bare name alone finds nothing.
 */
export function executableNames(name, { environment = process.env, platform = process.platform } = {}) {
  if (platform !== 'win32') return [name];
  const extensions = (environment.PATHEXT || WINDOWS_DEFAULT_PATHEXT)
    .split(';')
    .map(value => value.trim())
    .filter(Boolean)
    .map(value => (value.startsWith('.') ? value : `.${value}`));
  const names = [name];
  for (const extension of extensions) {
    names.push(`${name}${extension}`, `${name}${extension.toLowerCase()}`);
  }
  return names;
}

/**
 * Is this exact path a runnable command? Windows has no POSIX execute bits, so
 * file presence plus a PATHEXT suffix is its rule; elsewhere the execute bit is.
 */
export function isExecutable(path, platform = process.platform) {
  try {
    accessSync(path, platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The first of `names` that exists on PATH, returned as a bare command name.
 * A GUI launch inherits a minimal PATH, so the known install prefixes and the
 * nvm tree are scanned explicitly instead of trusting the inherited list.
 */
export function firstBinOnPath(names, {
  environment = process.env,
  platform = process.platform,
  home = homedir(),
} = {}) {
  const directories = new Set((environment.PATH || '').split(pathDelimiter(platform)).filter(Boolean));
  for (const directory of [
    '/opt/homebrew/bin', '/usr/local/bin',
    join(home, '.local', 'bin'), join(home, '.npm-global', 'bin'), join(home, '.opencode', 'bin'),
  ]) directories.add(directory);
  try {
    for (const version of readdirSync(join(home, '.nvm', 'versions', 'node'))) {
      directories.add(join(home, '.nvm', 'versions', 'node', version, 'bin'));
    }
  } catch { /* nvm absent — fine */ }

  for (const name of names) {
    for (const candidate of executableNames(name, { environment, platform })) {
      for (const directory of directories) {
        if (isExecutable(join(directory, candidate), platform)) return name;
      }
    }
  }
  return null;
}

/**
 * How to run `command` in a visible terminal on this platform, or null when no
 * terminal is available. Pure: the caller supplies the PATH probe, so the
 * platform branches are testable from any host.
 */
export function terminalLauncher(command, {
  platform = process.platform,
  binOnPath = (name) => firstBinOnPath([name], { platform }),
} = {}) {
  if (platform === 'darwin') {
    return {
      cmd: 'osascript',
      args: ['-e', 'tell application "Terminal" to do script ' + JSON.stringify(command)],
    };
  }
  if (platform === 'win32') {
    // `start` is a cmd built-in: it opens a real console window, and /k keeps it
    // open afterwards so the login's output and OAuth prompt stay readable.
    return { cmd: 'cmd', args: ['/c', 'start', '', 'cmd', '/k', command] };
  }
  if (platform !== 'linux') return null;

  // Keep the window open after the command exits, like /k on Windows.
  const shellCommand = `${command}; exec "\${SHELL:-sh}"`;
  const terminals = [
    ['x-terminal-emulator', ['-e', 'sh', '-lc', shellCommand]],
    ['gnome-terminal', ['--', 'sh', '-lc', shellCommand]],
    ['konsole', ['-e', 'sh', '-lc', shellCommand]],
    ['xfce4-terminal', ['-e', 'sh', '-lc', shellCommand]],
    ['xterm', ['-e', 'sh', '-lc', shellCommand]],
  ];
  for (const [name, args] of terminals) {
    if (binOnPath(name)) return { cmd: name, args };
  }
  return null;
}

/**
 * Open `command` in a terminal, or fall back to the product page. Returns
 * `{ action: 'terminal' | 'url', hint? }` — the same shape the preload bridge
 * already hands the renderer.
 */
export function openProductLogin({
  bin,
  command,
  url,
  hint,
  platform = process.platform,
  spawnImpl = spawn,
  openExternal,
  binOnPath,
}) {
  const fallback = () => { openExternal(url); return { action: 'url' }; };
  if (!bin) return fallback();

  const launcher = terminalLauncher(command, { platform, binOnPath });
  if (!launcher) return fallback();

  try {
    const child = spawnImpl(launcher.cmd, launcher.args, { stdio: 'ignore' });
    // osascript reports a missing Terminal automation permission this way; the
    // page is still a working answer, so a failed launch is not an error state.
    child?.on?.('error', fallback);
    return { action: 'terminal', hint };
  } catch {
    return fallback();
  }
}
