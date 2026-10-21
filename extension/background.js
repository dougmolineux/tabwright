// Background script (SPEC 5.2): owns the native messaging port, routes requests to tabs, enforces the
// site allowlist and the approval gate, shows the badge and tab indicator, and keeps the activity log.
import { Reassembler, chunkMessage, validateMessage } from "./lib/protocol.js";
import { mainSelectOptions, mainSetValue, mainUpload } from "./content/main-world-setter.js";

const HOST_NAME = "claude_bridge";
const CONTENT_FILES = ["content/common.js", "content/refs.js", "content/snapshot.js", "content/approval.js", "content/actions.js"];
const BLOCKED_HOSTS = new Set(["addons.mozilla.org", "accounts.firefox.com", "support.mozilla.org"]);
const MAIN_FUNCS = { setValue: mainSetValue, selectOptions: mainSelectOptions, upload: mainUpload };
const AUDIT_MAX = 500;
const CONTROL_IDLE_MS = 20_000;
const COLORS = { off: "#8a8a8a", on: "#2e9e4f", busy: "#e8833a", error: "#c0392b" };
const INDICATOR_CSS = `
html { outline: 3px solid #d97757 !important; outline-offset: -3px !important; }
html::after { content: "Claude is controlling this tab \\2014  press Esc to stop"; position: fixed !important;
  top: 6px !important; left: 50% !important; transform: translateX(-50%) !important; z-index: 2147483646 !important;
  background: #d97757 !important; color: #fff !important; font: 600 12px/1 -apple-system, BlinkMacSystemFont, sans-serif !important;
  padding: 6px 12px !important; border-radius: 999px !important; pointer-events: none !important;
  box-shadow: 0 2px 8px rgba(0,0,0,.2) !important; white-space: nowrap !important; }`;

class BridgeError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

// ---------- state ----------

const state = {
  port: null,
  connected: false,
  connecting: false,
  error: null,
  userStopped: false,
  reconnectAttempt: 0,
  reconnectTimer: null,
  hostInfo: null,
  busy: 0,
  selectedTabId: null,
  approvals: new Map(), // id -> { id, tabId, verb, target, host }
  question: null, // { id, question, options, resolve, reject, timer }
  run: null, // { runId, engine, label, status, instruction, summary, message, offerContinue }
  log: [], // live step log for the sidebar
};
const inflight = new Map(); // request id -> { method, tabId, responded }
const hostPending = new Map(); // x-N -> { resolve, reject, timer }
const tabs = new Map(); // tabId -> { nextRef, snapshotSeq, refFrames: {}, frames: [], controlled, cssInserted, idleTimer, lastFrameId }
const uiPorts = new Set();
const reassembler = new Reassembler();
let hostSeq = 0;
let auditCache = null;

function tabState(tabId) {
  let st = tabs.get(tabId);
  if (!st) {
    st = { nextRef: 1, snapshotSeq: 0, refFrames: {}, frames: [], controlled: false, cssInserted: false, idleTimer: null, lastFrameId: 0 };
    tabs.set(tabId, st);
  }
  return st;
}

let persistTimer = null;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const t = {};
    for (const [id, st] of tabs) t[id] = { nextRef: st.nextRef, snapshotSeq: st.snapshotSeq, refFrames: st.refFrames, frames: st.frames, lastFrameId: st.lastFrameId };
    browser.storage.session.set({ selectedTabId: state.selectedTabId, tabs: t }).catch(() => {});
  }, 200);
}

async function restore() {
  try {
    const saved = await browser.storage.session.get(["selectedTabId", "tabs"]);
    state.selectedTabId = saved.selectedTabId ?? null;
    for (const [id, s] of Object.entries(saved.tabs ?? {})) Object.assign(tabState(Number(id)), s);
  } catch {
    /* fresh start */
  }
}
const restored = restore();

// ---------- badge and UI ----------

function updateBadge() {
  const color = state.busy > 0 ? COLORS.busy : state.connected ? COLORS.on : state.error ? COLORS.error : COLORS.off;
  browser.action.setBadgeBackgroundColor({ color }).catch(() => {});
  browser.action.setBadgeText({ text: state.connected || state.error ? " " : "" }).catch(() => {});
  browser.action
    .setTitle({ title: `Firefox Bridge for Claude Code: ${state.busy ? "acting" : state.connected ? "connected" : state.error ? state.error : "disconnected"}` })
    .catch(() => {});
}

function publicState() {
  return {
    connected: state.connected,
    connecting: state.connecting,
    error: state.error,
    busy: state.busy > 0,
    selectedTabId: state.selectedTabId,
    hostInfo: state.hostInfo,
    approvals: [...state.approvals.values()],
    question: state.question ? { id: state.question.id, question: state.question.question, options: state.question.options } : null,
    run: state.run,
    log: state.log.slice(-200),
  };
}

function broadcast() {
  updateBadge();
  const s = publicState();
  for (const p of uiPorts) {
    try {
      p.postMessage({ type: "state", state: s });
    } catch {
      uiPorts.delete(p);
    }
  }
}

function addLog(text, kind = "step") {
  state.log.push({ time: Date.now(), text, kind });
  if (state.log.length > 300) state.log.splice(0, state.log.length - 300);
  broadcast();
}

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== "ui") return;
  uiPorts.add(port);
  port.onDisconnect.addListener(() => uiPorts.delete(port));
  port.postMessage({ type: "state", state: publicState() });
});

// ---------- audit log (SPEC 8.6) ----------

async function audit(entry) {
  if (!auditCache) {
    const { audit: saved } = await browser.storage.local.get("audit");
    auditCache = Array.isArray(saved) ? saved : [];
  }
  auditCache.push({ time: Date.now(), ...entry });
  if (auditCache.length > AUDIT_MAX) auditCache.splice(0, auditCache.length - AUDIT_MAX);
  await browser.storage.local.set({ audit: auditCache });
}

