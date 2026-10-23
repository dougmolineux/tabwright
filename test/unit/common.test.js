// @vitest-environment jsdom
// The page-model helpers and safety classifiers in extension/content/common.js (SPEC 6.1, 8.2, 8.3), called directly.
import { beforeAll, describe, expect, it } from "vitest";
import { loadContentScripts } from "../helpers/content-env.js";

let CB;
/** Renders html and returns the first element matching sel (default: the first element). */
const el = (html, sel) => {
  document.body.innerHTML = html;
  return sel ? document.querySelector(sel) : document.body.firstElementChild;
};

beforeAll(async () => {
  CB = await loadContentScripts();
});

describe("roleOf", () => {
  it.each([
    ['<a href="/x">x</a>', "link"],
    ["<button>x</button>", "button"],
    ["<details><summary>More</summary></details>", "button", "summary"],
    ['<input type="checkbox">', "checkbox"],
    ['<input type="radio">', "radio"],
    ['<input type="file">', "file"],
    ['<input type="range">', "slider"],
    ['<input type="submit">', "button"],
    ['<input type="image" alt="Go">', "button"],
    ['<input type="reset">', "button"],
    ['<input type="password">', "textbox"],
    ['<input type="email">', "textbox"],
    ["<input>", "textbox"],
    ['<input list="dl">', "combobox"],
    ['<input aria-autocomplete="list">', "combobox"],
    ['<input type="hidden">', null],
    ["<select><option>a</option></select>", "combobox"],
    ["<select multiple><option>a</option></select>", "listbox"],
    ["<textarea></textarea>", "textbox"],
    ["<h3>x</h3>", "heading"],
    ["<form></form>", "form"],
    ["<fieldset></fieldset>", "group"],
    ["<nav></nav>", "navigation"],
    ["<main></main>", "main"],
    ["<aside></aside>", "complementary"],
    ["<dialog></dialog>", "dialog"],
    ["<header></header>", "banner"],
    ["<main><header></header></main>", null, "header"],
    ["<footer></footer>", "contentinfo"],
    ["<article><footer></footer></article>", null, "footer"],
    ['<section aria-label="Jobs"></section>', "region"],
    ["<section></section>", null],
    ['<img alt="Logo">', "img"],
    ['<img alt="">', null],
    ["<iframe></iframe>", "frame"],
    ['<div role="switch"></div>', "switch"],
    ['<div role="searchbox"></div>', "textbox"],
    ['<div role="presentation"></div>', null],
    ['<div role="none"></div>', null],
    ['<div role="generic"></div>', null],
    ['<div role="tab menuitem"></div>', "tab"],
    ['<div contenteditable="true">x</div>', "textbox"],
    ['<div contenteditable="true"><p contenteditable="true">x</p></div>', null, "p"],
    ["<div>plain</div>", null],
  ])("%s → %s", (html, role, sel) => {
    expect(CB.roleOf(el(html, sel))).toBe(role);
  });
});

describe("isPointerClickable (button-like non-semantic elements)", () => {
  it("treats a short cursor:pointer div as a button", () => {
    expect(CB.roleOf(el('<div style="cursor: pointer">Save</div>'))).toBe("button");
    expect(CB.roleOf(el('<span style="cursor: pointer">Edit</span>'))).toBe("button");
  });

  it("only takes the outermost element of a pointer region", () => {
    const outer = el('<div style="cursor: pointer"><span style="cursor: pointer">Save</span></div>');
    expect(CB.roleOf(outer)).toBe("button");
    expect(CB.roleOf(outer.querySelector("span"))).toBe(null);
  });

  it("skips regions with real controls inside or around them, long labels and empty ones", () => {
    expect(CB.roleOf(el('<div style="cursor: pointer">Save <button>x</button></div>'))).toBe(null);
    expect(CB.roleOf(el('<button><span style="cursor: pointer">Save</span></button>', "span"))).toBe(null);
    expect(CB.roleOf(el(`<div style="cursor: pointer">${"x".repeat(41)}</div>`))).toBe(null);
    expect(CB.roleOf(el('<div style="cursor: pointer">   </div>'))).toBe(null);
    expect(CB.roleOf(el("<div>Save</div>"))).toBe(null);
  });

  it("treats an <a> without href as a button only when it is focusable or has onclick", () => {
    expect(CB.roleOf(el('<a tabindex="0">Save</a>'))).toBe("button");
    expect(CB.roleOf(el('<a onclick="void 0">Save</a>'))).toBe("button");
    expect(CB.roleOf(el("<a>Save</a>"))).toBe(null);
  });
});

