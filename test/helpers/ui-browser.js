// A fake WebExtension `browser` for the extension's own pages (popup, sidebar, activity), and a loader that
// puts a page's real HTML into jsdom and runs its real script. Use from tests in the jsdom environment.
import fs from "node:fs";
import path from "node:path";
import { vi } from "vitest";

const EXT = path.resolve(__dirname, "../../extension");

/** The background script's publicState() shape, with overrides. */
export const baseState = (over = {}) => ({
  connected: false,
  connecting: false,
  error: null,
  busy: false,
  selectedTabId: null,
  hostInfo: null,
  approvals: [],
  autoApprove: false,
  question: null,
  run: null,
  log: [],
  ...over,
});

/**
 * tabs: [{ id, windowId, url, active }]; granted: match patterns already allowed.
 * responses: message type -> fn(msg) returning the background script's reply (default { ok: true }).
 */
export function fakeBrowser({ tabs = [], granted = [], responses = {}, windowId = 1 } = {}) {
  const sent = [];
  const allowed = new Set(granted);
  const listeners = { portMessage: [], activated: [], updated: [], permAdded: [], permRemoved: [] };
  const port = {
    name: null,
    onMessage: { addListener: (fn) => listeners.portMessage.push(fn) },
    /** Pushes a state the way the background script broadcasts it. */
    push: (state) => listeners.portMessage.forEach((fn) => fn({ type: "state", state })),
  };
  const browser = {
    runtime: {
      connect: ({ name }) => {
        port.name = name;
        return port;
      },
      sendMessage: vi.fn(async (msg) => {
        sent.push(msg);
        const r = responses[msg.type];
        return r ? r(msg) : { ok: true };
      }),
      getURL: (p) => `moz-extension://test-id/${p}`,
    },
    tabs: {
      query: vi.fn(async (q) => tabs.filter((t) => t.active && (q.windowId === undefined || t.windowId === q.windowId))),
      get: vi.fn(async (id) => {
        const t = tabs.find((x) => x.id === id);
        if (!t) throw new Error(`Invalid tab ID: ${id}`);
        return t;
      }),
      create: vi.fn(async (props) => ({ id: 99, ...props })),
      onActivated: { addListener: (fn) => listeners.activated.push(fn) },
      onUpdated: { addListener: (fn) => listeners.updated.push(fn) },
    },
    permissions: {
      contains: vi.fn(async ({ origins }) => origins.every((o) => allowed.has(o))),
      getAll: vi.fn(async () => ({ origins: [...allowed] })),
      request: vi.fn(async ({ origins }) => {
        origins.forEach((o) => allowed.add(o));
        listeners.permAdded.forEach((fn) => fn({ origins }));
        return true;
      }),
      remove: vi.fn(async ({ origins }) => {
        origins.forEach((o) => allowed.delete(o));
        listeners.permRemoved.forEach((fn) => fn({ origins }));
        return true;
      }),
      onAdded: { addListener: (fn) => listeners.permAdded.push(fn) },
      onRemoved: { addListener: (fn) => listeners.permRemoved.push(fn) },
    },
    windows: { getCurrent: vi.fn(async () => ({ id: windowId })) },
    sidebarAction: { open: vi.fn(async () => {}) },
  };
  return { browser, port, sent, allowed, tabs, listeners };
}

/** Lets pending promise chains (sendMessage, permissions...) finish. */
export const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

/**
 * Loads extension/<page>.html's body into the document and runs its script fresh (vi.resetModules), with
 * `fake.browser` as the global `browser`. importScript must be () => import("<the page's script>").
 */
export async function loadPage(page, fake, importScript) {
  const html = fs.readFileSync(path.join(EXT, `${page}.html`), "utf8");
  const body = html.match(/<body>([\s\S]*)<\/body>/)[1].replace(/<script[^>]*><\/script>/g, "");
  document.body.innerHTML = body;
  globalThis.browser = fake.browser;
  window.close = vi.fn();
  vi.resetModules();
  await importScript();
  await flush();
  return fake;
}

export const $ = (id) => document.getElementById(id);
export const texts = (sel) => [...document.querySelectorAll(sel)].map((n) => n.textContent);
