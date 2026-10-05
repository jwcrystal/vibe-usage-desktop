const { contextBridge, ipcRenderer } = require('electron');

// Exposed to the dashboard at http://127.0.0.1:<port> (loopback only).
// The dashboard feature-detects this: in a plain browser (standalone server)
// window.vibeDesktop is undefined and refresh stays display-only, the quota
// 登入 button copies the login command instead of opening a terminal.
contextBridge.exposeInMainWorld('vibeDesktop', {
  syncNow: () => ipcRenderer.invoke('vibe-sync'),
  quotaLogin: (productId) => ipcRenderer.invoke('vibe-quota-login', String(productId)),
  quotaOAuthLogin: (productId) => ipcRenderer.invoke('vibe-quota-oauth-login', String(productId)),
  quotaKeyLogin: (productId, key) => ipcRenderer.invoke('vibe-quota-key-login', String(productId), String(key)),
  openExternal: (url) => ipcRenderer.invoke('vibe-open-external', String(url)),
});