// ---------- native messaging ----------

function sendNative(msg) {
  if (!state.port) return false;
  for (const part of chunkMessage(msg)) state.port.postMessage(part);
  return true;
}

function connect() {
  if (state.port) return;
  clearTimeout(state.reconnectTimer);
  state.userStopped = false;
  state.connecting = true;
  state.error = null;
  let port;
  try {
    port = browser.runtime.connectNative(HOST_NAME);
  } catch (err) {
    state.connecting = false;
    state.error = `Couldn't start the native host: ${err.message}`;
    broadcast();
    return;
  }
  state.port = port;
  port.onMessage.addListener(onNativeMessage);
  port.onDisconnect.addListener((p) => {
    const why = p.error?.message;
    if (state.port !== port) return;
    state.port = null;
    state.connected = false;
    state.connecting = false;
    state.hostInfo = null;
    failAllInflight("E_NOT_CONNECTED", "The native host disconnected");
    for (const [, h] of hostPending) {
      clearTimeout(h.timer);
      h.reject(new BridgeError("E_NOT_CONNECTED", "The native host disconnected"));
    }
    hostPending.clear();
    if (state.run && state.run.status === "running") Object.assign(state.run, { status: "failed", message: "Disconnected", offerContinue: false });
    if (!state.userStopped) {
      state.error = why ? `Native host: ${why}` : "Native host exited";
      scheduleReconnect();
    } else {
      state.error = null;
    }
    broadcast();
  });
  hostCall("host_info", {}, 10_000)
    .then((info) => {
      state.hostInfo = info;
      state.connected = true;
      state.connecting = false;
      state.reconnectAttempt = 0;
      state.error = null;
      broadcast();
    })
    .catch((err) => {
      state.connecting = false;
      state.error = err.message;
      broadcast();
    });
  broadcast();
}

function scheduleReconnect() {
  if (state.reconnectAttempt >= 8) {
    state.error = `${state.error ?? "Disconnected"}. Gave up reconnecting; click Connect to retry.`;
    return;
  }
  const delay = Math.min(30_000, 1000 * 2 ** state.reconnectAttempt++);
  state.reconnectTimer = setTimeout(() => {
    if (!state.userStopped && !state.port) connect();
  }, delay);
}

function disconnect() {
  state.userStopped = true;
  clearTimeout(state.reconnectTimer);
  const port = state.port;
  state.port = null;
  state.connected = false;
  state.connecting = false;
  state.hostInfo = null;
  state.error = null;
  try {
    port?.disconnect();
  } catch {
    /* already gone */
  }
  broadcast();
}

function waitConnected(timeoutMs = 8000) {
  if (state.connected) return Promise.resolve();
  if (!state.port) connect();
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (state.connected) {
        clearInterval(iv);
        resolve();
      } else if (!state.port || Date.now() - start > timeoutMs) {
        clearInterval(iv);
        reject(new BridgeError("E_NOT_CONNECTED", state.error || "Couldn't connect to the native host. Is it installed (scripts/install.sh)?"));
      }
    }, 100);
  });
}

function hostCall(method, params = {}, timeoutMs = 30_000) {
  const id = `x-${++hostSeq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      hostPending.delete(id);
      reject(new BridgeError("E_TIMEOUT", `${method} timed out`));
    }, timeoutMs);
    hostPending.set(id, { resolve, reject, timer });
    if (!sendNative({ v: 1, id, type: "request", method, params })) {
      clearTimeout(timer);
      hostPending.delete(id);
      reject(new BridgeError("E_NOT_CONNECTED", "Not connected to the native host"));
    }
  });
}

function onNativeMessage(raw) {
  const problem = validateMessage(raw);
  if (problem) {
    console.warn("claude-bridge: invalid message", problem);
    return;
  }
  let msg = raw;
  if (raw.type === "chunk") {
    try {
      msg = reassembler.add(raw);
    } catch (err) {
      sendNative({ v: 1, id: raw.id, type: "response", error: { code: err.code || "E_TOO_LARGE", message: err.message } });
      return;
    }
    if (!msg) return;
  }
  if (msg.type === "request") {
    handleRequest(msg);
  } else if (msg.type === "response") {
    const p = hostPending.get(msg.id);
    if (!p) return;
    hostPending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new BridgeError(msg.error.code, msg.error.message, msg.error.data));
    else p.resolve(msg.result);
  } else if (msg.type === "event") {
    onHostEvent(msg);
  }
}

function respond(id, result, error) {
  const entry = inflight.get(id);
  if (entry?.responded) return;
  if (entry) entry.responded = true;
  sendNative(error ? { v: 1, id, type: "response", error } : { v: 1, id, type: "response", result: result ?? { ok: true } });
}

function failAllInflight(code, message) {
  for (const [id, entry] of inflight) {
    if (!entry.responded) respond(id, null, { code, message });
  }
}

async function handleRequest(msg) {
  await restored;
  const handler = METHODS[msg.method];
  const entry = { method: msg.method, responded: false };
  inflight.set(msg.id, entry);
  state.busy++;
  updateBadge();
  try {
    if (!handler) throw new BridgeError("E_INTERNAL", `Unknown method ${msg.method}`);
    const result = await handler(msg.params ?? {}, entry);
    respond(msg.id, result);
  } catch (err) {
    const error = { code: err.code || "E_INTERNAL", message: String(err.message ?? err) };
    if (err.data !== undefined) error.data = err.data;
    respond(msg.id, null, error);
  } finally {
    inflight.delete(msg.id);
    state.busy = Math.max(0, state.busy - 1);
    updateBadge();
  }
}

// ---------- events from the host (instruction mode) ----------

function onHostEvent(msg) {
  const d = msg.data ?? {};
  const run = state.run;
  switch (msg.name) {
    case "run_engine":
      if (run) Object.assign(run, { engine: d.engine, label: d.label });
      addLog(`Engine: ${d.label}${d.reasons?.length ? ` (${d.reasons.join("; ")})` : ""}`, "engine");
      break;
    case "run_log":
      addLog(d.text, d.kind || "info");
      break;
    case "run_done":
      if (run) Object.assign(run, { status: "done", summary: d.summary });
      addLog("Finished", "done");
      notify("run", "Claude finished", "The instruction is done. Review the page before submitting.");
      break;
    case "run_failed":
      if (run) Object.assign(run, { status: "failed", message: d.message, offerContinue: !!d.offerContinue });
      addLog(d.message, "error");
      break;
    default:
      break;
  }
  broadcast();
}

// ---------- tabs, permissions, content scripts ----------

function originOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

function isBlockedUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return true;
    return BLOCKED_HOSTS.has(u.hostname);
  } catch {
    return true;
  }
}

/** Match pattern for a page's site. Firefox match patterns can't contain a port, so it is dropped. */
function patternFor(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? `${u.protocol}//${u.hostname}/*` : null;
  } catch {
    return null;
  }
}

