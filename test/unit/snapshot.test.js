// @vitest-environment jsdom
// Page snapshots and form fields (SPEC 6.1, 10.4) beyond the job-form basics in content.test.js: shadow DOM,
// frames, CAPTCHAs, redaction, control attributes, landmarks, list collapsing and truncation.
import { beforeAll, describe, expect, it } from "vitest";
import { cmd, frameIds, loadContentScripts, page, refIn, snapshotText } from "../helpers/content-env.js";

/** Refs come from a tab-wide counter, so exact comparisons ignore their numbers. */
const noRefs = (text) => text.replace(/\[ref=e\d+\]/g, "[ref]");

beforeAll(async () => {
  await loadContentScripts();
});

describe("structure", () => {
  it("renders headings, text, alerts, images and landmarks with depth", async () => {
    const { text } = await page(`
      <header><nav aria-label="Main"><a href="/">Home</a></nav></header>
      <main aria-label="Content">
        <h2>Openings</h2><div role="heading" aria-level="4">Sub</div>
        <p>Hello <b>there</b>, <a href="/x">friend</a>.</p>
        <div role="alert">Fix the errors below</div><div role="status">Saved</div><div aria-live="assertive">Hurry</div>
        <img alt="Team photo"><img alt="">
        <section aria-label="Benefits"><p>Dental</p></section><section><p>Unnamed</p></section>
        <aside aria-label="Help"></aside>
      </main>
      <footer>© Co</footer>`);
    expect(noRefs(text)).toBe(
      [
        "- banner",
        '  - navigation "Main"',
        '    - link "Home" [ref]',
        '- main "Content"',
        '  - heading "Openings" [level=2]',
        '  - heading "Sub" [level=4]',
        '  - text "Hello there ,"',
        '  - link "friend" [ref]',
        '  - text "."',
        '  - alert "Fix the errors below"',
        '  - alert "Saved"',
        '  - alert "Hurry"',
        '  - img "Team photo"',
        '  - region "Benefits"',
        '    - text "Dental"',
        '  - text "Unnamed"',
        '  - complementary "Help"',
        "- contentinfo",
        '  - text "© Co"',
      ].join("\n"),
    );
  });

  it("leaves out images and text blocks when includeText is false", async () => {
    document.body.innerHTML = '<p>Words</p><img alt="Pic"><h1>Title</h1>';
    const { text } = await snapshotText({ includeText: false });
    expect(text).toBe('- heading "Title" [level=1]');
  });

  it("only names list-like groups when they have a name", async () => {
    const { text } = await page('<ul><li><a href="/a">A</a></li></ul><div role="radiogroup" aria-label="Size"><input type="radio" aria-label="S"></div>');
    expect(noRefs(text)).toBe('- link "A" [ref]\n- radiogroup "Size"\n  - radio "S" [ref]');
  });

  it("skips hidden content, scripts and the bridge's own UI", async () => {
    const { text } = await page(`
      <p hidden>hidden</p><p style="display:none">none</p><p style="visibility:hidden">invisible</p>
      <div inert><button>Inert</button></div><script>var x = "script"</script><style>p{}</style><noscript>ns</noscript>
      <template><button>tpl</button></template><div data-tabwright-ui><button>Ours</button></div><p>shown</p>`);
    expect(text).toBe('- text "shown"');
  });

  it("doesn't repeat label, legend or aria-labelledby text", async () => {
    const { text } = await page(`
      <p id="q">How did you hear about us?</p><input aria-labelledby="q">
      <fieldset><legend>Remote?</legend><label><input type="radio" name="r"> Yes</label></fieldset>
      <label for="n">Name</label><input id="n">`);
    expect(noRefs(text)).toBe(
      ['- textbox "How did you hear about us?" [ref]', '- group "Remote?"', '  - radio "Yes" [ref]', '- textbox "Name" [ref]'].join("\n"),
    );
  });

  it("names radios without labels by their surrounding text", async () => {
    const { text } = await page('<div><input type="radio" name="x"> Option A</div>');
    expect(text).toMatch(/- radio "Option A" \[ref=e\d+\]/);
  });
});

describe("root option", () => {
  it("limits the snapshot to an element's subtree", async () => {
    const { text } = await page('<div role="listbox" aria-label="Pick"><div role="option">One</div><div role="option" aria-selected="true">Two</div></div><button>Outside</button>');
    const root = refIn(text, /listbox "Pick"/);
    const sub = await snapshotText({ root });
    expect(sub.text).toMatch(/^- listbox "Pick" \[ref=e\d+\]\n {2}- option "One" \[ref=e\d+\]\n {2}- option "Two" \[ref=e\d+\] \[selected\]$/);
    expect(sub.text).not.toContain("Outside");
    await expect(cmd("snapshot", { root: "e999" })).rejects.toMatchObject({ code: "E_STALE_REF" });
  });
});

