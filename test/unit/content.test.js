// @vitest-environment jsdom
// Loads the real content scripts into jsdom with a stub `browser`, against a React form that uses
// controlled inputs and react-select. Main-world calls run in the same window (jsdom has one world).
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import Select from "react-select";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mainSelectOptions, mainSetValue, mainUpload } from "../../extension/content/main-world-setter.js";

const h = React.createElement;
const listeners = [];
const sentToBackground = [];
let submitted = 0;
let refCounter = 1;

globalThis.IS_REACT_ACT_ENVIRONMENT = false;
globalThis.ClaudeBridge = { settings: { checkSize: false } }; // jsdom has no layout
Element.prototype.scrollIntoView = function () {};
if (!globalThis.PointerEvent) globalThis.PointerEvent = class extends MouseEvent {};
globalThis.browser = {
  runtime: {
    onMessage: { addListener: (fn) => listeners.push(fn) },
    sendMessage: async (msg) => {
      if (msg.type === "main") {
        const fn = { setValue: mainSetValue, selectOptions: mainSelectOptions, upload: mainUpload }[msg.fn];
        return fn(msg.nonce, msg.args);
      }
      sentToBackground.push(msg);
      return { ok: true };
    },
    getFrameId: () => -1,
  },
};

/** Sends a command the way the background script does and unwraps the envelope. */
async function cmd(name, params = {}) {
  for (const l of listeners) {
    const r = l({ to: "content", cmd: name, nextRef: refCounter, ...params }, {});
    if (r) {
      const res = await r;
      if (!res.ok) throw Object.assign(new Error(res.error.message), res.error);
      if (typeof res.result?.nextRef === "number") refCounter = res.result.nextRef;
      return res.result;
    }
  }
  throw new Error("no listener");
}

function App() {
  const [first, setFirst] = useState("");
  const [country, setCountry] = useState(null);
  return h(
    "main",
    null,
    h("h1", null, "Sr. Software Engineer - Backend"),
    h("p", null, "We are hiring. ", h("b", null, "Apply"), " below."),
    h(
      "form",
      { "aria-label": "Apply for this job", onSubmit: (e) => { e.preventDefault(); submitted++; } },
      h("label", { htmlFor: "first" }, "First Name*"),
      h("input", { id: "first", required: true, value: first, onChange: (e) => setFirst(e.target.value) }),
      h("output", { id: "first-state" }, first),
      h("label", { htmlFor: "email" }, "Email*"),
      h("input", { id: "email", type: "email", required: true, defaultValue: "" }),
      h("label", { id: "country-label", htmlFor: "country-input" }, "Country*"),
      h(Select, {
        inputId: "country-input",
        "aria-labelledby": "country-label",
        options: [{ value: "us", label: "United States" }, { value: "ca", label: "Canada" }, { value: "mx", label: "Mexico" }],
        value: country,
        onChange: setCountry,
      }),
      h("output", { id: "country-state" }, country?.label ?? ""),
      h("label", { htmlFor: "pw" }, "Password"),
      h("input", { id: "pw", type: "password", defaultValue: "hunter2" }),
      h("label", { htmlFor: "years" }, "Years of experience"),
      h("select", { id: "years", defaultValue: "" }, h("option", { value: "" }, "Select..."), h("option", { value: "a" }, "0-5"), h("option", { value: "b" }, "10+ years")),
      h("fieldset", null, h("legend", null, "Willing to relocate?"),
        h("label", null, h("input", { type: "radio", name: "reloc", value: "y" }), "Yes"),
        h("label", null, h("input", { type: "radio", name: "reloc", value: "n" }), "No")),
      h("label", null, h("input", { type: "checkbox", id: "terms" }), "I agree to the privacy notice"),
      h("label", { htmlFor: "gender" }, "Gender"),
      h("select", { id: "gender" }, h("option", null, "Decline to self identify"), h("option", null, "Female"), h("option", null, "Male")),
      h("div", { style: { display: "none" } }, h("input", { id: "hidden-field", "aria-label": "Hidden field" })),
      h("div", { "aria-hidden": "true" }, h("button", { type: "button" }, "Invisible")),
      h("button", { type: "button", id: "sneaky", onClick: (e) => e.currentTarget.form.requestSubmit() }, "Next"),
      h("button", { type: "submit" }, "Submit application"),
    ),
  );
}