async function isAllowedUrl(url) {
  if (isBlockedUrl(url)) return false;
  const pattern = patternFor(url);
  return pattern ? browser.permissions.contains({ origins: [pattern] }) : false;
}

async function assertAllowed(tab) {
  if (isBlockedUrl(tab.url)) {
    throw new BridgeError("E_SITE_NOT_ALLOWED", `Claude can't be used on ${tab.url.split("?")[0]} (browser and account pages are always blocked).`, { url: tab.url });
  }
  const origin = originOf(tab.url);
  if (!(await isAllowedUrl(tab.url))) {
    throw new BridgeError(
      "E_SITE_NOT_ALLOWED",
      `Claude isn't allowed on ${origin}. Ask the user to open the Firefox Bridge for Claude Code popup on that tab and click "Allow on this site".`,
      { origin },
    );
  }
  return origin;
}

async function resolveTab(params) {
  let tab = null;
  const id = params.tabId ?? state.selectedTabId;
  if (id != null) tab = await browser.tabs.get(id).catch(() => null);
  if (!tab && params.tabId != null) throw new BridgeError("E_NO_TAB", `No tab with id ${params.tabId}`);
  if (!tab) [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new BridgeError("E_NO_TAB", "No active tab");
  return tab;
}

async function toFrame(tabId, frameId, msg) {
  const res = await browser.tabs.sendMessage(tabId, { to: "content", ...msg }, { frameId });
  if (!res) throw new BridgeError("E_INTERNAL", "No response from the page");
  if (!res.ok) throw new BridgeError(res.error.code, res.error.message, res.error.data);
  return res.result;
}

async function ensureContent(tabId, frameId = 0) {
  try {
    const pong = await toFrame(tabId, frameId, { cmd: "ping" });
    if (pong?.ok) return pong;
  } catch {
    /* not injected yet */
  }
  await browser.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: CONTENT_FILES });
  return toFrame(tabId, frameId, { cmd: "ping" });
}

/** Marks a tab as driven: indicator stylesheet, Esc-to-stop, idle timeout. */
async function control(tab) {
  const st = tabState(tab.id);
  clearTimeout(st.idleTimer);
  if (!st.cssInserted) {
    st.cssInserted = true;
    await browser.scripting.insertCSS({ target: { tabId: tab.id }, css: INDICATOR_CSS }).catch(() => (st.cssInserted = false));
  }
  if (!st.controlled) {
    st.controlled = true;
    await toFrame(tab.id, 0, { cmd: "control", on: true }).catch(() => {});
  }
  st.idleTimer = setTimeout(() => release(tab.id), CONTROL_IDLE_MS);
}

async function release(tabId) {
  const st = tabs.get(tabId);
  if (!st) return;
  clearTimeout(st.idleTimer);
  if (st.cssInserted) {
    st.cssInserted = false;
    await browser.scripting.removeCSS({ target: { tabId }, css: INDICATOR_CSS }).catch(() => {});
  }
  if (st.controlled) {
    st.controlled = false;
    await toFrame(tabId, 0, { cmd: "control", on: false }).catch(() => {});
  }
}

/** Common preamble for anything that reads or acts on a page. */
async function pageContext(params) {
  const tab = await resolveTab(params);
  const origin = await assertAllowed(tab);
  await ensureContent(tab.id, 0);
  await control(tab);
  return { tab, origin, st: tabState(tab.id) };
}

function recordRefs(st, frameId, res) {
  if (typeof res?.nextRef === "number") st.nextRef = Math.max(st.nextRef, res.nextRef);
  for (const r of res?.newRefs ?? []) st.refFrames[r] = frameId;
  persist();
}

/** Finds the frame for a ref, or resolves a { label | text } target to a ref. */
async function resolveTarget(ctx, params) {
  const { tab, st } = ctx;
  if (params.ref) {
    const frameId = st.refFrames[params.ref];
    if (frameId === undefined) throw new BridgeError("E_STALE_REF", `Unknown ref ${params.ref}. Take a new snapshot.`);
    if (frameId !== 0) await ensureContent(tab.id, frameId);
    st.lastFrameId = frameId;
    return { frameId, ref: params.ref };
  }
  const target = params.target ?? {};
  if (!target.label && !target.text) throw new BridgeError("E_INTERNAL", "Provide ref or target");
  const matches = [];
  for (const frameId of [0, ...st.frames]) {
    try {
      const res = await toFrame(tab.id, frameId, { cmd: "find", label: target.label, text: target.label ? undefined : target.text, nextRef: st.nextRef });
      recordRefs(st, frameId, res);
      for (const m of res.matches) matches.push({ ...m, frameId });
    } catch {
      /* frame gone */
    }
  }
  const what = target.label ? `label "${target.label}"` : `text "${target.text}"`;
  if (matches.length === 0) throw new BridgeError("E_NOT_INTERACTABLE", `Nothing on the page matches ${what}. Take a snapshot to find it.`);
  if (matches.length > 1) {
    throw new BridgeError("E_AMBIGUOUS", `${matches.length} elements match ${what}; use a ref.`, {
      origin: ctx.origin,
      candidates: matches.map(({ ref, role, name }) => ({ ref, role, name })),
    });
  }
  st.lastFrameId = matches[0].frameId;
  return { frameId: matches[0].frameId, ref: matches[0].ref };
}

