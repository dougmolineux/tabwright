# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- **Requires Firefox 140 or later** (was 128), for Firefox's built-in data collection consent.
- **Renamed to Tabwright.** The add-on ID is now `tabwright@dougmolineux.dev`, the native host is `tabwright`, the MCP server is `tabwright` (tools are `mcp__tabwright__browser_*`), the config directory is `Tabwright` (`tabwright` on Linux) and environment variables use the `TABWRIGHT_` prefix.

### Added

- Project logo and new toolbar icon.
- `data_collection_permissions` in the manifest, declaring the page content, page activity, browsing activity and personal information the add-on passes to Claude Code.
- `PRIVACY.md`, the addons.mozilla.org listing text in `docs/amo-listing.md`, and `npm run ext:package` to build the add-on and source zips for submission.
- CONTRIBUTING guide, issue and pull request templates, and a CI workflow.
- Unit tests for the background script, extension pages, the MCP tool layer, the native host's runner and on-device helper client, and the shared Node helpers. `npm run coverage` prints a coverage report.

### Fixed

- **Security:** a mistyped `allowedUploadDirs` in `config.json` (a string instead of an array) was read character by character. That allowed uploads from `/`. Config values of the wrong type now fall back to their defaults.
- The approval timeout error said "No approval within NaN s" when the caller didn't pass a timeout.
- If the native host failed while connecting, the real reason (e.g. "No such native application") was replaced with a generic message.
- Replacing a pending `browser_ask_user` question left the new question unanswerable and without a timeout.
- A sidebar run stopped during its last step reported "Finished" instead of "Stopped".
- On-device helper: a restarted helper process could fail calls meant for the new process, and `TABWRIGHT_FM_HELPER` pointing at a missing file silently fell back to another helper.
- The MCP server kept reconnecting after it was closed.
- Selecting an option in a `<select>` inside a shadow root failed with "element not found".
- Role-less `aria-live="assertive"` regions (common for validation errors) now show as alerts in snapshots.
- The popup could request permission for an always-blocked site through a scripted click on its hidden Allow button.

### Also changed

- `web-ext` is now a dev dependency, so `npm run ext:run`, `ext:lint` and `ext:sign` work on a fresh clone.

## [0.1.0]

First release.

- MCP tools for tabs, navigation, snapshots, screenshots, text, clicking, typing, selecting, checking, uploading, keys, scrolling, waiting, form filling and asking the user.
- Per-site allowlist, in-page approval gate for consequential actions, submit backstop, sensitive-field redaction, and Esc/Stop.
- Instruction mode in the sidebar, with Claude, Apple on-device model and rules engines.
- Opt-in auto-approve toggle in the popup.
- Button-like non-semantic elements are treated as buttons.
