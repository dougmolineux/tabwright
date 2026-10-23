# Contributing

Thanks for helping out. This project hands an AI agent your real, logged-in browser, so the bar for changes that touch the safety model is high. The bar for everything else is "it works, it's tested, and it reads like the code around it."

## Setup

```sh
git clone <this repository>
cd tabwright
npm install
npm run build
npm test
```

To try your changes in Firefox, run `scripts/install.sh --no-mcp` once to install the native host. Then run `npm run ext:run`, or load `extension/manifest.json` from `about:debugging`. Register the MCP server with `claude mcp add` (see the README) if you want to drive it from Claude Code.

## Where things live

| Change | Files | Rebuild? |
|---|---|---|
| Message format between components | `shared/protocol.ts` | Yes: `npm run build` regenerates `extension/lib/protocol.js` |
| A new or changed `browser_*` tool | `mcp-server/src/tools/*.ts`, then a matching method in `extension/background.js`, then a content-script command in `extension/content/actions.js` | Yes, for the MCP server |
| What counts as consequential or sensitive | `extension/content/common.js` | No (reload the add-on) |
| Snapshot format | `extension/content/snapshot.js` | No |
| Approval prompt | `extension/content/approval.js` | No |
| Instruction mode, engines, fallback | `host/src/runner.ts`, `host/src/rules.ts`, `host/src/fm.ts` | Yes |
| Config, token, upload checks | `shared/node.ts` | Yes |

[SPEC.md](SPEC.md) is the design. If your change alters behaviour that SPEC.md describes, update it, or add a bullet under "Where the implementation differs from SPEC.md" in the README.

## Tests

Every change needs tests at the lowest layer that can catch the bug:

- **`test/unit/`** for logic in one component. The background script runs against the fake `browser` in `test/helpers/`; content scripts and extension pages run in jsdom. Prefer these: they're fast and they count towards coverage.
- **`test/integration/`** for anything that crosses the socket or native messaging boundary. These run the *built* host and MCP server, so `npm run test:integration` builds first.
- **`test/e2e/`** for behaviour only real Firefox shows: permissions, real event dispatch, iframes, layout. Add a fixture page to `test/fixtures/` if you need one.

```sh
npm run test:unit
npm run test:integration
npm run test:e2e         # needs Firefox installed; E2E_HEADLESS=1 to hide it
npm run coverage
npm run typecheck
npm run ext:lint
```

Tests must never call the real Claude, the network (beyond `127.0.0.1` fixtures), or the on-device model. Fake them; the existing suites show how.

## Changes to the safety model

Changes to any of these get extra review:

- the site allowlist and blocked hosts
- the approval gate and what counts as consequential
- the submit backstop
- sensitive-field redaction
- upload directory checks
- socket authentication
- the untrusted-content labelling

In the pull request, say what the change protects against or relaxes, and add tests for both the allowed and the refused case. Never add an "always allow" path that bypasses the per-action prompt. The opt-in auto-approve toggle is the one deliberate exception, and it is user-controlled, off by default and logged.

## Style

- **Match the surrounding code.** The extension is plain JavaScript (no bundler, no framework); the host and MCP server are strict TypeScript.
- **Comments explain *why*.** Reference the SPEC section when a rule comes from it (e.g. `// SPEC 8.2`).
- **Error messages are written for the model and the user.** Say what happened and what to do next, with one of the `E_*` codes from `shared/protocol.ts`.
- **Don't add runtime dependencies to the extension.**

## Pull requests

1. Branch from `main`.
2. Keep each PR to one change. Include tests and doc updates.
3. Make sure `npm run typecheck`, `npm test` and `npm run ext:lint` pass. Run `npm run test:e2e` too if you touched the extension.
4. Describe how you tested it, including the Firefox and OS versions for anything browser-specific.

## Reporting bugs and security issues

- **Bugs:** open an issue with steps to reproduce, the Firefox and OS versions, and the relevant lines from `host.log` and the activity log. Remove anything personal first.
- **Security issues:** don't open a public issue; follow [SECURITY.md](SECURITY.md#reporting-a-vulnerability).

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
