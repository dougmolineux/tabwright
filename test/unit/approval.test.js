// @vitest-environment jsdom
// The in-page approval prompt (SPEC 8.2): closed shadow root, Deny focused, only trusted clicks count,
// re-attached if the page removes it. Plus target highlighting and review annotations.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cmd, loadContentScripts, page, refIn, shadowRoots, snapshotText } from "../helpers/content-env.js";

// jsdom can't make trusted events, so keep the prompt's own click handlers and call them as a real click would.
const clickHandlers = new Map(); // button -> [fn]
const addEventListener = HTMLButtonElement.prototype.addEventListener;
HTMLButtonElement.prototype.addEventListener = function (type, fn, opts) {
  if (type === "click") clickHandlers.set(this, [...(clickHandlers.get(this) ?? []), fn]);
  return addEventListener.call(this, type, fn, opts);
};
function trustedClick(button) {
  let stopped = false;
  for (const fn of clickHandlers.get(button) ?? []) fn({ isTrusted: true, stopPropagation: () => (stopped = true) });
  return stopped;
}

let CB;
const tick = () => new Promise((r) => setTimeout(r, 0));

/** Starts a prompt and returns its parts, as seen from inside the closed root. */
async function prompt(params = {}) {
  const before = shadowRoots.length;
  const decision = cmd("approve", { verb: "click", target: "Submit application", host: "jobs.test", timeoutMs: 60_000, ...params });
  await tick();
  const entry = shadowRoots.slice(before).find((s) => s.host.tagName === "TABWRIGHT-APPROVAL");
  const [allow, deny] = entry.root.querySelectorAll("button");
  return { decision, host: entry.host, root: entry.root, mode: entry.mode, allow, deny };
}

beforeAll(async () => {
  CB = await loadContentScripts();
});

afterEach(() => {
  CB.cancelApproval();
  document.body.innerHTML = "";
});

describe("approval prompt", () => {
  it("is drawn in a closed shadow root the page can't read", async () => {
    const p = await prompt();
    expect(p.mode).toBe("closed");
    expect(p.host.isConnected).toBe(true);
    expect(p.host.shadowRoot).toBeNull();
    expect(p.host.textContent).toBe("");
    expect(p.host.hasAttribute("data-tabwright-ui")).toBe(true);
    expect(document.body.textContent).not.toContain("Submit application");
    const box = p.root.querySelector(".box");
    expect(box.getAttribute("role")).toBe("alertdialog");
    expect(box.textContent).toContain("Claude needs your approval");
    expect(box.querySelector(".msg").textContent).toBe("Claude wants to click Submit application on jobs.test.");
    expect([p.allow.textContent, p.deny.textContent]).toEqual(["Allow", "Deny"]);
    expect(p.root.querySelector(".timer").textContent).toBe("60s");
    p.host.remove();
  });

  it("focuses Deny, so a stray Enter denies", async () => {
    const p = await prompt();
    expect(p.root.activeElement).toBe(p.deny);
  });

  it("resolves allow on a real click of Allow, and allows the approved action's submit", async () => {
    const p = await prompt();
    expect(trustedClick(p.allow)).toBe(true); // stops propagation to the page
    await expect(p.decision).resolves.toEqual({ decision: "allow" });
    expect(p.host.isConnected).toBe(false);
    expect(CB.approvedUntil).toBeGreaterThan(Date.now());
  });

  it("resolves deny on a real click of Deny", async () => {
    const p = await prompt();
    trustedClick(p.deny);
    await expect(p.decision).resolves.toEqual({ decision: "deny" });
    expect(document.querySelector("tabwright-approval")).toBeNull();
  });

  it("ignores clicks from page scripts", async () => {
    const p = await prompt({ timeoutMs: 300 });
    p.allow.click();
    p.allow.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(p.host.isConnected).toBe(true);
    await expect(p.decision).resolves.toEqual({ decision: "timeout" });
  });

  it("counts down and times out", async () => {
    const p = await prompt({ timeoutMs: 1100 });
    const timer = p.root.querySelector(".timer");
    expect(timer.textContent).toBe("2s");
    await new Promise((r) => setTimeout(r, 1050));
    expect(timer.textContent).toBe("1s");
    await expect(p.decision).resolves.toEqual({ decision: "timeout" });
    expect(p.host.isConnected).toBe(false);
  });

  it("puts itself back if the page removes it", async () => {
    const p = await prompt();
    p.host.remove();
    await tick();
    expect(p.host.isConnected).toBe(true);
    document.body.innerHTML = "<p>rewritten</p>";
    await tick();
    expect(p.host.isConnected).toBe(true);
    trustedClick(p.deny);
    await expect(p.decision).resolves.toEqual({ decision: "deny" });
  });

  it("is cancelled by a newer prompt", async () => {
    const first = await prompt({ target: "First" });
    const second = await prompt({ target: "Second" });
    await expect(first.decision).resolves.toEqual({ decision: "cancelled" });
    expect(first.host.isConnected).toBe(false);
    expect(document.querySelectorAll("tabwright-approval")).toHaveLength(1);
    // The old prompt's buttons are dead.
    trustedClick(first.allow);
    trustedClick(second.allow);
    await expect(second.decision).resolves.toEqual({ decision: "allow" });
  });

  it("is cancelled by Stop", async () => {
    const p = await prompt();
    await cmd("cancel");
    await expect(p.decision).resolves.toEqual({ decision: "cancelled" });
    expect(p.host.isConnected).toBe(false);
  });

  it("has defaults for a missing verb or target", async () => {
    const p = await prompt({ verb: undefined, target: "" });
    expect(p.root.querySelector(".msg").textContent).toBe("Claude wants to click this element on jobs.test.");
  });

  it("is left out of snapshots", async () => {
    document.body.innerHTML = "<button>Real</button>";
    const p = await prompt();
    const { text } = await snapshotText();
    expect(text).toMatch(/^- button "Real"/);
    expect(text).not.toMatch(/Allow|Deny|approval/);
    p.host.remove();
  });
});

