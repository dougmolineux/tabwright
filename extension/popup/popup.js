// Toolbar popup (SPEC 4.1, 8.1): connection, site allowlist, Stop, pending approvals.
const $ = (id) => document.getElementById(id);
const BLOCKED = new Set(["addons.mozilla.org", "accounts.firefox.com", "support.mozilla.org"]);
let currentOrigin = null;
let currentPattern = null; // match patterns have no port

function siteOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return { origin: null, blocked: true, host: u.protocol.replace(":", "") + " page" };
    return { origin: u.origin, pattern: `${u.protocol}//${u.hostname}/*`, blocked: BLOCKED.has(u.hostname), host: u.hostname };
  } catch {
    return { origin: null, blocked: true, host: "this page" };
  }
}

async function renderSite() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const { origin, pattern, blocked, host } = siteOf(tab?.url ?? "");
  currentOrigin = blocked ? null : origin;
  currentPattern = pattern;
  $("siteHost").textContent = host;
  const allowBtn = $("allowBtn");
  if (blocked || !origin) {
    allowBtn.hidden = true;
    $("siteNote").textContent = "Claude can't be used on browser, extension or account pages.";
    return;
  }
  const allowed = await browser.permissions.contains({ origins: [pattern] });
  allowBtn.hidden = allowed;
  $("shotNote").hidden = !allowed;
  allowBtn.textContent = `Allow Claude on ${host}`;
  $("siteNote").textContent = allowed ? "Claude is allowed on this site." : "Claude can't read or act on this site until you allow it.";
}

async function renderSites() {
  const perms = await browser.permissions.getAll();
  const origins = (perms.origins ?? []).filter((o) => o !== "<all_urls>");
  const ul = $("sites");
  ul.replaceChildren();
  $("noSites").hidden = origins.length > 0;
  for (const o of origins) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = o.replace(/\/\*$/, "").replace(/^https?:\/\//, "");
    const rm = document.createElement("button");
    rm.className = "small";
    rm.textContent = "Remove";
    rm.addEventListener("click", async () => {
      await browser.permissions.remove({ origins: [o] });
      browser.runtime.sendMessage({ type: "site_changed" });
      renderSites();
      renderSite();
    });
    li.append(span, rm);
    ul.append(li);
  }
}

function renderState(s) {
  const dot = $("dot");
  dot.className = "dot" + (s.busy ? " busy" : s.connected ? " on" : s.error ? " error" : "");
  $("status").textContent = s.busy ? "acting" : s.connected ? "connected" : s.connecting ? "connecting…" : "disconnected";
  $("error").hidden = !s.error;
  $("error").textContent = s.error ?? "";
  const btn = $("connectBtn");
  btn.textContent = s.connected || s.connecting ? "Disconnect" : "Connect";
  btn.dataset.action = s.connected || s.connecting ? "disconnect" : "connect";
  $("autoApprove").checked = s.autoApprove === true;
  $("approvalsSec").hidden = !s.approvals.length;
  const ul = $("approvals");
  ul.replaceChildren();
  for (const a of s.approvals) {
    const li = document.createElement("li");
    li.textContent = `${a.verb} "${a.target}" on ${a.host}`;
    li.title = "Show the tab. Approve or deny in the page.";
    li.addEventListener("click", () => browser.runtime.sendMessage({ type: "focus_tab", tabId: a.tabId }));
    ul.append(li);
  }
}

// permissions.request must run synchronously inside the click handler (user gesture).
$("allowBtn").addEventListener("click", () => {
  if (!currentOrigin) return;
  browser.permissions.request({ origins: [currentPattern] }).then(() => {
    browser.runtime.sendMessage({ type: "site_changed" });
    renderSite();
    renderSites();
  });
});

$("connectBtn").addEventListener("click", () => browser.runtime.sendMessage({ type: $("connectBtn").dataset.action || "connect" }));
$("stopBtn").addEventListener("click", () => browser.runtime.sendMessage({ type: "stop" }));
$("autoApprove").addEventListener("change", (e) => browser.runtime.sendMessage({ type: "set_auto_approve", enabled: e.target.checked }));
$("openSidebar").addEventListener("click", (e) => {
  e.preventDefault();
  browser.sidebarAction.open();
  window.close();
});
$("viewActivity").addEventListener("click", (e) => {
  e.preventDefault();
  browser.tabs.create({ url: browser.runtime.getURL("popup/activity.html") });
  window.close();
});

const port = browser.runtime.connect({ name: "ui" });
port.onMessage.addListener((m) => m.type === "state" && renderState(m.state));
renderSite();
renderSites();