describe("accessibleName", () => {
  it("follows the SPEC 6.1 order", () => {
    document.body.innerHTML =
      '<span id="a">From</span><span id="b">labelledby <input value="ignored"></span>' +
      '<label for="i">From label</label>' +
      '<input id="i" aria-labelledby="a b" aria-label="From aria-label" placeholder="ph" title="t">';
    const i = document.getElementById("i");
    expect(CB.accessibleName(i)).toBe("From labelledby");
    i.removeAttribute("aria-labelledby");
    expect(CB.accessibleName(i)).toBe("From aria-label");
    i.removeAttribute("aria-label");
    expect(CB.accessibleName(i)).toBe("From label");
    document.querySelector("label").remove();
    expect(CB.accessibleName(i)).toBe("ph");
    i.removeAttribute("placeholder");
    expect(CB.accessibleName(i)).toBe("t");
    i.removeAttribute("title");
    expect(CB.accessibleName(i)).toBe("");
  });

  it("leaves nested controls out of label text", () => {
    const i = el('<label>Country <input id="c"> <select><option>Canada</option></select></label>', "#c");
    expect(CB.accessibleName(i)).toBe("Country");
  });

  it("names input buttons and images", () => {
    expect(CB.accessibleName(el('<input type="submit">'))).toBe("Submit");
    expect(CB.accessibleName(el('<input type="submit" value="Apply now">'))).toBe("Apply now");
    expect(CB.accessibleName(el('<input type="reset">'))).toBe("Reset");
    expect(CB.accessibleName(el('<input type="button">'))).toBe("");
    expect(CB.accessibleName(el('<input type="image">'))).toBe("Submit");
    expect(CB.accessibleName(el('<input type="image" alt="Go">'))).toBe("Go");
    expect(CB.accessibleName(el('<img alt="Logo">'))).toBe("Logo");
  });

  it("uses a fieldset's legend, own text, then an icon's label", () => {
    expect(CB.accessibleName(el("<fieldset><legend>Relocate?</legend><input></fieldset>"))).toBe("Relocate?");
    expect(CB.accessibleName(el("<fieldset><input></fieldset>"))).toBe("");
    expect(CB.accessibleName(el("<button>  Save \n draft </button>"))).toBe("Save draft");
    expect(CB.accessibleName(el('<button><img alt="Close"></button>'))).toBe("Close");
    expect(CB.accessibleName(el('<button><svg aria-label="Menu"></svg></button>'))).toBe("Menu");
    expect(CB.accessibleName(el("<select></select>"))).toBe("");
    expect(CB.accessibleName(el('<iframe title=""></iframe>'))).toBe("");
  });

  it("resolves aria-labelledby inside a shadow root", () => {
    document.body.innerHTML = "<div id=host></div>";
    const root = document.getElementById("host").attachShadow({ mode: "open" });
    root.innerHTML = '<span id="l">Shadow label</span><input aria-labelledby="l">';
    expect(CB.accessibleName(root.querySelector("input"))).toBe("Shadow label");
  });
});

describe("groupLabel", () => {
  it("uses the fieldset legend or the group's ARIA name", () => {
    expect(CB.groupLabel(el('<fieldset><legend>Sponsor?</legend><input type="radio"></fieldset>', "input"))).toBe("Sponsor?");
    expect(CB.groupLabel(el('<div role="radiogroup" aria-label="Size"><input type="radio"></div>', "input"))).toBe("Size");
    expect(CB.groupLabel(el('<p id="q">Remote?</p><div role="group" aria-labelledby="q"><input type="radio"></div>', "input"))).toBe("Remote?");
    expect(CB.groupLabel(el('<input type="radio">'))).toBe("");
  });
});

