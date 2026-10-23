// extension/background.js, part 2: the methods the MCP server calls (SPEC 6), with the site allowlist,
// approval gate, frames and refs, and the audit log. The fake host sends requests over the native port;
// fake pages (tabs.sendMessage) play the content scripts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SITE, SITE_URL, boot, deferred, settle, until } from "../helpers/load-background.js";

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const ORIGIN = SITE;
const err = (code, message, data) => Object.assign({ code, message }, data ? { data } : {});
const audits = (b) => b.storage.local.data.audit ?? [];
const snapshotOf = (items, extra = {}) => () => ({ items, truncated: false, nextRef: 10, newRefs: [], ...extra });

/** A page with one gated submit button (e1), found by label/text, needing approval until approved. */
function submitPage(b, tabId = 1) {
  b.pages.on(tabId, "find", () => ({ matches: [{ ref: "e1", role: "button", name: "Submit application" }], nextRef: 2, newRefs: ["e1"] }));
  b.pages.on(tabId, "click", (m) =>
    m.approved ? { ok: true, target: "Submit application", navigated: false } : { needsApproval: true, verb: "submit", target: "Submit application", reason: "button text" },
  );
}
const clickSubmit = (b, extra = {}) => b.host.call("click", { target: { text: "Submit" }, ...extra });

describe("site allowlist", () => {
  it("refuses sites the user hasn't allowed", async () => {
    const b = await boot();
    b.addTab({ id: 2, url: "https://mail.example.org/inbox", active: true });
    await expect(b.host.call("snapshot", { tabId: 2 })).rejects.toMatchObject({
      code: "E_SITE_NOT_ALLOWED",
      message: expect.stringContaining("isn't allowed on https://mail.example.org"),
      data: { origin: "https://mail.example.org" },
    });
    expect(b.pages.messages.filter((m) => m.tabId === 2)).toEqual([]); // nothing was sent to the page
  });

  it.each([
    ["https://addons.mozilla.org/en-US/firefox/", "https://addons.mozilla.org/*"],
    ["https://accounts.firefox.com/settings", "https://accounts.firefox.com/*"],
    ["https://support.mozilla.org/kb", "https://support.mozilla.org/*"],
  ])("always blocks %s, even when granted", async (url, pattern) => {
    const b = await boot({ tabs: [{ id: 1, url: url + "?secret=1", active: true }], granted: [pattern] });
    await expect(b.host.call("snapshot", {})).rejects.toMatchObject({ code: "E_SITE_NOT_ALLOWED", message: `Claude can't be used on ${url} (browser and account pages are always blocked).` });
    await expect(b.host.call("open_tab", { url })).rejects.toMatchObject({ code: "E_SITE_NOT_ALLOWED" });
    await expect(b.host.call("navigate", { url })).rejects.toMatchObject({ code: "E_SITE_NOT_ALLOWED" });
  });

  it.each(["about:config", "moz-extension://abc/popup.html", "file:///etc/hosts", "view-source:https://jobs.example.com/"])("blocks non-web page %s", async (url) => {
    const b = await boot({ tabs: [{ id: 1, url, active: true }], granted: ["<all_urls>"] });
    await expect(b.host.call("get_text", {})).rejects.toMatchObject({ code: "E_SITE_NOT_ALLOWED" });
  });

  it("ignores the port when matching (Firefox patterns can't hold one)", async () => {
    const b = await boot({ tabs: [{ id: 1, url: "http://localhost:8765/form.html", active: true }], granted: ["http://localhost/*"] });
    b.pages.on(1, "snapshot", snapshotOf([{ d: 0, t: "- heading" }]));
    expect(await b.host.call("snapshot", {})).toMatchObject({ origin: "http://localhost:8765", text: "- heading" });
  });

  it("refuses to open non-http URLs", async () => {
    const b = await boot();
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "about:addons", "not a url"]) {
      await expect(b.host.call("open_tab", { url })).rejects.toMatchObject({ code: "E_INTERNAL", message: "Only http and https URLs can be opened" });
      await expect(b.host.call("navigate", { url })).rejects.toMatchObject({ code: "E_INTERNAL" });
    }
  });
});

