// extension/background.js, part 1: the native messaging connection, message routing, UI and content
// script messages, events from the host, and tab lifecycle. Runs the real module against a fake
// `browser` (test/helpers/fake-browser.js) with fake timers that also advance in real time.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mainSetValue } from "../../extension/content/main-world-setter.js";
import { createFakeBrowser } from "../helpers/fake-browser.js";
import { SITE_PATTERN, SITE_URL, boot, deferred, settle, until } from "../helpers/load-background.js";

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const connects = (b) => b.calls.filter(([api]) => api === "connectNative").length;

describe("connection", () => {
  it("connects on request and completes the host_info handshake", async () => {
    const b = await boot({ connect: false });
    expect((await b.state()).connected).toBe(false);
    expect(b.action.badge.text).toBe("");

    await b.ui({ type: "connect" });
    expect(b.calls).toContainEqual(["connectNative", "tabwright"]);
    expect((await b.state()).connecting).toBe(true);

    await until(async () => (await b.state()).connected);
    const s = await b.state();
    expect(s).toMatchObject({ connected: true, connecting: false, error: null, hostInfo: { version: "0.1.0" } });
    expect(b.host.requests[0]).toMatchObject({ v: 1, type: "request", method: "host_info" });
    expect(b.action.badge).toMatchObject({ text: " ", color: "#2e9e4f" });
    expect(b.action.badge.title).toMatch(/connected$/);
  });

  it("ignores connect while already connected", async () => {
    const b = await boot();
    await b.ui({ type: "connect" });
    expect(connects(b)).toBe(1);
  });

  it("reports a native host that can't be started", async () => {
    const b = await boot({ connect: false });
    b.connectNativeError = "No such native application tabwright";
    await b.ui({ type: "connect" });
    const s = await b.state();
    expect(s).toMatchObject({ connected: false, connecting: false, error: "Couldn't start the native host: No such native application tabwright" });
    expect(b.action.badge.color).toBe("#c0392b");
  });

  it("reports a failed handshake", async () => {
    const b = await boot({ connect: false, hostHandlers: { host_info: () => Promise.reject({ code: "E_INTERNAL", message: "bad config" }) } });
    await b.ui({ type: "connect" });
    await until(async () => (await b.state()).error);
    expect(await b.state()).toMatchObject({ connected: false, connecting: false, error: "bad config" });
  });

  it("times out a handshake the host never answers", async () => {
    const b = await boot({ connect: false, hostHandlers: { host_info: null } });
    await b.ui({ type: "connect" });
    await settle(10_000);
    expect(await b.state()).toMatchObject({ connected: false, error: "host_info timed out" });
  });

  it("disconnects on request and doesn't reconnect", async () => {
    const b = await boot();
    const port = b.host.port;
    await b.ui({ type: "disconnect" });
    expect(port.disconnected).toBe(true);
    expect(await b.state()).toMatchObject({ connected: false, error: null, hostInfo: null });
    await settle(60_000);
    expect(connects(b)).toBe(1);
  });

  it("keeps the host's reason when it exits during the handshake", async () => {
    const b = await boot({ connect: false, hostHandlers: { host_info: null } });
    await b.ui({ type: "connect" });
    b.host.exit("No such native application tabwright");
    await settle();
    expect((await b.state()).error).toBe("Native host: No such native application tabwright");
  });

  it("reconnects with exponential backoff and gives up after 8 attempts", async () => {
    const b = await boot({ connect: false, hostHandlers: { host_info: null } });
    await b.ui({ type: "connect" });
    const delays = [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000];
    for (const [i, delay] of delays.entries()) {
      b.host.exit("crashed");
      await settle(delay - 50);
      expect(connects(b)).toBe(i + 1);
      await settle(50);
      expect(connects(b)).toBe(i + 2);
    }
    b.host.exit("crashed");
    await settle(120_000);
    expect(connects(b)).toBe(9);
    expect((await b.state()).error).toBe("Native host: crashed. Gave up reconnecting; click Connect to retry.");
  });

  it("resets the backoff after a successful handshake", async () => {
    const b = await boot();
    b.host.exit();
    expect((await b.state()).error).toBe("Native host exited");
    await settle(1000);
    await until(async () => (await b.state()).connected);
    b.host.exit();
    await settle(1000);
    expect(connects(b)).toBe(3);
  });

  it("rejects pending host calls and fails a running instruction when the host goes away", async () => {
    const b = await boot({ hostHandlers: { profile_get: null, run_start: () => ({ runId: "r1" }) } });
    await b.ui({ type: "run", instruction: "fill it" });
    const pending = b.ui({ type: "profile_get" });
    await settle();
    b.host.exit("crashed");
    expect(await pending).toEqual({ ok: false, error: "The native host disconnected", code: "E_NOT_CONNECTED" });
    expect((await b.state()).run).toMatchObject({ status: "failed", message: "Disconnected", offerContinue: false });
  });

  it("disconnects cleanly even if the port is already gone", async () => {
    const b = await boot();
    b.host.port.disconnect = () => {
      throw new Error("Attempt to disconnect a closed port");
    };
    expect(await b.ui({ type: "disconnect" })).toEqual({ ok: true });
    expect((await b.state()).connected).toBe(false);
  });

  it("starts with defaults when storage is unavailable", async () => {
    const b = createFakeBrowser({ tabs: [{ id: 1, url: SITE_URL, active: true }], granted: [SITE_PATTERN] });
    b.storage.session.get = b.storage.local.get = async () => {
      throw new Error("storage is broken");
    };
    await boot({ browser: b, connect: false });
    expect(await b.state()).toMatchObject({ selectedTabId: null, autoApprove: false });
  });

  it("ignores a stale port's disconnect after reconnecting", async () => {
    const b = await boot();
    const old = b.host.port;
    await b.ui({ type: "disconnect" });
    await b.ui({ type: "connect" });
    await until(async () => (await b.state()).connected);
    old.onDisconnect.emit(old);
    expect((await b.state()).connected).toBe(true);
  });

  it("connects on demand for profile calls, and reports when it can't", async () => {
    const b = await boot({ connect: false, hostHandlers: { profile_get: () => ({ profile: { firstName: "Jane" } }), profile_set: (p) => ({ ok: true, saved: p.profile }) } });
    expect(await b.ui({ type: "profile_get" })).toEqual({ profile: { firstName: "Jane" } });
    expect(await b.ui({ type: "profile_set", profile: { firstName: "Ann" } })).toEqual({ ok: true, saved: { firstName: "Ann" } });

    const c = await boot({ connect: false });
    c.connectNativeError = "boom";
    expect(await c.ui({ type: "profile_get" })).toEqual({ ok: false, error: "Couldn't start the native host: boom", code: "E_NOT_CONNECTED" });
  });

  it("passes host errors through to the UI", async () => {
    const b = await boot({ hostHandlers: { profile_set: () => Promise.reject({ code: "E_INTERNAL", message: "profile is not an object" }) } });
    expect(await b.ui({ type: "profile_set", profile: 1 })).toEqual({ ok: false, error: "profile is not an object", code: "E_INTERNAL" });
  });
});