function waitForTabComplete(tabId, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    let timer;
    const done = (tab) => {
      browser.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve(tab);
    };
    const listener = (id, info, tab) => {
      if (id === tabId && info.status === "complete") done(tab);
    };
    browser.tabs.onUpdated.addListener(listener);
    timer = setTimeout(async () => done(await browser.tabs.get(tabId).catch(() => null)), timeoutMs);
    browser.tabs.get(tabId).then((t) => {
      if (t.status === "complete" && !t.url?.startsWith("about:blank")) {
        // Give a just-started navigation a moment to flip to "loading".
        setTimeout(async () => {
          const again = await browser.tabs.get(tabId).catch(() => null);
          if (again?.status === "complete") done(again);
        }, 300);
      }
    }).catch(() => done(null));
  });
}

const DISCONNECT_RE = /disconnect|receiving end|message manager|context|unloaded|could not establish|actor|destroyed/i;

/**
 * Sends an action to a frame. If the page navigates away mid-action the content script dies; that
 * counts as success with navigated=true.
 */
async function actInFrame(ctx, frameId, msg) {
  try {
    const res = await toFrame(ctx.tab.id, frameId, msg);
    // SPEC 6.5: don't return while a navigation is pending.
    if (res?.navigated) {
      const tab = await waitForTabComplete(ctx.tab.id, 5000);
      if (tab?.url) res.url = tab.url;
    }
    return res;
  } catch (err) {
    if (!err.code && DISCONNECT_RE.test(err.message)) {
      const tab = await waitForTabComplete(ctx.tab.id, 5000);
      return { ok: true, navigated: true, snapshotStale: true, url: tab?.url };
    }
    throw err;
  }
}

// ---------- approval gate (SPEC 8.2) ----------

let approvalSeq = 0;

function notify(id, title, message) {
  browser.notifications.create(`cb-${id}`, { type: "basic", iconUrl: browser.runtime.getURL("icons/96.png"), title, message }).catch(() => {});
}

async function requestApproval(ctx, frameId, ref, info, timeoutMs, entry) {
  const host = new URL(ctx.tab.url).hostname;
  const id = `a-${++approvalSeq}`;
  const approval = { id, tabId: ctx.tab.id, verb: info.verb, target: info.target, host, reason: info.reason };
  state.approvals.set(id, approval);
  entry.approvalId = id;
  addLog(`Waiting for your approval: ${info.target}`, "approval");
  notify(id, "Claude needs your approval", `Claude wants to ${info.verb} "${info.target}" on ${host}. Approve it in the page.`);
  if (ref) await toFrame(ctx.tab.id, frameId, { cmd: "highlight", ref, on: true }).catch(() => {});
  let decision;
  try {
    await ensureContent(ctx.tab.id, 0);
    const timeout = Math.min(Math.max(Number(timeoutMs) || 120_000, 10_000), 600_000);
    ({ decision } = await toFrame(ctx.tab.id, 0, { cmd: "approve", verb: info.verb, target: info.target, host, timeoutMs: timeout }));
  } catch (err) {
    decision = err.code === "E_STOPPED" ? "cancelled" : "gone";
  } finally {
    state.approvals.delete(id);
    browser.notifications.clear(`cb-${id}`).catch(() => {});
    if (ref) toFrame(ctx.tab.id, frameId, { cmd: "highlight", ref, on: false }).catch(() => {});
    broadcast();
  }
  const auditBase = { url: ctx.tab.url, action: "approval", target: info.target };
  if (decision === "allow") {
    addLog(`You approved: ${info.target}`, "approval");
    audit({ ...auditBase, result: "allowed", approved: true });
    return;
  }
  audit({ ...auditBase, result: decision, approved: false });
  if (decision === "deny") throw new BridgeError("E_APPROVAL_DENIED", `User declined: ${info.target}`);
  if (decision === "timeout") throw new BridgeError("E_APPROVAL_TIMEOUT", `No approval within ${Math.round(timeoutMs / 1000)} s: ${info.target}`);
  if (decision === "cancelled") throw new BridgeError("E_STOPPED", "Stopped by the user");
  throw new BridgeError("E_APPROVAL_DENIED", `The page changed before approval: ${info.target}`);
}

/** Runs an action; if the content script says it needs approval, asks the user, then runs it approved. */
async function gatedAction(ctx, frameId, msg, params, entry) {
  let res = await actInFrame(ctx, frameId, msg);
  if (res?.needsApproval) {
    await requestApproval(ctx, frameId, msg.ref, res, params.approvalTimeoutMs, entry);
    res = await actInFrame(ctx, frameId, { ...msg, approved: true });
    if (res?.needsApproval) throw new BridgeError("E_INTERNAL", "Action still needs approval after approval");
    res.approved = true;
  }
  return res;
}

// ---------- logging helper for actions ----------

function short(s, n = 40) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

async function logged(ctx, action, target, fn, describe, auditDetail) {
  try {
    const res = await fn();
    if (describe) addLog(describe(res));
    audit({ url: ctx.tab.url, action, target: res?.target ?? target, result: "ok", approved: res?.approved ?? null, ...(auditDetail ? auditDetail(res) : {}) });
    return res;
  } catch (err) {
    addLog(`Couldn't ${action} ${short(target || "", 60)}: ${err.message}`, "error");
    audit({ url: ctx.tab.url, action, target, result: err.code || "E_INTERNAL", approved: null });
    throw err;
  }
}