describe("controls", () => {
  it("shows control state as attributes", async () => {
    const { text } = await page(`
      <input aria-label="A" required><input aria-label="B" aria-required="true" disabled><input aria-label="C" readonly value="ro">
      <input aria-label="D" type="tel"><textarea aria-label="E">multi</textarea>
      <input type="checkbox" aria-label="F" checked><div role="switch" aria-label="G" aria-checked="true"></div>
      <div role="menuitemcheckbox" aria-checked="true">H</div>
      <button aria-expanded="true">I</button><div role="tab" aria-selected="true">J</div>
      <input type="file" aria-label="K" accept=".pdf, .docx" multiple>
      <input aria-label="L" aria-invalid="true" aria-describedby="err hint"><span id="err">Required</span><span id="hint" hidden>secret hint</span>
      <input type="range" aria-label="M" value="30"><div role="spinbutton" aria-label="N" aria-valuenow="4"></div>
      <div contenteditable="true" aria-label="O">Rich <b>text</b></div>`);
    const lines = text.split("\n");
    const line = (name) => lines.find((l) => l.includes(`"${name}"`));
    expect(line("A")).toMatch(/\[ref=e\d+\] \[required\]$/);
    expect(line("B")).toMatch(/\[required\] \[disabled\]$/);
    expect(line("C")).toMatch(/\[readonly\] value="ro"$/);
    expect(line("D")).toMatch(/\[type=tel\]$/);
    expect(line("E")).toMatch(/^- textbox "E" \[ref=e\d+\] \[multiline\] value="multi"$/);
    expect(line("F")).toMatch(/^- checkbox "F" \[ref=e\d+\] \[checked\]$/);
    expect(line("G")).toMatch(/^- switch "G" \[ref=e\d+\] \[checked\]$/);
    expect(line("H")).toMatch(/^- menuitemcheckbox "H" \[ref=e\d+\] \[checked\]$/);
    expect(line("I")).toMatch(/\[expanded\]$/);
    expect(line("J")).toMatch(/^- tab "J" \[ref=e\d+\] \[selected\]$/);
    expect(line("K")).toMatch(/^- file "K" \[ref=e\d+\] \[accept=\.pdf,\.docx\] \[multiple\]$/);
    expect(line("L")).toMatch(/\[invalid\] error="Required"$/);
    expect(line("M")).toMatch(/^- slider "M" \[ref=e\d+\] value="30"$/);
    expect(line("N")).toMatch(/^- spinbutton "N" \[ref=e\d+\] value="4"$/);
    expect(line("O")).toMatch(/^- textbox "O" \[ref=e\d+\] value="Rich text"$/);
  });

  it("marks consequential buttons and links", async () => {
    const { text } = await page('<form><button>Next</button></form><button type="button">Delete</button><a href="/checkout">Continue</a><a href="/about">About</a>');
    expect(text).toMatch(/- button "Next" \[ref=e\d+\] \[consequential\]/);
    expect(text).toMatch(/- button "Delete" \[ref=e\d+\] \[consequential\]/);
    expect(text).toMatch(/- link "Continue" \[ref=e\d+\] \[consequential\]/);
    expect(text).toMatch(/- link "About" \[ref=e\d+\]$/m);
  });

  it("caps select options at 30 and shows multi-select values", async () => {
    const opts = Array.from({ length: 35 }, (_, i) => `<option>O${i}</option>`).join("");
    const { text } = await page(`<select aria-label="Many">${opts}</select><select aria-label="Multi" multiple><option selected>A</option><option>B</option><option selected>C</option></select>`);
    expect(text).toMatch(/\[options: O0 \| O1 .* \| O29 \| … \(5 more\)\]/);
    expect(text).not.toContain("O30");
    expect(text).toMatch(/- listbox "Multi" \[ref=e\d+\] value="A, C" \[options: A \| B \| C\]/);
  });

  it("shows a custom combobox's displayed value", async () => {
    const { text } = await page('<div><div class="value">Canada</div><input role="combobox" aria-label="Country"></div><div role="combobox" aria-label="Plain">Picked</div>');
    expect(text).toMatch(/- combobox "Country" \[ref=e\d+\] value="Canada"/);
    expect(text).toMatch(/- combobox "Plain" \[ref=e\d+\] value="Picked"/);
  });

  it("shows file names chosen in a file input", async () => {
    document.body.innerHTML = '<input type="file" aria-label="Resume">';
    Object.defineProperty(document.querySelector("input"), "files", { value: [{ name: "cv.pdf" }, { name: "cover.pdf" }] });
    const { text } = await snapshotText();
    expect(text).toMatch(/- file "Resume" \[ref=e\d+\] value="cv.pdf, cover.pdf"/);
  });

  it("treats button-like divs as buttons, and lists open custom listboxes", async () => {
    const { text } = await page(`
      <div style="cursor:pointer">Save</div>
      <div style="cursor:pointer"><span style="cursor:pointer">Outer only</span></div>
      <ul role="listbox" aria-label="Opts"><li role="option">First</li></ul>`);
    expect(text).toMatch(/^- button "Save" \[ref=e\d+\]$/m);
    expect(text.match(/Outer only/g)).toHaveLength(1);
    expect(text).toMatch(/- listbox "Opts" \[ref=e\d+\]\n {2}- option "First" \[ref=e\d+\]/);
  });
});

