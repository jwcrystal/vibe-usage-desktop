import { app, BrowserWindow, Tray, Menu, dialog, nativeImage, ipcMain, shell } from 'electron';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { accessSync, constants, existsSync, readFileSync, mkdirSync, writeFileSync, chmodSync, watch, readdirSync } from 'node:fs';
import { join, dirname, sep, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loginCodex, refreshIfExpiring } from './codex-oauth.js';
import { loginCommandcode, loginOpencodeGo } from './apikey-login.js';
import { configureLogFile, logEvent } from './server/log.js';
import { loadData } from './server/store.js';
import { loadPrices, estimateCost } from './server/prices.js';

// Packaged-app stdout is lost (Finder/Dock launch) — tee events to a
// size-capped file next to the other vibe-usage logs. npm start still sees
// everything live in the terminal.
configureLogFile(join(homedir(), '.vibe-usage', 'logs', 'desktop.log'));

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
// Menu-bar title mirrors the dashboard's selected range. The renderer pushes
// the descriptor after every load ('vibe-tray-range'); the default matches the
// dashboard's own default ("today").
let trayRange = { kind: 'today' };
// Set by startServer(); supplies filterBuckets so the tray aggregates with the
// exact same window logic as GET /api/usage.
let serverApi = null;

async function startServer() {
  // Must run before importing server.js: the server resolves its expected
  // API key from config.json once, at module-load time. Without this, a
  // fresh install (no config) runs the server in permissive mode while the
  // dashboard gets an empty injected key -> every /api/usage call 401s.
  ensureLocalCliConfig();
  const mod = await import('./server/server.js');
  const { server, start } = mod;
  serverApi = mod;
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
    webPreferences: { preload: join(__dirname, 'preload.cjs') },
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
  updateTrayTitle();
  // Data keeps growing while the window is hidden (the daemon syncs), so
  // refresh on a timer as well as on every renderer-reported range change.
  setInterval(updateTrayTitle, 60000);
  watchQuotaConfig();
  tray.on('click', () => { if (!win) createWindow(); win.show(); win.focus(); });
}

// --- Menu-bar readout: cost + tokens for the dashboard's selected range ---
// The renderer reports its range selection after every load; main aggregates
// the shared data file with the server's own helpers (same window filter and
// live pricing as GET /api/usage), so tray and dashboard KPIs never disagree.
// macOS shows a two-line readout (cost over tokens next to a mark). An
// NSStatusItem title is single-line, so the whole thing is drawn on a canvas
// in a hidden window and pushed as a 2x image. It is drawn all-black and set
// as a template image: AppKit then recolors it for the menu bar's actual
// appearance — which matters because the bar can be tinted dark by the
// wallpaper while the system reports light. Other platforms have no text
// slot, so the numbers land in the tooltip.

function sanitizeTrayRange(r) {
  if (!r || typeof r !== 'object') return null;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  if (r.kind === 'today') return { kind: 'today' };
  if (r.kind === 'hours') {
    const h = num(r.h);
    return h && h > 0 ? { kind: 'hours', h } : null;
  }
  if (r.kind === 'preset') {
    const days = num(r.days);
    return days && days > 0 ? { kind: 'preset', days } : null;
  }
  if (r.kind === 'custom') {
    const from = num(r.from);
    const to = num(r.to);
    return from != null && to != null && from <= to ? { kind: 'custom', from, to } : null;
  }
  return null;
}

// Mirrors the dashboard's computeRange() (server/ui/dashboard.html). Presets
// go over as days= so both sides anchor the rolling window at request time.
function trayQueryParams() {
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  if (trayRange.kind === 'hours') return { from: iso(now - trayRange.h * 3600000), to: iso(now) };
  if (trayRange.kind === 'preset') return { days: String(trayRange.days) };
  if (trayRange.kind === 'custom') return { from: iso(trayRange.from), to: iso(trayRange.to) };
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  return { from: iso(midnight.getTime()), to: iso(now) };
}

// Formatting copies the dashboard's money()/fmtTok() so both surfaces show the
// same string — keep in sync when those change.
const trayMoney = (v) => '$' + (v >= 1 ? v.toFixed(2) : v.toFixed(4));
const trayFmtTok = (n) => {
  n = n || 0;
  const units = ['', 'K', 'M', 'B', 'T'];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i += 1; }
  if (i > 0 && i < units.length - 1 && n >= 999.5) { n /= 1000; i += 1; }
  return i === 0 ? String(n) : n.toFixed(i === 1 ? 0 : 1) + units[i];
};