function withOrigin(ctx, res) {
  const { nextRef, newRefs, ...rest } = res ?? {};
  return { ...rest, origin: ctx.origin };
}

// ---------- snapshots ----------

const indent = (d) => "  ".repeat(d);

async function snapshotFrame(ctx, frameId, opts, baseDepth, level) {
  const { tab, st } = ctx;
  const res = await toFrame(tab.id, frameId, { cmd: "snapshot", ...opts, nextRef: st.nextRef });
  recordRefs(st, frameId, res);
  const lines = [];
  let truncated = res.truncated;
  for (const item of res.items) {
    const d = baseDepth + item.d;
    if (item.frameId === undefined) {
      lines.push(indent(d) + item.t);
      continue;
    }
    const srcOrigin = originOf(item.src) ?? "about:blank";
    const label = item.title ? ` ${JSON.stringify(item.title)}` : "";
    if (level >= 3) {
      lines.push(`${indent(d)}- frame${label} (nested too deep)`);
      continue;
    }
    let child;
    try {
      const pong = await ensureContent(tab.id, item.frameId);
      if (pong.origin && pong.origin !== "null" && !(await isAllowedUrl(pong.url))) throw new Error("not allowed");
      if (!st.frames.includes(item.frameId)) st.frames.push(item.frameId);
      child = await snapshotFrame(ctx, item.frameId, { ...opts, root: undefined }, d + 1, level + 1);
      lines.push(`${indent(d)}- frame${label} (${pong.origin})`);
      lines.push(...child.lines);
      truncated ||= child.truncated;
    } catch {
      lines.push(`${indent(d)}- frame${label} (not allowed: ${srcOrigin})`);
    }
  }
  return { lines, truncated };
}

// ---------- methods ----------

const httpUrl = (url) => {
  const o = originOf(url);
  if (!o) throw new BridgeError("E_INTERNAL", "Only http and https URLs can be opened");
  return url;
};