describe("native message routing", () => {
  it("answers unknown methods with E_INTERNAL", async () => {
    const b = await boot();
    const r = await b.host.request("frobnicate");
    expect(r).toEqual({ v: 1, id: r.id, type: "response", error: { code: "E_INTERNAL", message: "Unknown method frobnicate" } });
  });

  it("ignores invalid messages and responses to unknown ids", async () => {
    const b = await boot();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const before = b.host.sent.length;
    b.host.post({ v: 2, id: "m-x", type: "request", method: "status" }, { raw: true });
    b.host.post({ v: 1, type: "request", method: "status" }, { raw: true });
    b.host.post({ v: 1, id: "x-999", type: "response", result: {} }, { raw: true });
    b.host.post({ v: 1, type: "event", name: "mystery" }, { raw: true });
    await settle(50);
    expect(b.host.sent.length).toBe(before);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]).toEqual(["tabwright: invalid message", "unsupported protocol version 2"]);
  });

  it("reassembles chunked requests and chunks large responses", async () => {
    const b = await boot();
    const big = "x".repeat(1_200_000);
    b.pages.on(1, "get_text", () => ({ text: big, truncated: false, url: SITE_URL, origin: "https://jobs.example.com" }));
    // Send the request itself in chunks too (small threshold so a tiny request is split).
    const res = await b.host.call("get_text", { pad: "y".repeat(500) }, { threshold: 100, slice: 64 });
    expect(res.text.length).toBe(1_200_000);
    expect(b.host.sent.filter((m) => m.type === "chunk").length).toBeGreaterThan(1);
  });

  it("refuses an oversized chunked transfer with E_TOO_LARGE", async () => {
    const b = await boot();
    b.host.post({ v: 1, type: "chunk", id: "m-big", seq: 0, total: 2, data: "A".repeat(28_000_000) }, { raw: true });
    await settle();
    expect(b.host.responses.at(-1)).toMatchObject({ id: "m-big", type: "response", error: { code: "E_TOO_LARGE" } });
  });

  it("shows the busy badge while a request is in flight", async () => {
    const b = await boot();
    const gate = deferred();
    b.pages.on(1, "get_text", () => gate.promise);
    const p = b.host.call("get_text", {});
    await until(() => b.action.badge.color === "#e8833a");
    expect(b.action.badge.title).toMatch(/acting$/);
    expect((await b.state()).busy).toBe(true);
    gate.resolve({ text: "hi" });
    await p;
    expect(b.action.badge.color).toBe("#2e9e4f");
  });

  it("responds only once when an in-flight request is stopped", async () => {
    const b = await boot();
    const gate = deferred();
    b.pages.on(1, "wait_for", () => gate.promise);
    const p = b.host.request("wait_for", { text: "Done" });
    await until(() => b.pages.sent("wait_for").length);
    await b.ui({ type: "stop" });
    expect((await p).error).toEqual({ code: "E_STOPPED", message: "Stopped by the user" });
    expect(b.pages.sent("cancel").length).toBeGreaterThan(0);
    gate.resolve({ ok: true });
    await settle(50);
    expect(b.host.responses.filter((r) => r.id === "m-1")).toHaveLength(1);
  });
});

