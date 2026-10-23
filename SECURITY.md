# Security

This add-on lets an AI agent read and operate tabs in your real, logged-in Firefox. Treat it the way you'd treat handing someone your unlocked laptop for a task: useful, but only on sites you choose, and only while you're around to approve anything that matters.

The full design is in [SPEC.md §8](SPEC.md#8-safety). This page is the short version.

## What it protects

- **Nothing is allowed by default.** Claude can only read or act on a site after you click "Allow Claude on _site_" in the popup. You can remove sites at any time. Only `http` and `https` pages can be allowed (so never `about:`, extension or browser settings pages), and `addons.mozilla.org`, `accounts.firefox.com` and `support.mozilla.org` are always blocked.
- **The extension decides what needs approval, not the model.** Clicks that would submit, send, pay, purchase, delete, sign, post or publish, Enter-to-submit, and navigations to submit/confirm/checkout/pay/delete URLs all pause and show an Allow/Deny prompt drawn in a closed shadow root that the page can't fake or click. Approval is per action; there is no "always allow" for a site or a button. Deny has focus, so a stray Enter denies.
- **Unapproved form submissions are blocked.** As a backstop, a form `submit` that starts within a second of an agent action without approval is cancelled.
- **Sensitive fields are off limits.** Password, one-time-code and card fields, and fields labelled CVV, card number or SSN, can't be read or typed into; their values show as `[redacted]`. CAPTCHA frames can't be clicked.
- **Uploads are restricted.** Only files inside `allowedUploadDirs` (default `~/Documents`, checked after resolving symlinks) and under 10 MB can be uploaded. The extension never reads your disk itself.
- **Page content is labelled untrusted.** Everything read from a page is wrapped in `<page_content untrusted="true">` so the model can tell data from instructions.
- **The local connection is authenticated.** Claude Code's MCP server talks to the native host over a Unix socket in a `0700` directory, and must present a random 32-byte token (created at install, stored `0600`) within 2 seconds.
- **You can stop it.** Esc in the controlled tab, or Stop in the popup or sidebar, cancels everything in progress and disconnects. The popup keeps an activity log of the last 500 actions; typed values are logged by length only.

## What it doesn't protect

- **Auto-approve turns the gate off.** The popup has an opt-in "auto-approve" toggle (off by default, stored in this browser only) that skips the approval prompt for every consequential action until you turn it off. Actions are still logged as `auto-allowed` in the activity log. Leave it off unless you are watching the tab.
- **Prompt injection isn't solved.** A malicious page can still try to steer the model. The untrusted label helps, but the real protection is the approval gate, the site allowlist and the sensitive-field rules above. Only allow sites you trust, and read approval prompts before clicking Allow.
- **Reading is not gated.** On an allowed site, Claude can read anything visible on the page (except redacted fields), including private messages or account details, and that text goes to the model.
- **`fetch`-only actions can slip past the submit backstop.** A page that sends data from a click handler without a real form submission is only gated if the clicked button itself is recognized as consequential (by its type or its name).
- **The keyword list covers buttons, links and menu items only.** Checkboxes, radios, text fields and dropdowns don't prompt, so an "I agree…" checkbox can be ticked without asking.
- **Ports aren't distinguished.** Firefox match patterns can't include a port, so allowing `localhost` allows every local port.
- **Anything running as your user can read the token.** The socket and token are protected by file permissions, not by anything stronger.

## Supported versions

Only the latest release on `main` gets security fixes.

## Reporting a vulnerability

Please don't open a public issue for security problems. Use GitHub's private vulnerability reporting on this repository (Security tab → "Report a vulnerability"), with steps to reproduce and the Firefox and OS versions you used.
