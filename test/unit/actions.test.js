// @vitest-environment jsdom
// Content-script actions (SPEC 6.4, 6.5, 8.2) beyond the React job form in content.test.js: approval gating,
// interactability errors, custom dropdowns, checkboxes, uploads, keys, scrolling, waiting, text and the
// submit backstop.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cmd, loadContentScripts, mainCalls, page, raw, refIn, scrollCalls, sentToBackground } from "../helpers/content-env.js";

let CB;
let submits = 0;
const onSubmit = (e) => {
  e.preventDefault();
  submits++;
};

beforeAll(async () => {
  CB = await loadContentScripts();
  document.addEventListener("submit", onSubmit);
  // Every action waits for the DOM to be quiet for 300 ms; content.test.js covers that. Keep this file fast.
  const settle = CB.settle;
  CB.settle = (quietMs = 300, capMs) => settle(Math.min(quietMs, 20), capMs);
});

afterEach(() => {
  document.body.innerHTML = "";
  sentToBackground.length = 0;
  mainCalls.length = 0;
  submits = 0;
  CB.lastAgentActionAt = 0;
  CB.approvedUntil = 0;
});

describe("message handler", () => {
  it("answers ping with the frame's location", async () => {
    await expect(cmd("ping")).resolves.toMatchObject({ ok: true, url: location.href, origin: location.origin });
  });

  it("returns E_INTERNAL for unknown commands", async () => {
    await expect(raw("nope")).resolves.toEqual({ ok: false, error: { code: "E_INTERNAL", message: "unknown command nope" } });
  });

  it("passes error data through", async () => {
    const { text } = await page('<select aria-label="Size"><option>S</option><option>M</option></select>');
    const res = await raw("select", { ref: refIn(text, /"Size"/), option: "XL" });
    expect(res).toEqual({
      ok: false,
      error: { code: "E_NOT_INTERACTABLE", message: 'No option matching "XL" in "Size"', data: { available: ["S", "M"], origin: location.origin } },
    });
  });

  it("tracks control and lets only real Esc presses stop the agent", async () => {
    await cmd("control", { on: true });
    expect(CB.controlled).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(sentToBackground.some((m) => m.type === "user_stop")).toBe(false); // untrusted
    await cmd("control", { on: false });
    expect(CB.controlled).toBe(false);
    await cmd("control", { on: true });
    await cmd("cancel");
    expect(CB.controlled).toBe(false);
  });
});

