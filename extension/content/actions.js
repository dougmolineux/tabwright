// Actions in the page (SPEC 6.4, 6.5) and the content-script message handler. Loaded last.
(() => {
  const CB = (globalThis.ClaudeBridge = globalThis.ClaudeBridge || {});
  if (CB.actionsLoaded) return;
  CB.actionsLoaded = true;

  CB.controlled = false;
  CB.lastAgentActionAt = 0;
  CB.approvedUntil = 0;
  const cancellers = new Set();

  const stopped = () => Object.assign(new Error("Stopped by the user"), { code: "E_STOPPED" });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Approval covers only the action it was given for; any other agent action revokes it. */
  function markAgentAction(approved) {
    CB.lastAgentActionAt = Date.now();
    CB.approvedUntil = approved ? Date.now() + 2000 : 0;
  }

  // ---------- waiting (SPEC 6.5) ----------

  /** Resolves when the DOM has been quiet for quietMs (cap capMs), or the page starts to unload. */
  CB.settle = (quietMs = 300, capMs = 5000) =>
    new Promise((resolve) => {
      const startHref = location.href;
      let mutated = false;
      let quiet;
      const finish = (navigated) => {
        obs.disconnect();
        clearTimeout(quiet);
        clearTimeout(cap);
        removeEventListener("pagehide", onHide);
        removeEventListener("beforeunload", onHide);
        resolve({ navigated: navigated || location.href !== startHref, mutated });
      };
      const obs = new MutationObserver((records) => {
        if (records.every((r) => r.target.nodeType === 1 && r.target.closest?.("[data-claude-bridge-ui]"))) return;
        mutated = true;
        clearTimeout(quiet);
        quiet = setTimeout(() => finish(false), quietMs);
      });
      obs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      quiet = setTimeout(() => finish(false), quietMs);
      const cap = setTimeout(() => finish(false), capMs);
      const onHide = () => finish(true);
      addEventListener("pagehide", onHide);
      addEventListener("beforeunload", onHide);
    });

  function cancellableWait(executor, timeoutMs) {
    return new Promise((resolve, reject) => {
      let done = false;
      const end = (fn, v) => {
        if (done) return;
        done = true;
        cancellers.delete(cancel);
        clearTimeout(timer);
        cleanup?.();
        fn(v);
      };
      let cleanup = null;
      const cancel = () => end(reject, stopped());
      cancellers.add(cancel);
      const timer = setTimeout(() => end(reject, Object.assign(new Error(`Timed out after ${timeoutMs} ms`), { code: "E_TIMEOUT" })), timeoutMs);
      cleanup = executor((v) => end(resolve, v), (e) => end(reject, e));
      if (done) cleanup?.();
    });
  }

  // ---------- low-level input ----------

  function center(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  function scrollIntoView(el) {
    try {
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    } catch {
      el.scrollIntoView();
    }
  }

  /** pointerdown, mousedown, pointerup, mouseup, click at the element's center, then focus(). */
  CB.clickEl = (el) => {
    scrollIntoView(el);
    const { x, y } = center(el);
    const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0 };
    const ptr = { ...base, pointerId: 1, pointerType: "mouse", isPrimary: true };
    el.dispatchEvent(new PointerEvent("pointerdown", { ...ptr, buttons: 1 }));
    el.dispatchEvent(new MouseEvent("mousedown", { ...base, buttons: 1 }));
    el.dispatchEvent(new PointerEvent("pointerup", { ...ptr, buttons: 0 }));
    el.dispatchEvent(new MouseEvent("mouseup", { ...base, buttons: 0 }));
    el.dispatchEvent(new MouseEvent("click", { ...base, buttons: 0, detail: 1 }));
    if (typeof el.focus === "function") el.focus({ preventScroll: true });
  };

  /** Runs one of the main-world functions on el via the background script. */
  CB.runMain = async (fn, el, args) => {
    const nonce = "cb-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    el.setAttribute("data-claude-ref", nonce);
    try {
      const r = await browser.runtime.sendMessage({ type: "main", fn, nonce, args });
      if (!r || r.ok === false) CB.fail("E_INTERNAL", `main-world ${fn} failed: ${r?.error ?? "no result"}`);
      return r;
    } finally {
      el.removeAttribute("data-claude-ref");
    }
  };

  function deepActiveElement() {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return el;
  }

  function deepQueryAll(selector, root = document, out = []) {
    out.push(...root.querySelectorAll(selector));
    for (const host of root.querySelectorAll("*")) if (host.shadowRoot) deepQueryAll(selector, host.shadowRoot, out);
    return out;
  }

  // ---------- text matching ----------

  const clean = (s) => CB.norm(s).replace(/[*✱]+$/, "").trim();

  /** Index of the best match for `want` in `texts`, -1 for none, -2 for ambiguous. */
  CB.matchText = (texts, want) => {
    const w = clean(want);
    const wl = w.toLowerCase();
    const tries = [
      (t) => clean(t) === w,
      (t) => clean(t).toLowerCase() === wl,
      (t) => clean(t).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() === wl.replace(/[^a-z0-9]+/g, " ").trim(),
      (t) => clean(t).toLowerCase().startsWith(wl),
      (t) => clean(t).toLowerCase().includes(wl),
    ];
    for (const test of tries) {
      const hits = texts.map((t, i) => (test(t) ? i : -1)).filter((i) => i >= 0);
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) return test === tries[0] || test === tries[1] ? hits[0] : -2;
    }
    return -1;
  };

  // ---------- handlers ----------

  function resolve(msg) {
    const el = CB.resolveRef(msg.ref);
    const name = CB.accessibleName(el) || (CB.roleOf(el) === "radio" ? CB.visibleText(el.parentElement) : "");
    return { el, name };
  }

  function approvalNeeded(verb, target, reason, noApproval) {
    if (noApproval) {
      CB.fail("E_APPROVAL_DENIED", `"${target}" needs the user's approval (${reason}); browser_fill_form never does that. Use browser_click.`);
    }
    return { needsApproval: true, verb, target: CB.truncate(target || "this element", 120), reason };
  }

  async function click(msg) {
    const { el, name } = resolve(msg);
    CB.assertInteractable(el, name);
    const c = CB.classifyConsequential(el);
    if (c.consequential && !msg.approved) return approvalNeeded("click", c.name || name, c.reason, msg.noApproval);
    markAgentAction(msg.approved);
    CB.blockedSubmit = false;
    const settled = CB.settle();
    CB.clickEl(el);
    const s = await settled;
    return { ok: true, target: name, navigated: s.navigated, snapshotStale: s.mutated || s.navigated, ...(CB.blockedSubmit ? { blockedSubmit: true } : {}) };
  }

  async function type(msg) {
    const { el, name } = resolve(msg);
    if (CB.isSensitive(el, name)) CB.fail("E_REFUSED_SENSITIVE", `"${name}" is a password, payment or one-time-code field. Ask the user to fill it.`);
    CB.assertInteractable(el, name);
    const tag = el.tagName.toLowerCase();
    const role = CB.roleOf(el);
    if (tag === "select") CB.fail("E_NOT_INTERACTABLE", `"${name}" is a dropdown; use browser_select.`);
    const typable = el.isContentEditable || tag === "textarea" || (tag === "input" && !["checkbox", "radio", "file", "submit", "button", "image", "reset", "range", "color", "hidden"].includes(CB.inputType(el)));
    if (!typable) CB.fail("E_NOT_INTERACTABLE", `"${name}" (${role ?? tag}) doesn't accept text.`);
    if (el.readOnly) CB.fail("E_NOT_INTERACTABLE", `"${name}" is read-only.`);
    scrollIntoView(el);
    markAgentAction(false);
    const settled = CB.settle();
    await CB.runMain("setValue", el, { text: String(msg.text ?? ""), clear: msg.clear !== false, perKey: !!msg.perKey });
    const s = await settled;
    const value = el.isContentEditable ? CB.visibleText(el) : el.value;
    return { ok: true, target: name, value, snapshotStale: s.mutated || s.navigated };
  }

  function visibleOptionsFor(el) {
    let scope = null;
    for (const attr of ["aria-controls", "aria-owns"]) {
      const id = el.getAttribute(attr);
      if (id) scope = el.getRootNode().getElementById?.(id) || document.getElementById(id);
      if (scope) break;
    }
    const sel = '[role="option"], [id*="-option-"]';
    let opts = scope ? Array.from(scope.querySelectorAll(sel)) : [];
    if (!opts.length && scope) opts = Array.from(scope.children);
    if (!opts.length) opts = deepQueryAll(sel);
    if (!opts.length) {
      for (const lb of deepQueryAll('[role="listbox"], [class*="menu-list"], [class*="MenuList"]')) opts.push(...lb.children);
    }
    return opts.filter((o) => !CB.isHidden(o) && CB.norm(o.textContent) && o.getAttribute("aria-disabled") !== "true");
  }

  async function waitForOptions(el, timeoutMs) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const opts = visibleOptionsFor(el);
      if (opts.length || Date.now() > end) return opts;
      await sleep(100);
    }
  }

  async function selectCustom(el, name, want) {
    markAgentAction(false);
    CB.clickEl(el);
    let opts = await waitForOptions(el, 1500);
    let texts = opts.map((o) => CB.norm(o.textContent));
    let idx = CB.matchText(texts, want);
    const isTextInput = el.tagName.toLowerCase() === "input" && !["checkbox", "radio", "button", "submit"].includes(CB.inputType(el));
    if (idx < 0 && isTextInput) {
      // Type to filter, then look again.
      await CB.runMain("setValue", el, { text: want, clear: true });
      await sleep(250);
      opts = await waitForOptions(el, 2000);
      texts = opts.map((o) => CB.norm(o.textContent));
      idx = CB.matchText(texts, want);
    }
    if (idx < 0) {
      const ambiguous = idx === -2;
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      CB.fail(
        ambiguous ? "E_AMBIGUOUS" : "E_NOT_INTERACTABLE",
        ambiguous ? `Several options match "${want}" in "${name}"` : `No option matching "${want}" in "${name}"`,
        { available: texts.slice(0, 40), origin: location.origin },
      );
    }
    const chosen = opts[idx];
    const settled = CB.settle();
    CB.clickEl(chosen);
    const s = await settled;
    return { ok: true, target: name, selected: [texts[idx]], snapshotStale: s.mutated || s.navigated };
  }

  async function select(msg) {
    const { el, name } = resolve(msg);
    CB.assertInteractable(el, name);
    const wanted = Array.isArray(msg.options) && msg.options.length ? msg.options.map(String) : [String(msg.option ?? "")];
    if (el.tagName.toLowerCase() === "select") {
      const options = Array.from(el.options);
      const labels = options.map((o) => o.label || o.textContent);
      const indexes = wanted.map((w) => {
        const byValue = options.findIndex((o) => o.value === w);
        return byValue >= 0 ? byValue : CB.matchText(labels, w);
      });
      const bad = wanted.filter((_, i) => indexes[i] < 0);
      if (bad.length) {
        CB.fail("E_NOT_INTERACTABLE", `No option matching "${bad.join('", "')}" in "${name}"`, { available: labels.map(CB.norm).slice(0, 60), origin: location.origin });
      }
      if (!el.multiple && indexes.length > 1) CB.fail("E_NOT_INTERACTABLE", `"${name}" accepts one option.`);
      markAgentAction(false);
      const settled = CB.settle();
      const r = await CB.runMain("selectOptions", el, indexes);
      const s = await settled;
      return { ok: true, target: name, selected: r.selected, snapshotStale: s.mutated || s.navigated };
    }
    if (wanted.length > 1) CB.fail("E_NOT_INTERACTABLE", `Multi-select is only supported on native <select> elements.`);
    return selectCustom(el, name, wanted[0]);
  }

  function isChecked(el) {
    return el.tagName.toLowerCase() === "input" ? el.checked : el.getAttribute("aria-checked") === "true";
  }

  async function check(msg) {
    const { el, name } = resolve(msg);
    CB.assertInteractable(el, name);
    const want = !!msg.checked;
    if (isChecked(el) === want) return { ok: true, target: name, checked: want, changed: false };
    const role = CB.roleOf(el);
    if (role === "radio" && !want) CB.fail("E_NOT_INTERACTABLE", `A radio button can't be unchecked; choose another option in its group.`);
    const c = CB.classifyConsequential(el);
    if (c.consequential && !msg.approved) return approvalNeeded("click", c.name || name, c.reason, msg.noApproval);
    markAgentAction(msg.approved);
    const settled = CB.settle();
    CB.clickEl(el);
    let s = await settled;
    if (isChecked(el) !== want && el.labels && el.labels[0]) {
      CB.clickEl(el.labels[0]);
      s = await CB.settle();
    }
    const now = isChecked(el);
    if (now !== want) CB.fail("E_NOT_INTERACTABLE", `Clicking "${name}" didn't change it; the page may need a real click. Ask the user.`);
    return { ok: true, target: name, checked: now, changed: true, snapshotStale: s.mutated || s.navigated };
  }

  /** Picks the radio in el's group whose label matches `value`. */
  async function chooseRadio(el, value, msg) {
    let group;
    if (el.name) {
      const scope = el.form || el.getRootNode();
      group = Array.from(scope.querySelectorAll(`input[type="radio"]`)).filter((r) => r.name === el.name);
    } else {
      const container = el.closest('[role="radiogroup"], fieldset') || el.parentElement?.parentElement;
      group = Array.from(container.querySelectorAll('input[type="radio"], [role="radio"]'));
    }
    const names = group.map((r) => CB.accessibleName(r) || CB.visibleText(r.parentElement));
    const idx = CB.matchText(names, value);
    if (idx < 0) CB.fail("E_NOT_INTERACTABLE", `No choice matching "${value}"`, { available: names, origin: location.origin });
    const alloc = CB.newAllocator(msg.nextRef);
    const ref = CB.refFor(group[idx], alloc);
    const r = await check({ ...msg, ref, checked: true });
    return { ...r, selected: [names[idx]], nextRef: alloc.next, newRefs: alloc.created };
  }

  function findFileInput(el) {
    if (el.tagName.toLowerCase() === "input" && CB.inputType(el) === "file") return el;
    const inside = el.querySelector('input[type="file"]');
    if (inside) return inside;
    const label = el.closest("label");
    if (label?.control && CB.inputType(label.control) === "file") return label.control;
    // A drop zone often wraps or sits next to a hidden file input. Look a little way up, but stop at
    // page-level containers so an unrelated file input elsewhere on the page isn't picked.
    let a = el;
    for (let i = 0; i < 3 && a.parentElement; i++) {
      a = a.parentElement;
      if (a.matches("body, html, form, main, section, article, [role=main], [role=form]")) break;
      const found = a.querySelectorAll('input[type="file"]');
      if (found.length === 1) return found[0];
      if (found.length > 1) break;
    }
    return null;
  }

  async function upload(msg) {
    const { el, name } = resolve(msg);
    const input = findFileInput(el);
    const target = input || el;
    if (input && input.disabled) CB.fail("E_NOT_INTERACTABLE", `"${name}" is disabled`);
    if (!input) CB.assertInteractable(el, name);
    let warning;
    const accept = input?.getAttribute("accept");
    if (accept) {
      const ext = "." + String(msg.fileName).split(".").pop().toLowerCase();
      const ok = accept.split(",").map((a) => a.trim().toLowerCase()).some((a) => a === ext || a === msg.mimeType || (a.endsWith("/*") && String(msg.mimeType).startsWith(a.slice(0, -1))));
      if (!ok) warning = `The field accepts ${accept}; the site may reject ${msg.fileName}.`;
    }
    markAgentAction(false);
    const settled = CB.settle(500);
    const r = await CB.runMain("upload", target, { fileName: msg.fileName, mimeType: msg.mimeType, base64: msg.base64, mode: input ? "input" : "drop" });
    const s = await settled;
    return { ok: true, target: name, fileName: r.fileName, size: r.size, mode: input ? "input" : "drop", ...(warning ? { warning } : {}), snapshotStale: s.mutated || s.navigated };
  }

  const KEY_CODES = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, " ": 32, Space: 32, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, PageUp: 33, PageDown: 34 };

  function parseKey(spec) {
    const parts = String(spec).split("+");
    let key = parts.pop() || "+";
    if (key === "") key = "+";
    if (key === "Space") key = " ";
    const mods = new Set(parts.map((p) => p.toLowerCase()));
    return {
      key,
      ctrlKey: mods.has("control") || mods.has("ctrl"),
      shiftKey: mods.has("shift"),
      altKey: mods.has("alt") || mods.has("option"),
      metaKey: mods.has("meta") || mods.has("cmd") || mods.has("command"),
    };
  }

  function focusables() {
    return deepQueryAll('a[href], button, input:not([type="hidden"]), select, textarea, [tabindex], [contenteditable="true"]').filter(
      (e) => e.tabIndex >= 0 && !CB.isDisabled(e) && !CB.isHidden(e),
    );
  }

  async function pressKey(msg) {
    const k = parseKey(msg.key);
    const el = deepActiveElement() || document.body;
    const name = el === document.body ? "page" : CB.accessibleName(el) || el.tagName.toLowerCase();
    if (k.key === "Enter" && !msg.approved) {
      if (CB.enterWouldSubmit(el)) return approvalNeeded("press Enter in", `${name} (submits the form)`, "Enter would submit the form", msg.noApproval);
      const c = CB.classifyConsequential(el);
      if (c.consequential && el !== document.body) return approvalNeeded("press Enter on", c.name || name, c.reason, msg.noApproval);
    }
    markAgentAction(msg.approved);
    const settled = CB.settle();
    const code = k.key.length === 1 ? (/[a-z]/i.test(k.key) ? `Key${k.key.toUpperCase()}` : /\d/.test(k.key) ? `Digit${k.key}` : "") : k.key;
    const keyCode = KEY_CODES[k.key] ?? k.key.toUpperCase().charCodeAt(0);
    const init = { ...k, code, keyCode, which: keyCode, bubbles: true, cancelable: true, composed: true };
    const notPrevented = el.dispatchEvent(new KeyboardEvent("keydown", init));
    if (notPrevented && (k.key.length === 1 || k.key === "Enter")) el.dispatchEvent(new KeyboardEvent("keypress", init));
    if (notPrevented) {
      const tag = el.tagName.toLowerCase();
      if (k.key === "Tab") {
        const list = focusables();
        const i = list.indexOf(el);
        const next = list[(i + (k.shiftKey ? -1 : 1) + list.length) % list.length];
        next?.focus();
      } else if (k.key === "Enter") {
        if (CB.enterWouldSubmit(el)) el.form.requestSubmit();
        else if (tag === "a" || tag === "button" || (tag === "input" && ["submit", "button", "image", "reset"].includes(CB.inputType(el)))) CB.clickEl(el);
      } else if (k.key === " " && (tag === "button" || (tag === "input" && ["checkbox", "radio"].includes(CB.inputType(el))))) {
        CB.clickEl(el);
      } else if (k.key.length === 1 && !k.ctrlKey && !k.metaKey && (tag === "input" || tag === "textarea") && !CB.isSensitive(el)) {
        await CB.runMain("setValue", el, { text: k.key, clear: false });
      }
    }
    el.dispatchEvent(new KeyboardEvent("keyup", init));
    const s = await settled;
    return { ok: true, key: msg.key, target: name, navigated: s.navigated, snapshotStale: s.mutated || s.navigated };
  }

  async function scroll(msg) {
    if (msg.ref) {
      const { el, name } = resolve(msg);
      scrollIntoView(el);
      return { ok: true, target: name };
    }
    const amount = msg.amount ?? Math.round(innerHeight * 0.8);
    const dir = msg.direction || "down";
    window.scrollBy({ top: dir === "down" ? amount : dir === "up" ? -amount : 0, left: dir === "right" ? amount : dir === "left" ? -amount : 0, behavior: "instant" });
    await sleep(100);
    return { ok: true, scrollX: Math.round(scrollX), scrollY: Math.round(scrollY) };
  }

  function waitFor(msg) {
    const start = Date.now();
    const timeoutMs = Math.min(Math.max(Number(msg.timeoutMs) || 10000, 100), 60000);
    const lc = (s) => CB.norm(s).toLowerCase();
    const check = () => {
      if (msg.ref) {
        const el = CB.resolveRef(msg.ref);
        if (CB.isHidden(el)) return false;
      }
      const body = msg.text || msg.textGone ? lc(document.body?.innerText ?? document.body?.textContent ?? "") : "";
      if (msg.text && !body.includes(lc(msg.text))) return false;
      if (msg.textGone && body.includes(lc(msg.textGone))) return false;
      return true;
    };
    return cancellableWait((done, fail) => {
      const test = () => {
        try {
          if (check()) done({ ok: true, waitedMs: Date.now() - start });
        } catch (e) {
          fail(e);
        }
      };
      const obs = new MutationObserver(test);
      obs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      const iv = setInterval(test, 250);
      queueMicrotask(test);
      return () => {
        obs.disconnect();
        clearInterval(iv);
      };
    }, timeoutMs);
  }

  function getText(msg) {
    const el = msg.ref ? CB.resolveRef(msg.ref) : document.body || document.documentElement;
    let text = typeof el.innerText === "string" ? el.innerText : el.textContent;
    text = (text || "").replace(/\n{3,}/g, "\n\n").trim();
    const truncated = text.length > 50000;
    return { text: truncated ? text.slice(0, 50000) : text, truncated, url: location.href, origin: location.origin };
  }

  async function rect(msg) {
    const { el } = resolve(msg);
    scrollIntoView(el);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height, viewportWidth: innerWidth, viewportHeight: innerHeight };
  }

  function find(msg) {
    const alloc = CB.newAllocator(msg.nextRef);
    const want = msg.label ?? msg.text;
    const candidates = deepQueryAll(CB.INTERACTIVE_SELECTOR).filter((el) => {
      if (CB.isHidden(el) && !(el.tagName.toLowerCase() === "input" && CB.inputType(el) === "file")) return false;
      const role = CB.roleOf(el);
      if (!role) return false;
      const isControl = ["textbox", "combobox", "listbox", "checkbox", "radio", "switch", "file", "slider", "spinbutton"].includes(role);
      return msg.label ? isControl : !isControl || role === "checkbox" || role === "radio";
    });
    const lw = clean(want).toLowerCase();
    const match = (list) => {
      const names = list.map((el) => clean(CB.accessibleName(el)).toLowerCase());
      let hits = list.filter((_, i) => names[i] === lw);
      if (!hits.length) hits = list.filter((_, i) => names[i].includes(lw));
      return hits;
    };
    let hits = match(candidates);
    // Fall back to button-like elements that aren't real controls (only for text targets, not labels).
    if (!hits.length && !msg.label) {
      hits = match(deepQueryAll("a:not([href]), span, div").filter((el) => !CB.isHidden(el) && CB.isPointerClickable(el)));
    }
    return {
      matches: hits.slice(0, 10).map((el) => ({ ref: CB.refFor(el, alloc), role: CB.roleOf(el), name: CB.truncate(CB.accessibleName(el), 120) })),
      total: hits.length,
      nextRef: alloc.next,
      newRefs: alloc.created,
      origin: location.origin,
    };
  }

  /** One browser_fill_form field: dispatches on the element's type. Never approves anything. */
  async function fillField(msg) {
    const { el, name } = resolve(msg);
    const tag = el.tagName.toLowerCase();
    const role = CB.roleOf(el);
    const v = msg.value;
    const truthy = (x) => x === true || /^(true|yes|y|1|checked|on)$/i.test(String(x));
    if (role === "file") CB.fail("E_NOT_INTERACTABLE", `"${name}" is a file field; use browser_upload.`);
    if (role === "radio") {
      if (typeof v === "boolean") return check({ ...msg, checked: v, noApproval: true });
      return chooseRadio(el, String(v), { ...msg, noApproval: true });
    }
    if (role === "checkbox" || role === "switch") return check({ ...msg, checked: truthy(v), noApproval: true });
    if (tag === "select" || role === "combobox" || role === "listbox") {
      if (role === "combobox" && tag === "input" && el.getAttribute("aria-autocomplete") !== "list" && !el.getAttribute("aria-controls") && el.hasAttribute("list")) {
        return type({ ...msg, text: String(v), clear: true });
      }
      return select({ ...msg, option: String(v), noApproval: true });
    }
    return type({ ...msg, text: String(v), clear: true });
  }

  function describe(msg) {
    const { el, name } = resolve(msg);
    return { role: CB.roleOf(el), tag: el.tagName.toLowerCase(), name, sensitive: CB.isSensitive(el, name) };
  }

  async function approve(msg) {
    const decision = await CB.showApproval({ verb: msg.verb, target: msg.target, host: msg.host, timeoutMs: msg.timeoutMs });
    if (decision === "allow") CB.approvedUntil = Date.now() + 2000;
    return { decision };
  }

  const HANDLERS = {
    ping: () => ({ ok: true, url: location.href, origin: location.origin, refs: CB.refCount() }),
    snapshot: (m) => CB.snapshot(m),
    form_fields: (m) => CB.formFields(m),
    find,
    describe,
    click,
    type,
    select,
    check,
    upload,
    press_key: pressKey,
    scroll,
    wait_for: waitFor,
    get_text: getText,
    rect,
    fill_field: fillField,
    approve,
    highlight: (m) => {
      try {
        CB.highlight(CB.resolveRef(m.ref), !!m.on);
      } catch {
        /* stale: nothing to highlight */
      }
      return { ok: true };
    },
    annotate: (m) => {
      CB.annotate(CB.resolveRef(m.ref), String(m.note || "Review this"));
      return { ok: true };
    },
    control: (m) => {
      CB.controlled = !!m.on;
      return { ok: true };
    },
    cancel: () => {
      for (const c of [...cancellers]) c();
      CB.cancelApproval?.();
      CB.controlled = false;
      return { ok: true };
    },
  };

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.to !== "content") return undefined;
    const handler = HANDLERS[msg.cmd];
    if (!handler) return Promise.resolve({ ok: false, error: { code: "E_INTERNAL", message: `unknown command ${msg.cmd}` } });
    return Promise.resolve()
      .then(() => handler(msg))
      .then(
        (result) => ({ ok: true, result }),
        (err) => ({ ok: false, error: { code: err?.code || "E_INTERNAL", message: String(err?.message ?? err), ...(err?.data !== undefined ? { data: err.data } : {}) } }),
      );
  });

  // Backstop (SPEC 8.2): block a form submission that starts within 1 s of an agent action without approval.
  addEventListener(
    "submit",
    (e) => {
      const now = Date.now();
      if (now - CB.lastAgentActionAt < 1000 && now > CB.approvedUntil) {
        e.preventDefault();
        e.stopImmediatePropagation();
        CB.blockedSubmit = true;
        browser.runtime.sendMessage({ type: "blocked_submit", url: location.href }).catch(() => {});
      }
    },
    true,
  );

  // Esc in a controlled tab stops the agent. Only real key presses count.
  addEventListener(
    "keydown",
    (e) => {
      if (e.isTrusted && e.key === "Escape" && CB.controlled) browser.runtime.sendMessage({ type: "user_stop" }).catch(() => {});
    },
    true,
  );
})();
