# Privacy Policy

_Last updated: 2026-10-22_

Tabwright is a Firefox add-on that lets Claude Code, an AI coding tool from Anthropic that you install and sign in to yourself, read and operate the Firefox tabs you allow. This policy explains what data Tabwright handles, where it goes, and how you control it.

**The short version:** Tabwright has no servers, accounts, analytics or telemetry, and the developer never receives your data. Tabwright passes page data to software on your own computer: its native host and Claude Code. Claude Code then sends that data to Anthropic as part of your conversation with Claude, under your agreement with Anthropic.

## What Tabwright accesses

On sites you have allowed (none are allowed until you click **Allow Claude on this site**), and only when Claude or a sidebar instruction asks for it:

| Data | Example | Firefox consent category |
|---|---|---|
| Page structure and visible text | Headings, labels, buttons, links, paragraphs | Website content |
| Current values of form fields | What's typed in "Email" or "City" | Website content, personal info |
| Screenshots of the visible page | Taken when Claude needs to see layout | Website content |
| Actions performed on the page | Clicks, typing, selections, scrolling | Website activity |
| URL and title of the page | `https://jobs.example.com/apply` | Browsing activity |

Two things also happen beyond allowed sites:

- When Claude lists your tabs (`browser_list_tabs`), it sees the **titles and URLs of all open tabs**, including tabs on sites you haven't allowed. Tabwright can't read or act on the contents of those tabs.
- Tabwright **never** reads password, one-time-code or payment card fields, or fields labelled CVV, card number or SSN. Their values are shown as `[redacted]`. It never accesses `about:` pages, other add-ons, or Mozilla's account and add-on sites.

## Where the data goes

1. **Firefox extension → native host.** Data goes over Firefox native messaging to the Tabwright native host, a program running locally on your computer.
2. **Native host → MCP server → Claude Code.** The native host passes it over a local, token-protected Unix socket to the Tabwright MCP server, which Claude Code runs on your computer.
3. **Claude Code → Anthropic.** Claude Code sends tool results (page text, field values, screenshots) to Anthropic's API, as part of your conversation, so Claude can decide what to do next. How Anthropic handles that data is covered by your agreement with Anthropic and [Anthropic's Privacy Policy](https://www.anthropic.com/legal/privacy), not by this policy.

In **instruction mode** (the sidebar), the engine determines where data goes:

- **Claude:** same as above. The native host starts Claude Code on your computer.
- **On-device:** labels and short questions go to Apple's on-device Foundation Models, which run locally. Nothing leaves your computer.
- **Rules:** everything is processed locally.

**Uploads:** when Claude uploads a file to a page (`browser_upload`), the MCP server reads the file from a folder you allowed (`allowedUploadDirs`, default `~/Documents`) and passes its contents to the page through the extension. The file's contents aren't sent to Claude; Claude sees only the file's name and size.

## What is stored, and where

Everything stays on your computer:

| What | Where | Contents |
|---|---|---|
| Allowed sites | Firefox's add-on permissions | The sites you allowed |
| Activity log | Firefox extension storage | The last 500 actions: time, page URL, action, target and result. Typed text is logged by **length only**. Clear it from popup → View activity. |
| Settings | Firefox extension storage | Whether auto-approve is on |
| Profile | `profile.json` in the Tabwright config folder | The details you enter for instruction mode (name, email, phone, links, answers). Only readable by your user account. |
| Token and config | Tabwright config folder | A random authentication token and your settings |
| Host log | `~/Library/Logs/Tabwright/` on macOS, `~/.local/state/tabwright/` on Linux | Connection events and error messages for troubleshooting. It can include form field labels; it doesn't include page text or typed values. Rotated at 5 MB. |

The sidebar also shows a live step log for the current session, which can include the first 40 characters of typed text. That log exists only in memory and is cleared when Firefox closes or a new instruction starts.

## Your controls

- **Choose sites.** Allow or remove sites in the toolbar popup. Nothing is allowed by default.
- **Approve actions.** Anything that submits, sends, pays or deletes waits for your click in the page, unless you turn on the opt-in auto-approve toggle.
- **Stop.** Press Esc in the controlled tab, or click Stop in the popup or sidebar.
- **Delete.** Clear the activity log from the activity page. Edit or delete `profile.json`. Run `scripts/uninstall.sh --purge` to remove the native host, config, profile, token and logs, and remove the add-on from `about:addons` to delete its storage and permissions.

## What Tabwright does not do

- Send data to the developer or any third party other than Anthropic, through Claude Code as described above.
- Contact any remote server itself.
- Include analytics, telemetry, advertising or tracking.
- Sell or share data.
- Run in private windows unless you allow it in Firefox's add-on settings.

## Changes

Changes to this policy are recorded in this file's history in the [Tabwright repository](https://github.com/dougmolineux/tabwright/commits/main/PRIVACY.md).

## Contact

Open an issue at [github.com/dougmolineux/tabwright/issues](https://github.com/dougmolineux/tabwright/issues). For security problems, see [SECURITY.md](SECURITY.md).
