// An in-memory stand-in for the WebExtension `browser` API, enough to load extension/background.js in
// Node and drive it the way Firefox would: the native host on one side (a fake port that speaks the
// chunked protocol), pages and content scripts on the other (tabs.sendMessage played by `pages`).
import { Reassembler, chunkMessage } from "../../shared/protocol.ts";

export const EXT_ID = "tabwright@test";
export const EXT_BASE = "moz-extension://0000-test/";

export function fakeEvent() {
  const listeners = [];
  return {
    listeners,
    addListener: (fn) => void listeners.push(fn),
    removeListener: (fn) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    hasListener: (fn) => listeners.includes(fn),
    emit: (...args) => listeners.map((fn) => fn(...args)),
  };
}

const later = (fn) => setTimeout(fn, 0);
const clone = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));

/** The native host end of runtime.connectNative. Requests from the extension go to `hostHandlers`. */
class FakeHost {
  constructor(handlers) {
    this.handlers = handlers;
    this.port = null;
    this.sent = []; // every wire message the extension posted
    this.events = [];
    this.responses = [];
    this.requests = [];
    this.pending = new Map();
    this.reassembler = new Reassembler();
    this.seq = 0;
  }

  attach() {
    const host = this;
    const port = {
      name: "tabwright",
      error: null,
      disconnected: false,
      onMessage: fakeEvent(),
      onDisconnect: fakeEvent(),
      postMessage(m) {
        if (port.disconnected) throw new Error("Attempt to postMessage on disconnected port");
        host.onWire(clone(m));
      },
      disconnect() {
        port.disconnected = true;
      },
    };
    this.port = port;
    return port;
  }

  onWire(m) {
    this.sent.push(m);
    let msg = m;
    if (m.type === "chunk") {
      msg = this.reassembler.add(m);
      if (!msg) return;
    }
    if (msg.type === "event") this.events.push(msg);
    else if (msg.type === "response") {
      this.responses.push(msg);
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        p(msg);
      }
    } else if (msg.type === "request") {
      this.requests.push(msg);
      const h = this.handlers[msg.method];
      if (!h) return; // never answered (lets tests exercise timeouts)
      later(async () => {
        try {
          this.post({ v: 1, id: msg.id, type: "response", result: await h(msg.params ?? {}) });
        } catch (e) {
          this.post({ v: 1, id: msg.id, type: "response", error: { code: e.code ?? "E_INTERNAL", message: e.message ?? String(e) } });
        }
      });
    }
  }

  /** Delivers a message to the extension, chunked when large. */
  post(msg, opts = {}) {
    if (!this.port || this.port.disconnected) return;
    const parts = opts.raw ? [msg] : chunkMessage(msg, opts.threshold, opts.slice);
    for (const p of parts) this.port.onMessage.emit(clone(p));
  }

  /** Sends a request to the extension and resolves with its response envelope. */
  request(method, params = {}, opts) {
    const id = `m-${++this.seq}`;
    const done = new Promise((resolve) => this.pending.set(id, resolve));
    this.post({ v: 1, id, type: "request", method, params }, opts);
    return done;
  }

  /** Like request(), but unwraps: resolves with the result or rejects with the error object. */
  async call(method, params, opts) {
    const r = await this.request(method, params, opts);
    if (r.error) throw Object.assign(new Error(r.error.message), r.error);
    return r.result;
  }

  event(name, data) {
    this.post({ v: 1, type: "event", name, data });
  }

  /** Simulates the host process exiting (or Firefox closing the port). */
  exit(message) {
    const port = this.port;
    if (!port) return;
    port.disconnected = true;
    port.error = message ? { message } : null;
    port.onDisconnect.emit(port);
  }
}

/**
 * The page side. Each frame has a url and a set of command handlers; tabs.sendMessage fails the way
 * Firefox does until the content scripts are injected (scripting.executeScript with files).
 */
class FakePages {
  constructor(b) {
    this.b = b;
    this.frames = new Map(); // `${tabId}:${frameId}` -> { url, injected, handlers }
    this.messages = []; // every { tabId, frameId, msg } sent to a page
  }

  key(tabId, frameId) {
    return `${tabId}:${frameId}`;
  }