describe("redaction (SPEC 8.3)", () => {
  it("never shows sensitive values", async () => {
    const { text } = await page(`
      <input type="password" aria-label="Password" value="hunter2">
      <input autocomplete="cc-number" aria-label="Card" value="4111111111111111">
      <input autocomplete="one-time-code" aria-label="Code" value="123456">
      <input aria-label="CVV" value="999">
      <input aria-label="Social security number" value="078-05-1120">
      <input aria-label="Name" value="Jane">`);
    for (const secret of ["hunter2", "4111111111111111", "123456", "999", "078-05-1120"]) expect(text).not.toContain(secret);
    expect(text.match(/value=\[redacted\]/g)).toHaveLength(5);
    expect(text).toContain('value="Jane"');
  });

  it("refuses to type or fill them", async () => {
    const { text } = await page('<input autocomplete="cc-number" aria-label="Card"><input aria-label="CVV">');
    await expect(cmd("type", { ref: refIn(text, /"Card"/), text: "4111" })).rejects.toMatchObject({ code: "E_REFUSED_SENSITIVE" });
    await expect(cmd("fill_field", { ref: refIn(text, /"CVV"/), value: "123" })).rejects.toMatchObject({ code: "E_REFUSED_SENSITIVE" });
    expect(document.querySelector("input").value).toBe("");
  });

  it("describes a field's sensitivity", async () => {
    const { text } = await page('<input aria-label="Card number"><button>Go</button>');
    await expect(cmd("describe", { ref: refIn(text, /"Card number"/) })).resolves.toEqual({ role: "textbox", tag: "input", name: "Card number", sensitive: true });
    await expect(cmd("describe", { ref: refIn(text, /"Go"/) })).resolves.toEqual({ role: "button", tag: "button", name: "Go", sensitive: false });
  });
});

describe("shadow DOM", () => {
  it("walks open shadow roots and slots", async () => {
    document.body.innerHTML = '<x-card><span slot="title">Slotted title</span><button>Light button</button></x-card><x-plain></x-plain>';
    const card = document.querySelector("x-card");
    card.attachShadow({ mode: "open" }).innerHTML = '<div><slot name="title"></slot></div><label for="s">Shadow field</label><input id="s"><slot></slot>';
    document.querySelector("x-plain").attachShadow({ mode: "open" }).innerHTML = '<slot><button>Fallback</button></slot>';
    const { text } = await snapshotText();
    expect(text).toMatch(/^- text "Slotted title"$/m);
    expect(text).toMatch(/- textbox "Shadow field" \[ref=e\d+\]/);
    expect(text).toMatch(/- button "Light button" \[ref=e\d+\]/);
    expect(text).toMatch(/- button "Fallback" \[ref=e\d+\]/);
    const ref = refIn(text, /"Shadow field"/);
    await cmd("type", { ref, text: "in shadow" });
    expect(card.shadowRoot.getElementById("s").value).toBe("in shadow");
  });

  it("reports closed shadow roots as opaque", async () => {
    document.body.innerHTML = "<x-closed></x-closed>";
    const x = document.querySelector("x-closed");
    x.attachShadow({ mode: "closed" }).innerHTML = "<button>Hidden from us</button>";
    Object.defineProperty(x, "openOrClosedShadowRoot", { value: {} }); // Firefox exposes this to extensions
    const { text } = await snapshotText();
    expect(text).toBe("- opaque x-closed (closed shadow root)");
  });
});