const METHODS = {
  async status() {
    const info = await browser.runtime.getBrowserInfo();
    const perms = await browser.permissions.getAll();
    const sel = state.selectedTabId != null ? await browser.tabs.get(state.selectedTabId).catch(() => null) : null;
    return {
      firefoxVersion: info.version,
      extensionVersion: browser.runtime.getManifest().version,
      allowedSites: (perms.origins ?? []).filter((o) => o !== "<all_urls>").map((o) => o.replace(/\/\*$/, "")),
      selectedTab: sel ? { id: sel.id, title: sel.title, url: sel.url } : null,
    };
  },

  async list_tabs() {
    const all = await browser.tabs.query({});
    const out = [];
    for (const t of all) {
      out.push({ id: t.id, windowId: t.windowId, title: t.title, url: t.url, active: t.active, selected: t.id === state.selectedTabId, allowed: await isAllowedUrl(t.url ?? "") });
    }
    return { tabs: out };
  },

  async select_tab(p) {
    const tab = await browser.tabs.get(p.tabId).catch(() => null);
    if (!tab) throw new BridgeError("E_NO_TAB", `No tab with id ${p.tabId}`);
    await browser.tabs.update(tab.id, { active: true });
    await browser.windows.update(tab.windowId, { focused: true }).catch(() => {});
    state.selectedTabId = tab.id;
    persist();
    broadcast();
    return { ok: true, tabId: tab.id, title: tab.title, url: tab.url, allowed: await isAllowedUrl(tab.url) };
  },

  async open_tab(p) {
    const url = httpUrl(p.url);
    if (isBlockedUrl(url)) throw new BridgeError("E_SITE_NOT_ALLOWED", `Claude can't open ${new URL(url).hostname}`);
    const tab = await browser.tabs.create({ url, active: true });
    state.selectedTabId = tab.id;
    persist();
    const done = await waitForTabComplete(tab.id, 30_000);
    addLog(`Opened ${short(url, 80)}`);
    audit({ url, action: "open_tab", target: url, result: "ok", approved: null });
    return { ok: true, tabId: tab.id, url: done?.url ?? url, allowed: await isAllowedUrl(done?.url ?? url) };
  },

  async navigate(p, entry) {
    const tab = await resolveTab(p);
    if (p.url) {
      httpUrl(p.url);
      if (isBlockedUrl(p.url)) throw new BridgeError("E_SITE_NOT_ALLOWED", `Claude can't open ${new URL(p.url).hostname}`);
      if (urlNeedsApproval(p.url)) {
        if (!(await isAllowedUrl(tab.url))) {
          throw new BridgeError("E_APPROVAL_DENIED", `Opening ${p.url} needs the user's approval, which can only be shown on an allowed page.`);
        }
        const ctx = { tab, origin: originOf(tab.url), st: tabState(tab.id) };
        await ensureContent(tab.id, 0);
        await requestApproval(ctx, 0, null, { verb: "open", target: p.url, reason: "URL looks like a submit/confirm/pay/delete action" }, p.approvalTimeoutMs, entry);
      }
      await browser.tabs.update(tab.id, { url: p.url });
    } else if (p.action === "back") await browser.tabs.goBack(tab.id);
    else if (p.action === "forward") await browser.tabs.goForward(tab.id);
    else if (p.action === "reload") await browser.tabs.reload(tab.id);
    else throw new BridgeError("E_INTERNAL", "Provide url or action");
    const done = await waitForTabComplete(tab.id, 30_000);
    const url = done?.url ?? tab.url;
    addLog(p.url ? `Opened ${short(url, 80)}` : `Went ${p.action}`);
    audit({ url, action: "navigate", target: p.url ?? p.action, result: "ok", approved: null });
    return { ok: true, url, title: done?.title, allowed: await isAllowedUrl(url) };
  },

  async snapshot(p) {
    const ctx = await pageContext(p);
    const { st } = ctx;
    const limit = Math.max(2000, Number(p.charLimit) || 25_000);
    let frameId = 0;
    if (p.root) {
      frameId = st.refFrames[p.root];
      if (frameId === undefined) throw new BridgeError("E_STALE_REF", `Unknown ref ${p.root}. Take a new snapshot.`);
      if (frameId !== 0) await ensureContent(ctx.tab.id, frameId);
    }
    const out = await snapshotFrame(ctx, frameId, { root: p.root, includeText: p.includeText !== false, charLimit: limit }, 0, 0);
    let text = out.lines.join("\n");
    let truncated = out.truncated;
    if (text.length > limit) {
      text = text.slice(0, text.lastIndexOf("\n", limit));
      truncated = true;
    }
    const snapshotId = `s${++st.snapshotSeq}`;
    persist();
    return { snapshotId, title: ctx.tab.title, url: ctx.tab.url, origin: ctx.origin, text, truncated };
  },

  async screenshot(p) {
    let tab = await resolveTab(p);
    await assertAllowed(tab);
    let activated = false;
    if (!tab.active) {
      await browser.tabs.update(tab.id, { active: true });
      activated = true;
    }
    await browser.windows.update(tab.windowId, { focused: true }).catch(() => {});
    if (activated) await new Promise((r) => setTimeout(r, 350));
    let note;
    let rect = null;
    if (p.ref) {
      const ctx = await pageContext({ tabId: tab.id });
      const { frameId, ref } = await resolveTarget(ctx, p);
      if (frameId !== 0) note = "The element is inside a frame; returning the whole visible area.";
      else rect = await toFrame(tab.id, 0, { cmd: "rect", ref });
    }
    let dataUrl;
    try {
      dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 70 });
    } catch (err) {
      // Firefox only allows capture with <all_urls> or activeTab, which the user grants by clicking the
      // toolbar button on the tab (it lasts until the tab navigates). A site grant alone isn't enough.
      if (/activeTab|permission/i.test(err.message)) {
        throw new BridgeError(
          "E_SITE_NOT_ALLOWED",
          "Firefox needs the user to click the Firefox Bridge for Claude Code toolbar button on this tab before Claude can take a screenshot of it (once per page load). Ask them to, or use browser_snapshot instead.",
        );
      }
      throw err;
    }
    let data = dataUrl.slice(dataUrl.indexOf(",") + 1);
    if (rect && rect.width > 0 && rect.height > 0) {
      data = await cropJpeg(dataUrl, rect);
    }
    audit({ url: tab.url, action: "screenshot", target: p.ref ?? "viewport", result: "ok", approved: null });
    return { data, mimeType: "image/jpeg", activated, ...(note ? { note } : {}) };
  },

  async get_text(p) {
    const ctx = await pageContext(p);
    let frameId = 0;
    if (p.ref) frameId = (await resolveTarget(ctx, p)).frameId;
    const res = await toFrame(ctx.tab.id, frameId, { cmd: "get_text", ref: p.ref });
    return { text: res.text, truncated: res.truncated, url: res.url, origin: res.origin };
  },

  async click(p, entry) {
    const ctx = await pageContext(p);
    const { frameId, ref } = await resolveTarget(ctx, p);
    const res = await logged(ctx, "click", ref, () => gatedAction(ctx, frameId, { cmd: "click", ref }, p, entry), (r) => `Clicked ${short(r.target ?? ref, 60)}`);
    if (res.blockedSubmit) notify("blocked", "Submission blocked", "A form submission without your approval was blocked.");
    return withOrigin(ctx, res);
  },

  async type(p) {
    const ctx = await pageContext(p);
    const { frameId, ref } = await resolveTarget(ctx, p);
    const res = await logged(
      ctx, "type", ref,
      () => actInFrame(ctx, frameId, { cmd: "type", ref, text: p.text, clear: p.clear !== false, perKey: !!p.perKey }),
      (r) => `Typed ${short(p.text)} into ${short(r.target ?? ref, 60)}`,
      () => ({ detail: `${String(p.text ?? "").length} characters` }),
    );
    return withOrigin(ctx, res);
  },

  async select(p) {
    const ctx = await pageContext(p);
    const { frameId, ref } = await resolveTarget(ctx, p);
    const res = await logged(
      ctx, "select", ref,
      () => actInFrame(ctx, frameId, { cmd: "select", ref, option: p.option, options: p.options }),
      (r) => `Selected ${short((r.selected ?? []).join(", "))} in ${short(r.target ?? ref, 60)}`,
    );
    return withOrigin(ctx, res);
  },

  async check(p, entry) {
    const ctx = await pageContext(p);
    const { frameId, ref } = await resolveTarget(ctx, p);
    const res = await logged(
      ctx, "check", ref,
      () => gatedAction(ctx, frameId, { cmd: "check", ref, checked: !!p.checked }, p, entry),
      (r) => `${r.checked ? "Checked" : "Unchecked"} ${short(r.target ?? ref, 60)}`,
    );
    return withOrigin(ctx, res);
  },

  async upload(p) {
    const ctx = await pageContext(p);
    const { frameId, ref } = await resolveTarget(ctx, p);
    const res = await logged(
      ctx, "upload", ref,
      () => actInFrame(ctx, frameId, { cmd: "upload", ref, fileName: p.fileName, mimeType: p.mimeType, base64: p.base64 }),
      (r) => `Uploaded ${r.fileName} to ${short(r.target ?? ref, 60)}`,
      (r) => ({ detail: `${r.fileName}, ${r.size} bytes` }),
    );
    return withOrigin(ctx, res);
  },

  async press_key(p, entry) {
    const ctx = await pageContext(p);
    const frameId = ctx.st.lastFrameId ?? 0;
    if (frameId !== 0) await ensureContent(ctx.tab.id, frameId);
    const res = await logged(ctx, "press_key", p.key, () => gatedAction(ctx, frameId, { cmd: "press_key", key: p.key }, p, entry), () => `Pressed ${p.key}`);
    return withOrigin(ctx, res);
  },

  async scroll(p) {
    const ctx = await pageContext(p);
    let frameId = 0;
    let ref;
    if (p.ref || p.target) ({ frameId, ref } = await resolveTarget(ctx, p));
    return withOrigin(ctx, await toFrame(ctx.tab.id, frameId, { cmd: "scroll", ref, direction: p.direction, amount: p.amount }));
  },

  async wait_for(p, entry) {
    const ctx = await pageContext(p);
    let frameId = 0;
    if (p.ref) frameId = (await resolveTarget(ctx, p)).frameId;
    entry.cancel = () => toFrame(ctx.tab.id, frameId, { cmd: "cancel" }).catch(() => {});
    return withOrigin(ctx, await toFrame(ctx.tab.id, frameId, { cmd: "wait_for", text: p.text, textGone: p.textGone, ref: p.ref, timeoutMs: p.timeoutMs }));
  },

  async fill_form(p) {
    const ctx = await pageContext(p);
    const fields = Array.isArray(p.fields) ? p.fields : [];
    const results = [];
    for (const f of fields) {
      let frameId;
      try {
        ({ frameId } = await resolveTarget(ctx, { ref: f.ref }));
        const res = await logged(
          ctx, "fill", f.ref,
          () => actInFrame(ctx, frameId, { cmd: "fill_field", ref: f.ref, value: f.value, nextRef: ctx.st.nextRef }),
          (r) => (r.selected ? `Selected ${short(r.selected.join(", "))} in ${short(r.target, 60)}` : typeof r.checked === "boolean" ? `${r.checked ? "Checked" : "Unchecked"} ${short(r.target, 60)}` : `Typed ${short(f.value)} into ${short(r.target, 60)}`),
          () => ({ detail: typeof f.value === "string" ? `${f.value.length} characters` : String(f.value) }),
        );
        recordRefs(ctx.st, frameId, res);
        const { nextRef, newRefs, ...rest } = res;
        results.push({ ref: f.ref, ...rest });
      } catch (err) {
        results.push({ ref: f.ref, ok: false, error: { code: err.code || "E_INTERNAL", message: err.message } });
        break; // stop at the first error
      }
    }
    return { ok: results.length === fields.length && results.every((r) => r.ok !== false), results, origin: ctx.origin };
  },

  async form_fields(p) {
    const ctx = await pageContext(p);
    const { tab, st } = ctx;
    const res = await toFrame(tab.id, 0, { cmd: "form_fields", nextRef: st.nextRef });
    recordRefs(st, 0, res);
    const fields = res.fields.map((f) => ({ ...f, frameId: 0 }));
    for (const frameId of res.frames) {
      try {
        const pong = await ensureContent(tab.id, frameId);
        if (!(await isAllowedUrl(pong.url))) continue;
        const sub = await toFrame(tab.id, frameId, { cmd: "form_fields", nextRef: st.nextRef });
        recordRefs(st, frameId, sub);
        if (!st.frames.includes(frameId)) st.frames.push(frameId);
        fields.push(...sub.fields.map((f) => ({ ...f, frameId })));
      } catch {
        /* frame not allowed */
      }
    }
    return { fields, origin: ctx.origin };
  },

  async annotate(p) {
    const ctx = await pageContext(p);
    const { frameId, ref } = await resolveTarget(ctx, p);
    return toFrame(ctx.tab.id, frameId, { cmd: "annotate", ref, note: p.note });
  },

  async ask_user(p, entry) {
    if (state.question) state.question.reject(new BridgeError("E_STOPPED", "Replaced by a newer question"));
    const question = String(p.question ?? "").slice(0, 1000);
    const options = Array.isArray(p.options) ? p.options.slice(0, 20).map(String) : [];
    addLog(`Question: ${question}`, "question");
    notify("question", "Claude has a question", `${question.slice(0, 180)} (answer in the Claude sidebar)`);
    const answer = await new Promise((resolve, reject) => {
      const q = { id: `q-${Date.now()}`, question, options, resolve, reject };
      q.timer = setTimeout(() => reject(new BridgeError("E_TIMEOUT", "The user didn't answer within 10 minutes")), 10 * 60_000);
      state.question = q;
      entry.cancel = () => reject(new BridgeError("E_STOPPED", "Stopped by the user"));
      broadcast();
    }).finally(() => {
      clearTimeout(state.question?.timer);
      state.question = null;
      browser.notifications.clear("cb-question").catch(() => {});
      broadcast();
    });
    addLog(`You answered: ${short(answer, 80)}`, "question");
    return { answer };
  },
};

