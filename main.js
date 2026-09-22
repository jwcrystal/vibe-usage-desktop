import { app, BrowserWindow, Tray, Menu, dialog, nativeImage } from 'electron';
import { join, dirname } from 'node:path';
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
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => { app.isQuitting = true; app.quit(); },
    },
  ]));
  tray.on('click', () => { if (!win) createWindow(); win.show(); win.focus(); });
}

app.on('before-quit', () => { app.isQuitting = true; });

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
