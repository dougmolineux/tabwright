// Loads the real content scripts into jsdom with a stub `browser`, the way test/unit/content.test.js does, and
// fills in the browser APIs jsdom lacks. Import it from a test file that runs in the jsdom environment.
import { mainSelectOptions, mainSetValue, mainUpload } from "../../extension/content/main-world-setter.js";

export const MAIN = { setValue: mainSetValue, selectOptions: mainSelectOptions, upload: mainUpload };

/** Messages the content scripts sent to the background script (other than main-world calls). */
export const sentToBackground = [];
/** Main-world calls, as { fn, args }. */
export const mainCalls = [];
/** Frame ids that browser.runtime.getFrameId returns, keyed by element. Missing means -1. */
export const frameIds = new WeakMap();

const listeners = [];
let refCounter = 1;

globalThis.IS_REACT_ACT_ENVIRONMENT = false;
globalThis.Tabwright = { settings: { checkSize: false } }; // jsdom has no layout
Element.prototype.scrollIntoView = function () {};
/** window.scrollBy calls. jsdom doesn't scroll, so the stub moves scrollX/scrollY itself. */
export const scrollCalls = [];
window.scrollBy = function (opts = {}) {
  scrollCalls.push(opts);
  for (const [axis, d] of [["scrollX", opts.left ?? 0], ["scrollY", opts.top ?? 0]]) {
    Object.defineProperty(window, axis, { configurable: true, value: Math.max(0, (window[axis] || 0) + d) });
  }
};
/** Every shadow root created, open or closed, so tests can look inside the closed ones the page can't. */
export const shadowRoots = [];
const attachShadow = Element.prototype.attachShadow;
Element.prototype.attachShadow = function (init) {
  const root = attachShadow.call(this, init);
  shadowRoots.push({ host: this, root, mode: init.mode });
  return root;
};
if (!globalThis.PointerEvent) globalThis.PointerEvent = class extends MouseEvent {};

// jsdom has no contentEditable model.
if (!("isContentEditable" in HTMLElement.prototype)) {
  Object.defineProperty(HTMLElement.prototype, "isContentEditable", {
    configurable: true,
    get() {
      const host = this.closest("[contenteditable]");
      return !!host && ["", "true", "plaintext-only"].includes(host.getAttribute("contenteditable"));
    },
  });
}
// ...or editing commands. Enough of them for mainSetValue: select everything, then replace it.
let selectAllIn = null;
document.execCommand = (cmd, _ui, value) => {
  const el = document.activeElement;
  if (cmd === "selectAll") {
    selectAllIn = el;
    return true;
  }
  if (cmd === "insertText" && el?.isContentEditable) {
    if (selectAllIn === el) el.textContent = value;
    else el.textContent += value;
    selectAllIn = null;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    return true;
  }
  return false;
};

// ...or drag and drop.
if (!globalThis.DataTransfer) {
  globalThis.DataTransfer = class DataTransfer {
    constructor() {
      const files = [];
      this.files = files;
      this.items = { add: (f) => files.push(f), get length() { return files.length; } };
    }
  };
}
if (!globalThis.DragEvent) {
  globalThis.DragEvent = class DragEvent extends MouseEvent {
    constructor(type, init = {}) {
      super(type, init);
      this.dataTransfer = init.dataTransfer ?? null;
    }
  };
}

globalThis.browser = {
  runtime: {
    onMessage: { addListener: (fn) => listeners.push(fn) },
    sendMessage: async (msg) => {
      if (msg.type === "main") {
        mainCalls.push({ fn: msg.fn, args: msg.args });
        const fn = MAIN[msg.fn];
        return fn ? fn(msg.nonce, msg.args) : { ok: false, error: "unknown function" };
      }
      sentToBackground.push(msg);
      return { ok: true };
    },
    getFrameId: (el) => (frameIds.has(el) ? frameIds.get(el) : -1),
  },
};

/** Loads the content scripts in the order the background script injects them. */
export async function loadContentScripts() {
  await import("../../extension/content/common.js");
  await import("../../extension/content/refs.js");
  await import("../../extension/content/snapshot.js");
  await import("../../extension/content/approval.js");
  await import("../../extension/content/actions.js");
  return globalThis.Tabwright;
}

/** Sends a command the way the background script does and returns the raw envelope. */
export async function raw(name, params = {}) {
  for (const l of listeners) {
    const r = l({ to: "content", cmd: name, nextRef: refCounter, ...params }, {});
    if (r) {
      const res = await r;
      if (res.ok && typeof res.result?.nextRef === "number") refCounter = res.result.nextRef;
      return res;
    }
  }
  throw new Error("no listener");
}

/** Sends a command and unwraps the envelope, throwing { code, message, data } on error. */
export async function cmd(name, params = {}) {
  const res = await raw(name, params);
  if (!res.ok) throw Object.assign(new Error(res.error.message), res.error);
  return res.result;
}

/** Snapshot text, one line per item, indented by depth. */
export async function snapshotText(params = {}) {
  const snap = await cmd("snapshot", { includeText: true, charLimit: 25000, ...params });
  return { snap, text: snap.items.map((i) => (i.t === undefined ? `${"  ".repeat(i.d)}[frame ${i.frameId}]` : "  ".repeat(i.d) + i.t)).join("\n") };
}

/** The ref on the first snapshot line matching re. */
export function refIn(text, re) {
  const line = text.split("\n").find((t) => re.test(t));
  if (!line) throw new Error(`no line matching ${re}\n${text}`);
  return line.match(/\[ref=(e\d+)\]/)[1];
}

/** Replaces the page body and returns a fresh snapshot of it. */
export async function page(html) {
  document.body.innerHTML = html;
  return snapshotText();
}