describe("isHidden and isDisabled", () => {
  it("hides display:none ancestors, visibility:hidden, hidden, aria-hidden and inert", () => {
    expect(CB.isHidden(el('<div style="display:none"><input></div>', "input"))).toBe(true);
    expect(CB.isHidden(el('<input style="visibility:hidden">'))).toBe(true);
    expect(CB.isHidden(el('<input style="visibility:collapse">'))).toBe(true);
    expect(CB.isHidden(el("<input hidden>"))).toBe(true);
    expect(CB.isHidden(el('<div aria-hidden="true"><input></div>', "input"))).toBe(true);
    expect(CB.isHidden(el("<div inert><input></div>", "input"))).toBe(true);
    expect(CB.isHidden(el("<input>"))).toBe(false);
    expect(CB.isHidden(null)).toBe(true);
    expect(CB.isHidden(document.createTextNode("x"))).toBe(true);
  });

  it("hides zero-size elements when layout is available, except display:contents", () => {
    CB.settings.checkSize = true;
    try {
      expect(CB.isHidden(el("<input>"))).toBe(true); // jsdom: everything is 0×0
      expect(CB.isHidden(el('<div style="display: contents">x</div>'))).toBe(false);
      const sized = el("<input>");
      sized.getBoundingClientRect = () => ({ width: 10, height: 10 });
      expect(CB.isHidden(sized)).toBe(false);
    } finally {
      CB.settings.checkSize = false;
    }
  });

  it("uses checkVisibility when the browser has it", () => {
    const i = el("<input>");
    i.checkVisibility = () => false;
    expect(CB.isHidden(i)).toBe(true);
    i.checkVisibility = () => true;
    expect(CB.isHidden(i)).toBe(false);
  });

  it("treats disabled, aria-disabled and disabled fieldsets as disabled, except in the first legend", () => {
    expect(CB.isDisabled(el("<button disabled>x</button>"))).toBe(true);
    expect(CB.isDisabled(el('<div role="button" aria-disabled="true">x</div>'))).toBe(true);
    expect(CB.isDisabled(el("<fieldset disabled><div><a href=/>x</a></div></fieldset>", "a"))).toBe(true);
    expect(CB.isDisabled(el("<fieldset disabled><legend><a href=/>x</a></legend></fieldset>", "a"))).toBe(false);
    expect(CB.isDisabled(el("<button>x</button>"))).toBe(false);
  });
});

describe("isSensitive (SPEC 8.3)", () => {
  it.each([
    ['<input type="password">', true],
    ['<input autocomplete="current-password">', true],
    ['<input autocomplete="new-password">', true],
    ['<input autocomplete="one-time-code">', true],
    ['<input autocomplete="cc-number">', true],
    ['<input autocomplete="billing cc-exp">', true],
    ['<input aria-label="CVV">', true],
    ['<input aria-label="CVC code">', true],
    ['<input aria-label="Card number">', true],
    ['<input aria-label="Social Security Number">', true],
    ['<input aria-label="SSN">', true],
    ['<input aria-label="Passcode">', true],
    ['<textarea aria-label="Password hint"></textarea>', true],
    ['<div role="textbox" aria-label="Password"></div>', true],
    ['<input aria-label="Email" autocomplete="email">', false],
    ['<input aria-label="Passport number">', false],
    ['<input type="checkbox" aria-label="Show password">', false],
    ['<select aria-label="Password strength"></select>', false],
  ])("%s → %s", (html, sensitive) => {
    expect(CB.isSensitive(el(html))).toBe(sensitive);
  });

  it("uses a given name instead of computing one", () => {
    expect(CB.isSensitive(el("<input>"), "Card number")).toBe(true);
    expect(CB.isSensitive(el('<input aria-label="SSN">'), "Name")).toBe(false);
    expect(CB.isSensitive(null)).toBe(false);
  });
});