describe("tabs", () => {
  it("reports status with allowed sites and the selected tab", async () => {
    const b = await boot({ granted: ["https://jobs.example.com/*", "http://localhost/*", "<all_urls>"] });
    expect(await b.host.call("status")).toEqual({ firefoxVersion: "140.0", extensionVersion: "0.1.0", allowedSites: ["https://jobs.example.com", "http://localhost"], selectedTab: null });
    await b.host.call("select_tab", { tabId: 1 });
    expect((await b.host.call("status")).selectedTab).toEqual({ id: 1, title: "Apply", url: SITE_URL });
  });

  it("lists tabs with whether each is allowed", async () => {
    const b = await boot();
    b.addTab({ id: 2, url: "https://other.example.org/" });
    b.addTab({ id: 3, url: undefined });
    await b.host.call("select_tab", { tabId: 2 });
    const { tabs } = await b.host.call("list_tabs");
    expect(tabs.map(({ id, allowed, selected }) => ({ id, allowed, selected }))).toEqual([
      { id: 1, allowed: true, selected: false },
      { id: 2, allowed: false, selected: true },
      { id: 3, allowed: false, selected: false },
    ]);
  });

  it("selects a tab and focuses its window", async () => {
    const b = await boot();
    b.addTab({ id: 2, url: SITE_URL, windowId: 5 });
    expect(await b.host.call("select_tab", { tabId: 2 })).toEqual({ ok: true, tabId: 2, title: "Tab 2", url: SITE_URL, allowed: true });
    expect(b.calls).toContainEqual(["windows.update", 5, { focused: true }]);
    await expect(b.host.call("select_tab", { tabId: 42 })).rejects.toMatchObject({ code: "E_NO_TAB", message: "No tab with id 42" });
  });

  it("acts on the selected tab, then the active tab", async () => {
    const b = await boot();
    b.addTab({ id: 2, url: SITE_URL });
    b.pages.on(1, "get_text", () => ({ text: "one" }));
    b.pages.on(2, "get_text", () => ({ text: "two" }));
    expect((await b.host.call("get_text", {})).text).toBe("one");
    await b.host.call("select_tab", { tabId: 2 });
    b._tabs.get(1).active = true; // the user switched back; the selection still wins
    b._tabs.get(2).active = false;
    expect((await b.host.call("get_text", {})).text).toBe("two");
    b._tabs.delete(2); // a selected tab that has gone falls back to the active one
    expect((await b.host.call("get_text", {})).text).toBe("one");
    expect((await b.host.call("get_text", { tabId: 1 })).text).toBe("one");
    await expect(b.host.call("get_text", { tabId: 2 })).rejects.toMatchObject({ code: "E_NO_TAB", message: "No tab with id 2" });
    b._tabs.clear();
    await expect(b.host.call("get_text", {})).rejects.toMatchObject({ code: "E_NO_TAB", message: "No active tab" });
  });

  it("opens a tab, waits for it to load and selects it", async () => {
    const b = await boot();
    const r = await b.host.call("open_tab", { url: "https://jobs.example.com/job/42" });
    expect(r).toEqual({ ok: true, tabId: 100, url: "https://jobs.example.com/job/42", allowed: true });
    expect((await b.state()).selectedTabId).toBe(100);
    expect(audits(b).at(-1)).toMatchObject({ action: "open_tab", target: "https://jobs.example.com/job/42", result: "ok" });
  });
});

describe("content scripts and the indicator", () => {
  it("injects the content scripts once, then reuses them", async () => {
    const b = await boot();
    b.pages.on(1, "get_text", () => ({ text: "hi" }));
    await b.host.call("get_text", {});
    await b.host.call("get_text", {});
    const injections = b.calls.filter(([api, o]) => api === "executeScript" && o.files);
    expect(injections).toHaveLength(1);
    expect(injections[0][1]).toEqual({ target: { tabId: 1, frameIds: [0] }, files: ["content/common.js", "content/refs.js", "content/snapshot.js", "content/approval.js", "content/actions.js"] });
  });

  it("shows the indicator on the driven tab", async () => {
    const b = await boot();
    b.pages.on(1, "get_text", () => ({ text: "hi" }));
    await b.host.call("get_text", {});
    await b.host.call("get_text", {});
    expect(b.calls.filter(([api]) => api === "insertCSS")).toEqual([["insertCSS", 1]]);
    expect(b.pages.sent("control")).toHaveLength(1);
  });

  it("passes page errors through with their code and data", async () => {
    const b = await boot();
    b.pages.on(1, "get_text", () => {
      throw err("E_NOT_INTERACTABLE", "hidden", { why: "display:none" });
    });
    await expect(b.host.call("get_text", {})).rejects.toMatchObject({ code: "E_NOT_INTERACTABLE", message: "hidden", data: { why: "display:none" } });
  });
});