let snap;
const refOf = (re) => {
  const line = snap.items.map((i) => i.t).find((t) => re.test(t));
  if (!line) throw new Error(`no line matching ${re}\n${snap.items.map((i) => i.t).join("\n")}`);
  return line.match(/\[ref=(e\d+)\]/)[1];
};

beforeAll(async () => {
  document.body.innerHTML = '<div id="root"></div>';
  createRoot(document.getElementById("root")).render(h(App));
  await new Promise((r) => setTimeout(r, 50));
  await import("../../extension/content/common.js");
  await import("../../extension/content/refs.js");
  await import("../../extension/content/snapshot.js");
  await import("../../extension/content/approval.js");
  await import("../../extension/content/actions.js");
  snap = await cmd("snapshot", { includeText: true, charLimit: 25000 });
});

afterAll(() => {
  document.body.innerHTML = "";
});

describe("snapshot", () => {
  it("renders the outline from SPEC 6.1", () => {
    const text = snap.items.map((i) => "  ".repeat(i.d) + i.t).join("\n");
    expect(text).toContain('- heading "Sr. Software Engineer - Backend" [level=1]');
    expect(text).toContain('- form "Apply for this job"');
    expect(text).toMatch(/- textbox "First Name\*" \[ref=e\d+\] \[required\]/);
    expect(text).toMatch(/- textbox "Email\*" \[ref=e\d+\] \[required\] \[type=email\]/);
    expect(text).toMatch(/- combobox "Country\*" \[ref=e\d+\].*value="Select\.\.\."/);
    expect(text).toMatch(/- textbox "Password" \[ref=e\d+\] \[type=password\] value=\[redacted\]/);
    expect(text).toMatch(/- combobox "Years of experience" \[ref=e\d+\] value="Select\.\.\." \[options: Select\.\.\. \| 0-5 \| 10\+ years\]/);
    expect(text).toMatch(/- group "Willing to relocate\?"/);
    expect(text).toMatch(/- radio "Yes" \[ref=e\d+\]/);
    expect(text).toMatch(/- button "Submit application" \[ref=e\d+\] \[consequential\]/);
    expect(text).toMatch(/- text "We are hiring\. Apply below\."/);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("Hidden field");
    expect(text).not.toContain("Invisible");
    // Labels used as names aren't repeated as text.
    expect(text).not.toMatch(/- text "First Name\*"/);
  });

  it("keeps refs stable across snapshots", async () => {
    const again = await cmd("snapshot", { includeText: false });
    const first = (s) => s.items.map((i) => i.t).find((t) => t.includes('"First Name*"'));
    expect(first(again)).toBe(first(snap));
    expect(again.items.filter((i) => i.t.startsWith('- text "')).map((i) => i.t)).toEqual([]);
  });
});