describe("classifyConsequential (SPEC 8.2)", () => {
  const c = (html, sel) => CB.classifyConsequential(el(html, sel));

  it("flags buttons that submit a form", () => {
    expect(c("<form><button>Next</button></form>", "button")).toMatchObject({ consequential: true, reason: "submits a form", name: "Next" });
    expect(c('<form><input type="submit" value="Go"></form>', "input")).toMatchObject({ consequential: true, reason: "submits a form" });
    expect(c('<form><input type="image" alt="Go"></form>', "input")).toMatchObject({ consequential: true });
    expect(c('<form><button type="button">Next</button></form>', "button").consequential).toBe(false);
    expect(c("<button>Next</button>").consequential).toBe(false); // no form
  });

  it.each(["Submit", "Apply", "Send message", "Pay $20", "Purchase", "Buy now", "Place order", "Checkout", "Confirm", "Delete account", "Remove", "Cancel subscription", "Sign", "Transfer", "Post", "Publish"])(
    "flags a button named %j",
    (name) => {
      expect(c(`<button type="button">${name}</button>`)).toMatchObject({ consequential: true, reason: `named "${name}"` });
    },
  );

  it("doesn't flag ordinary buttons or partial words", () => {
    for (const name of ["Next", "Back", "Save", "Cancel", "Signal", "Resubmitting?", "Postpone"]) {
      expect(c(`<button type="button">${name}</button>`).consequential, name).toBe(false);
    }
  });

  it("flags links to submit/confirm/checkout/pay/delete URLs, on http(s) only", () => {
    expect(c('<a href="/checkout">Continue</a>')).toMatchObject({ consequential: true, reason: "navigates to a submit/confirm/checkout/pay/delete URL" });
    expect(c('<a href="https://shop.test/cart/pay?x=1">Continue</a>').consequential).toBe(true);
    expect(c('<a href="/order/confirm.php">Continue</a>').consequential).toBe(true);
    expect(c('<a href="/payments">Continue</a>').consequential).toBe(false);
    expect(c('<a href="javascript:void(0)">Continue</a>').consequential).toBe(false);
    expect(CB.isConsequentialUrl("http://[bad", "http://x.test/")).toBe(false);
  });

  it("classifies the clickable ancestor of an inner element", () => {
    expect(c('<button type="button"><span>Delete</span></button>', "span")).toMatchObject({ consequential: true, name: "Delete" });
    expect(c('<div role="menuitem">Remove from list</div>').consequential).toBe(true);
  });

  it("never flags value controls, whatever their label says", () => {
    expect(c('<label><input type="checkbox"> I confirm and submit</label>', "input").consequential).toBe(false);
    expect(c('<input type="radio" aria-label="Pay monthly">').consequential).toBe(false);
    expect(c('<input aria-label="Order notes">').consequential).toBe(false);
    expect(c('<div role="tab">Checkout</div>').consequential).toBe(false);
  });

  it("only flags long non-clickable text when it is short", () => {
    expect(c(`<div style="cursor:pointer">Submit</div>`).consequential).toBe(true);
    expect(c(`<div>${"Please submit the form when you are ready to continue with ".repeat(2)}</div>`).consequential).toBe(false);
    expect(CB.classifyConsequential(null).consequential).toBe(false);
  });
});