describe("snapshots", () => {
  it("returns the page outline with ids, origin and refs recorded", async () => {
    const b = await boot();
    b.pages.on(1, "snapshot", snapshotOf([{ d: 0, t: '- form "Apply"' }, { d: 1, t: '- textbox "Email" [ref=e1]' }], { nextRef: 2, newRefs: ["e1"] }));
    const r = await b.host.call("snapshot", {});
    expect(r).toEqual({ snapshotId: "s1", title: "Apply", url: SITE_URL, origin: ORIGIN, text: '- form "Apply"\n  - textbox "Email" [ref=e1]', truncated: false });
    expect(b.pages.sent("snapshot")[0].msg).toMatchObject({ includeText: true, charLimit: 25_000, nextRef: 1 });
    expect((await b.host.call("snapshot", { includeText: false })).snapshotId).toBe("s2");
    expect(b.pages.sent("snapshot")[1].msg).toMatchObject({ includeText: false, nextRef: 2 });
  });

  it("includes allowed frames and labels the rest", async () => {
    const b = await boot();
    b.pages.on(1, "snapshot", snapshotOf([
      { d: 0, t: "- main" },
      { d: 1, frameId: 5, src: `${SITE}/embed`, title: "Questions" },
      { d: 1, frameId: 6, src: "https://ads.tracker.example/x" },
      { d: 1, frameId: 7, src: "about:blank" },
    ]));
    b.pages.frame(1, 5, { url: `${SITE}/embed`, handlers: { snapshot: snapshotOf([{ d: 0, t: '- textbox "Why us?" [ref=e5]' }], { nextRef: 6, newRefs: ["e5"]  }) } });
    b.pages.frame(1, 6, { url: "https://ads.tracker.example/x", handlers: { snapshot: () => ({ items: [{ d: 0, t: "secret" }] }) } });
    b.pages.frame(1, 7, { url: "about:blank", handlers: { snapshot: snapshotOf([{ d: 0, t: "- paragraph: inline" }]) } });
    const { text } = await b.host.call("snapshot", {});
    expect(text).toBe([
      "- main",
      `  - frame "Questions" (${ORIGIN})`,
      '    - textbox "Why us?" [ref=e5]',
      "  - frame (not allowed: https://ads.tracker.example)",
      "  - frame (null)",
      "    - paragraph: inline",
    ].join("\n"));
    expect(b.pages.sent("snapshot").filter((m) => m.frameId === 6)).toEqual([]);

    // Refs remember their frame: clicking e5 goes to frame 5.
    b.pages.on(1, "click", () => ({ ok: true, target: "Why us?" }), 5);
    await b.host.call("click", { ref: "e5" });
    expect(b.pages.sent("click").map((m) => m.frameId)).toEqual([5]);
  });

  it("stops descending into frames three levels down", async () => {
    const b = await boot();
    for (let f = 0; f <= 4; f++) {
      b.pages.frame(1, f, { url: `${SITE}/f${f}`, injected: f === 0 ? undefined : false, handlers: { snapshot: snapshotOf([{ d: 0, t: `- level ${f}` }, { d: 0, frameId: f + 1, src: `${SITE}/f${f + 1}` }]) } });
    }
    const { text } = await b.host.call("snapshot", {});
    expect(text).toContain("- level 3");
    expect(text).toContain("- frame (nested too deep)");
    expect(text).not.toContain("level 4");
  });

  it("truncates at a line boundary when over the character limit", async () => {
    const b = await boot();
    const lines = Array.from({ length: 300 }, (_, i) => ({ d: 0, t: `- item ${String(i).padStart(3, "0")} ${"x".repeat(10)}` }));
    b.pages.on(1, "snapshot", snapshotOf(lines));
    const r = await b.host.call("snapshot", { charLimit: 100 }); // raised to the 2000 minimum
    expect(b.pages.sent("snapshot")[0].msg.charLimit).toBe(2000);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(2000);
    expect(r.text.split("\n").every((l) => /^- item \d{3} x{10}$/.test(l))).toBe(true);
  });

  it("keeps the page's own truncated flag", async () => {
    const b = await boot();
    b.pages.on(1, "snapshot", snapshotOf([{ d: 0, t: "- a" }], { truncated: true }));
    expect((await b.host.call("snapshot", {})).truncated).toBe(true);
  });

  it("snapshots a subtree by ref, in that ref's frame", async () => {
    const b = await boot();
    b.pages.on(1, "snapshot", snapshotOf([{ d: 0, frameId: 5, src: `${SITE}/embed` }]));
    b.pages.frame(1, 5, { url: `${SITE}/embed`, handlers: { snapshot: snapshotOf([{ d: 0, t: '- group "Q" [ref=e7]' }], { newRefs: ["e7"] }) } });
    await b.host.call("snapshot", {});
    await b.host.call("snapshot", { root: "e7" });
    expect(b.pages.sent("snapshot").at(-1)).toMatchObject({ frameId: 5, msg: { root: "e7" } });
    await expect(b.host.call("snapshot", { root: "e99" })).rejects.toMatchObject({ code: "E_STALE_REF", message: "Unknown ref e99. Take a new snapshot." });
  });
});

describe("targets", () => {
  it("rejects unknown refs and missing targets", async () => {
    const b = await boot();
    await expect(b.host.call("click", { ref: "e9" })).rejects.toMatchObject({ code: "E_STALE_REF" });
    await expect(b.host.call("click", {})).rejects.toMatchObject({ code: "E_INTERNAL", message: "Provide ref or target" });
    await expect(b.host.call("click", { target: {} })).rejects.toMatchObject({ code: "E_INTERNAL" });
  });

  it("finds a target by label across frames", async () => {
    const b = await boot();
    b.pages.on(1, "snapshot", snapshotOf([{ d: 0, frameId: 5, src: `${SITE}/embed` }]));
    b.pages.frame(1, 5, { url: `${SITE}/embed`, handlers: { snapshot: snapshotOf([]) } });
    await b.host.call("snapshot", {});
    b.pages.on(1, "find", () => ({ matches: [], nextRef: 10 }));
    b.pages.on(1, "find", (m) => ({ matches: [{ ref: "e10", role: "textbox", name: m.label }], nextRef: 11, newRefs: ["e10"] }), 5);
    b.pages.on(1, "type", (m) => ({ ok: true, target: "Email", value: m.text }), 5);
    const r = await b.host.call("type", { target: { label: "Email" }, text: "jane@example.com" });
    expect(r).toEqual({ ok: true, target: "Email", value: "jane@example.com", origin: ORIGIN });
    expect(b.pages.sent("find").map((m) => [m.frameId, m.msg.label, m.msg.text])).toEqual([[0, "Email", undefined], [5, "Email", undefined]]);
  });

  it("finds by text, and explains no match or several", async () => {
    const b = await boot();
    let matches = [];
    b.pages.on(1, "find", () => ({ matches, nextRef: 5 }));
    await expect(b.host.call("click", { target: { text: "Next" } })).rejects.toMatchObject({ code: "E_NOT_INTERACTABLE", message: 'Nothing on the page matches text "Next". Take a snapshot to find it.' });
    expect(b.pages.sent("find")[0].msg).toMatchObject({ text: "Next" });
    expect(b.pages.sent("find")[0].msg.label).toBeUndefined();
    matches = [{ ref: "e1", role: "button", name: "Next", extra: 1 }, { ref: "e2", role: "link", name: "Next page" }];
    await expect(b.host.call("click", { target: { text: "Next" } })).rejects.toMatchObject({
      code: "E_AMBIGUOUS",
      message: '2 elements match text "Next"; use a ref.',
      data: { origin: ORIGIN, candidates: [{ ref: "e1", role: "button", name: "Next" }, { ref: "e2", role: "link", name: "Next page" }] },
    });
  });
});