// Renders the two-line readout (mark + cost over tokens) on a canvas and
// returns a 2x PNG data URL. Lives in a hidden window: the main process has no
// DOM, and a plain hidden page needs no paint/compositing for toDataURL.
// Geometry was tuned against the reference menu-bar app: 18pt mark, 11/10
// text at semibold, tight leading, block top-aligned with the mark.
const TRAY_RENDER_PAGE = `<!doctype html><meta charset="utf-8"><body style="margin:0"><script>
function renderTray(o) {
  const family = '-apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif';
  const font = (weight, size) => weight + ' ' + size + 'px ' + family;
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = font(700, 11);
  const costW = probe.measureText(o.cost).width;
  probe.font = font(600, 10);
  const tokW = probe.measureText(o.tok).width;
  const mark = 18;
  const gap = 6;
  const height = 20;
  const width = Math.ceil(mark + gap + Math.max(costW, tokW)) + 0.5;
  const canvas = document.createElement('canvas');
  canvas.width = width * 2;
  canvas.height = height * 2;
  const ctx = canvas.getContext('2d');
  ctx.scale(2, 2);
  ctx.fillStyle = '#000';
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(0.75, 2.25, 16.5, 16.5, 1.8);
  ctx.stroke();
  ctx.font = font(700, 11);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('U', 9, 10.9);
  ctx.textAlign = 'left';
  ctx.font = font(600, 10);
  ctx.fillText(o.tok, mark + gap, 14.4);
  ctx.font = font(700, 11);
  ctx.fillText(o.cost, mark + gap, 5.5);
  return canvas.toDataURL('image/png');
}
</script></body>`;

let trayImageWin = null;
let lastTrayKey = null;

function trayImageWindow() {
  if (trayImageWin && !trayImageWin.isDestroyed()) return trayImageWin;
  trayImageWin = new BrowserWindow({
    show: false,
    width: 400,
    height: 80,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  trayImageWin.on('closed', () => { trayImageWin = null; });
  trayImageWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(TRAY_RENDER_PAGE));
  return trayImageWin;
}

async function renderTrayImage(money, tok) {
  const page = trayImageWindow();
  if (page.webContents.isLoading()) {
    await new Promise((resolve) => page.webContents.once('did-finish-load', resolve));
  }
  return page.webContents.executeJavaScript(`renderTray(${JSON.stringify({ cost: money, tok })})`);
}

async function updateTrayTitle() {
  if (!tray || !serverApi) return;
  const prices = loadPrices();
  const buckets = serverApi.filterBuckets(loadData().buckets, trayQueryParams());
  let cost = 0;
  let tokens = 0;
  for (const b of buckets) {
    const c = estimateCost(b, prices);
    if (c != null) cost += c;
    tokens += (b.inputTokens || 0) + (b.outputTokens || 0) + (b.reasoningOutputTokens || 0) + (b.cachedInputTokens || 0);
  }
  const money = trayMoney(cost);
  const tok = trayFmtTok(tokens);
  tray.setToolTip(`Vibe Usage Desktop — ${money} · ${tok}`);
  if (process.platform !== 'darwin') return;
  // Skip identical re-renders (the 60s tick usually changes nothing).
  const key = `${money}|${tok}`;
  if (key === lastTrayKey) return;
  try {
    const dataUrl = await renderTrayImage(money, tok);
    const image = nativeImage.createEmpty();
    image.addRepresentation({ scaleFactor: 2, dataURL: dataUrl });
    image.setTemplateImage(true);
    tray.setImage(image);
    tray.setTitle('');
    lastTrayKey = key;
  } catch (err) {
    // Never leave the tray blank: fall back to the single-line text title.
    console.error('[tray] image render failed, using text title:', err.message);
    tray.setTitle(`${money} · ${tok}`, { fontType: 'monospacedDigit' });
    lastTrayKey = null;
  }
}

ipcMain.on('vibe-tray-range', (_event, r) => {
  const next = sanitizeTrayRange(r);
  if (!next) return;
  trayRange = next;
  updateTrayTitle();
});

// Quota sync opt-in lives in the shared ~/.vibe-usage/config.json — the same
// fields the web dashboard's 管理 menu writes and the CLI reads. The tray
// mirrors those toggles natively; changes take effect on the daemon's next
// sync cycle. The server endpoint is the single writer path (validation plus
// the quotaSyncApiUrl binding), exactly like the web menu.
const QUOTA_PRODUCTS = [
  { id: 'codex', label: 'Codex' },
  { id: 'commandcode', label: 'CommandCode' },
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'opencode-go', label: 'OpenCode Go' },
];