describe("actions", () => {
  it("types into a React-controlled input and React sees it", async () => {
    const res = await cmd("type", { ref: refOf(/"First Name\*"/), text: "Jane", clear: true });
    expect(res).toMatchObject({ ok: true, value: "Jane", target: "First Name*" });
    expect(document.getElementById("first-state").textContent).toBe("Jane");
    const again = await cmd("type", { ref: refOf(/"First Name\*"/), text: "Doug", clear: true, perKey: true });
    expect(again.value).toBe("Doug");
    expect(document.getElementById("first-state").textContent).toBe("Doug");
  });

  it("selects a react-select option", async () => {
    const res = await cmd("select", { ref: refOf(/combobox "Country\*"/), option: "canada" });
    expect(res).toMatchObject({ ok: true, selected: ["Canada"] });
    expect(document.getElementById("country-state").textContent).toBe("Canada");
  });

  it("selects native options by text", async () => {
    const res = await cmd("select", { ref: refOf(/"Years of experience"/), option: "10+ years" });
    expect(res.selected).toEqual(["10+ years"]);
    expect(document.getElementById("years").value).toBe("b");
  });

  it("refuses password fields", async () => {
    await expect(cmd("type", { ref: refOf(/"Password"/), text: "x" })).rejects.toMatchObject({ code: "E_REFUSED_SENSITIVE" });
  });

  it("asks for approval before clicking submit, and only submits once approved", async () => {
    await cmd("type", { ref: refOf(/"Email\*"/), text: "jane@example.com" }); // required, or the form won't submit
    const ref = refOf(/"Submit application"/);
    const res = await cmd("click", { ref });
    expect(res).toMatchObject({ needsApproval: true, verb: "click", target: "Submit application" });
    expect(submitted).toBe(0);
    const ok = await cmd("click", { ref, approved: true });
    expect(ok.ok).toBe(true);
    expect(submitted).toBe(1);
  });

  it("treats Enter in a field as consequential", async () => {
    document.getElementById("first").focus();
    const res = await cmd("press_key", { key: "Enter" });
    expect(res).toMatchObject({ needsApproval: true });
    expect(submitted).toBe(1);
  });

  it("blocks unapproved submissions that a page script starts right after an agent click", async () => {
    sentToBackground.length = 0;
    const res = await cmd("click", { ref: refOf(/button "Next"/) });
    expect(res.blockedSubmit).toBe(true);
    expect(submitted).toBe(1);
    expect(sentToBackground.some((m) => m.type === "blocked_submit")).toBe(true);
  });

  it("fills radios by label and checkboxes by boolean", async () => {
    const radio = await cmd("fill_field", { ref: refOf(/radio "Yes"/), value: "No" });
    expect(radio.selected).toEqual(["No"]);
    expect(document.querySelector('input[value="n"]').checked).toBe(true);
    const box = await cmd("fill_field", { ref: refOf(/checkbox "I agree/), value: true });
    expect(box.checked).toBe(true);
    expect(document.getElementById("terms").checked).toBe(true);
  });

  it("finds elements by label and reports ambiguity", async () => {
    const found = await cmd("find", { label: "email" });
    expect(found.matches).toHaveLength(1);
    expect(found.matches[0].name).toBe("Email*");
    const many = await cmd("find", { text: "e" });
    expect(many.matches.length).toBeGreaterThan(1);
  });

  it("returns E_STALE_REF for removed elements", async () => {
    const extra = document.createElement("button");
    extra.textContent = "Temporary";
    document.body.append(extra);
    const s = await cmd("snapshot", {});
    const ref = s.items.map((i) => i.t).find((t) => t.includes("Temporary")).match(/\[ref=(e\d+)\]/)[1];
    extra.remove();
    await expect(cmd("click", { ref })).rejects.toMatchObject({ code: "E_STALE_REF" });
  });

  it("waits for text and can be cancelled", async () => {
    setTimeout(() => document.body.append(Object.assign(document.createElement("p"), { textContent: "Thanks for applying" })), 100);
    const ok = await cmd("wait_for", { text: "thanks for applying", timeoutMs: 2000 });
    expect(ok.ok).toBe(true);
    const pending = cmd("wait_for", { text: "never appears", timeoutMs: 5000 });
    setTimeout(() => cmd("cancel"), 50);
    await expect(pending).rejects.toMatchObject({ code: "E_STOPPED" });
    await expect(cmd("wait_for", { text: "never appears", timeoutMs: 150 })).rejects.toMatchObject({ code: "E_TIMEOUT" });
  });

  it("shows the approval prompt and times out without a real click", async () => {
    const res = await cmd("approve", { verb: "click", target: "Submit application", host: "example.com", timeoutMs: 150 });
    expect(res.decision).toBe("timeout");
    expect(document.querySelector("claude-bridge-approval")).toBeNull();
  });
});

describe("form_fields (instruction mode)", () => {
  it("lists fields with labels, kinds, options and groups radios", async () => {
    const { fields } = await cmd("form_fields", {});
    const by = (label) => fields.find((f) => f.label === label);
    expect(by("First Name*")).toMatchObject({ kind: "text", required: true, value: "Doug" });
    expect(by("Email*")).toMatchObject({ kind: "email" });
    expect(by("Country*")).toMatchObject({ kind: "combobox" });
    expect(by("Years of experience")).toMatchObject({ kind: "select", options: ["Select...", "0-5", "10+ years"] });
    expect(by("Willing to relocate?")).toMatchObject({ kind: "radio", options: ["Yes", "No"], value: "No" });
    expect(by("Gender")).toMatchObject({ kind: "select" });
    expect(fields.some((f) => f.label === "Password")).toBe(false); // sensitive fields are never offered
  });
});
