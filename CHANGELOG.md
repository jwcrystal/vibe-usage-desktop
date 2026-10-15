# Changelog

All notable changes to this project are documented here.

> Not maintained between `[0.1.5]` and `[0.5.5]`: entries for 0.1.6–0.5.4 are
> missing and are not backfilled.

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