describe("enterWouldSubmit", () => {
  it("is true in a text field of a form with an enabled submit button", () => {
    expect(CB.enterWouldSubmit(el('<form><input id="a"><input id="b"><button>Go</button></form>', "#a"))).toBe(true);
    expect(CB.enterWouldSubmit(el('<form><input id="a"><input type="submit"></form>', "#a"))).toBe(true);
    expect(CB.enterWouldSubmit(el('<form><input id="a" type="password"><input type="image"></form>', "#a"))).toBe(true);
  });

  it("is true for a lone text field without a submit button (implicit submission)", () => {
    expect(CB.enterWouldSubmit(el('<form><input id="a"><input type="checkbox"></form>', "#a"))).toBe(true);
  });

  it("is false with several fields and no usable submit button", () => {
    expect(CB.enterWouldSubmit(el('<form><input id="a"><input id="b"></form>', "#a"))).toBe(false);
    expect(CB.enterWouldSubmit(el('<form><input id="a"><input id="b"><button disabled>Go</button></form>', "#a"))).toBe(false);
    expect(CB.enterWouldSubmit(el('<form><input id="a"><input id="b"><button type="button">Go</button></form>', "#a"))).toBe(false);
  });

  it("is false outside forms and for non-text controls", () => {
    expect(CB.enterWouldSubmit(el("<input>"))).toBe(false);
    expect(CB.enterWouldSubmit(el('<form><input type="checkbox"><button>Go</button></form>', "input"))).toBe(false);
    expect(CB.enterWouldSubmit(el("<form><textarea></textarea><button>Go</button></form>", "textarea"))).toBe(false);
    expect(CB.enterWouldSubmit(null)).toBe(false);
  });
});

describe("isCaptchaFrame", () => {
  it.each([
    ["https://www.google.com/recaptcha/api2/anchor", true],
    ["https://www.recaptcha.net/recaptcha/api2/bframe", true],
    ["https://newassets.hcaptcha.com/captcha/v1", true],
    ["https://challenges.cloudflare.com/cdn-cgi/challenge-platform", true],
    ["https://jobs.test/embed", false],
  ])("%s → %s", (src, captcha) => {
    expect(CB.isCaptchaFrame(el(`<iframe src="${src}"></iframe>`))).toBe(captcha);
  });
});

describe("assertInteractable", () => {
  it("throws E_NOT_INTERACTABLE for hidden or disabled elements, but lets hidden file inputs through", () => {
    expect(() => CB.assertInteractable(el("<input hidden>"), "Name")).toThrow(/"Name" is not visible/);
    expect(() => CB.assertInteractable(el("<button disabled>x</button>"))).toThrow(/"button" is disabled/);
    expect(() => CB.assertInteractable(el('<input type="file" hidden>'), "Resume")).not.toThrow();
    try {
      CB.assertInteractable(el("<input disabled>"), "x".repeat(100));
    } catch (e) {
      expect(e.code).toBe("E_NOT_INTERACTABLE");
      expect(e.message.length).toBeLessThan(100);
    }
  });
});

describe("matchText", () => {
  const texts = ["United States", "United Kingdom", "Canada", "Yes, I am authorized*", "Other (please specify)"];
  it.each([
    ["Canada", 2],
    ["canada", 2],
    ["CANADA ", 2],
    ["Yes, I am authorized", 3],
    ["yes i am authorized", 3],
    ["Other please specify", 4],
    ["Can", 2],
    ["kingdom", 1],
    ["United", -2],
    ["Mexico", -1],
  ])("%j → %i", (want, idx) => {
    expect(CB.matchText(texts, want)).toBe(idx);
  });

  it("takes the first of repeated exact or case-insensitive matches, but not of looser ones", () => {
    expect(CB.matchText(["Yes", "No", "Yes"], "Yes")).toBe(0);
    expect(CB.matchText(["Yes", "No", "yes"], "YES")).toBe(0);
    expect(CB.matchText(["Yes!", "No", "yes?"], "yes")).toBe(-2);
  });
});

describe("text helpers", () => {
  it("normalizes whitespace and truncates with an ellipsis", () => {
    expect(CB.norm("  a \n\t b  ")).toBe("a b");
    expect(CB.norm(null)).toBe("");
    expect(CB.truncate("abcdef", 4)).toBe("abc…");
    expect(CB.truncate("abc", 4)).toBe("abc");
    expect(CB.visibleText(null)).toBe("");
  });

  it("fails with a code and data", () => {
    try {
      CB.fail("E_STALE_REF", "gone", { ref: "e1" });
    } catch (e) {
      expect(e).toMatchObject({ code: "E_STALE_REF", message: "gone", data: { ref: "e1" } });
    }
  });
});