describe("actions", () => {
  async function page() {
    const b = await boot();
    b.pages.on(1, "snapshot", snapshotOf([], { nextRef: 4, newRefs: ["e1", "e2", "e3"] }));
    await b.host.call("snapshot", {});
    return b;
  }

  it("types with clear on by default, and logs only the length", async () => {
    const b = await page();
    b.pages.on(1, "type", () => ({ ok: true, target: "Cover letter" }));
    await b.host.call("type", { ref: "e1", text: "my secret answer" });
    await b.host.call("type", { ref: "e1", text: "more", clear: false, perKey: true });
    expect(b.pages.sent("type").map((m) => m.msg)).toMatchObject([{ ref: "e1", text: "my secret answer", clear: true, perKey: false }, { clear: false, perKey: true }]);
    expect(audits(b).filter((a) => a.action === "type")).toMatchObject([{ target: "Cover letter", result: "ok", detail: "16 characters" }, { detail: "4 characters" }]);
    expect(JSON.stringify(audits(b))).not.toContain("secret");
  });

  it("selects options and checks boxes", async () => {
    const b = await page();
    b.pages.on(1, "select", (m) => ({ ok: true, target: "Country", selected: [m.option] }));
    b.pages.on(1, "check", (m) => ({ ok: true, target: "Remote", checked: m.checked }));
    expect(await b.host.call("select", { ref: "e2", option: "Canada" })).toEqual({ ok: true, target: "Country", selected: ["Canada"], origin: ORIGIN });
    expect(await b.host.call("check", { ref: "e3", checked: 1 })).toMatchObject({ checked: true });
    expect(await b.host.call("check", { ref: "e3" })).toMatchObject({ checked: false });
    expect((await b.state()).log.map((l) => l.text)).toEqual(expect.arrayContaining(["Selected Canada in Country", "Checked Remote", "Unchecked Remote"]));
  });

  it("uploads a file and audits its name and size", async () => {
    const b = await page();
    b.pages.on(1, "upload", (m) => ({ ok: true, target: "Resume", fileName: m.fileName, size: 9 }));
    await b.host.call("upload", { ref: "e1", fileName: "resume.pdf", mimeType: "application/pdf", base64: "JVBERi0xLjQ=" });
    expect(b.pages.sent("upload")[0].msg).toMatchObject({ fileName: "resume.pdf", mimeType: "application/pdf", base64: "JVBERi0xLjQ=" });
    expect(audits(b).at(-1)).toMatchObject({ action: "upload", detail: "resume.pdf, 9 bytes" });
  });

  it("audits and logs failed actions", async () => {
    const b = await page();
    b.pages.on(1, "type", () => {
      throw err("E_REFUSED_SENSITIVE", '"Password" is a password field.');
    });
    await expect(b.host.call("type", { ref: "e1", text: "hunter2" })).rejects.toMatchObject({ code: "E_REFUSED_SENSITIVE" });
    expect(audits(b).at(-1)).toMatchObject({ action: "type", target: "e1", result: "E_REFUSED_SENSITIVE", approved: null });
    expect((await b.state()).log.at(-1)).toMatchObject({ kind: "error", text: 'Couldn\'t type e1: "Password" is a password field.' });
  });

  it("treats a page that navigated away mid-action as success", async () => {
    const b = await page();
    b.pages.on(1, "click", () => {
      b._tabs.get(1).url = `${SITE}/next`;
      throw new Error("Actor 'Conduits' destroyed before query 'RuntimeMessage' was resolved");
    });
    expect(await b.host.call("click", { ref: "e1" })).toEqual({ ok: true, navigated: true, snapshotStale: true, url: `${SITE}/next`, origin: ORIGIN });
  });

  it("waits for a navigation the click started before returning", async () => {
    const b = await page();
    b.pages.on(1, "click", () => {
      b.tabs.update(1, { url: `${SITE}/thanks` });
      return { ok: true, target: "Next", navigated: true };
    });
    expect(await b.host.call("click", { ref: "e1" })).toMatchObject({ navigated: true, url: `${SITE}/thanks` });
  });

  it("doesn't swallow other transport errors", async () => {
    const b = await page();
    b.pages.on(1, "click", () => {
      throw new Error("weird failure");
    });
    await expect(b.host.call("click", { ref: "e1" })).rejects.toMatchObject({ code: "E_INTERNAL", message: "weird failure" });
  });

  it("presses keys in the frame of the last action", async () => {
    const b = await boot();
    b.pages.on(1, "snapshot", snapshotOf([{ d: 0, frameId: 5, src: `${SITE}/embed` }]));
    b.pages.frame(1, 5, { url: `${SITE}/embed`, handlers: { snapshot: snapshotOf([], { newRefs: ["e5"] }), click: () => ({ ok: true }), press_key: (m) => ({ ok: true, key: m.key }) } });
    b.pages.on(1, "press_key", () => ({ ok: true, frame: 0 }));
    expect(await b.host.call("press_key", { key: "Tab" })).toMatchObject({ frame: 0 });
    await b.host.call("snapshot", {});
    await b.host.call("click", { ref: "e5" });
    expect(await b.host.call("press_key", { key: "ArrowDown" })).toMatchObject({ key: "ArrowDown" });
    expect(b.pages.sent("press_key").map((m) => m.frameId)).toEqual([0, 5]);
  });

  it("scrolls the page or an element", async () => {
    const b = await page();
    b.pages.on(1, "scroll", (m) => ({ ok: true, ref: m.ref ?? null, direction: m.direction }));
    expect(await b.host.call("scroll", { direction: "down", amount: 2 })).toEqual({ ok: true, ref: null, direction: "down", origin: ORIGIN });
    expect(await b.host.call("scroll", { ref: "e2", direction: "up" })).toMatchObject({ ref: "e2" });
  });

  it("waits for text and cancels the wait on stop", async () => {
    const b = await page();
    b.pages.on(1, "wait_for", (m) => (m.text === "Saved" ? { ok: true, found: true } : new Promise(() => {})));
    expect(await b.host.call("wait_for", { text: "Saved", timeoutMs: 1000 })).toEqual({ ok: true, found: true, origin: ORIGIN });
    const p = b.host.call("wait_for", { textGone: "Loading" }).catch((e) => e);
    await until(() => b.pages.sent("wait_for").length === 2);
    await b.ui({ type: "stop" });
    expect(await p).toMatchObject({ code: "E_STOPPED" });
  });

  it("reads text of the page or an element", async () => {
    const b = await page();
    b.pages.on(1, "get_text", (m) => ({ text: m.ref ? "element" : "page", truncated: false, url: SITE_URL, origin: ORIGIN, extra: "dropped" }));
    expect(await b.host.call("get_text", {})).toEqual({ text: "page", truncated: false, url: SITE_URL, origin: ORIGIN });
    expect((await b.host.call("get_text", { ref: "e1" })).text).toBe("element");
  });

  it("annotates an element", async () => {
    const b = await page();
    b.pages.on(1, "annotate", (m) => ({ ok: true, note: m.note }));
    expect(await b.host.call("annotate", { ref: "e1", note: "Draft: please review" })).toEqual({ ok: true, note: "Draft: please review" });
  });

  it("doesn't leak ref bookkeeping in results", async () => {
    const b = await page();
    b.pages.on(1, "type", () => ({ ok: true, target: "x", nextRef: 99, newRefs: ["e98"] }));
    expect(await b.host.call("type", { ref: "e1", text: "a" })).toEqual({ ok: true, target: "x", origin: ORIGIN });
  });
});

