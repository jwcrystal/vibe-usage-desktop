# Changelog

All notable changes to this project are documented here.

> Not maintained between `[0.1.5]` and `[0.5.5]`: entries for 0.1.6–0.5.4 are
> missing and are not backfilled.

## [0.5.15] - 2026-11-10

### Fixed

- Pricing: Claude Fable 5.2 (`claude-fable-5-2`) was missing from the price table, so its usage was flagged 未定價 and left out of cost totals. Added Anthropic's official price — $8 / MTok input, $40 / MTok output, cache read $0.20, cache write $10. Vendored server from `vibe-usage-local-server@0.3.6`.

## [0.5.14] - 2026-11-05

### Fixed

- Pricing: Claude Haiku 5.5 (`claude-haiku-5-5`) was missing from the price table, so its usage was flagged 未定價 and left out of cost totals. Added Anthropic's official price for prompts ≤ 100K tokens — $0.10 / MTok input, $0.50 / MTok output, cache read $0.01, cache write $0.125 (the > 100K tier is recorded in the entry's `note`). Vendored server from `vibe-usage-local-server@0.3.5`.

## [0.5.13] - 2026-11-04

### Fixed

- About is a dark panel again instead of the native message box: the long `Electron · Chromium · Node` line wrapped mid-version and left an empty band above the buttons. The panel shows one version per row, the app icon, and a copy button that puts the same block on the clipboard.
- macOS: closing the window with File > Close (Cmd+W) works again. The new application menu had dropped the File menu, so only the red button hid the window; Close and the View menu are restored.
- macOS: closing the dashboard now also removes the Dock icon, so the idle app really does live only in the menu bar. Reopening the dashboard (tray menu, Dock, second launch) brings the Dock icon and the application menu back; the tray popover never shows one.

## [0.5.11] - 2026-11-04

### Added

- Version is now visible in the app: a `v0.5.11` badge beside the dashboard title, a line under the menu-bar popover, the version in the tray tooltip, and an About item in the tray menu (macOS also gets a proper application menu). About lists the desktop build, the bundled CLI version and the Electron/Chromium/Node versions, and copies that block for bug reports. The dashboard badge is desktop-only — the same page opened from the standalone server in a plain browser is unchanged.
- The bundled CLI is spawned with `VIBE_USAGE_SURFACE_VERSION` set to the app version, so synced usage records report the desktop build they came from. `vibe-usage --version` still prints the CLI's own version (0.13.x), which About shows separately.

## [0.5.10] - 2026-11-03

> `0.5.8` and `0.5.9` were cut locally for these same changes and never
> distributed; their content is folded in here.

### Fixed

- Quotas: a Claude Code install that only lives inside Claude Desktop is now found. Desktop keeps its build at `claude-code/<version>/<build-hash>/claude.app`, one level deeper than the walk expected, so the product read as 未偵測到, the CLI probe — the route that also refreshes a lapsed login — never ran, and the card sat on 登入已過期 until the stored token lapsed. Both layouts are walked, newest version first (bundled CLI `jwcrystal/vibe-usage`@9a86407).
- Quotas: on macOS a login that lives only in the Keychain now counts as detected. Presence reads the Keychain item's attributes — no `-w`, no secret, no ACL prompt — instead of only `~/.claude/.credentials.json`, which Claude Code never writes on that platform, so a Keychain-only machine showed 未偵測到 while its OAuth route had a usable login (bundled CLI `jwcrystal/vibe-usage`@9a86407).
- Quotas: that search covers every platform instead of the macOS path it was written on. The data directory follows `claude-roots.js` — Application Support on macOS, `%APPDATA%\Claude` on Windows, `$XDG_CONFIG_HOME/Claude` (or `~/.config/Claude`) on Linux — the executable name follows the platform (`claude`, `claude.exe`, `claude.cmd`), and both bundle layouts are probed, with and without the per-build hash directory. `VIBE_USAGE_CLAUDE_BIN` still overrides the whole search with an absolute path (bundled CLI `jwcrystal/vibe-usage`@955d83d).
- Quotas: the search also covers the installers' documented locations. The native installer keeps each version under `.local/share/claude/versions/` and only a launcher in `.local/bin`, and replacing that launcher is supported — so a launcher that was rewritten or removed used to hide a working install; the version directories are probed now, newest first. Windows gets the per-platform manager trees, `%APPDATA%\npm` and `%LOCALAPPDATA%\mise\shims`, instead of POSIX paths that could never match there (bundled CLI `jwcrystal/vibe-usage`@26358cc).
- Quota cards: Claude's 登入 button now finds the CLI the same way the probe does. It only searched PATH, so on a machine whose only Claude Code is Claude Desktop's it logged `detected binary=none` and did nothing; it now runs that binary by path, quoting the "Application Support" directory name.

## [0.5.7] - 2026-11-02

