import { app, BrowserWindow, Tray, Menu, dialog, nativeImage, ipcMain } from 'electron';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || process.env.VIBE_USAGE_PORT || 3456);
const HOST = '127.0.0.1';
const DASHBOARD_URL = `http://${HOST}:${PORT}/`;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let win = null;
let tray = null;
let portInUse = false;

async function startServer() {
  const { server, start } = await import('./server/server.js');
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      portInUse = true;
      console.warn(`[server] port ${PORT} in use — connecting to the already-running local server (same data file).`);
    } else {
      console.error('[server]', err);
    }
  });
  start();
  await new Promise((r) => setTimeout(r, 600));
  if (portInUse) {
    dialog.showMessageBox({
      type: 'info',
      title: 'Vibe Usage Desktop',
      message: `Port ${PORT} is already in use.`,
      detail: 'The dashboard will connect to the existing local server (they share the same data file). Quit the other server (e.g. launchd agent) to let this app host it.',
    });
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Vibe Usage Desktop',
    icon: join(__dirname, 'build', 'icon.png'),
    show: false,
    webPreferences: { preload: join(__dirname, 'preload.js') },
  });
  win.loadURL(DASHBOARD_URL);
  win.once('ready-to-show', () => win.show());
  win.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => { win = null; });
}

function createTray() {
  const icon = nativeImage
    .createFromPath(join(__dirname, 'build', 'icon.png'))
    .resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('Vibe Usage Desktop');
  refreshTrayMenu();
  tray.on('click', () => { if (!win) createWindow(); win.show(); win.focus(); });
}

function refreshTrayMenu() {
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: 'Open Dashboard',
      click: () => { if (!win) createWindow(); win.show(); win.focus(); },
    },
    { type: 'separator' },
    {
      label: 'Launch at Login',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (mi) => app.setLoginItemSettings({ openAtLogin: mi.checked }),
    },
    {
      label: 'Usage Daemon (background)',
      type: 'checkbox',
      checked: daemonInstalled(),
      click: (mi) => { if (mi.checked) installDaemon(); else uninstallDaemon(); },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => { app.isQuitting = true; app.quit(); },
    },
  ]));
}

// --- vibe-usage daemon service management (delegates to the CLI) ---
// Service-file locations mirror vibe-usage's daemon-service.js getServicePaths().
const DAEMON_LABEL = 'ai.vibecafe.vibe-usage';
const DAEMON_UNIT = 'vibe-usage';
const NPM_PKG = '@vibe-cafe/vibe-usage';

function daemonServiceFile() {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'LaunchAgents', `${DAEMON_LABEL}.plist`);
  if (process.platform === 'linux') return join(homedir(), '.config', 'systemd', 'user', `${DAEMON_UNIT}.service`);
  if (process.platform === 'win32') return join(homedir(), '.vibe-usage', 'daemon-task.xml');
  return null;
}

// Mirrors the CLI's installed-state semantics (daemon-service.js): launchd/
// systemd = service file exists; taskscheduler = live task OR leftover
// daemon-task.xml counts as installed, so the checkbox can always drive a
// clean uninstall. "Already installed" install-side checks live task only.
function daemonInstalled() {
  if (process.platform === 'win32') {
    let task = false;
    try {
      const r = spawnSync('schtasks', ['/Query', '/TN', 'vibe-usage'], { stdio: 'ignore', windowsHide: true });
      task = r.status === 0;
    } catch { /* schtasks missing — fall back to the file check */ }
    return task || existsSync(join(homedir(), '.vibe-usage', 'daemon-task.xml'));
  }
  const f = daemonServiceFile();
  return Boolean(f && existsSync(f));
}

function run(cmd, args, extraEnv = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...extraEnv } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('error', (err) => resolve({ ok: false, out: String(err) }));
    p.on('close', (code) => resolve({ ok: code === 0, out }));
  });
}

