// @vitest-environment jsdom
// The toolbar popup (SPEC 4.1, 8.1) and the activity page (SPEC 8.6), with their real HTML and scripts.
import { describe, expect, it, vi } from "vitest";
import { $, baseState, fakeBrowser, flush, loadPage, texts } from "../helpers/ui-browser.js";

const JOBS = { id: 5, windowId: 1, url: "https://jobs.test/apply?id=3", active: true };
const openPopup = (opts = {}) => loadPage("popup/popup", fakeBrowser({ tabs: [JOBS], ...opts }), () => import("../../extension/popup/popup.js"));
const openActivity = (opts = {}) => loadPage("popup/activity", fakeBrowser(opts), () => import("../../extension/popup/activity.js"));

describe("popup: connection state", () => {
  it("connects a ui port and shows nothing until the first state arrives", async () => {
    const { port } = await openPopup();
    expect(port.name).toBe("ui");
    expect($("status").textContent).toBe("…");
  });

  it.each([
    [{}, "disconnected", "dot", "Connect", "connect"],
    [{ connecting: true }, "connecting…", "dot", "Disconnect", "disconnect"],
    [{ connected: true }, "connected", "dot on", "Disconnect", "disconnect"],
    [{ connected: true, busy: true }, "acting", "dot busy", "Disconnect", "disconnect"],
    [{ error: "Native host exited" }, "disconnected", "dot error", "Connect", "connect"],
  ])("%j → %s", async (over, status, dot, button, action) => {
    const { port } = await openPopup();
    port.push(baseState(over));
    expect($("status").textContent).toBe(status);
    expect($("dot").className).toBe(dot);
    expect($("connectBtn").textContent).toBe(button);
    expect($("connectBtn").dataset.action).toBe(action);
    expect($("error").hidden).toBe(!over.error);
    expect($("error").textContent).toBe(over.error ?? "");
  });

  it("sends connect, disconnect and stop", async () => {
    const { port, sent } = await openPopup();
    $("connectBtn").click();
    port.push(baseState({ connected: true }));
    $("connectBtn").click();
    $("stopBtn").click();
    expect(sent.map((m) => m.type)).toEqual(["connect", "disconnect", "stop"]);
  });
});

describe("popup: approvals", () => {
  it("lists pending approvals and focuses their tab on click", async () => {
    const { port, sent } = await openPopup();
    expect($("approvalsSec").hidden).toBe(true);
    port.push(baseState({ connected: true, approvals: [{ id: "a-1", tabId: 5, verb: "click", target: "Submit application", host: "jobs.test" }] }));
    expect($("approvalsSec").hidden).toBe(false);
    expect(texts("#approvals li")).toEqual(['click "Submit application" on jobs.test']);
    document.querySelector("#approvals li").click();
    expect(sent).toContainEqual({ type: "focus_tab", tabId: 5 });
    port.push(baseState({ connected: true }));
    expect($("approvalsSec").hidden).toBe(true);
    expect(texts("#approvals li")).toEqual([]);
  });

  it("reflects and toggles auto-approve", async () => {
    const { port, sent } = await openPopup();
    port.push(baseState({ autoApprove: true }));
    expect($("autoApprove").checked).toBe(true);
    $("autoApprove").click();
    expect(sent).toContainEqual({ type: "set_auto_approve", enabled: false });
    $("autoApprove").click();
    expect(sent.at(-1)).toEqual({ type: "set_auto_approve", enabled: true });
  });
});