describe("events from the host (instruction mode)", () => {
  async function running() {
    const b = await boot({ hostHandlers: { run_start: () => ({ runId: "r1" }) } });
    expect(await b.ui({ type: "run", instruction: "Fill the application" })).toEqual({ ok: true, runId: "r1" });
    return b;
  }

  it("starts a run on the active allowed tab", async () => {
    const b = await running();
    expect(b.host.requests.at(-1)).toMatchObject({ method: "run_start", params: { instruction: "Fill the application", tabId: 1, engine: "auto" } });
    const s = await b.state();
    expect(s.selectedTabId).toBe(1);
    expect(s.run).toMatchObject({ runId: "r1", status: "running", instruction: "Fill the application", tabId: 1 });
    expect(s.log.map((l) => l.text)).toEqual(["Instruction: Fill the application"]);
  });

  it("refuses to run on a site that isn't allowed, or without a tab", async () => {
    const b = await boot({ hostHandlers: { run_start: () => ({ runId: "r1" }) } });
    b.addTab({ id: 2, url: "https://other.example.org/", active: true });
    expect(await b.ui({ type: "run", instruction: "x" })).toEqual({ ok: false, code: "E_SITE_NOT_ALLOWED", error: "Allow Claude on https://other.example.org first." });
    expect(await b.ui({ type: "run", instruction: "x", tabId: 99 })).toEqual({ ok: false, code: "E_NO_TAB", error: "No active tab" });
    expect(await b.ui({ type: "run", instruction: "x", tabId: 1, engine: "rules" })).toEqual({ ok: true, runId: "r1" });
    expect(b.host.requests.at(-1).params.engine).toBe("rules");
  });

  it("follows run_engine, run_log, run_done and run_failed", async () => {
    const b = await running();
    b.host.event("run_engine", { engine: "fm", label: "On-device model", reasons: ["Claude isn't installed", "offline"] });
    b.host.event("run_log", { text: "Filled First Name", kind: "step" });
    b.host.event("run_log", { text: "no kind" });
    await settle();
    let s = await b.state();
    expect(s.run).toMatchObject({ engine: "fm", label: "On-device model" });
    expect(s.log.slice(1).map((l) => [l.kind, l.text])).toEqual([
      ["engine", "Engine: On-device model (Claude isn't installed; offline)"],
      ["step", "Filled First Name"],
      ["info", "no kind"],
    ]);

    b.host.event("run_done", { summary: "Filled 5 fields" });
    await settle();
    s = await b.state();
    expect(s.run).toMatchObject({ status: "done", summary: "Filled 5 fields" });
    expect(b.calls.find(([api, id]) => api === "notifications.create" && id === "cb-run")).toBeTruthy();

    b.host.event("run_failed", { message: "Ran out of steps", offerContinue: true });
    await settle();
    expect((await b.state()).run).toMatchObject({ status: "failed", message: "Ran out of steps", offerContinue: true });
  });

  it("logs events that arrive without a run", async () => {
    const b = await boot();
    b.host.event("run_engine", { engine: "rules", label: "Rules" });
    b.host.event("something_new", {});
    await settle();
    const s = await b.state();
    expect(s.run).toBeNull();
    expect(s.log.map((l) => l.text)).toEqual(["Engine: Rules"]);
  });

  it("keeps the live log to the last 300 lines and shows 200", async () => {
    const b = await boot();
    for (let i = 0; i < 350; i++) b.host.event("run_log", { text: `line ${i}` });
    await settle();
    const { log } = await b.state();
    expect(log).toHaveLength(200);
    expect(log.at(-1).text).toBe("line 349");
  });
});

