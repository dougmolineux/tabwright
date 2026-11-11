// @vitest-environment jsdom
// Clipboard capture around clicks (SPEC 6.4): mainClipboardArm / mainClipboardTake, called directly the way
// scripting.executeScript runs them. This file doesn't load content-env.js, whose execCommand stub would
// shadow the patched Document.prototype.execCommand.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mainClipboardArm as arm, mainClipboardTake as take } from "../../extension/content/main-world-setter.js";

/** Calls that reached the page's original (unpatched) clipboard methods. */
const original = [];

beforeAll(() => {
  // jsdom has none of these. The originals fail the way Firefox does without user activation.
  globalThis.Clipboard = class Clipboard {
    writeText(text) {
      original.push(["writeText", text]);
      return Promise.reject(new DOMException("blocked", "NotAllowedError"));
    }
    write(items) {
      original.push(["write", items]);
      return Promise.reject(new DOMException("blocked", "NotAllowedError"));
    }
  };
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: new Clipboard() });
  globalThis.ClipboardItem = class ClipboardItem {
    constructor(data) {
      this.data = data;
      this.types = Object.keys(data);
    }
    async getType(type) {
      return this.data[type];
    }
  };
  globalThis.DataTransfer = class DataTransfer {
    #data = new Map();
    setData(type, v) {
      this.#data.set(type, String(v));
    }
    getData(type) {
      return this.#data.get(type) ?? "";
    }
  };
  globalThis.ClipboardEvent = class ClipboardEvent extends Event {
    constructor(type, init = {}) {
      super(type, init);
      this.clipboardData = init.clipboardData ?? null;
    }
  };
  Document.prototype.execCommand = function (cmd) {
    original.push(["execCommand", cmd]);
    return false;
  };
});

beforeEach(() => {
  original.length = 0;
  document.body.innerHTML = "";
});

describe("clipboard capture", () => {
  it("passes everything through untouched when not armed", async () => {
    await expect(navigator.clipboard.writeText("mine")).rejects.toThrow("blocked");
    expect(document.execCommand("copy")).toBe(false);
    expect(original).toEqual([["writeText", "mine"], ["execCommand", "copy"]]); // first call installs nothing
    arm(null, {});
    await take();
    original.length = 0;
    await expect(navigator.clipboard.writeText("mine")).rejects.toThrow("blocked");
    expect(original).toEqual([["writeText", "mine"]]);
  });

  it("captures writeText while armed, tells the page it worked, then disarms on take", async () => {
    expect(arm(null, {})).toEqual({ ok: true });
    await expect(navigator.clipboard.writeText("https://amzn.to/abc")).resolves.toBeUndefined();
    expect(original).toEqual([]);
    expect(await take()).toEqual({ ok: true, text: "https://amzn.to/abc" });
    expect(await take()).toEqual({ ok: true, text: null });
    await expect(navigator.clipboard.writeText("x")).rejects.toThrow("blocked");
  });

  it("keeps only the last text when the page copies twice", async () => {
    arm(null, {});
    await navigator.clipboard.writeText("first");
    await navigator.clipboard.writeText("second");
    expect((await take()).text).toBe("second");
  });

  it("captures the text/plain part of clipboard.write", async () => {
    arm(null, {});
    const blob = (t) => ({ text: async () => t }); // jsdom's Blob has no text()
    const item = new ClipboardItem({ "text/html": blob("<b>hi</b>"), "text/plain": blob("hi") });
    const p = navigator.clipboard.write([item]); // the page may not await it before the click settles
    expect((await take()).text).toBe("hi");
    await expect(p).resolves.toBeUndefined();
  });

  it("doesn't hang when a ClipboardItem never resolves", async () => {
    arm(null, {});
    navigator.clipboard.write([{ types: ["text/plain"], getType: () => new Promise(() => {}) }]);
    const t0 = Date.now();
    expect((await take()).text).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("captures execCommand('copy') of a selected textarea, the classic copy-to-clipboard trick", () => {
    document.body.innerHTML = "<textarea>ignore https://amzn.to/xyz ignore</textarea>";
    const ta = document.querySelector("textarea");
    ta.focus();
    ta.setSelectionRange(7, 26);
    arm(null, {});
    expect(document.execCommand("copy")).toBe(true);
    expect(original).toEqual([]);
    return expect(take()).resolves.toEqual({ ok: true, text: "https://amzn.to/xyz" });
  });

  it("prefers data a copy handler puts in clipboardData", async () => {
    document.addEventListener("copy", function handler(e) {
      e.clipboardData.setData("text/plain", "from handler");
      e.preventDefault();
      document.removeEventListener("copy", handler);
    });
    arm(null, {});
    expect(document.execCommand("copy")).toBe(true);
    expect((await take()).text).toBe("from handler");
  });

  it("leaves other editing commands alone while armed", async () => {
    arm(null, {});
    expect(document.execCommand("bold")).toBe(false);
    expect(original).toEqual([["execCommand", "bold"]]);
    await take();
  });

  it("disarms by itself after armMs, in case take never comes (e.g. the page navigated)", async () => {
    arm(null, { armMs: 20 });
    await new Promise((r) => setTimeout(r, 40));
    await expect(navigator.clipboard.writeText("late")).rejects.toThrow("blocked");
    expect(original).toEqual([["writeText", "late"]]);
  });

  it("keeps its state where the page can't delete or enumerate it", () => {
    const key = Symbol.for("tabwright.clipboard");
    const desc = Object.getOwnPropertyDescriptor(window, key);
    expect(desc?.configurable).toBe(false); // the trap can't be removed or replaced by the page
    expect(desc?.enumerable).toBe(false);
  });
});