describe("fill_form and form_fields", () => {
  it("fills fields in order and stops at the first error", async () => {
    const b = await boot();
    b.pages.on(1, "snapshot", snapshotOf([], { nextRef: 5, newRefs: ["e1", "e2", "e3"] }));
    await b.host.call("snapshot", {});
    b.pages.on(1, "fill_field", (m) => {
      if (m.ref === "e2") throw err("E_NO_MATCH", "No option matches Narnia");
      return { ok: true, target: m.ref, ...(typeof m.value === "boolean" ? { checked: m.value } : {}), nextRef: 6, newRefs: ["e5"] };
    });
    const r = await b.host.call("fill_form", { fields: [{ ref: "e1", value: true }, { ref: "e2", value: "Narnia" }, { ref: "e3", value: "never" }] });
    expect(r).toEqual({
      ok: false,
      origin: ORIGIN,
      results: [{ ref: "e1", ok: true, target: "e1", checked: true }, { ref: "e2", ok: false, error: { code: "E_NO_MATCH", message: "No option matches Narnia" } }],
    });
    expect(b.pages.sent("fill_field").map((m) => m.msg.ref)).toEqual(["e1", "e2"]);
    expect(audits(b).filter((a) => a.action === "fill").map((a) => a.detail ?? a.result)).toEqual(["true", "E_NO_MATCH"]);
  });

  it("reports stale refs as a field error, and succeeds when all fields do", async () => {
    const b = await boot();
    b.pages.on(1, "snapshot", snapshotOf([], { newRefs: ["e1"] }));
    await b.host.call("snapshot", {});
    b.pages.on(1, "fill_field", (m) => ({ ok: true, target: "Name", value: m.value }));
    expect((await b.host.call("fill_form", { fields: [{ ref: "e1", value: "Jane" }] })).ok).toBe(true);
    expect(audits(b).at(-1).detail).toBe("4 characters");
    const r = await b.host.call("fill_form", { fields: [{ ref: "e7", value: "x" }, { ref: "e1", value: "y" }] });
    expect(r).toMatchObject({ ok: false, results: [{ ref: "e7", ok: false, error: { code: "E_STALE_REF" } }] });
    expect(await b.host.call("fill_form", {})).toEqual({ ok: true, results: [], origin: ORIGIN });
  });

  it("collects form fields from allowed frames only", async () => {
    const b = await boot();
    b.pages.on(1, "form_fields", () => ({ fields: [{ ref: "e1", label: "Name" }], frames: [5, 6, 8], nextRef: 2, newRefs: ["e1"] }));
    b.pages.frame(1, 5, { url: `${SITE}/embed`, handlers: { form_fields: () => ({ fields: [{ ref: "e2", label: "Why?" }], frames: [], nextRef: 3, newRefs: ["e2"] }) } });
    b.pages.frame(1, 6, { url: "https://evil.example/", handlers: { form_fields: () => ({ fields: [{ ref: "e9", label: "leak" }], frames: [] }) } });
    // frame 8 never answers (gone)
    b.scripting.executeScript = async (o) => {
      if (o.target.frameIds?.[0] === 8) throw new Error("Frame not found");
      b.pages.frame(o.target.tabId, o.target.frameIds?.[0] ?? 0, { injected: true });
      return [{}];
    };
    expect(await b.host.call("form_fields", {})).toEqual({ fields: [{ ref: "e1", label: "Name", frameId: 0 }, { ref: "e2", label: "Why?", frameId: 5 }], origin: ORIGIN });
    expect(b.pages.sent("form_fields").filter((m) => m.frameId === 6)).toEqual([]);
  });
});