### Fixed

- Quotas on Windows: Claude Code's CLI was searched for as a file literally named `claude`, but npm installs `claude.cmd` there — so a machine with a healthy CLI reported as not installed and the probe (the only route a non-OAuth login has) never ran. The PATHEXT rule the registry already used is now shared with the probe (bundled CLI `jwcrystal/vibe-usage`@45be96d).
- Quotas on Linux: OpenCode Go's store was read from `<home>/.local/share` unconditionally while the parser follows `XDG_DATA_HOME`, so a relocated store showed usage with no quota beside it. Both now read the same root (bundled CLI `jwcrystal/vibe-usage`@45be96d).
- Quota cards: a revoked or expired Claude login now reads as `expired_credentials` instead of `missing_credentials` and keeps its plan label, so the card offers the action that fixes it instead of claiming nothing is installed (bundled CLI `jwcrystal/vibe-usage`@3290866).
- Quota card login buttons now work on Windows and Linux. The launcher only knew `osascript` + Terminal.app, so both platforms always fell back to the product page; it now opens a `cmd` window on Windows and the first available terminal emulator on Linux, keeping the page as the fallback. The launcher and its PATH rules moved to `login-launcher.js`, covered by `npm test`.

## [0.5.6] - 2026-10-15

### Fixed

- Background daemon: it now reloads when the installed CLI sources change under it. Node holds the CLI's files in memory from startup and the installed service keeps the old process alive (`KeepAlive` / `Restart=on-failure`), so an upgraded install kept running the previous code indefinitely — a vendor sync carrying a provider fix could sit unused while the daemon went on reporting its stale result every 30m, with nothing in the output pointing at the version. The daemon now watches `bin/` and `src/`, waits for the change to settle (a vendor sync writes many files in sequence), and exits so the service relaunches it; Windows' Task Scheduler has no restart-on-failure policy, so there it reports instead of exiting (bundled CLI `jwcrystal/vibe-usage`@d80ae27).

## [0.5.5] - 2026-10-15

### Fixed

- Background daemon: the installed service now re-applies `ELECTRON_RUN_AS_NODE`. The desktop shell installs the daemon through the bundled CLI run by Electron in Node mode, so the unit's executable is the Electron binary; without the flag launchd / systemd / Task Scheduler started a GUI app instead of the daemon (bundled CLI `jwcrystal/vibe-usage`@2769bcc).
- Credential files (`~/.codex/auth.json`, `~/.vibe-usage/codex-oauth.json`, `~/.commandcode/auth.json`, and their `.vibe-bak` backups) are now written owner-only (0600). They carry refresh tokens and API keys and were previously world-readable.

### Security

- Local server (`vibe-usage-local-server` 0.3.3): requests whose `Host` is not loopback are refused (DNS-rebinding guard) and the wildcard `Access-Control-Allow-Origin: *` is gone. `GET /` injects the API key into the served HTML, so any website could previously read it and then drive `DELETE /api/usage/ingest` and the quota-sync writer. A deliberate non-loopback bind can list its names in `VIBE_USAGE_ALLOWED_HOSTS`.

### Changed

- Local server (`vibe-usage-local-server` 0.3.3): `GET /api/usage` loads the price table once per request instead of once per bucket.

## [0.1.5] - 2026-10-01

### Changed

- Updated the bundled local server to 0.1.6: the dashboard detail table gains an export menu — a **detail CSV** (raw values with ISO-8601+offset timestamps; UTF-8 BOM; terminal column follows the mask toggle; spreadsheet formula-injection guard) and a **single-page HTML report** (KPI overview + model/tool/project breakdown tables, print-to-PDF ready). Both respect the current range, filters, and table sort.

## [0.1.4] - 2026-09-30

### Added

- OpenCode V2 usage-record support in the bundled CLI.
- `OPENCODE_DB` override for the bundled CLI.
- MIT license and upstream attribution for vendored components.
- Traditional Chinese README.

### Changed

- Updated the bundled CLI to `jwcrystal/vibe-usage`@ce9925d (upstream vibe-usage 0.13.2 plus the fork's OpenCode additions; the fork tracks upstream versioning).
- Updated the bundled local server to 0.1.5, including cache-write pricing, separate dashboard cache read/write reporting, and a gpt-6-sol cache-read price fix with the new gpt-6.1-sol model.
- Dashboard flicker-free refresh (re-vendored from vibe-usage-local-server@801b4db): unchanged data only updates the meta line instead of rebuilding the view, re-renders crossfade via View Transitions, and tooltips abbreviate token counts.
- `npm run preflight` now auto-syncs the CLI vendor from the sibling checkout's committed `HEAD` and checks the server vendor for drift (warn-only, no overwrite; sync-server stays manual).
- Documented the CLI vendor source as the `jwcrystal/vibe-usage` fork.
