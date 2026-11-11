// Functions run in the page's main world (SPEC 5.3, 6.4) with scripting.executeScript({ world: "MAIN", func }).
// Each must be self-contained: it is serialized and runs with no access to the extension. The target
// element is found through a temporary data-tabwright-ref attribute set by the content script.

/** Sets a value the way a framework expects: native prototype setter, then input/change events. */
export function mainSetValue(nonce, opts) {
  const find = (root) => {
    const hit = root.querySelector(`[data-tabwright-ref="${nonce}"]`);
    if (hit) return hit;
    for (const host of root.querySelectorAll("*")) {
      if (host.shadowRoot) {
        const inner = find(host.shadowRoot);
        if (inner) return inner;
      }
    }
    return null;
  };
  const el = find(document);
  if (!el) return { ok: false, error: "element not found" };
  const { text = "", clear = true, perKey = false } = opts || {};

  if (el.isContentEditable) {
    el.focus();
    if (clear) document.execCommand("selectAll", false);
    document.execCommand("insertText", false, text);
    return { ok: true, value: el.innerText };
  }

  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
  const fire = (type, init) => el.dispatchEvent(new Event(type, { bubbles: true, ...init }));
  const input = (data) =>
    el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data }));
  const key = (type, ch) =>
    el.dispatchEvent(new KeyboardEvent(type, { key: ch, code: ch.length === 1 && /[a-z]/i.test(ch) ? `Key${ch.toUpperCase()}` : "", bubbles: true, cancelable: true, composed: true }));

  el.focus();
  if (perKey) {
    if (clear && el.value !== "") {
      setter.call(el, "");
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
    }
    for (const ch of text) {
      const down = key("keydown", ch);
      key("keypress", ch);
      if (down) {
        setter.call(el, el.value + ch);
        input(ch);
      }
      key("keyup", ch);
    }
  } else {
    setter.call(el, clear ? text : el.value + text);
    input(text);
  }
  fire("change");
  return { ok: true, value: el.value };
}

/** Selects options of a native <select> by index and fires input/change. */
export function mainSelectOptions(nonce, indexes) {
  const find = (root) => {
    const hit = root.querySelector(`[data-tabwright-ref="${nonce}"]`);
    if (hit) return hit;
    for (const host of root.querySelectorAll("*")) {
      if (host.shadowRoot) {
        const inner = find(host.shadowRoot);
        if (inner) return inner;
      }
    }
    return null;
  };
  const el = find(document);
  if (!el) return { ok: false, error: "element not found" };
  const want = new Set(indexes);
  if (el.multiple) {
    Array.from(el.options).forEach((o, i) => (o.selected = want.has(i)));
  } else {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
    setter.call(el, el.options[indexes[0]].value);
    el.selectedIndex = indexes[0];
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, selected: Array.from(el.selectedOptions).map((o) => o.label || o.textContent.trim()) };
}

/** Puts a file into an <input type=file>, or drops it on a drop zone. */
export function mainUpload(nonce, file) {
  const find = (root) => {
    const hit = root.querySelector(`[data-tabwright-ref="${nonce}"]`);
    if (hit) return hit;
    for (const host of root.querySelectorAll("*")) {
      if (host.shadowRoot) {
        const inner = find(host.shadowRoot);
        if (inner) return inner;
      }
    }
    return null;
  };
  const el = find(document);
  if (!el) return { ok: false, error: "element not found" };
  const bin = atob(file.base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const f = new File([bytes], file.fileName, { type: file.mimeType || "application/octet-stream", lastModified: Date.now() });
  const dt = new DataTransfer();
  dt.items.add(f);
  if (file.mode === "input") {
    el.files = dt.files;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, fileName: f.name, size: f.size, accepted: el.files.length > 0 };
  }
  const r = el.getBoundingClientRect();
  const init = { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  el.dispatchEvent(new DragEvent("dragenter", init));
  el.dispatchEvent(new DragEvent("dragover", init));
  el.dispatchEvent(new DragEvent("drop", init));
  return { ok: true, fileName: f.name, size: f.size, dropped: true };
}

/**
 * Arms clipboard capture around one browser_click (SPEC 6.4). Synthetic clicks carry no user activation,
 * so Firefox rejects a page's navigator.clipboard.writeText/write and makes execCommand("copy") fail, and
 * "Copy" buttons break. While armed, the patched methods record the text the page tries to copy and tell
 * the page it worked; the background script then writes that text with the add-on's clipboardWrite
 * permission. The patch is installed once per document and passes straight through when not armed, so
 * the user's own copies are untouched. armMs bounds how long one click keeps it armed.
 */
export function mainClipboardArm(_nonce, opts) {
  const KEY = Symbol.for("tabwright.clipboard");
  let trap = window[KEY];
  if (!trap) {
    trap = { armedUntil: 0, text: null, pending: [] };
    Object.defineProperty(window, KEY, { value: trap });
    const armed = () => Date.now() < trap.armedUntil;
    const record = (t) => {
      if (typeof t === "string") trap.text = t;
    };
    const C = globalThis.Clipboard?.prototype;
    const writeText = C?.writeText;
    if (writeText) {
      C.writeText = function (text) {
        if (!armed()) return writeText.apply(this, arguments);
        record(String(text));
        return Promise.resolve();
      };
    }
    const write = C?.write;
    if (write) {
      C.write = function (items) {
        if (!armed()) return write.apply(this, arguments);
        const p = (async () => {
          for (const item of items ?? []) {
            if (!item?.types?.includes("text/plain")) continue;
            const data = await item.getType("text/plain");
            record(typeof data === "string" ? data : await data.text());
            return;
          }
        })();
        trap.pending.push(p.catch(() => {}));
        return p.then(() => undefined);
      };
    }
    const exec = Document.prototype.execCommand;
    Document.prototype.execCommand = function (cmd) {
      if (!armed() || String(cmd).toLowerCase() !== "copy") return exec.apply(this, arguments);
      // Pages copy either by selecting text (often a hidden textarea) or by filling clipboardData in a copy
      // handler. Fire the copy event so a handler can set its data, else take the selection.
      const active = this.activeElement;
      let dt = null;
      try {
        dt = new DataTransfer();
      } catch {}
      const ev = new ClipboardEvent("copy", { bubbles: true, cancelable: true, composed: true, clipboardData: dt });
      (active ?? this.documentElement).dispatchEvent(ev);
      const set = ev.defaultPrevented ? (ev.clipboardData ?? dt)?.getData("text/plain") : "";
      if (set) record(set);
      else if (active && typeof active.selectionStart === "number" && /^(textarea|input)$/i.test(active.tagName)) {
        record(active.value.slice(active.selectionStart, active.selectionEnd ?? active.value.length));
      } else record(String(this.defaultView?.getSelection?.() ?? ""));
      return true;
    };
  }
  trap.text = null;
  trap.pending = [];
  trap.armedUntil = Date.now() + (Number(opts?.armMs) || 10_000);
  return { ok: true };
}

/** Disarms clipboard capture and returns what the page copied since mainClipboardArm, or null. */
export async function mainClipboardTake() {
  const trap = window[Symbol.for("tabwright.clipboard")];
  if (!trap) return { ok: true, text: null };
  // A ClipboardItem's text arrives asynchronously; give it a moment, but never hang the click.
  if (trap.text === null && trap.pending.length) {
    await Promise.race([Promise.all(trap.pending), new Promise((r) => setTimeout(r, 1000))]);
  }
  const text = trap.text;
  trap.armedUntil = 0;
  trap.text = null;
  trap.pending = [];
  return { ok: true, text };
}
