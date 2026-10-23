// @vitest-environment jsdom
// Main-world functions (SPEC 5.3, 6.4), called directly the way scripting.executeScript runs them.
import { beforeEach, describe, expect, it } from "vitest";
import { MAIN } from "../helpers/content-env.js";

const { setValue, selectOptions, upload } = MAIN;
const NONCE = "cb-test";

/** Puts html in the page and tags the element matching sel with the nonce, like CB.runMain does. */
function target(html, sel) {
  document.body.innerHTML = html;
  const el = document.querySelector(sel);
  el.setAttribute("data-tabwright-ref", NONCE);
  return el;
}

/** Records events of the given types on el. */
function record(el, types) {
  const seen = [];
  for (const t of types) el.addEventListener(t, (e) => seen.push(e.type === "input" ? `input:${e.inputType ?? ""}` : e.type));
  return seen;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("mainSetValue", () => {
  it("fails cleanly when the nonce isn't on the page", () => {
    expect(setValue("cb-missing", { text: "x" })).toEqual({ ok: false, error: "element not found" });
    expect(selectOptions("cb-missing", [0])).toEqual({ ok: false, error: "element not found" });
    expect(upload("cb-missing", { base64: "", fileName: "a" })).toEqual({ ok: false, error: "element not found" });
  });

  it("uses the native setter, so a framework's own value tracking can't swallow it", () => {
    const el = target("<input>", "input");
    let viaInstance = 0;
    Object.defineProperty(el, "value", {
      configurable: true,
      get: () => Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").get.call(el),
      set: () => viaInstance++, // what React's tracker would intercept
    });
    const seen = record(el, ["input", "change"]);
    expect(setValue(NONCE, { text: "Jane" })).toEqual({ ok: true, value: "Jane" });
    expect(viaInstance).toBe(0);
    expect(seen).toEqual(["input:insertText", "change"]);
    expect(document.activeElement).toBe(el);
  });

  it("clears by default, appends with clear: false", () => {
    const el = target('<input value="old">', "input");
    setValue(NONCE, { text: "new" });
    expect(el.value).toBe("new");
    setValue(NONCE, { text: "er", clear: false });
    expect(el.value).toBe("newer");
    setValue(NONCE, undefined);
    expect(el.value).toBe("");
  });

  it("works on textareas", () => {
    const el = target("<textarea>x</textarea>", "textarea");
    expect(setValue(NONCE, { text: "line 1\nline 2" })).toEqual({ ok: true, value: "line 1\nline 2" });
  });

  it("types per key with keydown/keypress/keyup, and respects a cancelled keydown", () => {
    const el = target('<input value="zz">', "input");
    const seen = record(el, ["keydown", "keypress", "keyup", "input", "change"]);
    el.addEventListener("keydown", (e) => e.key === "b" && e.preventDefault());
    const keys = [];
    el.addEventListener("keydown", (e) => keys.push([e.key, e.code]));
    expect(setValue(NONCE, { text: "ab1", perKey: true })).toEqual({ ok: true, value: "a1" });
    expect(keys).toEqual([["a", "KeyA"], ["b", "KeyB"], ["1", ""]]);
    expect(seen.slice(0, 5)).toEqual(["input:deleteContentBackward", "keydown", "keypress", "input:insertText", "keyup"]);
    expect(seen.at(-1)).toBe("change");
  });

  it("doesn't clear an already-empty field per key", () => {
    const el = target("<input>", "input");
    const seen = record(el, ["input"]);
    setValue(NONCE, { text: "a", perKey: true });
    expect(seen).toEqual(["input:insertText"]);
  });

  it("edits contenteditable elements with editing commands", () => {
    const el = target('<div contenteditable="true">old text</div>', "div");
    el.innerText = undefined; // jsdom: fall through to textContent
    const r = setValue(NONCE, { text: "new" });
    expect(r.ok).toBe(true);
    expect(el.textContent).toBe("new");
    setValue(NONCE, { text: "+", clear: false });
    expect(el.textContent).toBe("new+");
  });

  it("finds elements inside open shadow roots", () => {
    document.body.innerHTML = "<x-a></x-a>";
    const outer = document.querySelector("x-a").attachShadow({ mode: "open" });
    outer.innerHTML = "<x-b></x-b>";
    const inner = outer.querySelector("x-b").attachShadow({ mode: "open" });
    inner.innerHTML = "<input>";
    const el = inner.querySelector("input");
    el.setAttribute("data-tabwright-ref", NONCE);
    expect(setValue(NONCE, { text: "deep" })).toEqual({ ok: true, value: "deep" });
  });
});

describe("mainSelectOptions", () => {
  it("selects one option by index and fires input and change", () => {
    const el = target('<select><option value="a">A</option><option value="b">B</option></select>', "select");
    const seen = record(el, ["input", "change"]);
    expect(selectOptions(NONCE, [1])).toEqual({ ok: true, selected: ["B"] });
    expect(el.value).toBe("b");
    expect(seen).toEqual(["input:", "change"]);
  });

  it("sets every option of a multi-select", () => {
    const el = target("<select multiple><option selected>A</option><option>B</option><option>C</option></select>", "select");
    expect(selectOptions(NONCE, [1, 2])).toEqual({ ok: true, selected: ["B", "C"] });
    expect(el.options[0].selected).toBe(false);
  });

  it("uses an option's label when it has one", () => {
    target('<select><option label="Short">Long text</option></select>', "select");
    expect(selectOptions(NONCE, [0]).selected).toEqual(["Short"]);
  });

  it("finds selects inside open shadow roots", () => {
    document.body.innerHTML = "<x-a></x-a>";
    const root = document.querySelector("x-a").attachShadow({ mode: "open" });
    root.innerHTML = '<select><option value="1">One</option><option value="2">Two</option></select>';
    root.querySelector("select").setAttribute("data-tabwright-ref", NONCE);
    expect(selectOptions(NONCE, [1])).toEqual({ ok: true, selected: ["Two"] });
  });
});

describe("mainUpload", () => {
  const file = { fileName: "cv.pdf", mimeType: "application/pdf", base64: btoa("%PDF-1.4") };

  it("puts the file into a file input and fires input and change", () => {
    const el = target('<input type="file">', "input");
    let files = [];
    Object.defineProperty(el, "files", { configurable: true, get: () => files, set: (v) => (files = v) }); // jsdom only takes a real FileList
    const seen = record(el, ["input", "change"]);
    expect(upload(NONCE, { ...file, mode: "input" })).toEqual({ ok: true, fileName: "cv.pdf", size: 8, accepted: true });
    expect(files[0]).toBeInstanceOf(File);
    expect(files[0].type).toBe("application/pdf");
    expect(seen).toEqual(["input:", "change"]);
  });

  it("drops the file on a drop zone", () => {
    const el = target('<div class="dz">Drop here</div>', ".dz");
    const events = [];
    for (const t of ["dragenter", "dragover", "drop"]) el.addEventListener(t, (e) => events.push([t, e.dataTransfer.files[0]]));
    expect(upload(NONCE, { ...file, mimeType: "", mode: "drop" })).toEqual({ ok: true, fileName: "cv.pdf", size: 8, dropped: true });
    expect(events.map(([t]) => t)).toEqual(["dragenter", "dragover", "drop"]);
    const dropped = events[2][1];
    expect(dropped.type).toBe("application/octet-stream");
    expect([dropped.name, dropped.size]).toEqual(["cv.pdf", 8]);
  });
});