describe("frames", () => {
  it("returns placeholders for frames the background script can descend into", async () => {
    document.body.innerHTML = '<p>Before</p><iframe src="https://forms.test/embed" title="Application"></iframe><iframe name="ads" src="https://ads.test/"></iframe>';
    const [app, ads] = document.querySelectorAll("iframe");
    frameIds.set(app, 7);
    const { snap } = await snapshotText();
    expect(snap.items).toEqual([
      { d: 0, t: '- text "Before"' },
      { d: 0, frameId: 7, src: "https://forms.test/embed", title: "Application" },
      { d: 0, t: '- frame "ads" (unavailable)' },
    ]);
    frameIds.delete(app);
    void ads;
  });

  it("marks CAPTCHAs for the user instead of descending", async () => {
    document.body.innerHTML = '<iframe src="https://www.google.com/recaptcha/api2/anchor"></iframe>';
    frameIds.set(document.querySelector("iframe"), 9);
    const { snap, text } = await snapshotText();
    expect(text).toBe("- captcha (user must complete)");
    expect(snap.items.some((i) => i.frameId !== undefined)).toBe(false);
  });

  it("lists frames for form_fields", async () => {
    document.body.innerHTML = '<input aria-label="Top"><iframe src="https://forms.test/"></iframe>';
    frameIds.set(document.querySelector("iframe"), 3);
    const res = await cmd("form_fields");
    expect(res.frames).toEqual([3]);
    expect(res.fields.map((f) => f.label)).toEqual(["Top"]);
  });
});

describe("size limits", () => {
  it("collapses long lists when the snapshot is too big, keeping refs valid", async () => {
    const items = Array.from({ length: 200 }, (_, i) => `<li><a href="/job/${i}">Job number ${i} with a fairly long title to fill space</a></li>`).join("");
    document.body.innerHTML = `<ul>${items}</ul><button>After</button>`;
    const { snap, text } = await snapshotText({ charLimit: 3000 });
    expect(text).toContain("- … (190 more items)");
    expect(text).toContain('link "Job number 9 ');
    expect(text).not.toContain('"Job number 10 ');
    expect(text).toMatch(/- button "After"/);
    expect(snap.truncated).toBe(false);
    await expect(cmd("click", { ref: refIn(text, /"After"/) })).resolves.toMatchObject({ ok: true });
  });

  it("marks the snapshot truncated when even collapsing isn't enough", async () => {
    document.body.innerHTML = Array.from({ length: 300 }, (_, i) => `<p>Paragraph ${i} ${"lorem ipsum ".repeat(5)}</p>`).join("");
    const { snap } = await snapshotText({ charLimit: 2000 });
    expect(snap.truncated).toBe(true);
    expect(snap.items.length).toBeLessThan(300);
  });

  it("truncates long text and names", async () => {
    const { text } = await page(`<p>${"word ".repeat(100)}</p><button>${"b".repeat(200)}</button>`);
    const [p, b] = text.split("\n");
    expect(p.length).toBeLessThan(220);
    expect(p).toMatch(/…"$/);
    expect(b).toMatch(/^- button "b{149}…"/);
  });

  it("reports page info and allocated refs", async () => {
    document.title = "Apply";
    const { snap } = await page("<button>One</button><button>Two</button>");
    expect(snap).toMatchObject({ title: "Apply", url: location.href, origin: location.origin, truncated: false });
    expect(snap.newRefs).toHaveLength(2);
    expect(snap.nextRef).toBe(Number(snap.newRefs[1].slice(1)) + 1);
  });
});

describe("form_fields", () => {
  it("prefixes grouped checkboxes with the group label and reports file accept", async () => {
    document.body.innerHTML = `
      <fieldset><legend>Languages</legend><label><input type="checkbox" checked> Go</label><label><input type="checkbox"> Rust</label></fieldset>
      <label><input type="checkbox"> Subscribe</label>
      <label for="cv">Resume</label><input type="file" id="cv" accept=".pdf">
      <label for="cl">Cover letter</label><textarea id="cl" required></textarea>
      <div role="radiogroup" aria-label="Size"><input type="radio" aria-label="S"><input type="radio" aria-label="M" checked></div>`;
    const { fields } = await cmd("form_fields");
    expect(fields).toEqual([
      expect.objectContaining({ label: "Languages: Go", kind: "checkbox", value: "true" }),
      expect.objectContaining({ label: "Languages: Rust", kind: "checkbox", value: "false" }),
      expect.objectContaining({ label: "Subscribe", kind: "checkbox" }),
      expect.objectContaining({ label: "Resume", kind: "file", accept: ".pdf" }),
      expect.objectContaining({ label: "Cover letter", kind: "textarea", required: true }),
      expect.objectContaining({ label: "Size", kind: "radio", options: ["S", "M"], value: "M" }),
    ]);
  });
});

describe("live regions", () => {
  it("reads a role-less assertive live region as an alert, unless it wraps controls", async () => {
    const { text } = await page('<div aria-live="assertive">Email is required</div><div aria-live="assertive"><label for="z">Zip</label><input id="z"></div><div aria-live="polite">Saved</div>');
    expect(noRefs(text)).toBe(['- alert "Email is required"', '- textbox "Zip" [ref]', '- text "Saved"'].join("\n"));
  });
});