function urlNeedsApproval(url) {
  try {
    return /\/(submit|confirm|checkout|pay|delete)(\/|$|\.|\?)/i.test(new URL(url).pathname + "/");
  } catch {
    return false;
  }
}

async function cropJpeg(dataUrl, rect) {
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  const scale = bmp.width / rect.viewportWidth;
  const sx = Math.max(0, Math.floor(rect.x * scale));
  const sy = Math.max(0, Math.floor(rect.y * scale));
  const sw = Math.max(1, Math.min(bmp.width - sx, Math.ceil(rect.width * scale)));
  const sh = Math.max(1, Math.min(bmp.height - sy, Math.ceil(rect.height * scale)));
  const canvas = new OffscreenCanvas(sw, sh);
  canvas.getContext("2d").drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
  const out = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.7 });
  const buf = new Uint8Array(await out.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

// ---------- stop (SPEC 5.2.6) ----------

async function stopAll(reason = "Stopped by the user") {
  for (const [, entry] of inflight) entry.cancel?.();
  failAllInflight("E_STOPPED", reason);
  if (state.question) state.question.reject(new BridgeError("E_STOPPED", reason));
  for (const [tabId, st] of tabs) {
    if (st.controlled || st.cssInserted) {
      toFrame(tabId, 0, { cmd: "cancel" }).catch(() => {});
      for (const f of st.frames) toFrame(tabId, f, { cmd: "cancel" }).catch(() => {});
      await release(tabId);
    }
  }
  state.approvals.clear();
  if (state.run && state.run.status === "running") Object.assign(state.run, { status: "failed", message: "Stopped", offerContinue: false });
  addLog("Stopped", "error");
  if (state.port) {
    sendNative({ v: 1, type: "event", name: "stopped", data: { reason } });
    // Let the error responses flush before closing the port.
    await new Promise((r) => setTimeout(r, 200));
  }
  disconnect();
}

// ---------- messages from content scripts and extension pages ----------

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || typeof msg !== "object") return undefined;
  if (sender.id !== browser.runtime.id) return undefined;
  // Extension pages (popup, sidebar, activity) may also be open in a tab, so tell them apart by URL.
  const fromExtensionPage = (sender.url ?? "").startsWith(browser.runtime.getURL(""));

  // From content scripts.
  if (sender.tab && !fromExtensionPage) {
    if (msg.type === "main") {
      const func = MAIN_FUNCS[msg.fn];
      if (!func) return Promise.resolve({ ok: false, error: "unknown function" });
      return browser.scripting
        .executeScript({ target: { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] }, world: "MAIN", func, args: [msg.nonce, msg.args] })
        .then(([r]) => r?.result ?? { ok: false, error: r?.error?.message ?? "no result" })
        .catch((err) => ({ ok: false, error: err.message }));
    }
    if (msg.type === "user_stop") return stopAll("Stopped by the user (Esc)").then(() => ({ ok: true }));
    if (msg.type === "blocked_submit") {
      addLog("Blocked a form submission that wasn't approved", "error");
      audit({ url: msg.url, action: "submit", target: "form", result: "blocked", approved: false });
      return Promise.resolve({ ok: true });
    }
    return undefined;
  }

  // From the popup, sidebar and activity page.
  return handleUi(msg).catch((err) => ({ ok: false, error: err.message, code: err.code }));
});

