// Shared page-model helpers: visibility, accessible names, roles and the safety classifiers
// (consequential actions, sensitive fields). Loaded first into every controlled frame, and by unit tests.
(() => {
  const CB = (globalThis.Tabwright = globalThis.Tabwright || {});
  if (CB.commonLoaded) return;
  CB.commonLoaded = true;
  CB.settings = CB.settings || { checkSize: true };

  // ---------- errors ----------

  CB.fail = (code, message, data) => {
    const err = new Error(message);
    err.code = code;
    if (data !== undefined) err.data = data;
    throw err;
  };

  // ---------- text ----------

  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  CB.norm = norm;

  CB.truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

  CB.visibleText = (el) => {
    if (!el) return "";
    // innerText respects CSS visibility; jsdom doesn't implement it.
    return norm(typeof el.innerText === "string" ? el.innerText : el.textContent);
  };

  // ---------- visibility ----------

  function styleOf(el) {
    const win = el.ownerDocument?.defaultView;
    return win ? win.getComputedStyle(el) : null;
  }

  /** SPEC 6.1: display:none, visibility:hidden, zero size, aria-hidden="true", inert. */
  CB.isHidden = (el) => {
    if (!el || el.nodeType !== 1) return true;
    if (el.closest('[aria-hidden="true"]') || el.closest("[inert]")) return true;
    if (el.hidden) return true;
    if (typeof el.checkVisibility === "function") {
      if (!el.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true })) return true;
    } else {
      for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
        const st = styleOf(n);
        if (st && st.display === "none") return true;
      }
      const st = styleOf(el);
      if (st && (st.visibility === "hidden" || st.visibility === "collapse")) return true;
    }
    if (CB.settings.checkSize) {
      const st = styleOf(el);
      if (st && st.display === "contents") return false;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return true;
    }
    return false;
  };

  CB.isDisabled = (el) => {
    if (el.disabled) return true;
    if (el.getAttribute("aria-disabled") === "true") return true;
    const fs = el.closest("fieldset[disabled]");
    if (fs) {
      const legend = fs.querySelector(":scope > legend");
      if (!legend || !legend.contains(el)) return true;
    }
    return false;
  };

  // ---------- roles ----------

  const TEXT_INPUT_TYPES = new Set(["", "text", "email", "tel", "url", "search", "number", "date", "datetime-local", "month", "week", "time", "color"]);

  CB.inputType = (el) => (el.getAttribute("type") || "").toLowerCase();

  /** Returns the role used in snapshots, or null for structural/unknown elements. */
  CB.roleOf = (el) => {
    const explicit = (el.getAttribute("role") || "").trim().split(/\s+/)[0].toLowerCase();
    if (explicit && explicit !== "presentation" && explicit !== "none" && explicit !== "generic") {
      if (explicit === "searchbox") return "textbox";
      return explicit;
    }
    const tag = el.tagName.toLowerCase();
    switch (tag) {
      case "a":
        if (el.hasAttribute("href")) return "link";
        return CB.isPointerClickable(el) ? "button" : null;
      case "button":
      case "summary":
        return "button";
      case "input": {
        const t = CB.inputType(el);
        if (t === "hidden") return null;
        if (t === "checkbox") return "checkbox";
        if (t === "radio") return "radio";
        if (t === "file") return "file";
        if (t === "range") return "slider";
        if (["submit", "button", "reset", "image"].includes(t)) return "button";
        if (t === "password") return "textbox";
        if (el.hasAttribute("list") || el.getAttribute("aria-autocomplete") === "list") return "combobox";
        return "textbox";
      }
      case "select":
        return el.multiple ? "listbox" : "combobox";
      case "textarea":
        return "textbox";
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
        return "heading";
      case "form":
        return "form";
      case "fieldset":
        return "group";
      case "nav":
        return "navigation";
      case "main":
        return "main";
      case "aside":
        return "complementary";
      case "dialog":
        return "dialog";
      case "header":
        return el.closest("article, section, main, aside, nav") ? null : "banner";
      case "footer":
        return el.closest("article, section, main, aside, nav") ? null : "contentinfo";
      case "section":
        return el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby") ? "region" : null;
      case "img":
        return norm(el.getAttribute("alt")) ? "img" : null;
      case "iframe":
      case "frame":
        return "frame";
      default:
        if (el.isContentEditable && (el.parentElement === null || !el.parentElement.isContentEditable)) return "textbox";
        if ((tag === "span" || tag === "div") && CB.isPointerClickable(el)) return "button";
        return null;
    }
  };

  /**
   * Non-semantic elements that act as buttons (e.g. App Store Connect's enabled "Save", which isn't a <button>):
   * an <a> without href that is focusable or has an onclick, or the outermost element of a cursor:pointer
   * region with a short label and no real controls inside or around it.
   */
  CB.isPointerClickable = (el) => {
    if (el.parentElement?.closest(CB.INTERACTIVE_SELECTOR)) return false;
    if (el.querySelector(CB.INTERACTIVE_SELECTOR)) return false;
    const label = norm(el.textContent);
    if (!label || label.length > 40) return false;
    if (el.tagName.toLowerCase() === "a" && (el.hasAttribute("onclick") || el.hasAttribute("tabindex"))) return true;
    const st = styleOf(el);
    if (!st || st.cursor !== "pointer") return false;
    const parent = el.parentElement && styleOf(el.parentElement);
    return !parent || parent.cursor !== "pointer";
  };

  /** Roles that get a ref because an agent can act on them. */
  CB.INTERACTIVE_ROLES = new Set([
    "link", "button", "textbox", "checkbox", "radio", "combobox", "listbox", "file", "slider", "spinbutton",
    "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "treeitem",
  ]);

  /** Roles rendered as a single line with no children walked. */
  CB.LEAF_ROLES = new Set([...CB.INTERACTIVE_ROLES, "heading", "img", "alert", "status", "frame", "progressbar", "meter"]);

  CB.LANDMARK_ROLES = new Set(["form", "navigation", "main", "complementary", "banner", "contentinfo", "region", "dialog", "alertdialog", "search", "list", "group", "radiogroup", "tablist", "menu", "tabpanel"]);

  CB.INTERACTIVE_SELECTOR =
    'a[href], button, input:not([type="hidden"]), select, textarea, summary, [contenteditable=""], [contenteditable="true"], ' +
    '[role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"], ' +
    '[role="option"], [role="combobox"], [role="textbox"], [role="searchbox"], [role="slider"], [role="spinbutton"], [role="listbox"]';

  // ---------- accessible names ----------

  function textWithoutControls(node) {
    const clone = node.cloneNode(true);
    clone.querySelectorAll("input, select, textarea, button, [role=combobox], [role=listbox], script, style").forEach((n) => n.remove());
    return norm(clone.textContent);
  }

  function byIds(el, attr) {
    const ids = (el.getAttribute(attr) || "").split(/\s+/).filter(Boolean);
    if (!ids.length) return "";
    const root = el.getRootNode();
    const doc = el.ownerDocument;
    return norm(
      ids
        .map((id) => (root.getElementById ? root.getElementById(id) : null) || doc.getElementById(id))
        .filter(Boolean)
        .map((n) => textWithoutControls(n))
        .join(" "),
    );
  }

  /** Name from ARIA attributes only (used for landmarks, which would otherwise take all their text). */
  CB.ariaName = (el) => byIds(el, "aria-labelledby") || norm(el.getAttribute("aria-label"));

  const LABELABLE = new Set(["input", "select", "textarea", "button", "meter", "output", "progress"]);

  /** SPEC 6.1 order: aria-labelledby, aria-label, <label>, placeholder, title, own text. */
  CB.accessibleName = (el) => {
    let name = byIds(el, "aria-labelledby");
    if (name) return name;
    name = norm(el.getAttribute("aria-label"));
    if (name) return name;
    const tag = el.tagName.toLowerCase();
    if (LABELABLE.has(tag) && el.labels && el.labels.length) {
      name = norm(Array.from(el.labels).map(textWithoutControls).join(" "));
      if (name) return name;
    }
    if (tag === "input" || tag === "textarea") {
      name = norm(el.getAttribute("placeholder"));
      if (name) return name;
    }
    name = norm(el.getAttribute("title"));
    if (name) return name;
    if (tag === "input") {
      const t = CB.inputType(el);
      if (t === "submit" || t === "button" || t === "reset") return norm(el.value) || (t === "submit" ? "Submit" : t === "reset" ? "Reset" : "");
      if (t === "image") return norm(el.getAttribute("alt")) || "Submit";
      return "";
    }
    if (tag === "img") return norm(el.getAttribute("alt"));
    if (tag === "select" || tag === "textarea") return "";
    if (tag === "fieldset") {
      const legend = el.querySelector(":scope > legend");
      return legend ? norm(legend.textContent) : "";
    }
    if (tag === "iframe" || tag === "frame") return "";
    const own = CB.visibleText(el);
    if (own) return own;
    const img = el.querySelector("img[alt], svg[aria-label]");
    if (img) return norm(img.getAttribute("alt") || img.getAttribute("aria-label"));
    return "";
  };

  /** Label for a group of radios/checkboxes: fieldset legend, radiogroup name, or the question near it. */
  CB.groupLabel = (el) => {
    const group = el.closest('fieldset, [role="radiogroup"], [role="group"]');
    if (!group) return "";
    if (group.tagName.toLowerCase() === "fieldset") {
      const legend = group.querySelector(":scope > legend");
      if (legend) return norm(legend.textContent);
    }
    return byIds(group, "aria-labelledby") || norm(group.getAttribute("aria-label"));
  };

  // ---------- safety classifiers ----------

  const SENSITIVE_LABEL = /\b(password|passcode|pass code|cvv|cvc|card number|credit card number|ssn|social security)\b/i;
  const SENSITIVE_AUTOCOMPLETE = new Set(["current-password", "new-password", "one-time-code"]);

  /** SPEC 8.3: password, card and one-time-code fields, and fields labelled like them. */
  CB.isSensitive = (el, name) => {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName.toLowerCase();
    const type = CB.inputType(el);
    if (tag === "input" && type === "password") return true;
    const tokens = (el.getAttribute("autocomplete") || "").toLowerCase().split(/\s+/);
    if (tokens.some((t) => SENSITIVE_AUTOCOMPLETE.has(t) || t.startsWith("cc-"))) return true;
    const textEntry =
      (tag === "input" && TEXT_INPUT_TYPES.has(type)) || tag === "textarea" || el.isContentEditable ||
      el.getAttribute("role") === "textbox";
    if (!textEntry) return false;
    const label = name !== undefined ? name : CB.accessibleName(el);
    return SENSITIVE_LABEL.test(label);
  };

  const CONSEQUENTIAL_WORDS =
    /\b(submit|apply|send|pay|purchase|buy|order|checkout|confirm|delete|remove|cancel subscription|sign|transfer|post|publish)\b/i;
  const CONSEQUENTIAL_PATH = /\/(submit|confirm|checkout|pay|delete)(\/|$|\.|\?)/i;
  CB.CONSEQUENTIAL_PATH = CONSEQUENTIAL_PATH;

  const CLICKABLE =
    'button, input[type="submit"], input[type="image"], input[type="button"], input[type="reset"], a[href], ' +
    '[role="button"], [role="link"], [role="menuitem"]';
  // Controls whose activation sets a value rather than doing something.
  const VALUE_ROLES = new Set(["checkbox", "radio", "switch", "textbox", "combobox", "listbox", "option", "slider", "spinbutton", "file", "tab"]);

  CB.isConsequentialUrl = (href, base) => {
    try {
      const u = new URL(href, base);
      if (u.protocol !== "http:" && u.protocol !== "https:") return false;
      return CONSEQUENTIAL_PATH.test(u.pathname + "/");
    } catch {
      return false;
    }
  };

  /**
   * SPEC 8.2. Returns { consequential, reason, name }. Decided by the extension from the DOM, never by the model.
   */
  CB.classifyConsequential = (el) => {
    const none = { consequential: false, reason: "", name: "" };
    if (!el || el.nodeType !== 1) return none;
    const ownRole = CB.roleOf(el);
    if (ownRole && VALUE_ROLES.has(ownRole)) return none;
    const target = el.closest(CLICKABLE) || el;
    const role = CB.roleOf(target);
    if (role && VALUE_ROLES.has(role)) return none;
    const tag = target.tagName.toLowerCase();
    const name = CB.accessibleName(target);

    if (tag === "button") {
      const type = (target.getAttribute("type") || "submit").toLowerCase();
      if (type === "submit" && target.form) return { consequential: true, reason: "submits a form", name };
    }
    if (tag === "input") {
      const type = CB.inputType(target);
      if ((type === "submit" || type === "image") && target.form) return { consequential: true, reason: "submits a form", name };
    }
    const isClickable = target !== el || target.matches(CLICKABLE);
    if (CONSEQUENTIAL_WORDS.test(name) && (isClickable || name.length <= 60)) {
      return { consequential: true, reason: `named "${CB.truncate(name, 60)}"`, name };
    }
    if (tag === "a" && target.hasAttribute("href") && CB.isConsequentialUrl(target.getAttribute("href"), target.ownerDocument.baseURI)) {
      return { consequential: true, reason: "navigates to a submit/confirm/checkout/pay/delete URL", name };
    }
    return { consequential: false, reason: "", name };
  };

  /** Would pressing Enter in this field submit its form (implicit submission)? */
  CB.enterWouldSubmit = (el) => {
    if (!el || el.tagName?.toLowerCase() !== "input") return false;
    const type = CB.inputType(el);
    if (!TEXT_INPUT_TYPES.has(type) && type !== "password") return false;
    const form = el.form;
    if (!form) return false;
    const controls = Array.from(form.elements);
    const hasSubmit = controls.some((c) => {
      const t = c.tagName.toLowerCase();
      if (t === "button") return (c.getAttribute("type") || "submit").toLowerCase() === "submit" && !c.disabled;
      return t === "input" && ["submit", "image"].includes(CB.inputType(c)) && !c.disabled;
    });
    if (hasSubmit) return true;
    const blocking = controls.filter((c) => c.tagName.toLowerCase() === "input" && (TEXT_INPUT_TYPES.has(CB.inputType(c)) || CB.inputType(c) === "password"));
    return blocking.length === 1;
  };

  const CAPTCHA_SRC = /(google\.com|recaptcha\.net)\/recaptcha|hcaptcha\.com|challenges\.cloudflare\.com/i;
  CB.isCaptchaFrame = (el) => CAPTCHA_SRC.test(el.getAttribute("src") || el.src || "");

  /** SPEC 6.4: visible and enabled, else E_NOT_INTERACTABLE. File inputs are often visually hidden on purpose. */
  CB.assertInteractable = (el, name) => {
    const isFile = el.tagName?.toLowerCase() === "input" && CB.inputType(el) === "file";
    if (!isFile && CB.isHidden(el)) CB.fail("E_NOT_INTERACTABLE", `"${CB.truncate(name || el.tagName.toLowerCase(), 80)}" is not visible`);
    if (CB.isDisabled(el)) CB.fail("E_NOT_INTERACTABLE", `"${CB.truncate(name || el.tagName.toLowerCase(), 80)}" is disabled`);
  };
})();
