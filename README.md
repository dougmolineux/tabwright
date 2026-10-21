# Firefox Bridge for Claude Code

Lets Claude Code read and operate tabs in your normal, logged-in Firefox, with you in control: you choose which sites it can touch, you can see when a tab is being driven, Esc or Stop halts it, and anything that submits, sends, pays or deletes waits for your click in the page. It can also run on its own from a Firefox sidebar, using Claude when available and falling back to Apple's on-device model, then to simple rules.

See [SPEC.md](SPEC.md) for the design, and read [SECURITY.md](SECURITY.md) before installing: it covers what the add-on protects against and what it doesn't.

> **Not affiliated with Anthropic.** This is an independent community project. "Claude" and "Claude Code" are trademarks of Anthropic, PBC, and are used here only to say what this works with.

**Platform support:** macOS is tested, including the on-device fallback (Apple Silicon, macOS 26+). Linux paths are implemented but untested. Windows isn't supported yet.

```
Claude Code ⇄ MCP server (stdio) ⇄ Unix socket ⇄ native host ⇄ native messaging ⇄ Firefox extension ⇄ content scripts
```

## Install (macOS)

Requirements: Firefox 128+, Node.js 20+. For the on-device fallback: Apple Silicon, macOS 26+, Apple Intelligence on, Xcode command-line tools.

```sh
scripts/install.sh
```

This builds everything, installs the native host to `~/.local/share/claude-bridge/`, writes the native messaging manifest, creates `~/Library/Application Support/ClaudeBridge/` (token, `config.json`, `profile.json`), builds the Swift helper when the OS supports it, and registers the MCP server with Claude Code at user scope (`claude mcp add -s user firefox …`). Use `--no-mcp` to skip the registration. `scripts/uninstall.sh [--purge]` reverses it.

Then load the extension:

- **Development:** `npm run ext:run` (temporary profile) or `about:debugging` → This Firefox → Load Temporary Add-on → `extension/manifest.json`.
- **Daily use:** release Firefox only installs signed add-ons. Run `npm run ext:sign` with `WEB_EXT_API_KEY` / `WEB_EXT_API_SECRET` from AMO to sign it as unlisted, then install the `.xpi` from `web-ext-artifacts/`.

## Use

1. Click the toolbar button → **Connect**.
2. On a page you want Claude to work on, click **Allow Claude on _site_**. No site is allowed by default.
3. In Claude Code, ask for things like "fill out the application in my Firefox tab". The tools are `browser_status`, `browser_list_tabs`, `browser_select_tab`, `browser_open_tab`, `browser_navigate`, `browser_snapshot`, `browser_screenshot`, `browser_get_text`, `browser_click`, `browser_type`, `browser_select`, `browser_check`, `browser_upload`, `browser_press_key`, `browser_scroll`, `browser_wait_for`, `browser_fill_form` and `browser_ask_user`.

**Instruction mode:** open the sidebar (popup → Open sidebar), type an instruction, and click Run. Answers come from your profile (edit it in the sidebar); `null` values are asked each time, and EEO questions are never filled. The engine in use is shown next to the Run button.

**Stopping:** press Esc in the controlled tab, or click Stop in the popup or sidebar. This cancels everything in progress and disconnects.

## Configuration

`~/Library/Application Support/ClaudeBridge/config.json`:

| Key | Default | Meaning |
|---|---|---|
| `allowedUploadDirs` | `["~/Documents"]` | Only files under these (after resolving symlinks) can be uploaded. |
| `maxUploadBytes` | `10485760` | Upload size limit. |
| `snapshotCharLimit` | `25000` | Snapshot size cap. |
| `approvalTimeoutSec` | `120` | How long an approval prompt waits. |
| `draftFreeText` | `false` | On-device mode: draft answers to free-text questions (highlighted for review) instead of leaving them blank. |

Logs: `~/Library/Logs/ClaudeBridge/host.log` (rotated at 5 MB). Activity log: popup → View activity.

## Development

```sh
npm install
npm run build        # host + MCP server bundles, and extension/lib/protocol.js from shared/protocol.ts
npm test             # unit (Node + jsdom content-script tests) and integration (real host + MCP server, fake Firefox)
npm run test:e2e     # real Firefox via geckodriver, against test/fixtures (set E2E_HEADLESS=1 to hide the window)
npm run fixtures     # serve the fixture pages at http://127.0.0.1:8765/
npm run typecheck
```

The e2e suite launches Firefox in a throwaway profile. While it runs it temporarily replaces the `claude_bridge` native messaging manifest (restoring any existing one afterwards), and it never calls the real Claude: instruction mode is tested with Claude marked unavailable, so it uses the on-device model (or rules).

`extension/lib/protocol.js` is generated from `shared/protocol.ts`; edit the TypeScript and rebuild.

## Differences from the spec

- **Screenshots need one click from you.** Firefox only lets an extension capture a tab with `<all_urls>` or `activeTab`, not with a single-site grant. `activeTab` is in the manifest, and opening the toolbar popup on a tab grants it until that tab navigates. Without it, `browser_screenshot` returns `E_SITE_NOT_ALLOWED` explaining what to ask. `browser_snapshot` doesn't have this restriction.
- **Site matching ignores the port**, because Firefox match patterns can't include one. Allowing `localhost` allows every port on it.
- **The consequential-action keyword list applies to buttons, links and menu items only**, not to checkboxes, radios, text fields or dropdowns ("I confirm…" checkboxes don't prompt). Form submission, Enter-to-submit and risky URLs are gated as specified.
- **Approval prompt keyboard:** Deny has focus when the prompt appears, so a stray Enter denies.
- **A second, scoped socket client is allowed during a sidebar run**, so the headless `claude -p` session's MCP server can connect while your interactive Claude Code session holds the main connection.
- **On-device matching** constrains the model's answer to your real profile keys and asks it a yes/no follow-up to confirm each match. The host also rejects skip-labels that don't appear in your instruction, and uses fixed patterns to catch out-of-scope requests the small model misses. The model's `option` guess is ignored, since it never sees profile values; options are chosen from the profile value.
- **E2E uses Selenium + geckodriver** rather than Playwright, because Playwright's Firefox build can't load extensions or use native messaging.
- `sidebar.html?tab=<id>` opens the sidebar UI as a page bound to a tab (used by the e2e tests).
- **Not done:** full-page screenshots and Windows support (both M7/v2). Linux paths are implemented in the code and install script but untested.

## Known limitations

- Script-created events have `isTrusted === false`. Some payment and anti-bot widgets ignore them; Claude should report that and ask you to do the step.
- The submit backstop catches `submit` events. A page that sends data with `fetch` from a click handler, without a form submission, is only gated if the clicked button itself is classified as consequential.
- One interactive Claude Code session can be connected at a time.

## License

[MIT](LICENSE)
