# Changelog

All notable changes to this project are documented here.

## [0.1.4] - 2026-09-30

### Added

- OpenCode V2 usage-record support in the bundled CLI.
- `OPENCODE_DB` override for the bundled CLI.
- MIT license and upstream attribution for vendored components.
- Traditional Chinese README.

### Changed

- Updated the bundled CLI to upstream vibe-usage 0.13.2.
- Updated the bundled local server to 0.1.4, including cache-write pricing and separate dashboard cache read/write reporting.
- Dashboard flicker-free refresh (re-vendored from vibe-usage-local-server@801b4db): unchanged data only updates the meta line instead of rebuilding the view, re-renders crossfade via View Transitions, and tooltips abbreviate token counts.
- `npm run preflight` now auto-syncs the CLI vendor from the sibling checkout's committed `HEAD` and checks the server vendor for drift (warn-only, no overwrite; sync-server stays manual).
- Documented the CLI vendor source as the `jwcrystal/vibe-usage` fork.
