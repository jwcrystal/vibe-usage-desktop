import { contextBridge, ipcRenderer } from 'electron';

// Exposed to the dashboard at http://127.0.0.1:<port> (loopback only).
// The dashboard feature-detects this: in a plain browser (standalone server)
// window.vibeDesktop is undefined and refresh stays display-only.
contextBridge.exposeInMainWorld('vibeDesktop', {
  syncNow: () => ipcRenderer.invoke('vibe-sync'),
});