describe("approval gate", () => {
  it("asks in the page, highlights the target, and runs the action once allowed", async () => {
    const b = await boot();
    submitPage(b);
    const decision = deferred();
    b.pages.on(1, "approve", () => decision.promise);
    const p = clickSubmit(b);
    await until(async () => (await b.state()).approvals.length === 1);
    expect((await b.state()).approvals[0]).toMatchObject({ tabId: 1, verb: "submit", target: "Submit application", host: "jobs.example.com", reason: "button text" });
    expect(b.pages.sent("approve")[0].msg).toMatchObject({ verb: "submit", target: "Submit application", host: "jobs.example.com", timeoutMs: 120_000 });
    expect(b.pages.sent("highlight").map((m) => [m.msg.ref, m.msg.on])).toEqual([["e1", true]]);
    const note = b.calls.find(([api]) => api === "notifications.create");
    expect(note[2]).toMatchObject({ title: "Claude needs your approval", message: 'Claude wants to submit "Submit application" on jobs.example.com. Approve it in the page.' });

    decision.resolve({ decision: "allow" });
    expect(await p).toEqual({ ok: true, target: "Submit application", navigated: false, approved: true, origin: ORIGIN });
    expect(b.pages.sent("click").map((m) => !!m.msg.approved)).toEqual([false, true]);
    expect(b.pages.sent("highlight").map((m) => m.msg.on)).toEqual([true, false]);
    expect(b.calls).toContainEqual(["notifications.clear", note[1]]);
    expect((await b.state()).approvals).toEqual([]);
    expect(audits(b).slice(-2)).toMatchObject([
      { action: "approval", target: "Submit application", result: "allowed", approved: true },
      { action: "click", target: "Submit application", result: "ok", approved: true },
    ]);
  });

  it.each([
    ["deny", { decision: "deny" }, "E_APPROVAL_DENIED", "User declined: Submit application", "deny"],
    ["timeout", { decision: "timeout" }, "E_APPROVAL_TIMEOUT", "No approval within 120 s: Submit application", "timeout"],
    ["cancel", err("E_STOPPED", "Stopped"), "E_STOPPED", "Stopped by the user", "cancelled"],
    ["page change", new Error("Receiving end does not exist."), "E_APPROVAL_DENIED", "The page changed before approval: Submit application", "gone"],
  ])("refuses the action on %s", async (_, outcome, code, message, result) => {
    const b = await boot();
    submitPage(b);
    b.pages.on(1, "approve", () => {
      if (outcome instanceof Error || outcome.code) throw outcome;
      return outcome;
    });
    await expect(clickSubmit(b)).rejects.toMatchObject({ code, message });
    expect(b.pages.sent("click")).toHaveLength(1); // never re-sent as approved
    expect(audits(b).find((a) => a.action === "approval")).toMatchObject({ result, approved: false });
    expect((await b.state()).approvals).toEqual([]);
  });

  it("clamps the approval timeout to 10 s - 10 min and reports the one used", async () => {
    const b = await boot();
    submitPage(b);
    b.pages.on(1, "approve", () => ({ decision: "timeout" }));
    await expect(clickSubmit(b, { approvalTimeoutMs: 500 })).rejects.toMatchObject({ message: "No approval within 10 s: Submit application" });
    await expect(clickSubmit(b, { approvalTimeoutMs: 3_600_000 })).rejects.toMatchObject({ message: "No approval within 600 s: Submit application" });
    await expect(clickSubmit(b, { approvalTimeoutMs: 30_000 })).rejects.toMatchObject({ message: "No approval within 30 s: Submit application" });
    expect(b.pages.sent("approve").map((m) => m.msg.timeoutMs)).toEqual([10_000, 600_000, 30_000]);
  });

  it("skips the prompt when the user turned on auto-approve", async () => {
    const b = await boot();
    submitPage(b);
    await b.ui({ type: "set_auto_approve", enabled: true });
    expect(await clickSubmit(b)).toMatchObject({ ok: true, approved: true });
    expect(b.pages.sent("approve")).toEqual([]);
    expect(audits(b).find((a) => a.action === "approval")).toMatchObject({ result: "auto-allowed", approved: true });
    expect((await b.state()).log.map((l) => l.text)).toContain("Auto-approve turned on");
  });

  it("fails if the page still wants approval after approval", async () => {
    const b = await boot();
    b.pages.on(1, "find", () => ({ matches: [{ ref: "e1" }], nextRef: 2, newRefs: ["e1"] }));
    b.pages.on(1, "click", () => ({ needsApproval: true, verb: "pay", target: "Pay" }));
    b.pages.on(1, "approve", () => ({ decision: "allow" }));
    await expect(clickSubmit(b)).rejects.toMatchObject({ code: "E_INTERNAL", message: "Action still needs approval after approval" });
  });

  it("gates checkboxes and Enter the same way", async () => {
    const b = await boot();
    b.pages.on(1, "snapshot", snapshotOf([], { newRefs: ["e1"] }));
    await b.host.call("snapshot", {});
    b.pages.on(1, "check", (m) => (m.approved ? { ok: true, checked: true } : { needsApproval: true, verb: "agree", target: "Terms" }));
    b.pages.on(1, "press_key", (m) => (m.approved ? { ok: true } : { needsApproval: true, verb: "submit", target: "Enter in Email" }));
    b.pages.on(1, "approve", () => ({ decision: "allow" }));
    expect(await b.host.call("check", { ref: "e1", checked: true })).toMatchObject({ approved: true });
    expect(await b.host.call("press_key", { key: "Enter" })).toMatchObject({ approved: true });
    expect(b.pages.sent("approve")).toHaveLength(2);
  });

  it("notifies when the page blocked an unapproved submission", async () => {
    const b = await boot();
    b.pages.on(1, "find", () => ({ matches: [{ ref: "e1" }], nextRef: 2, newRefs: ["e1"] }));
    b.pages.on(1, "click", () => ({ ok: true, blockedSubmit: true }));
    expect(await clickSubmit(b)).toMatchObject({ blockedSubmit: true });
    expect(b.calls).toContainEqual(["notifications.create", "cb-blocked", expect.objectContaining({ title: "Submission blocked" })]);
  });
});

