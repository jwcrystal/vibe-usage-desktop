const { contextBridge, ipcRenderer } = require('electron');

// Passed through webPreferences.additionalArguments by main.js. Reading it here
// (instead of a synchronous IPC round trip) cannot block the page load.
const VERSION_PREFIX = '--vibe-app-version=';
const versionArg = process.argv.find((arg) => arg.startsWith(VERSION_PREFIX));

// Exposed to the dashboard at http://127.0.0.1:<port> (loopback only).
// The dashboard feature-detects this: in a plain browser (standalone server)
// window.vibeDesktop is undefined and refresh stays display-only, the quota
// 登入 button copies the login command instead of opening a terminal.
contextBridge.exposeInMainWorld('vibeDesktop', {
  // Desktop build version; the dashboard renders it as a header badge and
  // hides the badge when the page is opened in a plain browser.
  version: versionArg ? versionArg.slice(VERSION_PREFIX.length) : undefined,
  syncNow: () => ipcRenderer.invoke('vibe-sync'),
  setRange: (range) => ipcRenderer.send('vibe-tray-range', range),
  quotaLogin: (productId) => ipcRenderer.invoke('vibe-quota-login', String(productId)),
  quotaOAuthLogin: (productId) => ipcRenderer.invoke('vibe-quota-oauth-login', String(productId)),
  quotaKeyLogin: (productId, key) => ipcRenderer.invoke('vibe-quota-key-login', String(productId), String(key)),
  openExternal: (url) => ipcRenderer.invoke('vibe-open-external', String(url)),
  copyVersionInfo: () => ipcRenderer.invoke('vibe-copy-version'),
  openDashboard: () => ipcRenderer.send('vibe-open-dashboard'),
  onRangeChanged: (cb) => ipcRenderer.on('vibe-range-changed', (_e, r) => cb(r)),
});