  /** Defines (or extends) a frame. Handlers map cmd -> (msg) => result; throw { code, message } to fail. */
  frame(tabId, frameId = 0, { url, injected = false, handlers = {} } = {}) {
    const k = this.key(tabId, frameId);
    const f = this.frames.get(k) ?? { url: null, injected, handlers: {} };
    if (url !== undefined) f.url = url;
    f.injected = f.injected || injected;
    Object.assign(f.handlers, handlers);
    this.frames.set(k, f);
    return f;
  }

  on(tabId, cmd, fn, frameId = 0) {
    this.frame(tabId, frameId, { handlers: { [cmd]: fn } });
  }

  sent(cmd, tabId) {
    return this.messages.filter((m) => m.msg.cmd === cmd && (tabId === undefined || m.tabId === tabId));
  }

  async send(tabId, msg, { frameId = 0 } = {}) {
    this.messages.push({ tabId, frameId, msg: clone(msg) });
    const tab = this.b._tabs.get(tabId);
    const f = this.frames.get(this.key(tabId, frameId)) ?? (frameId === 0 && tab ? this.frame(tabId, 0) : null);
    if (!tab || !f || !f.injected) throw new Error("Could not establish connection. Receiving end does not exist.");
    const url = f.url ?? tab.url;
    const fallback = {
      ping: () => ({ ok: true, url, origin: new URL(url).origin, refs: 0 }),
      control: () => ({ ok: true }),
      highlight: () => ({ ok: true }),
      cancel: () => ({ ok: true }),
    };
    const h = f.handlers[msg.cmd] ?? fallback[msg.cmd];
    if (!h) return { ok: false, error: { code: "E_INTERNAL", message: `fake page: no handler for ${msg.cmd}` } };
    try {
      return { ok: true, result: await h(msg, { tabId, frameId }) };
    } catch (e) {
      if (e instanceof Error && !e.code) throw e; // transport-level failure (e.g. the page went away)
      return { ok: false, error: { code: e.code ?? "E_INTERNAL", message: e.message ?? String(e), ...(e.data ? { data: e.data } : {}) } };
    }
  }
}

function storageArea() {
  const data = {};
  return {
    data,
    async get(keys) {
      if (keys == null) return clone(data);
      const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const out = {};
      for (const k of list) if (k in data) out[k] = clone(data[k]);
      return out;
    },
    async set(obj) {
      Object.assign(data, clone(obj));
    },
  };
}

