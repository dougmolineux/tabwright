// Page snapshots (SPEC 6.1): a compact outline of what a person could see and interact with.
// Returns items { d: depth, t: line } plus frame placeholders { d, frameId } that the background
// script replaces with the child frame's own snapshot.
(() => {
  const CB = (globalThis.Tabwright = globalThis.Tabwright || {});
  if (CB.snapshotLoaded) return;
  CB.snapshotLoaded = true;

  const SKIP_TAGS = new Set([
    "script", "style", "noscript", "template", "head", "meta", "link", "svg", "canvas", "option", "optgroup",
    "datalist", "title", "br", "hr", "source", "track", "object", "embed", "map", "area", "picture",
  ]);
  const LISTISH = 'ul, ol, tbody, table, [role="list"], [role="listbox"], [role="menu"], [role="grid"], [role="tree"]';
  const TEXT_LIMIT = 200;
  const MAX_SELECT_OPTIONS = 30;
  const INLINE_BLOCKERS = `${CB.INTERACTIVE_SELECTOR}, iframe, frame, h1, h2, h3, h4, h5, h6, [role], img[alt], label, p, div, li, table`;

  const q = (s) => JSON.stringify(s);

  function childNodesOf(node) {
    if (node.nodeType === 1) {
      if (node.shadowRoot) return Array.from(node.shadowRoot.childNodes);
      if (node.tagName === "SLOT") {
        const assigned = node.assignedNodes({ flatten: true });
        if (assigned.length) return assigned;
      }
    }
    return Array.from(node.childNodes);
  }

  const INLINE_TAGS = new Set(["a", "abbr", "b", "bdi", "bdo", "cite", "code", "data", "dfn", "em", "i", "kbd", "mark", "q", "s", "samp", "small", "span", "strong", "sub", "sup", "time", "u", "var"]);

  function isInline(el) {
    if (el.shadowRoot || el.openOrClosedShadowRoot) return false;
    const st = el.ownerDocument.defaultView.getComputedStyle(el);
    // Browsers always report display; jsdom leaves it empty, so fall back to the tag.
    const display = st.display || (INLINE_TAGS.has(el.tagName.toLowerCase()) ? "inline" : "block");
    if (!display.startsWith("inline") || (display === "inline-block" && el.childElementCount > 3)) return false;
    return !el.querySelector(INLINE_BLOCKERS);
  }

  function selectedOptionTexts(sel) {
    return Array.from(sel.selectedOptions || []).map((o) => CB.norm(o.label || o.textContent));
  }

  function optionTexts(sel) {
    return Array.from(sel.options || []).map((o) => CB.norm(o.label || o.textContent)).filter(Boolean);
  }

  /** The displayed value of a custom combobox (e.g. react-select shows it next to the input). */
  function comboValue(el) {
    if (el.tagName.toLowerCase() !== "input") return CB.visibleText(el);
    if (el.value) return el.value;
    let a = el;
    for (let i = 0; i < 4 && a.parentElement; i++) {
      a = a.parentElement;
      if (a.querySelector("label") || a.tagName.toLowerCase() === "form") break;
      const t = CB.visibleText(a);
      if (t) return CB.truncate(t, 100);
    }
    return "";
  }

  function errorText(el) {
    const ids = `${el.getAttribute("aria-errormessage") || ""} ${el.getAttribute("aria-describedby") || ""}`.split(/\s+/).filter(Boolean);
    const root = el.getRootNode();
    const texts = ids
      .map((id) => (root.getElementById ? root.getElementById(id) : null) || el.ownerDocument.getElementById(id))
      .filter((n) => n && !CB.isHidden(n))
      .map((n) => CB.norm(n.textContent));
    return CB.truncate(texts.join(" "), TEXT_LIMIT);
  }

  function fieldKind(el, role) {
    const tag = el.tagName.toLowerCase();
    if (role === "file") return "file";
    if (role === "checkbox" || role === "switch") return "checkbox";
    if (role === "radio") return "radio";
    if (tag === "select") return "select";
    if (role === "combobox" || role === "listbox") return "combobox";
    if (tag === "textarea" || el.getAttribute("aria-multiline") === "true") return "textarea";
    if (tag === "input") return CB.inputType(el) || "text";
    return "text";
  }

  class Walker {
    constructor(opts) {
      this.alloc = CB.newAllocator(opts.nextRef);
      this.includeText = opts.includeText !== false;
      this.collapseLists = !!opts.collapseLists;
      this.fieldsMode = !!opts.fieldsMode;
      this.charLimit = opts.charLimit || 25000;
      this.items = [];
      this.fields = [];
      this.frames = [];
      this.chars = 0;
      this.stopped = false;
      this.buf = [];
      this.labelledIds = new Set();
      for (const n of document.querySelectorAll("[aria-labelledby]")) {
        for (const id of n.getAttribute("aria-labelledby").split(/\s+/)) if (id) this.labelledIds.add(id);
      }
    }

    push(d, t) {
      this.items.push({ d, t });
      this.chars += t.length + d * 2 + 1;
      // Hard stop well past the limit; the caller retries with list collapsing first.
      if (this.chars > this.charLimit * 2) this.stopped = true;
    }

    flush(d) {
      if (!this.buf.length) return;
      const text = CB.norm(this.buf.join(""));
      this.buf = [];
      if (text && this.includeText && !this.fieldsMode) this.push(d, `- text ${q(CB.truncate(text, TEXT_LIMIT))}`);
    }

    walk(nodes, d, suppressText = false) {
      for (let i = 0; i < nodes.length && !this.stopped; i++) {
        const node = nodes[i];
        if (node.nodeType === 3) {
          if (!suppressText) this.buf.push(node.data);
          continue;
        }
        if (node.nodeType !== 1) continue;
        const el = node;
        const tag = el.tagName.toLowerCase();
        if (SKIP_TAGS.has(tag) || el.hasAttribute("data-tabwright-ui")) continue;
        if (tag === "legend" && el.parentElement?.tagName.toLowerCase() === "fieldset") continue; // the group's name
        if (CB.isHidden(el)) continue;
        let role = CB.roleOf(el);
        // A role-less assertive live region (a common way to show validation errors) reads as an alert.
        if (!role && el.getAttribute("aria-live") === "assertive" && !el.querySelector(CB.INTERACTIVE_SELECTOR)) role = "alert";

        if (tag === "label" && !role) {
          const ctl = el.control;
          if (ctl && !el.contains(ctl)) continue; // its text is the control's name
          if (ctl) {
            this.flush(d);
            this.walk(childNodesOf(el), d, true);
            continue;
          }
        }
        if (!role && el.id && this.labelledIds.has(el.id) && !el.querySelector(CB.INTERACTIVE_SELECTOR)) continue;
        if (!role && isInline(el)) {
          if (!suppressText) this.buf.push(" " + (typeof el.innerText === "string" ? el.innerText : el.textContent) + " ");
          continue;
        }

        this.flush(d);
        if (role) {
          const emitted = this.emit(el, role, d);
          // A custom listbox (an open dropdown) shows its options; everything else in LEAF_ROLES is one line.
          if (CB.LEAF_ROLES.has(role) && !(role === "listbox" && tag !== "select")) continue;
          this.walkChildren(el, emitted ? d + 1 : d, suppressText);
        } else if (!el.shadowRoot && el.openOrClosedShadowRoot) {
          this.push(d, `- opaque ${tag} (closed shadow root)`);
        } else {
          this.walkChildren(el, d, suppressText);
        }
      }
      this.flush(d);
    }

    walkChildren(el, d, suppressText) {
      let kids = childNodesOf(el);
      if (this.collapseLists && el.matches(LISTISH)) {
        const elems = kids.filter((n) => n.nodeType === 1);
        if (elems.length > 20) {
          this.walk(elems.slice(0, 10), d, suppressText);
          this.push(d, `- … (${elems.length - 10} more items)`);
          return;
        }
      }
      this.walk(kids, d, suppressText);
    }

    emit(el, role, d) {
      if (role === "frame") return this.emitFrame(el, d);
      if (role === "heading") {
        const level = Number(el.getAttribute("aria-level")) || Number(el.tagName.slice(1)) || 2;
        const text = CB.visibleText(el);
        if (text && !this.fieldsMode) this.push(d, `- heading ${q(CB.truncate(text, TEXT_LIMIT))} [level=${level}]`);
        return false;
      }
      if (role === "alert" || role === "status" || el.getAttribute("aria-live") === "assertive") {
        const text = CB.visibleText(el);
        if (text && !this.fieldsMode) this.push(d, `- alert ${q(CB.truncate(text, TEXT_LIMIT))}`);
        return false;
      }
      if (role === "img") {
        if (this.includeText && !this.fieldsMode) this.push(d, `- img ${q(CB.truncate(CB.accessibleName(el), 100))}`);
        return false;
      }
      if (CB.LANDMARK_ROLES.has(role)) {
        const own = CB.ariaName(el) || (el.tagName.toLowerCase() === "fieldset" ? CB.accessibleName(el) : "");
        if ((role === "list" || role === "group" || role === "radiogroup" || role === "menu" || role === "tablist") && !own) return false;
        if (this.fieldsMode) return false;
        this.push(d, own ? `- ${role} ${q(CB.truncate(own, 120))}` : `- ${role}`);
        return true;
      }
      if (!CB.INTERACTIVE_ROLES.has(role)) return false;
      this.emitControl(el, role, d);
      return true;
    }

    emitFrame(el, d) {
      if (CB.isCaptchaFrame(el)) {
        if (!this.fieldsMode) this.push(d, "- captcha (user must complete)");
        return false;
      }
      let frameId = -1;
      try {
        if (typeof browser !== "undefined" && browser.runtime?.getFrameId) frameId = browser.runtime.getFrameId(el);
      } catch {
        /* not a browsing context yet */
      }
      const title = CB.norm(el.getAttribute("title") || el.getAttribute("name") || "");
      if (frameId < 0) {
        if (!this.fieldsMode) this.push(d, `- frame ${q(title)} (unavailable)`);
        return false;
      }
      this.frames.push(frameId);
      this.items.push({ d, frameId, src: el.src || "", title });
      return false;
    }

    emitControl(el, role, d) {
      const tag = el.tagName.toLowerCase();
      const ref = CB.refFor(el, this.alloc);
      let name = CB.accessibleName(el);
      const sensitive = CB.isSensitive(el, name);
      const attrs = [`[ref=${ref}]`];
      const type = CB.inputType(el);
      const required = el.required || el.getAttribute("aria-required") === "true";
      if (required) attrs.push("[required]");
      if (CB.isDisabled(el)) attrs.push("[disabled]");
      if (el.readOnly || el.getAttribute("aria-readonly") === "true") attrs.push("[readonly]");
      if (tag === "input" && role === "textbox" && type && type !== "text") attrs.push(`[type=${type}]`);
      if (tag === "textarea") attrs.push("[multiline]");
      if (role === "checkbox" || role === "radio" || role === "switch" || role === "menuitemcheckbox" || role === "menuitemradio") {
        const checked = tag === "input" ? el.checked : el.getAttribute("aria-checked") === "true";
        if (checked) attrs.push("[checked]");
      }
      if (el.getAttribute("aria-expanded") === "true") attrs.push("[expanded]");
      if ((role === "option" || role === "tab" || role === "treeitem") && el.getAttribute("aria-selected") === "true") attrs.push("[selected]");
      if (role === "file") {
        const accept = el.getAttribute("accept");
        if (accept) attrs.push(`[accept=${accept.replace(/\s+/g, "")}]`);
        if (el.multiple) attrs.push("[multiple]");
      }
      if (el.getAttribute("aria-invalid") === "true") {
        attrs.push("[invalid]");
        const err = errorText(el);
        if (err) attrs.push(`error=${q(err)}`);
      }
      if (role === "button" || role === "link" || role === "menuitem") {
        if (CB.classifyConsequential(el).consequential) attrs.push("[consequential]");
      }

      let value = null;
      let options = null;
      if (sensitive) {
        attrs.push("value=[redacted]");
      } else if (tag === "select") {
        const sel = selectedOptionTexts(el);
        value = sel.join(", ");
        attrs.push(`value=${q(CB.truncate(value, TEXT_LIMIT))}`);
        options = optionTexts(el);
        const max = this.collapseLists ? 10 : MAX_SELECT_OPTIONS;
        const shown = options.slice(0, max).map((o) => CB.truncate(o, 60)).join(" | ");
        attrs.push(`[options: ${shown}${options.length > max ? ` | … (${options.length - max} more)` : ""}]`);
      } else if (role === "textbox" || role === "spinbutton" || role === "slider") {
        value = el.isContentEditable ? CB.visibleText(el) : el.value ?? el.getAttribute("aria-valuenow") ?? "";
        if (value) attrs.push(`value=${q(CB.truncate(value, TEXT_LIMIT))}`);
      } else if (role === "combobox") {
        value = comboValue(el);
        if (value) attrs.push(`value=${q(CB.truncate(value, TEXT_LIMIT))}`);
      } else if (role === "file") {
        const names = Array.from(el.files || []).map((f) => f.name);
        if (names.length) attrs.push(`value=${q(names.join(", "))}`);
        value = names.join(", ");
      }

      if (role === "radio" && !name) name = CB.visibleText(el.parentElement);
      if (!this.fieldsMode) this.push(d, `- ${role} ${q(CB.truncate(name, 150))} ${attrs.join(" ")}`);

      if (this.fieldsMode && ["textbox", "combobox", "listbox", "checkbox", "radio", "switch", "file", "spinbutton"].includes(role) && !sensitive) {
        const kind = fieldKind(el, role);
        let label = name;
        if (kind === "radio" || kind === "checkbox") {
          const gl = CB.groupLabel(el);
          this.fields.push({ ref, label, kind, required, value: kind === "checkbox" ? String(el.checked ?? el.getAttribute("aria-checked") === "true") : "", group: gl, groupKey: kind === "radio" ? (el.form ? "f" : "") + ":" + (el.name || gl) : null, checked: !!el.checked });
          return;
        }
        this.fields.push({ ref, label, kind, required, value: value ?? "", options: options ?? undefined, accept: el.getAttribute("accept") || undefined });
      }
    }
  }

  function run(opts) {
    const root = opts.root ? CB.resolveRef(opts.root) : null;
    const start = root ? [root] : childNodesOf(document.body || document.documentElement);
    let w = new Walker(opts);
    w.walk(start, 0);
    if (!opts.fieldsMode && (w.chars > w.charLimit || w.stopped) && !opts.collapseLists) {
      // Retry with long lists collapsed; refs already created stay valid.
      const retry = new Walker({ ...opts, collapseLists: true, nextRef: w.alloc.next });
      retry.alloc.created = w.alloc.created;
      retry.walk(start, 0);
      w = retry;
    }
    return w;
  }

  CB.snapshot = (opts = {}) => {
    const w = run(opts);
    return {
      items: w.items,
      truncated: w.stopped || w.chars > w.charLimit,
      nextRef: w.alloc.next,
      newRefs: w.alloc.created,
      title: document.title,
      url: location.href,
      origin: location.origin,
    };
  };

  /** Form fields for instruction mode (SPEC 10.4 step 2): label, type, options, required. */
  CB.formFields = (opts = {}) => {
    const w = run({ ...opts, fieldsMode: true, includeText: false });
    const fields = [];
    const groups = new Map();
    for (const f of w.fields) {
      if (f.kind === "radio") {
        const key = f.groupKey;
        let g = groups.get(key);
        if (!g) {
          g = { ref: f.ref, label: f.group || f.label, kind: "radio", required: f.required, options: [], value: "" };
          groups.set(key, g);
          fields.push(g);
        }
        g.options.push(f.label);
        g.required = g.required || f.required;
        if (f.checked) g.value = f.label;
        continue;
      }
      const { groupKey, group, checked, ...rest } = f;
      if (f.kind === "checkbox" && group && group !== f.label) rest.label = `${group}: ${f.label}`;
      fields.push(rest);
    }
    return { fields, frames: w.frames, nextRef: w.alloc.next, newRefs: w.alloc.created, origin: location.origin };
  };
})();