async function handleUi(msg) {
  await restored;
  switch (msg.type) {
    case "get_state":
      return publicState();
    case "connect":
      connect();
      return { ok: true };
    case "disconnect":
      disconnect();
      return { ok: true };
    case "stop":
      await stopAll();
      return { ok: true };
    case "focus_tab": {
      const tab = await browser.tabs.update(msg.tabId, { active: true });
      await browser.windows.update(tab.windowId, { focused: true }).catch(() => {});
      return { ok: true };
    }
    case "site_changed":
      broadcast();
      return { ok: true };
    case "answer":
      if (state.question && state.question.id === msg.id) state.question.resolve(String(msg.answer ?? ""));
      return { ok: true };
    case "profile_get":
      await waitConnected();
      return hostCall("profile_get");
    case "profile_set":
      await waitConnected();
      return hostCall("profile_set", { profile: msg.profile });
    case "run": {
      await waitConnected();
      const [tab] = msg.tabId
        ? [await browser.tabs.get(msg.tabId).catch(() => null)]
        : await browser.tabs.query(msg.windowId ? { active: true, windowId: msg.windowId } : { active: true, lastFocusedWindow: true });
      if (!tab) throw new BridgeError("E_NO_TAB", "No active tab");
      if (!(await isAllowedUrl(tab.url ?? ""))) throw new BridgeError("E_SITE_NOT_ALLOWED", `Allow Claude on ${originOf(tab.url) ?? "this page"} first.`);
      state.selectedTabId = tab.id;
      persist();
      state.log = [];
      state.run = { runId: null, engine: null, label: "Starting…", status: "running", instruction: msg.instruction, summary: null, message: null, offerContinue: false, tabId: tab.id };
      addLog(`Instruction: ${msg.instruction}`, "instruction");
      const res = await hostCall("run_start", { instruction: msg.instruction, tabId: tab.id, engine: msg.engine ?? "auto" });
      state.run.runId = res.runId;
      broadcast();
      return { ok: true, runId: res.runId };
    }
    case "audit_get": {
      const { audit: saved } = await browser.storage.local.get("audit");
      return { entries: Array.isArray(saved) ? saved : [] };
    }
    case "audit_clear":
      auditCache = [];
      await browser.storage.local.set({ audit: [] });
      return { ok: true };
    default:
      return { ok: false, error: `unknown message ${msg.type}` };
  }
}

// ---------- tab lifecycle ----------

browser.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== "loading") return;
  const st = tabs.get(tabId);
  if (!st) return;
  // A new document: refs, frames and the injected indicator are gone.
  st.refFrames = {};
  st.frames = [];
  st.cssInserted = false;
  st.lastFrameId = 0;
  if (st.controlled) {
    st.controlled = false;
    clearTimeout(st.idleTimer);
  }
  persist();
});

browser.tabs.onRemoved.addListener((tabId) => {
  tabs.delete(tabId);
  if (state.selectedTabId === tabId) state.selectedTabId = null;
  for (const [id, a] of state.approvals) if (a.tabId === tabId) state.approvals.delete(id);
  persist();
  sendNative({ v: 1, type: "event", name: "tab_closed", data: { tabId } });
  broadcast();
});

browser.permissions.onAdded.addListener(() => broadcast());
browser.permissions.onRemoved.addListener(() => broadcast());

browser.notifications.onClicked.addListener(async (id) => {
  const approvalId = id.replace(/^cb-/, "");
  const a = state.approvals.get(approvalId);
  if (a) {
    const tab = await browser.tabs.update(a.tabId, { active: true });
    await browser.windows.update(tab.windowId, { focused: true }).catch(() => {});
  } else if (id === "cb-question") {
    browser.sidebarAction.open().catch(() => {});
  }
});

updateBadge();
