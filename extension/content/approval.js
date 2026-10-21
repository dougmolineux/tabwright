// In-page approval prompt (SPEC 8.2), drawn in a closed shadow root so the page can't read, fake or click it.
// Only trusted (real user) clicks count. Also: target highlighting and "review this" annotations.
(() => {
  const CB = (globalThis.ClaudeBridge = globalThis.ClaudeBridge || {});
  if (CB.approvalLoaded) return;
  CB.approvalLoaded = true;

  const STYLE = `
    :host { all: initial; }
    .box { position: fixed; z-index: 2147483647; right: 16px; bottom: 16px; width: min(380px, calc(100vw - 32px));
      box-sizing: border-box; background: #fffaf5; color: #1f1d1a; border: 2px solid #d97757; border-radius: 12px;
      box-shadow: 0 8px 30px rgba(0,0,0,.25); font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 14px 16px; }
    .title { font-weight: 600; font-size: 13px; color: #b5532f; margin: 0 0 6px; letter-spacing: .02em; text-transform: uppercase; }
    .msg { margin: 0 0 12px; word-wrap: break-word; }
    .msg b { font-weight: 650; }
    .row { display: flex; gap: 8px; align-items: center; }
    button { font: inherit; font-weight: 600; border-radius: 8px; padding: 7px 16px; cursor: pointer; border: 1px solid #c9c2b8; }
    .allow { background: #d97757; border-color: #d97757; color: #fff; }
    .deny { background: #fff; color: #1f1d1a; }
    .timer { margin-left: auto; color: #6b665e; font-size: 12px; font-variant-numeric: tabular-nums; }
    @media (prefers-color-scheme: dark) {
      .box { background: #262420; color: #f2efe9; }
      .deny { background: #34312c; color: #f2efe9; border-color: #4a463f; }
      .timer { color: #a9a39a; }
    }`;

  let active = null; // { finish }

  /**
   * Shows the prompt. Resolves to "allow", "deny", "timeout" or "cancelled".
   */
  CB.showApproval = ({ verb, target, host, timeoutMs }) => {
    if (active) active.finish("cancelled");
    return new Promise((resolve) => {
      const hostEl = document.createElement("claude-bridge-approval");
      hostEl.setAttribute("data-claude-bridge-ui", "");
      const root = hostEl.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = STYLE;
      const box = document.createElement("div");
      box.className = "box";
      box.setAttribute("role", "alertdialog");
      const title = document.createElement("p");
      title.className = "title";
      title.textContent = "Claude needs your approval";
      const msg = document.createElement("p");
      msg.className = "msg";
      const b = document.createElement("b");
      b.textContent = target || "this element";
      msg.append(`Claude wants to ${verb || "click"} `, b, ` on ${host}.`);
      const row = document.createElement("div");
      row.className = "row";
      const allow = document.createElement("button");
      allow.className = "allow";
      allow.textContent = "Allow";
      const deny = document.createElement("button");
      deny.className = "deny";
      deny.textContent = "Deny";
      const timer = document.createElement("span");
      timer.className = "timer";
      row.append(allow, deny, timer);
      box.append(title, msg, row);
      root.append(style, box);
      (document.body || document.documentElement).appendChild(hostEl);

      const deadline = Date.now() + timeoutMs;
      const tick = () => {
        const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
        timer.textContent = `${left}s`;
      };
      tick();
      const interval = setInterval(tick, 1000);
      const timeout = setTimeout(() => finish("timeout"), timeoutMs);
      // Re-attach if the page removes the prompt.
      const keepAlive = new MutationObserver(() => {
        if (!hostEl.isConnected) (document.body || document.documentElement).appendChild(hostEl);
      });
      keepAlive.observe(document.documentElement, { childList: true, subtree: true });

      function finish(decision) {
        if (!active || active.finish !== finish) return;
        active = null;
        clearInterval(interval);
        clearTimeout(timeout);
        keepAlive.disconnect();
        hostEl.remove();
        resolve(decision);
      }
      const onClick = (decision) => (e) => {
        if (!e.isTrusted) return; // scripts can't approve
        e.stopPropagation();
        finish(decision);
      };
      allow.addEventListener("click", onClick("allow"));
      deny.addEventListener("click", onClick("deny"));
      active = { finish };
      try {
        deny.focus({ preventScroll: true });
      } catch {
        /* ignore */
      }
    });
  };

  CB.cancelApproval = () => active?.finish("cancelled");

  // ---------- highlight ----------

  const saved = new WeakMap();
  CB.highlight = (el, on) => {
    if (on) {
      if (!saved.has(el)) saved.set(el, { outline: el.style.outline, offset: el.style.outlineOffset });
      el.style.setProperty("outline", "3px solid #d97757", "important");
      el.style.setProperty("outline-offset", "2px", "important");
    } else if (saved.has(el)) {
      const s = saved.get(el);
      el.style.outline = s.outline;
      el.style.outlineOffset = s.offset;
      saved.delete(el);
    }
  };

  // ---------- review annotations (drafted answers) ----------

  CB.annotate = (el, note) => {
    el.style.setProperty("outline", "2px dashed #e0a100", "important");
    el.style.setProperty("outline-offset", "2px", "important");
    const tag = document.createElement("claude-bridge-note");
    tag.setAttribute("data-claude-bridge-ui", "");
    const root = tag.attachShadow({ mode: "closed" });
    const span = document.createElement("span");
    span.textContent = note;
    span.style.cssText =
      "display:inline-block;margin:4px 0;padding:2px 8px;border-radius:6px;background:#fff3cd;color:#5c4400;" +
      "font:600 12px/1.6 -apple-system,BlinkMacSystemFont,sans-serif;border:1px solid #e0a100";
    root.append(span);
    el.insertAdjacentElement("afterend", tag);
  };
})();