describe("messages from pages and extension pages", () => {
  it("ignores messages from other extensions and non-objects", async () => {
    const b = await boot();
    expect(await b.send({ type: "stop" }, b.senders.otherExtension)).toBeUndefined();
    expect(await b.send("stop", b.senders.popup)).toBeUndefined();
    expect(await b.send(null, b.senders.popup)).toBeUndefined();
    expect((await b.state()).connected).toBe(true);
  });

  it("doesn't let content scripts use UI messages", async () => {
    const b = await boot();
    for (const type of ["get_state", "stop", "set_auto_approve", "audit_clear", "answer", "profile_get"]) {
      expect(await b.send({ type, enabled: true }, b.senders.content(1))).toBeUndefined();
    }
    expect((await b.state()).autoApprove).toBe(false);
  });

  it("treats an extension page open in a tab as UI, not as a content script", async () => {
    const b = await boot();
    expect(await b.send({ type: "get_state" }, b.senders.sidebarInTab(1))).toMatchObject({ connected: true });
    expect(await b.send({ type: "main", fn: "setValue" }, b.senders.sidebarInTab(1))).toEqual({ ok: false, error: "unknown message main" });
  });

  it("answers unknown UI messages", async () => {
    const b = await boot();
    expect(await b.ui({ type: "nope" })).toEqual({ ok: false, error: "unknown message nope" });
  });

  it("runs main-world helpers in the sender's frame", async () => {
    const b = await boot();
    const r = await b.send({ type: "main", fn: "setValue", nonce: "n-1", args: { text: "Jane" } }, b.senders.content(1, 3));
    expect(r).toEqual({ ok: true, value: "set" });
    const [, opts] = b.calls.findLast(([api]) => api === "executeScript");
    expect(opts).toMatchObject({ target: { tabId: 1, frameIds: [3] }, world: "MAIN", args: ["n-1", { text: "Jane" }] });
    expect(String(opts.func)).toBe(String(mainSetValue)); // a fresh module instance, so compare source
  });

  it("refuses unknown main-world functions and reports script failures", async () => {
    const b = await boot();
    expect(await b.send({ type: "main", fn: "eval", nonce: "n", args: "alert(1)" }, b.senders.content(1))).toEqual({ ok: false, error: "unknown function" });
    b.mainResult = undefined;
    expect(await b.send({ type: "main", fn: "upload", nonce: "n" }, b.senders.content(1))).toEqual({ ok: false, error: "no result" });
    b.scripting.executeScript = async () => {
      throw new Error("Missing host permission for the tab");
    };
    expect(await b.send({ type: "main", fn: "selectOptions", nonce: "n" }, b.senders.content(1))).toEqual({ ok: false, error: "Missing host permission for the tab" });
  });

  it("records blocked submissions", async () => {
    const b = await boot();
    expect(await b.send({ type: "blocked_submit", url: SITE_URL }, b.senders.content(1))).toEqual({ ok: true });
    expect((await b.state()).log.at(-1)).toMatchObject({ kind: "error", text: "Blocked a form submission that wasn't approved" });
    const { entries } = await b.ui({ type: "audit_get" });
    expect(entries.at(-1)).toMatchObject({ url: SITE_URL, action: "submit", target: "form", result: "blocked", approved: false });
  });

  it("stops everything on Esc from the page", async () => {
    const b = await boot();
    const port = b.host.port;
    expect(await b.send({ type: "user_stop" }, b.senders.content(1))).toEqual({ ok: true });
    expect(b.host.events.at(-1)).toMatchObject({ name: "stopped", data: { reason: "Stopped by the user (Esc)" } });
    expect(port.disconnected).toBe(true);
  });

  it("ignores other content-script messages", async () => {
    const b = await boot();
    expect(await b.send({ type: "hello" }, b.senders.content(1))).toBeUndefined();
  });

  it("persists the auto-approve setting", async () => {
    const b = await boot();
    expect(await b.ui({ type: "set_auto_approve", enabled: true })).toEqual({ ok: true });
    expect(b.storage.local.data.autoApprove).toBe(true);
    expect((await b.state()).autoApprove).toBe(true);
    expect((await b.state()).log.at(-1).text).toBe("Auto-approve turned on");
    await b.ui({ type: "set_auto_approve", enabled: "yes" }); // only a real true turns it on
    expect(b.storage.local.data.autoApprove).toBe(false);

    const again = await boot({ storage: { local: { autoApprove: true } } });
    expect((await again.state()).autoApprove).toBe(true);
  });

  it("focuses a tab for the UI", async () => {
    const b = await boot();
    b.addTab({ id: 2, url: SITE_URL, windowId: 7 });
    expect(await b.ui({ type: "focus_tab", tabId: 2 })).toEqual({ ok: true });
    expect(b.calls).toContainEqual(["tabs.update", 2, { active: true }]);
    expect(b.calls).toContainEqual(["windows.update", 7, { focused: true }]);
  });
});