function readConfigValue(key) {
  try {
    const dir = process.env.VIBE_USAGE_CONFIG_DIR?.trim() || join(homedir(), '.vibe-usage');
    return JSON.parse(readFileSync(join(dir, 'config.json'), 'utf-8'))?.[key];
  } catch {
    return undefined;
  }
}

function quotaSyncEnabled() {
  const ids = readConfigValue('quotaSyncProducts');
  return Array.isArray(ids) ? ids.filter((id) => QUOTA_PRODUCTS.some((p) => p.id === id)) : [];
}

let quotaToggling = null;
function toggleQuotaProduct(id, on) {
  if (quotaToggling) return quotaToggling;
  quotaToggling = (async () => {
    const current = quotaSyncEnabled();
    const next = on ? [...new Set([...current, id])] : current.filter((x) => x !== id);
    try {
      const key = readConfigValue('apiKey');
      const res = await fetch(`http://${HOST}:${PORT}/api/usage/quota-sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ products: next }),
      });
      if (!res.ok) {
        const why = res.status === 409 ? 'apiUrl must point at this machine (loopback)' : `HTTP ${res.status}`;
        dialog.showErrorBox('Quota sync', `Could not update quota products: ${why}`);
      }
    } catch (err) {
      dialog.showErrorBox('Quota sync', `Could not reach the local server: ${err.message}`);
    } finally {
      refreshTrayMenu();
    }
  })();
  const done = quotaToggling.finally(() => { quotaToggling = null; });
  quotaToggling = done;
  return done;
}

// The tray mirrors quotaSyncProducts from the shared config; the web 管理
// menu, the CLI (`quota sync enable/disable`), and manual edits all write
// that same file — watch it so the checkboxes never go stale, whichever
// surface changed it. Atomic writers replace the file (rename), so watch
// the directory and filter by name.
function watchQuotaConfig() {
  const dir = process.env.VIBE_USAGE_CONFIG_DIR?.trim() || join(homedir(), '.vibe-usage');
  let timer = null;
  try {
    watch(dir, (_event, fileName) => {
      if (fileName && fileName !== 'config.json') return;
      clearTimeout(timer);
      timer = setTimeout(() => { if (tray) refreshTrayMenu(); }, 250);
    });
  } catch { /* config dir may not exist on a fresh machine yet */ }
}

function refreshTrayMenu() {
  const enabled = quotaSyncEnabled();
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: 'Open Dashboard',
      click: () => { if (!win) createWindow(); win.show(); win.focus(); },
    },
    { type: 'separator' },
    { label: 'Quota Sync (applies on next daemon run)', enabled: false },
    ...QUOTA_PRODUCTS.map((product) => ({
      label: product.label,
      type: 'checkbox',
      checked: enabled.includes(product.id),
      click: (mi) => toggleQuotaProduct(product.id, mi.checked),
    })),
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
    // Machines without the official codex CLI have nobody to refresh the
    // OAuth token we wrote — top it up (cheap no-op while fresh) so the
    // sync never reads an expired ~/.codex/auth.json.
    try {
      await refreshIfExpiring({ log: (m) => logEvent('codex-oauth', m) });
    } catch (err) {
      logEvent('codex-oauth', 'refresh skipped: ' + ((err && err.message) || err));
    }
    const cli = await findDaemonCli();
    if (!cli) return { ok: false, out: 'vibe-usage CLI not found' };
    const res = await run(cli.cmd, [...cli.pre, 'sync'], cli.env);
    return { ok: res.ok, out: res.out.slice(-2000) };
  })();
  const done = syncing.finally(() => { syncing = null; });
  syncing = done;
  return done;
});

// Quota card 登入/安裝 buttons: per-product official login. The binary is
// checked at click time — present, Terminal.app runs the tool's own login
// command (each official login opens its browser OAuth itself and writes the
// credential file the quota providers read); missing, the product site opens
// instead. Ids are allowlisted and commands are static constants, never built
// from renderer input.
const QUOTA_LOGIN = {
  codex: { bin: ['codex'], cmd: 'codex login', url: 'https://github.com/openai/codex' },
  'claude-code': { bin: ['claude'], cmd: 'claude', hint: '已開啟 claude — 輸入 /login 登入', url: 'https://docs.anthropic.com/en/docs/claude-code/overview' },
  commandcode: { bin: ['command-code', 'cmd'], cmd: 'cmd login', url: 'https://commandcode.ai' },
  'opencode-go': { bin: ['opencode'], cmd: 'opencode auth login', url: 'https://opencode.ai/docs' },
};

function firstBinOnPath(names) {
  const home = homedir();
  const dirs = new Set((process.env.PATH || '').split(delimiter).filter(Boolean));
  // GUI (Finder/Dock) launches get a minimal PATH without the package
  // managers and per-product bins where these CLIs actually live — scan the
  // known locations explicitly instead of trusting the inherited PATH.
  for (const dir of [
    '/opt/homebrew/bin', '/usr/local/bin',
    join(home, '.local', 'bin'), join(home, '.npm-global', 'bin'),
    join(home, '.opencode', 'bin'),
  ]) dirs.add(dir);
  try {
    for (const version of readdirSync(join(home, '.nvm', 'versions', 'node'))) {
      dirs.add(join(home, '.nvm', 'versions', 'node', version, 'bin'));
    }
  } catch { /* nvm absent — fine */ }
  for (const name of names) {
    for (const dir of dirs) {
      try {
        accessSync(join(dir, name), constants.X_OK);
        return name;
      } catch { /* keep scanning */ }
    }
  }
  return null;
}

ipcMain.handle('vibe-quota-login', (_event, productId) => {
  const act = QUOTA_LOGIN[productId];
  if (!act) return { action: 'none' };
  const bin = firstBinOnPath(act.bin);
  logEvent('quota-login', 'detected binary=' + (bin || 'none'), { product: productId });
  if (!bin) {
    shell.openExternal(act.url);
    return { action: 'url' };
  }
  // Terminal.app runs the login; osascript failures fall back to the site.
  const script = 'tell application "Terminal" to do script ' + JSON.stringify(act.cmd);
  spawn('osascript', ['-e', script], { stdio: 'ignore' }).on('error', () => {
    shell.openExternal(act.url);
  });
  return { action: 'terminal', hint: act.hint || ('已開啟終端機：' + act.cmd) };
});

ipcMain.handle('vibe-open-external', (_event, url) => {
  if (typeof url === 'string' && /^https:\/\//.test(url)) shell.openExternal(url);
  return { ok: true };
});

// In-app codex OAuth (Phase 1): pi-ai drives the browser flow, the credential
// lands in ~/.codex/auth.json (official format), then a one-shot sync fills
// the card immediately. Single-flight like vibe-sync. On failure the renderer
// falls back to the guided path (Terminal / 官網), which reports its own toast.
let oauthLogin = null;
ipcMain.handle('vibe-quota-oauth-login', (_event, productId) => {
  if (productId !== 'codex') return Promise.resolve({ ok: false, error: 'unsupported_product' });
  if (oauthLogin) return oauthLogin;
  oauthLogin = (async () => {
    try {
      await loginCodex({
        openUrl: (url) => shell.openExternal(url),
        log: (m) => logEvent('codex-oauth', m),
      });
      // Return the moment the credential lands — the renderer runs the sync
      // (refreshNow), so the user sees 已登入 immediately instead of after
      // a 30-60s CLI sync inside one silent IPC round-trip.
      return { ok: true };
    } catch (err) {
      logEvent('codex-oauth', 'login failed: ' + ((err && err.message) || err));
      return { ok: false, error: String((err && err.message) || err) };
    }
  })();
  const done = oauthLogin.finally(() => { oauthLogin = null; });
  oauthLogin = done;
  return done;
});

// Phase 2: in-app API-key login (Command Code / OpenCode Go). The key is
// validated against the official endpoint first — only a valid key is ever
// persisted. Returns as soon as the credential is written; the renderer
// kicks the usual sync (refreshNow) so feedback is immediate instead of
// waiting out a ~30-60s CLI sync inside one IPC round-trip.
ipcMain.handle('vibe-quota-key-login', async (_event, productId, key) => {
  try {
    const login = productId === 'commandcode' ? loginCommandcode
      : productId === 'opencode-go' ? loginOpencodeGo : null;
    if (!login) return { ok: false, error: 'unsupported_product' };
    const res = await login(key);
    logEvent('key-login', res.ok ? 'ok (credential written)' : 'failed: ' + res.error, { product: productId });
    return res;
  } catch (err) {
    logEvent('key-login', 'error: ' + ((err && err.message) || err), { product: productId });
    return { ok: false, error: String((err && err.message) || err) };
  }
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
      const htmlOk = res.status === 200 && (await res.text()).includes('<html');
      console.log(`[smoke] GET / -> ${res.status}, html=${htmlOk}`);
      const probe = new BrowserWindow({
        show: false,
        webPreferences: { preload: join(__dirname, 'preload.cjs') },
      });
      await probe.loadURL(DASHBOARD_URL);
      const bridgeOk = await probe.webContents.executeJavaScript('typeof window.vibeDesktop?.syncNow === "function"');
      console.log(`[smoke] sandboxed preload sync bridge=${bridgeOk}`);
      app.exit(htmlOk && bridgeOk ? 0 : 1);
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
