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