describe("UI ports", () => {
  it("sends state on connect and on every change, and drops broken ports", async () => {
    const b = await boot();
    const port = b.openUiPort();
    expect(port.messages[0]).toMatchObject({ type: "state", state: { connected: true } });
    const other = b.openUiPort("not-ui");
    expect(other.messages).toHaveLength(0);

    await b.ui({ type: "site_changed" });
    expect(port.messages).toHaveLength(2);

    const broken = b.openUiPort();
    broken.postMessage = () => {
      throw new Error("port closed");
    };
    await b.ui({ type: "site_changed" });
    await b.ui({ type: "site_changed" });
    expect(port.messages).toHaveLength(4);

    port.onDisconnect.emit();
    await b.ui({ type: "site_changed" });
    expect(port.messages).toHaveLength(4);
  });

  it("broadcasts when site permissions change", async () => {
    const b = await boot();
    const port = b.openUiPort();
    b.permissions.onAdded.emit({ origins: ["https://x.example/*"] });
    b.permissions.onRemoved.emit({ origins: ["https://x.example/*"] });
    expect(port.messages).toHaveLength(3);
  });
});

describe("audit log", () => {
  it("keeps the newest 500 entries", async () => {
    const old = Array.from({ length: 499 }, (_, i) => ({ time: i, action: "old", target: String(i) }));
    const b = await boot({ storage: { local: { audit: old } } });
    await b.send({ type: "blocked_submit", url: SITE_URL }, b.senders.content(1));
    await b.send({ type: "blocked_submit", url: SITE_URL }, b.senders.content(1));
    const { entries } = await b.ui({ type: "audit_get" });
    expect(entries).toHaveLength(500);
    expect(entries[0].target).toBe("1");
    expect(entries.at(-1).action).toBe("submit");
  });

  it("clears, and starts fresh afterwards", async () => {
    const b = await boot({ storage: { local: { audit: [{ action: "old" }] } } });
    await b.send({ type: "blocked_submit", url: SITE_URL }, b.senders.content(1));
    expect(await b.ui({ type: "audit_clear" })).toEqual({ ok: true });
    expect((await b.ui({ type: "audit_get" })).entries).toEqual([]);
    await b.send({ type: "blocked_submit", url: SITE_URL }, b.senders.content(1));
    expect((await b.ui({ type: "audit_get" })).entries).toHaveLength(1);
  });

  it("tolerates a corrupt stored log", async () => {
    const b = await boot({ storage: { local: { audit: "garbage" } } });
    expect((await b.ui({ type: "audit_get" })).entries).toEqual([]);
    await b.send({ type: "blocked_submit", url: SITE_URL }, b.senders.content(1));
    expect((await b.ui({ type: "audit_get" })).entries).toHaveLength(1);
  });
});