describe("navigate", () => {
  it.each(["/submit", "/jobs/42/confirm", "/checkout?cart=1", "/pay", "/account/delete.php", "/SUBMIT/"])("asks before opening %s", async (path) => {
    const b = await boot();
    b.pages.on(1, "approve", () => ({ decision: "allow" }));
    const r = await b.host.call("navigate", { url: SITE + path });
    expect(r).toMatchObject({ ok: true, url: SITE + path, allowed: true });
    expect(b.pages.sent("approve")[0].msg).toMatchObject({ verb: "open", target: SITE + path });
    expect(audits(b).map((a) => a.action)).toEqual(["approval", "navigate"]);
  });

  it.each(["/submitted-applications", "/payments", "/confirmation", "/jobs?action=submit", "/"])("doesn't ask for %s", async (path) => {
    const b = await boot();
    await b.host.call("navigate", { url: SITE + path });
    expect(b.pages.sent("approve")).toEqual([]);
    expect(b.calls).toContainEqual(["tabs.update", 1, { url: SITE + path }]);
  });

  it("doesn't navigate when the approval is denied", async () => {
    const b = await boot();
    b.pages.on(1, "approve", () => ({ decision: "deny" }));
    await expect(b.host.call("navigate", { url: `${SITE}/checkout` })).rejects.toMatchObject({ code: "E_APPROVAL_DENIED" });
    expect(b._tabs.get(1).url).toBe(SITE_URL);
  });

  it("can't ask for approval from a page that isn't allowed", async () => {
    const b = await boot({ tabs: [{ id: 1, url: "https://news.example.net/", active: true }] });
    await expect(b.host.call("navigate", { url: `${SITE}/pay` })).rejects.toMatchObject({ code: "E_APPROVAL_DENIED", message: expect.stringContaining("can only be shown on an allowed page") });
    // Plain navigation from a page that isn't allowed is fine (the destination is checked on use).
    expect(await b.host.call("navigate", { url: `${SITE}/jobs` })).toMatchObject({ ok: true, allowed: true });
  });

  it("goes back, forward and reloads", async () => {
    const b = await boot();
    for (const action of ["back", "forward", "reload"]) {
      expect(await b.host.call("navigate", { action })).toMatchObject({ ok: true, url: SITE_URL, title: "Apply", allowed: true });
    }
    expect(b.calls.filter(([api]) => /^tabs\.(goBack|goForward|reload)$/.test(api))).toEqual([["tabs.goBack", 1], ["tabs.goForward", 1], ["tabs.reload", 1]]);
    expect((await b.state()).log.map((l) => l.text)).toEqual(["Went back", "Went forward", "Went reload"]);
    await expect(b.host.call("navigate", { action: "sideways" })).rejects.toMatchObject({ code: "E_INTERNAL", message: "Provide url or action" });
  });
});

describe("screenshot", () => {
  it("captures the visible area, activating the tab first", async () => {
    const b = await boot();
    b.addTab({ id: 2, url: SITE_URL, windowId: 3 });
    const r = await b.host.call("screenshot", { tabId: 2 });
    expect(r).toEqual({ data: "QUJD", mimeType: "image/jpeg", activated: true });
    expect(b.calls).toContainEqual(["tabs.update", 2, { active: true }]);
    expect(b.calls).toContainEqual(["captureVisibleTab", 3, { format: "jpeg", quality: 70 }]);
    expect(audits(b).at(-1)).toMatchObject({ action: "screenshot", target: "viewport" });
    expect((await b.host.call("screenshot", { tabId: 2 })).activated).toBe(false);
  });

  it("asks for the toolbar click when Firefox refuses the capture", async () => {
    const b = await boot();
    b.captureError = "Missing activeTab permission";
    await expect(b.host.call("screenshot", {})).rejects.toMatchObject({ code: "E_SITE_NOT_ALLOWED", message: expect.stringContaining("click the Tabwright toolbar button") });
    b.captureError = "Out of memory";
    await expect(b.host.call("screenshot", {})).rejects.toMatchObject({ code: "E_INTERNAL", message: "Out of memory" });
  });

  it("refuses tabs on sites that aren't allowed", async () => {
    const b = await boot({ tabs: [{ id: 1, url: "https://bank.example/", active: true }] });
    await expect(b.host.call("screenshot", {})).rejects.toMatchObject({ code: "E_SITE_NOT_ALLOWED" });
    expect(b.calls.find(([api]) => api === "captureVisibleTab")).toBeUndefined();
  });

  it("crops to an element, scaled to the captured image", async () => {
    const drawn = [];
    vi.stubGlobal("createImageBitmap", async () => ({ width: 200, height: 100 }));
    vi.stubGlobal("OffscreenCanvas", class {
      constructor(w, h) {
        drawn.push(["canvas", w, h]);
      }
      getContext() {
        return { drawImage: (...a) => drawn.push(["draw", ...a.slice(1)]) };
      }
      async convertToBlob() {
        return new Blob([new Uint8Array([1, 2, 3])]);
      }
    });
    const b = await boot();
    b.pages.on(1, "snapshot", snapshotOf([{ d: 0, frameId: 5, src: `${SITE}/embed` }], { newRefs: ["e1"] }));
    b.pages.frame(1, 5, { url: `${SITE}/embed`, handlers: { snapshot: snapshotOf([], { newRefs: ["e5"] }) } });
    await b.host.call("snapshot", {});
    b.pages.on(1, "rect", () => ({ x: 10, y: 20, width: 50, height: 30, viewportWidth: 100 }));
    expect(await b.host.call("screenshot", { ref: "e1" })).toEqual({ data: "AQID", mimeType: "image/jpeg", activated: false });
    expect(drawn).toEqual([["canvas", 100, 60], ["draw", 20, 40, 100, 60, 0, 0, 100, 60]]);

    const inFrame = await b.host.call("screenshot", { ref: "e5" });
    expect(inFrame).toMatchObject({ data: "QUJD", note: "The element is inside a frame; returning the whole visible area." });
  });
});

