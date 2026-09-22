# vibe-usage-desktop

Cross-platform desktop shell (macOS / Windows / Linux) for
[vibe-usage-local-server](../vibe-usage-local-server) — Electron app that
embeds the zero-dependency local server and shows its dashboard.

- Tray icon + menu: open dashboard, launch at login, quit
- Embedded server on `http://127.0.0.1:3456` (same data file
  `~/.vibe-usage-server/data.json`, same price table)
- Closing the window keeps the app in the tray; quit via tray menu
- If port 3456 is already in use (e.g. the launchd agent), the app just
  connects to the running server — no conflict, shared data

## Setup

```bash
npm run sync-server   # vendor ../vibe-usage-local-server/src -> ./server
npm install
npm start
```

## Smoke test

```bash
npm run smoke         # starts embedded server, GET /, exits 0/1
```

## Build installers

```bash
npm run dist:mac      # dist/ Vibe Usage Desktop.dmg (unsigned)
npm run dist:win      # dist/ NSIS installer
npm run dist:linux    # dist/ AppImage
npm run dist          # all three (cross-build from any host)
```

## Icon

`icon-source.svg` is adapted from vibe-usage-app's pixel-art mark
(recolored white on indigo). Regenerate:

```bash
magick -background none icon-source.svg -resize 1024x1024 build/icon.png
```