describe("popup: this tab", () => {
  it("offers to allow a site that isn't allowed, by hostname", async () => {
    await openPopup();
    expect($("siteHost").textContent).toBe("jobs.test");
    expect($("allowBtn").hidden).toBe(false);
    expect($("allowBtn").textContent).toBe("Allow Claude on jobs.test");
    expect($("siteNote").textContent).toMatch(/can't read or act on this site until you allow it/);
    expect($("shotNote").hidden).toBe(true);
  });

  it("requests the site's match pattern on click, then shows it as allowed", async () => {
    const fake = await openPopup();
    $("allowBtn").click();
    expect(fake.browser.permissions.request).toHaveBeenCalledWith({ origins: ["https://jobs.test/*"] });
    await flush();
    expect(fake.sent).toContainEqual({ type: "site_changed" });
    expect($("allowBtn").hidden).toBe(true);
    expect($("siteNote").textContent).toBe("Claude is allowed on this site.");
    expect($("shotNote").hidden).toBe(false);
    expect(texts("#sites li span")).toEqual(["jobs.test"]);
    expect($("noSites").hidden).toBe(true);
  });

  it("drops the port from the pattern, since match patterns can't have one", async () => {
    const fake = await openPopup({ tabs: [{ id: 1, windowId: 1, url: "http://localhost:8765/form.html", active: true }] });
    $("allowBtn").click();
    expect(fake.browser.permissions.request).toHaveBeenCalledWith({ origins: ["http://localhost/*"] });
  });

  it.each([
    ["https://addons.mozilla.org/en-US/firefox/", "addons.mozilla.org"],
    ["https://accounts.firefox.com/settings", "accounts.firefox.com"],
    ["https://support.mozilla.org/kb", "support.mozilla.org"],
    ["about:preferences", "about page"],
    ["moz-extension://x/popup.html", "moz-extension page"],
    ["", "this page"],
  ])("never offers %j", async (url, host) => {
    const fake = await openPopup({ tabs: [{ id: 1, windowId: 1, url, active: true }] });
    expect($("siteHost").textContent).toBe(host);
    expect($("allowBtn").hidden).toBe(true);
    expect($("siteNote").textContent).toBe("Claude can't be used on browser, extension or account pages.");
    $("allowBtn").click();
    expect(fake.browser.permissions.request).not.toHaveBeenCalled();
  });

  it("copes with no active tab", async () => {
    await openPopup({ tabs: [] });
    expect($("siteHost").textContent).toBe("this page");
  });
});

describe("popup: allowed sites", () => {
  it("lists allowed sites without <all_urls>, and removes them", async () => {
    const fake = await openPopup({ granted: ["https://jobs.test/*", "http://localhost/*", "<all_urls>"] });
    expect(texts("#sites li span")).toEqual(["jobs.test", "localhost"]);
    expect($("allowBtn").hidden).toBe(true);
    document.querySelector("#sites li button").click();
    await flush();
    expect(fake.browser.permissions.remove).toHaveBeenCalledWith({ origins: ["https://jobs.test/*"] });
    expect(fake.sent).toContainEqual({ type: "site_changed" });
    expect(texts("#sites li span")).toEqual(["localhost"]);
    expect($("allowBtn").hidden).toBe(false); // the current tab's site is no longer allowed
  });

  it("says when nothing is allowed", async () => {
    await openPopup();
    expect($("noSites").hidden).toBe(false);
    expect(texts("#sites li")).toEqual([]);
  });
});

describe("popup: links", () => {
  it("opens the sidebar and closes", async () => {
    const fake = await openPopup();
    $("openSidebar").click();
    expect(fake.browser.sidebarAction.open).toHaveBeenCalled();
    expect(window.close).toHaveBeenCalled();
  });

  it("opens the activity page in a tab and closes", async () => {
    const fake = await openPopup();
    $("viewActivity").click();
    expect(fake.browser.tabs.create).toHaveBeenCalledWith({ url: "moz-extension://test-id/popup/activity.html" });
    expect(window.close).toHaveBeenCalled();
  });
});

describe("activity page", () => {
  const entries = [
    { time: Date.UTC(2026, 0, 1, 9), url: "https://jobs.test/", action: "type", target: "e3", result: "ok", approved: null, detail: "4 characters" },
    { time: Date.UTC(2026, 0, 1, 10), url: "https://jobs.test/", action: "approval", target: "Submit", result: "allowed", approved: true },
    { time: Date.UTC(2026, 0, 1, 11), url: "https://jobs.test/", action: "approval", target: "Delete", result: "deny", approved: false },
    { time: Date.UTC(2026, 0, 1, 12) },
  ];

  it("shows entries newest first with results and approvals", async () => {
    await openActivity({ responses: { audit_get: () => ({ entries }) } });
    expect($("count").textContent).toBe("4 entries");
    const rows = [...document.querySelectorAll("#rows tr")].map((tr) => [...tr.children].map((td) => td.textContent));
    expect(rows.map((r) => r.slice(1))).toEqual([
      ["", "", "", "—", "", ""],
      ["approval", "Delete", "deny", "no", "", "https://jobs.test/"],
      ["approval", "Submit", "allowed", "yes", "", "https://jobs.test/"],
      ["type", "e3", "ok", "—", "4 characters", "https://jobs.test/"],
    ]);
    expect(rows[3][0]).toBe(new Date(entries[0].time).toLocaleString());
    const resultClasses = [...document.querySelectorAll("#rows tr td:nth-child(4)")].map((td) => td.className);
    expect(resultClasses).toEqual(["bad", "bad", "ok", "ok"]);
    expect(document.querySelector("#rows td.url").textContent).toBe("");
  });

  it("refreshes", async () => {
    let list = [];
    const fake = await openActivity({ responses: { audit_get: () => ({ entries: list }) } });
    expect($("count").textContent).toBe("0 entries");
    list = entries.slice(0, 1);
    $("refresh").click();
    await flush();
    expect($("count").textContent).toBe("1 entries");
    expect(fake.sent.filter((m) => m.type === "audit_get")).toHaveLength(2);
  });

  it("clears only after confirmation", async () => {
    let list = entries;
    const fake = await openActivity({ responses: { audit_get: () => ({ entries: list }), audit_clear: () => ((list = []), { ok: true }) } });
    window.confirm = vi.fn(() => false);
    $("clear").click();
    await flush();
    expect(window.confirm).toHaveBeenCalledWith("Clear the activity log?");
    expect(fake.sent.some((m) => m.type === "audit_clear")).toBe(false);
    window.confirm = vi.fn(() => true);
    $("clear").click();
    await flush();
    expect(fake.sent.some((m) => m.type === "audit_clear")).toBe(true);
    expect($("count").textContent).toBe("0 entries");
    expect(document.querySelectorAll("#rows tr")).toHaveLength(0);
  });
});