describe("highlight", () => {
  it("outlines the target and restores its own outline afterwards", async () => {
    const { text } = await page('<button style="outline: 1px dotted blue">Pay now</button>');
    const ref = refIn(text, /"Pay now"/);
    const btn = document.querySelector("button");
    await cmd("highlight", { ref, on: true });
    expect(btn.style.outline).toBe("3px solid #d97757");
    expect(btn.style.getPropertyPriority("outline")).toBe("important");
    await cmd("highlight", { ref, on: true }); // twice keeps the original saved
    await cmd("highlight", { ref, on: false });
    expect(btn.style.outline).toBe("1px dotted blue");
    await cmd("highlight", { ref, on: false }); // already off: no-op
    expect(btn.style.outline).toBe("1px dotted blue");
  });

  it("ignores stale refs", async () => {
    const { text } = await page("<button>Gone</button>");
    const ref = refIn(text, /"Gone"/);
    document.body.innerHTML = "";
    await expect(cmd("highlight", { ref, on: true })).resolves.toEqual({ ok: true });
  });
});

describe("annotate", () => {
  it("marks a drafted answer for review in a closed note after the field", async () => {
    const { text } = await page('<label for="why">Why us?</label><textarea id="why"></textarea>');
    const ref = refIn(text, /"Why us\?"/);
    const before = shadowRoots.length;
    await cmd("annotate", { ref, note: "Drafted on-device. Review it." });
    const ta = document.getElementById("why");
    expect(ta.style.outline).toBe("2px dashed #e0a100");
    const note = ta.nextElementSibling;
    expect(note.tagName).toBe("TABWRIGHT-NOTE");
    expect(note.shadowRoot).toBeNull();
    const entry = shadowRoots.slice(before).find((s) => s.host === note);
    expect(entry.mode).toBe("closed");
    expect(entry.root.textContent).toBe("Drafted on-device. Review it.");
    const again = await snapshotText();
    expect(again.text).not.toContain("Drafted on-device");
  });

  it("uses a default note and fails on stale refs", async () => {
    const { text } = await page('<input aria-label="City">');
    const ref = refIn(text, /"City"/);
    const before = shadowRoots.length;
    await cmd("annotate", { ref });
    expect(shadowRoots[before].root.textContent).toBe("Review this");
    document.body.innerHTML = "";
    await expect(cmd("annotate", { ref })).rejects.toMatchObject({ code: "E_STALE_REF" });
  });
});