describe("tab lifecycle", () => {
  function withSnapshot(b) {
    b.pages.on(1, "snapshot", () => ({ items: [{ d: 0, t: '- button "Next" [ref=e1]' }], truncated: false, nextRef: 2, newRefs: ["e1"] }));
    b.pages.on(1, "click", () => ({ ok: true, target: "Next" }));
  }

  it("forgets refs and the indicator when the tab starts loading a new page", async () => {
    const b = await boot();
    withSnapshot(b);
    await b.host.call("snapshot", {});
    expect((await b.host.call("click", { ref: "e1" })).ok).toBe(true);
    b.tabs.onUpdated.emit(1, { status: "loading" });
    b.tabs.onUpdated.emit(1, { status: "complete" }); // ignored
    await expect(b.host.call("click", { ref: "e1" })).rejects.toMatchObject({ code: "E_STALE_REF" });
    await b.host.call("snapshot", {});
    expect(b.calls.filter(([api]) => api === "insertCSS")).toHaveLength(2);
  });

  it("releases a tab after 20 s without actions", async () => {
    const b = await boot();
    withSnapshot(b);
    await b.host.call("snapshot", {});
    expect(b.pages.sent("control").map((m) => m.msg.on)).toEqual([true]);
    await settle(19_000);
    await b.host.call("snapshot", {}); // activity resets the timer
    await settle(19_000);
    expect(b.calls.filter(([api]) => api === "removeCSS")).toHaveLength(0);
    await settle(1100);
    expect(b.calls.filter(([api]) => api === "removeCSS")).toHaveLength(1);
    expect(b.pages.sent("control").map((m) => m.msg.on)).toEqual([true, false]);
  });

  it("drops a closed tab's state and approvals, and tells the host", async () => {
    const b = await boot();
    b.pages.on(1, "click", (m) => (m.approved ? { ok: true } : { needsApproval: true, verb: "submit", target: "Submit" }));
    b.pages.on(1, "approve", () => new Promise(() => {}));
    await b.host.call("select_tab", { tabId: 1 });
    b.pages.on(1, "find", () => ({ matches: [{ ref: "e1", role: "button", name: "Submit" }], nextRef: 2, newRefs: ["e1"] }));
    b.host.call("click", { target: { text: "Submit" } }).catch(() => {});
    await until(async () => (await b.state()).approvals.length === 1);
    b._tabs.delete(1);
    b.tabs.onRemoved.emit(1);
    const s = await b.state();
    expect(s.approvals).toEqual([]);
    expect(s.selectedTabId).toBeNull();
    expect(b.host.events.at(-1)).toMatchObject({ name: "tab_closed", data: { tabId: 1 } });
  });

  it("restores refs and the selected tab after the background restarts", async () => {
    const b = await boot();
    withSnapshot(b);
    await b.host.call("select_tab", { tabId: 1 });
    await b.host.call("snapshot", {});
    await settle(250); // persist() is debounced
    expect(b.storage.session.data).toMatchObject({ selectedTabId: 1, tabs: { 1: { refFrames: { e1: 0 }, nextRef: 2, snapshotSeq: 1 } } });

    const fresh = createFakeBrowser({ tabs: [{ id: 1, url: SITE_URL, active: false }], granted: [SITE_PATTERN] });
    const c = await boot({ browser: fresh, storage: { session: b.storage.session.data } });
    withSnapshot(c);
    expect((await c.state()).selectedTabId).toBe(1);
    expect(await c.host.call("click", { ref: "e1" })).toMatchObject({ ok: true, target: "Next" });
    expect((await c.host.call("snapshot", {})).snapshotId).toBe("s2");
  });
});

describe("notifications", () => {
  it("focuses the tab of a pending approval, or opens the sidebar for a question", async () => {
    const b = await boot();
    b.addTab({ id: 2, url: SITE_URL, windowId: 4 });
    b.pages.on(2, "click", (m) => (m.approved ? { ok: true } : { needsApproval: true, verb: "send", target: "Send" }));
    b.pages.on(2, "find", () => ({ matches: [{ ref: "e1", role: "button", name: "Send" }], nextRef: 2, newRefs: ["e1"] }));
    b.pages.on(2, "approve", () => new Promise(() => {}));
    b.host.call("click", { tabId: 2, target: { text: "Send" } }).catch(() => {});
    await until(async () => (await b.state()).approvals.length === 1);
    const [{ id }] = (await b.state()).approvals;

    await b.notifications.onClicked.listeners[0](`cb-${id}`);
    expect(b.calls).toContainEqual(["tabs.update", 2, { active: true }]);
    expect(b.calls).toContainEqual(["windows.update", 4, { focused: true }]);

    await b.notifications.onClicked.listeners[0]("cb-question");
    expect(b.calls).toContainEqual(["sidebarAction.open"]);
    await b.notifications.onClicked.listeners[0]("cb-unknown");
  });
});