describe("ask_user", () => {
  const question = (b) => until(async () => (await b.state()).question).then(async () => (await b.state()).question);

  it("shows the question and returns the user's answer", async () => {
    const b = await boot();
    const p = b.host.call("ask_user", { question: "Which resume?", options: ["Short", "Long", 3] });
    const q = await question(b);
    expect(q).toMatchObject({ question: "Which resume?", options: ["Short", "Long", "3"] });
    expect(b.calls).toContainEqual(["notifications.create", "cb-question", expect.objectContaining({ title: "Claude has a question" })]);
    await b.ui({ type: "answer", id: "q-wrong", answer: "nope" });
    await b.ui({ type: "answer", id: q.id, answer: "Long" });
    expect(await p).toEqual({ answer: "Long" });
    expect((await b.state()).question).toBeNull();
    expect(b.calls).toContainEqual(["notifications.clear", "cb-question"]);
  });

  it("limits question and option sizes", async () => {
    const b = await boot();
    b.host.call("ask_user", { question: "q".repeat(5000), options: Array.from({ length: 30 }, (_, i) => `o${i}`) }).catch(() => {});
    const q = await question(b);
    expect(q.question).toHaveLength(1000);
    expect(q.options).toHaveLength(20);
  });

  it("replaces an older question, and the newer one can still be answered", async () => {
    const b = await boot();
    const first = b.host.call("ask_user", { question: "First?" }).catch((e) => e);
    await question(b);
    await settle(1);
    const second = b.host.call("ask_user", { question: "Second?" });
    expect(await first).toMatchObject({ code: "E_STOPPED", message: "Replaced by a newer question" });
    await settle();
    const q = (await b.state()).question;
    expect(q).toMatchObject({ question: "Second?" });
    await b.ui({ type: "answer", id: q.id, answer: "yes" });
    expect(await second).toEqual({ answer: "yes" });
  });

  it("gives up after 10 minutes", async () => {
    const b = await boot();
    const p = b.host.call("ask_user", { question: "Still there?" }).catch((e) => e);
    await question(b);
    await settle(10 * 60_000);
    expect(await p).toMatchObject({ code: "E_TIMEOUT", message: "The user didn't answer within 10 minutes" });
    expect((await b.state()).question).toBeNull();
  });

  it("is cancelled by stop", async () => {
    const b = await boot();
    const p = b.host.call("ask_user", { question: "Hmm?" }).catch((e) => e);
    await question(b);
    await b.ui({ type: "stop" });
    expect(await p).toMatchObject({ code: "E_STOPPED" });
  });
});

describe("stop", () => {
  it("cancels work in every driven frame, releases tabs, tells the host and disconnects", async () => {
    const b = await boot({ hostHandlers: { run_start: () => ({ runId: "r1" }) } });
    b.pages.on(1, "snapshot", snapshotOf([{ d: 0, frameId: 5, src: `${SITE}/embed` }]));
    b.pages.frame(1, 5, { url: `${SITE}/embed`, handlers: { snapshot: snapshotOf([]) } });
    await b.host.call("snapshot", {});
    await b.ui({ type: "run", instruction: "go" });
    submitPage(b);
    b.pages.on(1, "approve", () => new Promise(() => {}));
    const pending = clickSubmit(b).catch((e) => e);
    await until(async () => (await b.state()).approvals.length === 1);
    const port = b.host.port;

    expect(await b.ui({ type: "stop" })).toEqual({ ok: true });
    expect(await pending).toMatchObject({ code: "E_STOPPED" });
    expect(b.pages.sent("cancel").map((m) => m.frameId)).toEqual([0, 5]);
    expect(b.calls).toContainEqual(["removeCSS", 1]);
    expect(b.pages.sent("control").map((m) => m.msg.on)).toEqual([true, false]);
    expect(b.host.events.at(-1)).toEqual({ v: 1, type: "event", name: "stopped", data: { reason: "Stopped by the user" } });
    expect(port.disconnected).toBe(true);
    const s = await b.state();
    expect(s).toMatchObject({ connected: false, error: null, approvals: [], run: { status: "failed", message: "Stopped" } });
    expect(s.log.at(-1)).toMatchObject({ text: "Stopped", kind: "error" });
    await settle(60_000);
    expect(b.calls.filter(([api]) => api === "connectNative")).toHaveLength(1); // a user stop doesn't reconnect
  });

  it("works while disconnected", async () => {
    const b = await boot({ connect: false });
    expect(await b.ui({ type: "stop" })).toEqual({ ok: true });
  });
});