export function createFakeBrowser({ hostHandlers = {}, tabs = [], granted = [] } = {}) {
  const calls = []; // [api, ...args] for the calls tests usually assert on
  const record = (api, ...args) => calls.push([api, ...args]);
  const host = new FakeHost({ host_info: () => ({ version: "0.1.0", platform: "darwin", engines: {} }), ...hostHandlers });
  const _tabs = new Map();
  const perms = new Set(granted);
  const nav = (id, url) => {
    const t = _tabs.get(id);
    if (!t) return;
    if (url) t.url = url;
    t.status = "loading";
    b.tabs.onUpdated.emit(id, { status: "loading", ...(url ? { url } : {}) }, { ...t });
    later(() => {
      t.status = "complete";
      b.tabs.onUpdated.emit(id, { status: "complete" }, { ...t });
    });
  };
  let nextTabId = 100;

  const b = {
    calls,
    host,
    _tabs,
    perms,
    pages: null,
    connectNativeError: null,
    captureError: null,
    captureData: "data:image/jpeg;base64,QUJD",
    mainResult: { ok: true, value: "set" },
    runtime: {
      id: EXT_ID,
      lastError: null,
      onMessage: fakeEvent(),
      onConnect: fakeEvent(),
      getURL: (p) => EXT_BASE + p,
      getManifest: () => ({ version: "0.1.0" }),
      getBrowserInfo: async () => ({ name: "Firefox", version: "140.0" }),
      connectNative(name) {
        record("connectNative", name);
        if (b.connectNativeError) throw new Error(b.connectNativeError);
        return host.attach();
      },
    },
    tabs: {
      onUpdated: fakeEvent(),
      onRemoved: fakeEvent(),
      async get(id) {
        const t = _tabs.get(id);
        if (!t) throw new Error(`Invalid tab ID: ${id}`);
        return { ...t };
      },
      async query(q = {}) {
        let all = [..._tabs.values()];
        if (q.active) all = all.filter((t) => t.active);
        if (q.windowId) all = all.filter((t) => t.windowId === q.windowId);
        return all.map((t) => ({ ...t }));
      },
      async update(id, props) {
        record("tabs.update", id, props);
        const t = _tabs.get(id);
        if (!t) throw new Error(`Invalid tab ID: ${id}`);
        if (props.active) for (const o of _tabs.values()) if (o.windowId === t.windowId) o.active = o.id === id;
        if (props.url) nav(id, props.url);
        return { ...t };
      },
      async create({ url, active }) {
        record("tabs.create", url);
        const t = addTab({ id: nextTabId++, url, active: !!active, status: "loading" });
        nav(t.id);
        return { ...t };
      },
      goBack: async (id) => (record("tabs.goBack", id), nav(id)),
      goForward: async (id) => (record("tabs.goForward", id), nav(id)),
      reload: async (id) => (record("tabs.reload", id), nav(id)),
      sendMessage: (tabId, msg, opts) => b.pages.send(tabId, msg, opts),
      async captureVisibleTab(windowId, opts) {
        record("captureVisibleTab", windowId, opts);
        if (b.captureError) throw new Error(b.captureError);
        return b.captureData;
      },
    },
    windows: { update: async (id, props) => (record("windows.update", id, props), {}) },
    scripting: {
      async executeScript(opts) {
        record("executeScript", opts);
        if (opts.files) {
          for (const frameId of opts.target.frameIds ?? [0]) b.pages.frame(opts.target.tabId, frameId, { injected: true });
          return [{ result: undefined }];
        }
        const r = typeof b.mainResult === "function" ? b.mainResult(opts) : b.mainResult;
        return [{ result: r }];
      },
      insertCSS: async (opts) => void record("insertCSS", opts.target.tabId),
      removeCSS: async (opts) => void record("removeCSS", opts.target.tabId),
    },
    permissions: {
      onAdded: fakeEvent(),
      onRemoved: fakeEvent(),
      contains: async ({ origins }) => origins.every((o) => perms.has(o)),
      getAll: async () => ({ origins: [...perms], permissions: [] }),
    },
    storage: { session: storageArea(), local: storageArea() },
    notifications: {
      onClicked: fakeEvent(),
      create: async (id, opts) => (record("notifications.create", id, opts), id),
      clear: async (id) => (record("notifications.clear", id), true),
    },
    action: {
      badge: { text: "", color: null, title: "" },
      setBadgeText: async ({ text }) => void (b.action.badge.text = text),
      setBadgeBackgroundColor: async ({ color }) => void (b.action.badge.color = color),
      setTitle: async ({ title }) => void (b.action.badge.title = title),
    },
    sidebarAction: { open: async () => void record("sidebarAction.open") },
  };
  b.pages = new FakePages(b);

  function addTab(t) {
    const tab = { windowId: 1, active: false, title: `Tab ${t.id}`, status: "complete", ...t };
    _tabs.set(tab.id, tab);
    if (tab.active) for (const o of _tabs.values()) if (o.windowId === tab.windowId && o.id !== tab.id) o.active = false;
    return tab;
  }
  b.addTab = addTab;
  for (const t of tabs) addTab(t);

  /** Delivers a runtime message the way Firefox does and resolves with the listener's answer. */
  b.send = async (msg, sender) => {
    for (const r of b.runtime.onMessage.emit(msg, sender)) if (r !== undefined) return r;
    return undefined;
  };
  b.senders = {
    popup: { id: EXT_ID, url: EXT_BASE + "popup/popup.html" },
    sidebarInTab: (tabId) => ({ id: EXT_ID, url: EXT_BASE + `sidebar/sidebar.html?tab=${tabId}`, tab: { id: tabId }, frameId: 0 }),
    content: (tabId, frameId = 0) => ({ id: EXT_ID, url: _tabs.get(tabId)?.url, tab: { id: tabId }, frameId }),
    otherExtension: { id: "evil@example", url: "moz-extension://other/page.html" },
  };
  b.ui = (msg) => b.send(msg, b.senders.popup);

  /** Opens a UI port (popup/sidebar) and collects the state broadcasts. */
  b.openUiPort = (name = "ui") => {
    const port = { name, messages: [], onDisconnect: fakeEvent(), postMessage: (m) => port.messages.push(clone(m)) };
    b.runtime.onConnect.emit(port);
    return port;
  };

  return b;
}
