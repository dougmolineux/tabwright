# addons.mozilla.org listing

Everything to paste into the AMO submission form, in the order the form asks for it. Run `npm run ext:package` first to build the two zips.

## Upload

- **Distribution:** On this site
- **File:** `web-ext-artifacts/tabwright-<version>.zip`
- **Compatibility:** Firefox (desktop) only. Untick Firefox for Android.
- **Source code:** Yes. Upload `web-ext-artifacts/tabwright-<version>-source.zip`.

## Describe add-on

**Name**

```
Tabwright
```

**Add-on URL**

```
tabwright
```

**Summary** (250 characters max)

```
Lets Claude Code read and operate the Firefox tabs you allow, in your normal logged-in profile. Nothing is allowed by default, and anything that submits, sends, pays or deletes waits for your click.
```

**Description**

```
Tabwright connects Claude Code, Anthropic's AI coding tool, to your real Firefox, so Claude can fill in forms, click through pages and read what's on screen for you, with you in control.

Tabwright needs a free companion program on your computer, plus Claude Code (or the built-in offline modes). Setup instructions: https://github.com/dougmolineux/tabwright#install

YOU STAY IN CONTROL
• Nothing is allowed by default. Claude can only see or touch a site after you click "Allow Claude on this site".
• Anything that submits, sends, pays, deletes, signs, posts or publishes pauses on an Allow/Deny prompt in the page. The page can't fake or click it, and Tabwright decides what needs approval, not the AI.
• Unapproved form submissions are blocked.
• Password, one-time-code and payment card fields are never read or typed into.
• A banner shows when a tab is being controlled. Press Esc, or click Stop, to halt everything.
• Every action is recorded in a local activity log. Typed text is logged by length only.

WHAT IT CAN DO
• Read pages as a compact outline, or take screenshots.
• Type into React and Vue forms, pick options in custom dropdowns, tick checkboxes and radios, and upload files from folders you allow.
• Work across same-site iframes and shadow DOM.
• Run from the sidebar without a terminal: type an instruction like "Fill out this application with my details, leave salary for me".

PRIVACY
Tabwright has no servers, accounts, analytics or telemetry. Page data goes to programs on your own computer, and from Claude Code to Anthropic as part of your conversation with Claude. Full policy: https://github.com/dougmolineux/tabwright/blob/main/PRIVACY.md

REQUIREMENTS
macOS (tested) or Linux (untested), Node.js 20+, and Claude Code for the main mode. Windows isn't supported yet.

Tabwright is an independent open-source project (MIT), not affiliated with Anthropic or Mozilla.
```

**Categories (Firefox):** Other

**Support email:** leave empty, or use a project address (it's shown publicly)

**Support website**

```
https://github.com/dougmolineux/tabwright/issues
```

**License:** MIT License

**Privacy policy:** tick "This add-on has a privacy policy" and paste the contents of [`PRIVACY.md`](../PRIVACY.md).

**This add-on is experimental:** leave unticked

**This add-on requires payment, non-free services or software, or additional hardware:** tick it. Claude Code needs an Anthropic account, which can be paid, and the add-on needs the companion program. The offline modes work without Claude, so this is a judgment call; ticking it is the transparent choice.

## Screenshots

Upload these from `docs/screenshots/` (1280×800), with these captions:

| File | Caption |
|---|---|
| `approval.png` | Anything that submits, sends, pays or deletes waits for your click, in a prompt the page can't fake. |
| `instruction-mode.png` | Run it from the sidebar: Claude fills what it knows and asks you about the rest. |

To refresh them, drive the fixture pages (`npm run fixtures`) at a 1280×800 window size.

## Notes for reviewers

```
Tabwright is a bridge between Firefox and Claude Code (Anthropic's CLI). The add-on itself contains no AI and contacts no servers: it talks only to a local native messaging host (in the source zip under host/), which relays requests from a local MCP server that Claude Code runs.

SOURCE AND BUILD
The add-on is plain JavaScript with no bundler, except extension/lib/protocol.js, which esbuild generates from shared/protocol.ts (not minified). To reproduce it from the source zip:
  Node.js 20 or 22, then: npm ci && npm run build
  The result is byte-identical to extension/lib/protocol.js in the upload.

PERMISSIONS
- nativeMessaging: the only channel to the local host ("tabwright").
- optional_host_permissions <all_urls>: never requested at install. The popup requests one site at a time when the user clicks "Allow Claude on this site"; no site is allowed by default. addons.mozilla.org, accounts.firefox.com and support.mozilla.org are always refused, as are non-http(s) pages.
- scripting: injects the content scripts (extension/content/) into allowed sites only. It also uses world: "MAIN" to call three small fixed functions (extension/content/main-world-setter.js) that set form values the way React/Vue expect. No strings are evaluated.
- tabs, activeTab: list and focus tabs; activeTab is needed for screenshots.
- storage, notifications: activity log and settings; approval and question notifications.

DATA COLLECTION
Declared as required: websiteContent, websiteActivity, browsingActivity, personallyIdentifyingInfo. On sites the user allowed, page text, form values and screenshots go to the local host, and through Claude Code to Anthropic, when Claude asks for them. That is the add-on's purpose. Sensitive fields (passwords, card numbers, one-time codes) are redacted and refused in extension/content/common.js (isSensitive).

HOW TO TEST WITHOUT CLAUDE
On macOS or Linux, with Node.js 20+:
  1. Unzip the source, run: scripts/install.sh --no-mcp
     This installs the native host and writes a sample profile; it doesn't need Claude Code.
  2. Load the uploaded add-on, click the toolbar button, then Connect.
  3. Run: npm run fixtures, then open http://127.0.0.1:8765/greenhouse.html
  4. In the popup, click "Allow Claude on this site". Open the sidebar (popup > Open sidebar).
  5. Type "Fill out this application" and click Run. If Claude Code isn't installed, it falls back to the on-device model (macOS 26+) or the rules engine; the engine in use is shown next to Run. It fills the form from the sample profile, leaves EEO and free-text questions for the user, and never submits.
  6. Click the page's Submit button yourself, or use plain-form.html, to see that the add-on only gates its own actions. Press Esc to see the stop behaviour.
The full automated suite (npm test, npm run test:e2e) is in the source zip.
```