describe("click", () => {
  it("clicks with the full pointer sequence and reports DOM changes", async () => {
    const { text } = await page('<button type="button">Add</button><ul></ul>');
    const btn = document.querySelector("button");
    const seen = [];
    for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) btn.addEventListener(t, () => seen.push(t));
    btn.addEventListener("click", () => document.querySelector("ul").append(document.createElement("li")));
    const res = await cmd("click", { ref: refIn(text, /"Add"/) });
    expect(seen).toEqual(["pointerdown", "mousedown", "pointerup", "mouseup", "click"]);
    expect(res).toEqual({ ok: true, target: "Add", navigated: false, snapshotStale: true });
    expect(document.activeElement).toBe(btn);
  });

  it("reports a navigation when the page starts to unload", async () => {
    const { text } = await page('<a href="/next">Next page</a>');
    document.querySelector("a").addEventListener("click", (e) => {
      e.preventDefault();
      dispatchEvent(new Event("pagehide"));
    });
    await expect(cmd("click", { ref: refIn(text, /"Next page"/) })).resolves.toMatchObject({ navigated: true, snapshotStale: true });
  });

  it("refuses hidden and disabled elements", async () => {
    const { text } = await page('<button id="h">Hide me</button><fieldset disabled><button type="button">Locked</button></fieldset><div role="button" aria-disabled="true">Aria</div>');
    const hideRef = refIn(text, /"Hide me"/);
    document.getElementById("h").style.display = "none";
    await expect(cmd("click", { ref: hideRef })).rejects.toMatchObject({ code: "E_NOT_INTERACTABLE", message: '"Hide me" is not visible' });
    await expect(cmd("click", { ref: refIn(text, /"Locked"/) })).rejects.toMatchObject({ code: "E_NOT_INTERACTABLE", message: '"Locked" is disabled' });
    await expect(cmd("click", { ref: refIn(text, /"Aria"/) })).rejects.toMatchObject({ message: '"Aria" is disabled' });
  });

  it("needs approval for consequential links and buttons, without clicking", async () => {
    const { text } = await page('<a href="/cart/checkout">Continue</a><button type="button">Delete account</button>');
    let clicked = 0;
    document.body.addEventListener("click", () => clicked++);
    await expect(cmd("click", { ref: refIn(text, /"Continue"/) })).resolves.toEqual({
      needsApproval: true, verb: "click", target: "Continue", reason: "navigates to a submit/confirm/checkout/pay/delete URL",
    });
    await expect(cmd("click", { ref: refIn(text, /"Delete account"/) })).resolves.toMatchObject({ needsApproval: true, reason: 'named "Delete account"' });
    expect(clicked).toBe(0);
  });

  it("refuses consequential clicks outright when approval isn't possible (fill_form)", async () => {
    const { text } = await page('<button type="button">Submit</button>');
    await expect(cmd("click", { ref: refIn(text, /"Submit"/), noApproval: true })).rejects.toMatchObject({
      code: "E_APPROVAL_DENIED",
      message: expect.stringMatching(/browser_fill_form never does that/),
    });
  });

  it("truncates long approval targets", async () => {
    const name = "Submit " + "x".repeat(200);
    const { text } = await page(`<button type="button" aria-label="${name}">go</button>`);
    const res = await cmd("click", { ref: refIn(text, /"Submit x/) });
    expect(res.target).toHaveLength(120);
    expect(res.target.endsWith("…")).toBe(true);
  });
});

describe("submit backstop (SPEC 8.2)", () => {
  it("blocks a page-initiated submit right after an agent action, and reports it", async () => {
    const { text } = await page('<form><input aria-label="Q"><button type="button" id="b">Next</button></form>');
    document.getElementById("b").addEventListener("click", (e) => e.currentTarget.form.requestSubmit());
    const res = await cmd("click", { ref: refIn(text, /"Next"/) });
    expect(res.blockedSubmit).toBe(true);
    expect(submits).toBe(0);
    expect(sentToBackground).toContainEqual({ type: "blocked_submit", url: location.href });
  });

  it("lets the approved action submit, and submits long after any agent action", async () => {
    const { text } = await page('<form><button id="go">Send</button></form>');
    const res = await cmd("click", { ref: refIn(text, /"Send"/), approved: true });
    expect(res.blockedSubmit).toBeUndefined();
    expect(submits).toBe(1);
    CB.lastAgentActionAt = Date.now() - 1500;
    CB.approvedUntil = 0;
    document.querySelector("form").requestSubmit();
    expect(submits).toBe(2);
  });

  it("revokes approval on the next unapproved action", async () => {
    const { text } = await page('<form><input aria-label="Name"><button type="button" id="b">Next</button></form>');
    await cmd("click", { ref: refIn(text, /"Next"/), approved: true });
    expect(CB.approvedUntil).toBeGreaterThan(Date.now());
    await cmd("type", { ref: refIn(text, /"Name"/), text: "x" });
    expect(CB.approvedUntil).toBe(0);
  });
});

describe("type", () => {
  it("refuses things that don't take text", async () => {
    const { text } = await page(`
      <select aria-label="S"><option>a</option></select><input type="checkbox" aria-label="C">
      <input aria-label="R" readonly><input type="file" aria-label="F"><input type="color" aria-label="Col">`);
    await expect(cmd("type", { ref: refIn(text, /"S"/), text: "a" })).rejects.toMatchObject({ message: '"S" is a dropdown; use browser_select.' });
    await expect(cmd("type", { ref: refIn(text, /"C"/), text: "a" })).rejects.toMatchObject({ message: '"C" (checkbox) doesn\'t accept text.' });
    await expect(cmd("type", { ref: refIn(text, /"R"/), text: "a" })).rejects.toMatchObject({ message: '"R" is read-only.' });
    await expect(cmd("type", { ref: refIn(text, /"F"/), text: "a" })).rejects.toMatchObject({ code: "E_NOT_INTERACTABLE" });
    await expect(cmd("type", { ref: refIn(text, /"Col"/), text: "a" })).rejects.toMatchObject({ code: "E_NOT_INTERACTABLE" });
  });

  it("types into contenteditable elements and reads the result back", async () => {
    const { text } = await page('<div contenteditable="true" aria-label="Bio">old</div>');
    await expect(cmd("type", { ref: refIn(text, /"Bio"/), text: "Hello" })).resolves.toMatchObject({ ok: true, target: "Bio", value: "Hello" });
  });

  it("passes clear and perKey through to the main world", async () => {
    const { text } = await page('<input aria-label="N" value="a">');
    await cmd("type", { ref: refIn(text, /"N"/), text: "b", clear: false, perKey: true });
    expect(mainCalls.at(-1)).toEqual({ fn: "setValue", args: { text: "b", clear: false, perKey: true } });
    expect(document.querySelector("input").value).toBe("ab");
    await cmd("type", { ref: refIn(text, /"N"/) });
    expect(mainCalls.at(-1).args).toEqual({ text: "", clear: true, perKey: false });
  });
});

/** A minimal custom dropdown: click opens a listbox; typing filters it; clicking an option picks it. */
function customCombo(options) {
  document.body.innerHTML = `
    <label for="cb">Location</label><input id="cb" role="combobox" aria-controls="lb" aria-autocomplete="list">
    <span id="chosen"></span><ul id="lb" role="listbox" hidden></ul>`;
  const input = document.getElementById("cb");
  const lb = document.getElementById("lb");
  const render = () => {
    const q = input.value.toLowerCase();
    lb.replaceChildren(
      ...options.filter((o) => o.toLowerCase().includes(q)).map((o) => {
        const li = document.createElement("li");
        li.setAttribute("role", "option");
        li.textContent = o;
        li.addEventListener("click", () => {
          document.getElementById("chosen").textContent = o;
          lb.hidden = true;
        });
        return li;
      }),
    );
  };
  input.addEventListener("click", () => {
    lb.hidden = false;
    render();
  });
  input.addEventListener("input", render);
  const escapes = [];
  input.addEventListener("keydown", (e) => e.key === "Escape" && escapes.push(e));
  return { input, escapes };
}

describe("select", () => {
  it("selects native options by value, and several in a multi-select", async () => {
    const { text } = await page(`
      <select aria-label="One"><option value="us">United States</option><option value="ca">Canada</option></select>
      <select aria-label="Many" multiple><option>Go</option><option>Rust</option><option>Zig</option></select>`);
    await expect(cmd("select", { ref: refIn(text, /"One"/), option: "ca" })).resolves.toMatchObject({ selected: ["Canada"] });
    await expect(cmd("select", { ref: refIn(text, /"Many"/), options: ["go", "zig"] })).resolves.toMatchObject({ selected: ["Go", "Zig"] });
  });

  it("refuses several options on a single select", async () => {
    const { text } = await page('<select aria-label="One"><option>A</option><option>B</option></select>');
    await expect(cmd("select", { ref: refIn(text, /"One"/), options: ["A", "B"] })).rejects.toMatchObject({ message: '"One" accepts one option.' });
  });

  it("opens a custom dropdown and clicks the matching option", async () => {
    const { input } = customCombo(["Berlin", "Boston", "Bogotá"]);
    const snap = (await cmd("snapshot", {})).items.map((i) => i.t).join("\n");
    const res = await cmd("select", { ref: refIn(snap, /"Location"/), option: "boston" });
    expect(res).toMatchObject({ ok: true, target: "Location", selected: ["Boston"] });
    expect(document.getElementById("chosen").textContent).toBe("Boston");
    expect(input.value).toBe(""); // found without typing
  });

  it("types to filter when the option isn't listed yet", async () => {
    const many = Array.from({ length: 5 }, (_, i) => `City ${i}`);
    const { input } = customCombo([...many, "Zürich"]);
    // Only the first five render until the user types.
    input.addEventListener("click", () => [...document.querySelectorAll("#lb li")].slice(5).forEach((li) => li.remove()));
    const snap = (await cmd("snapshot", {})).items.map((i) => i.t).join("\n");
    const res = await cmd("select", { ref: refIn(snap, /"Location"/), option: "Zürich" });
    expect(res.selected).toEqual(["Zürich"]);
    expect(input.value).toBe("Zürich");
  });

  it("reports ambiguous and missing options, and closes the dropdown", async () => {
    const { escapes } = customCombo(["New York", "New Delhi"]);
    const snap = (await cmd("snapshot", {})).items.map((i) => i.t).join("\n");
    const ref = refIn(snap, /"Location"/);
    await expect(cmd("select", { ref, option: "new" })).rejects.toMatchObject({
      code: "E_AMBIGUOUS",
      message: 'Several options match "new" in "Location"',
      data: { available: ["New York", "New Delhi"] },
    });
    await expect(cmd("select", { ref, option: "Paris" })).rejects.toMatchObject({ code: "E_NOT_INTERACTABLE", message: 'No option matching "Paris" in "Location"' });
    expect(escapes.length).toBe(2);
  });

  it("only supports multi-select on native selects", async () => {
    customCombo(["A"]);
    const snap = (await cmd("snapshot", {})).items.map((i) => i.t).join("\n");
    await expect(cmd("select", { ref: refIn(snap, /"Location"/), options: ["A", "B"] })).rejects.toMatchObject({
      message: "Multi-select is only supported on native <select> elements.",
    });
  });
});

describe("check", () => {
  it("does nothing when already in the wanted state", async () => {
    const { text } = await page('<input type="checkbox" aria-label="T" checked>');
    await expect(cmd("check", { ref: refIn(text, /"T"/), checked: true })).resolves.toEqual({ ok: true, target: "T", checked: true, changed: false });
  });

  it("unchecks checkboxes but not radios", async () => {
    const { text } = await page('<input type="checkbox" aria-label="T" checked><input type="radio" aria-label="R" checked>');
    await expect(cmd("check", { ref: refIn(text, /"T"/), checked: false })).resolves.toMatchObject({ checked: false, changed: true });
    await expect(cmd("check", { ref: refIn(text, /"R"/), checked: false })).rejects.toMatchObject({ message: expect.stringMatching(/can't be unchecked/) });
  });

  it("toggles ARIA checkboxes and switches", async () => {
    const { text } = await page('<div role="switch" aria-checked="false" tabindex="0">Dark mode</div>');
    const sw = document.querySelector("[role=switch]");
    sw.addEventListener("click", () => sw.setAttribute("aria-checked", String(sw.getAttribute("aria-checked") !== "true")));
    await expect(cmd("check", { ref: refIn(text, /"Dark mode"/), checked: true })).resolves.toMatchObject({ checked: true, changed: true });
  });

  it("falls back to clicking the label, then gives up", async () => {
    const { text } = await page('<input type="checkbox" id="t"><label for="t">Terms</label><input type="checkbox" id="u"><label for="u">Stuck</label>');
    let first = true;
    document.getElementById("t").addEventListener("click", (e) => {
      if (first) e.preventDefault();
      first = false;
    });
    await expect(cmd("check", { ref: refIn(text, /"Terms"/), checked: true })).resolves.toMatchObject({ checked: true });
    document.getElementById("u").addEventListener("click", (e) => e.preventDefault());
    await expect(cmd("check", { ref: refIn(text, /"Stuck"/), checked: true })).rejects.toMatchObject({ message: expect.stringMatching(/didn't change it/) });
  });
});

describe("fill_field", () => {
  it("dispatches on the field type", async () => {
    const { text } = await page(`
      <label for="a">City</label><input id="a" list="cities"><datalist id="cities"><option>Oslo</option></datalist>
      <label for="b">Size</label><select id="b"><option>S</option><option>M</option></select>
      <label><input type="checkbox" id="c"> Remote</label>
      <label><input type="radio" name="r" id="d"> Yes</label><label><input type="radio" name="r"> No</label>
      <label for="e">Notes</label><textarea id="e"></textarea>`);
    await expect(cmd("fill_field", { ref: refIn(text, /"City"/), value: "Oslo" })).resolves.toMatchObject({ value: "Oslo" });
    await expect(cmd("fill_field", { ref: refIn(text, /"Size"/), value: "M" })).resolves.toMatchObject({ selected: ["M"] });
    await expect(cmd("fill_field", { ref: refIn(text, /"Remote"/), value: "yes" })).resolves.toMatchObject({ checked: true });
    await expect(cmd("fill_field", { ref: refIn(text, /"Remote"/), value: "no" })).resolves.toMatchObject({ checked: false });
    await expect(cmd("fill_field", { ref: refIn(text, /radio "Yes"/), value: true })).resolves.toMatchObject({ checked: true });
    await expect(cmd("fill_field", { ref: refIn(text, /"Notes"/), value: 42 })).resolves.toMatchObject({ value: "42" });
  });

  it("refuses file fields and unknown radio choices", async () => {
    const { text } = await page('<label for="f">CV</label><input type="file" id="f"><div role="radiogroup"><input type="radio" aria-label="A"><input type="radio" aria-label="B"></div>');
    await expect(cmd("fill_field", { ref: refIn(text, /"CV"/), value: "x" })).rejects.toMatchObject({ message: '"CV" is a file field; use browser_upload.' });
    await expect(cmd("fill_field", { ref: refIn(text, /radio "A"/), value: "C" })).rejects.toMatchObject({ code: "E_NOT_INTERACTABLE", data: { available: ["A", "B"] } });
    await expect(cmd("fill_field", { ref: refIn(text, /radio "A"/), value: "b" })).resolves.toMatchObject({ selected: ["B"] });
  });
});

describe("upload", () => {
  /** jsdom only accepts a real FileList for input.files; record what the main world puts there. */
  const stubFiles = (input) => {
    let files = [];
    Object.defineProperty(input, "files", { configurable: true, get: () => files, set: (v) => (files = v) });
    return () => files;
  };
  const pdf = { fileName: "cv.pdf", mimeType: "application/pdf", base64: btoa("%PDF") };

  it("fills a file input, and warns when the type isn't accepted", async () => {
    const { text } = await page('<label for="f">Resume</label><input type="file" id="f" accept=".docx,.doc">');
    const files = stubFiles(document.getElementById("f"));
    const res = await cmd("upload", { ref: refIn(text, /"Resume"/), ...pdf });
    expect(res).toMatchObject({ ok: true, target: "Resume", fileName: "cv.pdf", size: 4, mode: "input", warning: "The field accepts .docx,.doc; the site may reject cv.pdf." });
    expect(files()).toHaveLength(1);
  });

  it("accepts MIME wildcards and exact types", async () => {
    const { text } = await page('<input type="file" aria-label="A" accept="application/*"><input type="file" aria-label="B" accept="application/pdf">');
    for (const i of document.querySelectorAll("input")) stubFiles(i);
    expect((await cmd("upload", { ref: refIn(text, /"A"/), ...pdf })).warning).toBeUndefined();
    expect((await cmd("upload", { ref: refIn(text, /"B"/), ...pdf })).warning).toBeUndefined();
  });

  it("finds the hidden file input behind a drop zone", async () => {
    const { text } = await page('<div><div role="button">Upload resume</div><input type="file" hidden></div>');
    const files = stubFiles(document.querySelector("input"));
    await expect(cmd("upload", { ref: refIn(text, /"Upload resume"/), ...pdf })).resolves.toMatchObject({ mode: "input" });
    expect(files()[0].name).toBe("cv.pdf");
  });

  it("drops on the zone when there's no single nearby input", async () => {
    const { text } = await page('<form><div role="button">Drop files</div></form><input type="file" aria-label="Elsewhere">');
    const drops = [];
    document.querySelector("[role=button]").addEventListener("drop", (e) => drops.push(e.dataTransfer.files[0].name));
    await expect(cmd("upload", { ref: refIn(text, /"Drop files"/), ...pdf })).resolves.toMatchObject({ mode: "drop" });
    expect(drops).toEqual(["cv.pdf"]);
  });

  it("refuses disabled inputs", async () => {
    const { text } = await page('<label for="f">Resume</label><input type="file" id="f">');
    document.getElementById("f").disabled = true;
    await expect(cmd("upload", { ref: refIn(text, /"Resume"/), ...pdf })).rejects.toMatchObject({ message: '"Resume" is disabled' });
  });
});

describe("press_key", () => {
  it("needs approval for Enter that would submit, and submits once approved", async () => {
    await page('<form><input id="q" aria-label="Search"></form>');
    document.getElementById("q").focus();
    await expect(cmd("press_key", { key: "Enter" })).resolves.toEqual({
      needsApproval: true, verb: "press Enter in", target: "Search (submits the form)", reason: "Enter would submit the form",
    });
    expect(submits).toBe(0);
    await expect(cmd("press_key", { key: "Enter", noApproval: true })).rejects.toMatchObject({ code: "E_APPROVAL_DENIED" });
    await expect(cmd("press_key", { key: "Enter", approved: true })).resolves.toMatchObject({ ok: true, key: "Enter", target: "Search" });
    expect(submits).toBe(1);
  });

  it("needs approval for Enter on a consequential button, and clicks plain ones", async () => {
    await page('<button type="button" id="pay">Pay now</button><button type="button" id="more">More</button>');
    document.getElementById("pay").focus();
    await expect(cmd("press_key", { key: "Enter" })).resolves.toMatchObject({ needsApproval: true, verb: "press Enter on", target: "Pay now" });
    let clicks = 0;
    document.getElementById("more").addEventListener("click", () => clicks++);
    document.getElementById("more").focus();
    await cmd("press_key", { key: "Enter" });
    expect(clicks).toBe(1);
  });

  it("presses Enter on the page without approval", async () => {
    await page("<p>nothing focused</p>");
    document.activeElement?.blur?.();
    await expect(cmd("press_key", { key: "Enter" })).resolves.toMatchObject({ ok: true, target: "page" });
  });

  it("moves focus with Tab and Shift+Tab, wrapping around", async () => {
    await page('<input id="a"><button id="b">B</button><a href="/c" id="c">C</a><input type="hidden"><button disabled>D</button>');
    const $ = (id) => document.getElementById(id);
    $("a").focus();
    await cmd("press_key", { key: "Tab" });
    expect(document.activeElement).toBe($("b"));
    await cmd("press_key", { key: "Tab" });
    await cmd("press_key", { key: "Tab" });
    expect(document.activeElement).toBe($("a"));
    await cmd("press_key", { key: "Shift+Tab" });
    expect(document.activeElement).toBe($("c"));
  });

  it("toggles a focused checkbox with Space", async () => {
    await page('<input type="checkbox" id="x">');
    document.getElementById("x").focus();
    await cmd("press_key", { key: "Space" });
    expect(document.getElementById("x").checked).toBe(true);
  });

  it("types printable keys into fields, but not into sensitive ones or with Ctrl/Cmd", async () => {
    await page('<input id="a"><input id="p" type="password">');
    document.getElementById("a").focus();
    await cmd("press_key", { key: "x" });
    await cmd("press_key", { key: "Control+a" });
    await cmd("press_key", { key: "Meta+v" });
    expect(document.getElementById("a").value).toBe("x");
    document.getElementById("p").focus();
    await cmd("press_key", { key: "z" });
    expect(document.getElementById("p").value).toBe("");
  });

  it("sends key events with modifiers, codes and keyCodes, and honours preventDefault", async () => {
    await page('<input id="a">');
    const a = document.getElementById("a");
    a.focus();
    const events = [];
    a.addEventListener("keydown", (e) => {
      events.push({ type: e.type, key: e.key, code: e.code, keyCode: e.keyCode, shift: e.shiftKey, alt: e.altKey });
      e.preventDefault();
    });
    a.addEventListener("keypress", (e) => events.push({ type: e.type }));
    a.addEventListener("keyup", (e) => events.push({ type: e.type, key: e.key }));
    await cmd("press_key", { key: "Shift+Alt+7" });
    await cmd("press_key", { key: "ArrowDown" });
    await cmd("press_key", { key: "+" });
    expect(events).toEqual([
      { type: "keydown", key: "7", code: "Digit7", keyCode: 55, shift: true, alt: true },
      { type: "keyup", key: "7" },
      { type: "keydown", key: "ArrowDown", code: "ArrowDown", keyCode: 40, shift: false, alt: false },
      { type: "keyup", key: "ArrowDown" },
      { type: "keydown", key: "+", code: "", keyCode: 43, shift: false, alt: false },
      { type: "keyup", key: "+" },
    ]);
    expect(a.value).toBe(""); // keydown was prevented
  });
});

describe("scroll", () => {
  it("scrolls the page by direction and amount", async () => {
    scrollCalls.length = 0;
    await expect(cmd("scroll", {})).resolves.toMatchObject({ ok: true, scrollY: Math.round(innerHeight * 0.8) });
    await cmd("scroll", { direction: "up", amount: 100 });
    await cmd("scroll", { direction: "right", amount: 50 });
    await cmd("scroll", { direction: "left", amount: 20 });
    expect(scrollCalls).toEqual([
      { top: Math.round(innerHeight * 0.8), left: 0, behavior: "instant" },
      { top: -100, left: 0, behavior: "instant" },
      { top: 0, left: 50, behavior: "instant" },
      { top: 0, left: -20, behavior: "instant" },
    ]);
  });

  it("scrolls an element into view", async () => {
    const { text } = await page("<button>Far away</button>");
    let calls = 0;
    document.querySelector("button").scrollIntoView = () => calls++;
    await expect(cmd("scroll", { ref: refIn(text, /"Far away"/) })).resolves.toEqual({ ok: true, target: "Far away" });
    expect(calls).toBe(1);
  });
});

describe("wait_for", () => {
  it("waits for text to go away", async () => {
    await page("<p id=l>Loading…</p>");
    setTimeout(() => document.getElementById("l").remove(), 50);
    await expect(cmd("wait_for", { textGone: "loading", timeoutMs: 2000 })).resolves.toMatchObject({ ok: true });
  });

  it("waits for an element to become visible, and fails on stale refs", async () => {
    const { text } = await page('<button id="b">Later</button>');
    const ref = refIn(text, /"Later"/);
    const b = document.getElementById("b");
    b.hidden = true;
    setTimeout(() => (b.hidden = false), 50);
    await expect(cmd("wait_for", { ref, timeoutMs: 2000 })).resolves.toMatchObject({ ok: true });
    b.remove();
    await expect(cmd("wait_for", { ref, timeoutMs: 2000 })).rejects.toMatchObject({ code: "E_STALE_REF" });
  });

  it("clamps the timeout to at least 100 ms", async () => {
    await page("<p>x</p>");
    const start = Date.now();
    await expect(cmd("wait_for", { text: "never", timeoutMs: 1 })).rejects.toMatchObject({ code: "E_TIMEOUT", message: "Timed out after 100 ms" });
    expect(Date.now() - start).toBeGreaterThanOrEqual(90);
  });
});

describe("get_text and rect", () => {
  it("returns the page text with runs of blank lines collapsed", async () => {
    document.body.innerHTML = "<p>One</p>\n\n\n\n<p>Two</p>";
    await expect(cmd("get_text")).resolves.toEqual({ text: "One\n\nTwo", truncated: false, url: location.href, origin: location.origin });
  });

  it("returns one element's text, and truncates at 50,000 characters", async () => {
    const { text } = await page(`<button>Short</button><section aria-label="Big"><button>${"y".repeat(60_000)}</button></section>`);
    await expect(cmd("get_text", { ref: refIn(text, /"Short"/) })).resolves.toMatchObject({ text: "Short", truncated: false });
    const big = await cmd("get_text");
    expect(big.truncated).toBe(true);
    expect(big.text).toHaveLength(50_000);
  });

  it("measures an element after scrolling it into view", async () => {
    const { text } = await page("<button>Box</button>");
    document.querySelector("button").getBoundingClientRect = () => ({ left: 10, top: 20, width: 30, height: 40 });
    await expect(cmd("rect", { ref: refIn(text, /"Box"/) })).resolves.toEqual({ x: 10, y: 20, width: 30, height: 40, viewportWidth: innerWidth, viewportHeight: innerHeight });
  });
});

describe("find", () => {
  it("matches labels against controls only, and text against buttons and links", async () => {
    await page('<label for="e">Email</label><input id="e"><button>Email us</button>');
    const byLabel = await cmd("find", { label: "Email" });
    expect(byLabel.matches.map((m) => m.role)).toEqual(["textbox"]);
    const byText = await cmd("find", { text: "email us" });
    expect(byText.matches.map((m) => [m.role, m.name])).toEqual([["button", "Email us"]]);
  });

  it("prefers exact names over partial ones", async () => {
    await page("<button>Next</button><button>Next step</button>");
    const res = await cmd("find", { text: "Next" });
    expect(res.matches.map((m) => m.name)).toEqual(["Next"]);
  });

  it("falls back to button-like elements for text, and caps matches at 10", async () => {
    await page('<div style="cursor:pointer">Save</div>' + "<button>Item</button>".repeat(12));
    expect((await cmd("find", { text: "save" })).matches).toEqual([{ ref: expect.stringMatching(/^e\d+$/), role: "button", name: "Save" }]);
    const many = await cmd("find", { text: "item" });
    expect(many.total).toBe(12);
    expect(many.matches).toHaveLength(10);
    expect((await cmd("find", { label: "save" })).matches).toEqual([]);
  });
});
