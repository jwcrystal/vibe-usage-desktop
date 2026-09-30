# vibe-usage-desktop

Cross-platform desktop shell (macOS / Windows / Linux) for
[vibe-usage-local-server](https://github.com/jwcrystal/vibe-usage-local-server)
— Electron app that embeds the zero-dependency local server and shows its dashboard.

- Tray icon + menu: open dashboard, launch at login, quit
- Embedded server on `http://127.0.0.1:3456` (same data file
  `~/.vibe-usage-server/data.json`, same price table)
- Closing the window keeps the app in the tray; quit via tray menu
- If port 3456 is already in use (e.g. the launchd agent), the app just
  connects to the running server — no conflict, shared data

## Setup

```bash
npm install
npm start
```

`server/` and `cli/` are committed vendored snapshots — the app builds and
runs without any sibling checkout. To refresh them, clone the source repos
next to this one and re-sync:

```bash
git clone https://github.com/jwcrystal/vibe-usage-local-server ../vibe-usage-local-server
git clone https://github.com/vibe-cafe/vibe-usage ../vibe-usage
npm run sync-server   # vendor ../vibe-usage-local-server/src -> ./server
npm run preflight     # vendor ../vibe-usage @HEAD -> ./cli
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

`icon-source.svg` is adapted from
[vibe-usage-app](https://github.com/vibe-cafe/vibe-usage-app)'s pixel-art mark
(recolored white on indigo; upstream MIT). Regenerate:

```bash
magick -background none icon-source.svg -resize 1024x1024 build/icon.png
```

## Acknowledgements

- [`cli/`](cli/) — vendored snapshot of the [vibe-usage](https://github.com/vibe-cafe/vibe-usage) CLI (MIT), re-synced via `scripts/sync-cli.sh`
- [`server/`](server/) — vendored from [vibe-usage-local-server](https://github.com/jwcrystal/vibe-usage-local-server)
- App icon adapted from [vibe-usage-app](https://github.com/vibe-cafe/vibe-usage-app) (MIT)

## License

MIT — see [LICENSE](LICENSE). `cli/` contains vendored upstream code (MIT),
see [cli/NOTICE](cli/NOTICE).