// Locate the CLI. Preferred: the copy bundled in ./cli, run via this app's own
// Electron binary in Node mode — no npm/Node install required on the user's
// machine. Fallbacks: PATH binary; the launchd plist the CLI itself wrote
// (ProgramArguments = [node, script, 'daemon']) so repo-checkout installs work.
const bundledCli = () => {
  let bin = join(__dirname, 'cli', 'bin', 'vibe-usage.js');
  // In a packaged app the CLI lives in app.asar.unpacked (see electron-builder
  // asarUnpack) because ELECTRON_RUN_AS_NODE cannot execute scripts inside the
  // asar archive — translate the asar path Electron reports to the real one.
  bin = bin.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`);
  return existsSync(bin) ? { cmd: process.execPath, pre: [bin], env: { ELECTRON_RUN_AS_NODE: '1' } } : null;
};

async function findDaemonCli() {
  const bundled = bundledCli();
  if (bundled) return bundled;
  const which = process.platform === 'win32' ? 'where' : 'which';
  const w = await run(which, ['vibe-usage']);
  if (w.ok && w.out.trim()) return { cmd: w.out.trim().split('\n')[0], pre: [] };
  if (process.platform === 'darwin' && daemonInstalled()) {
    try {
      const strings = [...readFileSync(daemonServiceFile(), 'utf8').matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
      const i = strings.indexOf('daemon');
      if (i >= 2) return { cmd: strings[i - 2], pre: [strings[i - 1]] };
    } catch { /* unreadable plist — fall through */ }
  }
  return null;
}

async function installDaemon() {
  let cli = await findDaemonCli();
  if (!cli) {
    const r = await dialog.showMessageBox({
      type: 'question',
      buttons: ['Install', 'Cancel'],
      defaultId: 0,
      title: 'Vibe Usage Desktop',
      message: 'Install the vibe-usage CLI globally?',
      detail: `The background daemon needs the CLI.\n\nThis runs: npm install -g ${NPM_PKG}`,
    });
    if (r.response !== 0) { refreshTrayMenu(); return; }
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const inst = await run(npm, ['install', '-g', NPM_PKG]);
    if (!inst.ok) {
      dialog.showErrorBox('vibe-usage install failed', inst.out.trim() || 'npm install -g failed');
      refreshTrayMenu();
      return;
    }
    cli = await findDaemonCli();
  }
  if (!cli) {
    dialog.showErrorBox('vibe-usage CLI not found', 'npm install reported success but the CLI is still not on PATH.');
    refreshTrayMenu();
    return;
  }
  ensureLocalCliConfig();
  const res = await run(cli.cmd, [...cli.pre, 'daemon', 'install'], cli.env);
  if (!daemonInstalled()) dialog.showErrorBox('daemon install failed', res.out.trim() || 'unknown error');
  refreshTrayMenu();
}

// Fresh-machine pairing: write ~/.vibe-usage/config.json so the daemon feeds
// this app's embedded server (same file the CLI and server both read; see
// vibe-usage config.js and server.js resolveExpectedKey). Never touch an
// existing config — that is a deliberate cloud or local pairing.
function ensureLocalCliConfig() {
  const dir = process.env.VIBE_USAGE_CONFIG_DIR?.trim() || join(homedir(), '.vibe-usage');
  const cfgPath = join(dir, 'config.json');
  if (existsSync(cfgPath)) return;
  const apiKey = 'vbu_' + randomBytes(24).toString('hex');
  mkdirSync(dir, { recursive: true });
  // File holds a vbu_ API key — owner-only on POSIX (best effort on Windows).
  writeFileSync(cfgPath, JSON.stringify({ apiUrl: `http://127.0.0.1:${PORT}`, apiKey }, null, 2) + '\n', { mode: 0o600 });
  try { chmodSync(cfgPath, 0o600); } catch { /* Windows permission model differs */ }
}

async function uninstallDaemon() {
  const cli = await findDaemonCli();
  if (!cli) {
    dialog.showErrorBox('vibe-usage CLI not found', 'Cannot locate the CLI that installed the daemon. Uninstall manually with: vibe-usage daemon uninstall');
    refreshTrayMenu();
    return;
  }
  const res = await run(cli.cmd, [...cli.pre, 'daemon', 'uninstall'], cli.env);
  if (daemonInstalled()) dialog.showErrorBox('daemon uninstall failed', res.out.trim() || 'unknown error');
  refreshTrayMenu();
}



app.on('before-quit', () => { app.isQuitting = true; });

// Dashboard "更新" button: run a one-shot `vibe-usage sync` (parse local usage
// files -> POST to this server), then the caller re-fetches the view. Guarded
// so overlapping clicks share one sync.
let syncing = null;
ipcMain.handle('vibe-sync', () => {
  if (syncing) return syncing;
  syncing = (async () => {
    const cli = await findDaemonCli();
    if (!cli) return { ok: false, out: 'vibe-usage CLI not found' };
    const res = await run(cli.cmd, [...cli.pre, 'sync'], cli.env);
    return { ok: res.ok, out: res.out.slice(-2000) };
  })();
  const done = syncing.finally(() => { syncing = null; });
  syncing = done;
  return done;
});

app.on('second-instance', () => {
  if (win) { win.show(); win.focus(); }
});

app.on('activate', () => {
  if (!win) createWindow();
  else { win.show(); win.focus(); }
});

app.on('window-all-closed', (e) => {
  // Keep running in tray on all platforms; quit via tray menu.
});

if (process.env.VIBE_DESKTOP_SMOKE === '1') {
  app.whenReady().then(async () => {
    try {
      await startServer();
      const res = await fetch(DASHBOARD_URL);
      const ok = res.status === 200 && (await res.text()).includes('<html');
      console.log(`[smoke] GET / -> ${res.status}, html=${ok}`);
      app.exit(ok ? 0 : 1);
    } catch (err) {
      console.error('[smoke] failed:', err);
      app.exit(1);
    }
  });
} else {
  app.whenReady().then(async () => {
    await startServer();
    createTray();
    createWindow();
  });
}
