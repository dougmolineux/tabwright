// Instruction mode sidebar (SPEC 10.1): instruction box, engine, step log, questions, summary, profile editor.
const $ = (id) => document.getElementById(id);
let windowId = null;
let lastState = null;
let logClearedAt = 0;
let currentOrigin = null;
let currentPattern = null; // match patterns have no port
let lastInstruction = "";
// When opened as a page instead of the sidebar (e.g. sidebar.html?tab=12), act on that tab.
const pinnedTabId = Number(new URLSearchParams(location.search).get("tab")) || null;

function el(tag, text, cls) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (cls) n.className = cls;
  return n;
}

async function send(msg) {
  const res = await browser.runtime.sendMessage(msg);
  if (res && res.ok === false) throw Object.assign(new Error(res.error), { code: res.code });
  return res;
}

// ---------- site permission ----------

async function renderSite() {
  const tab = pinnedTabId ? await browser.tabs.get(pinnedTabId).catch(() => null) : (await browser.tabs.query({ active: true, windowId: windowId ?? undefined }))[0];
  let origin = null;
  let host = "this page";
  currentPattern = null;
  try {
    const u = new URL(tab?.url ?? "");
    if (u.protocol === "http:" || u.protocol === "https:") {
      origin = u.origin;
      host = u.hostname;
      currentPattern = `${u.protocol}//${u.hostname}/*`;
    }
  } catch {
    /* not a web page */
  }
  currentOrigin = origin;
  const allowed = origin ? await browser.permissions.contains({ origins: [currentPattern] }) : false;
  $("allowBox").hidden = allowed;
  $("allowBtn").hidden = !origin;
  $("allowText").textContent = origin
    ? `Claude isn't allowed on ${host}. Allow it to fill forms on this site.`
    : "Open a web page to use Claude here.";
}

$("allowBtn").addEventListener("click", () => {
  if (!currentOrigin) return;
  // Must be called directly in the click handler (user gesture).
  browser.permissions.request({ origins: [currentPattern] }).then(() => {
    send({ type: "site_changed" });
    renderSite();
  });
});

// ---------- state ----------

function renderState(s) {
  lastState = s;
  const dot = $("dot");
  dot.className = "dot" + (s.busy ? " busy" : s.connected ? " on" : s.error ? " error" : "");
  $("conn").textContent = s.connected ? (s.busy ? "Claude is acting" : "Connected") : s.connecting ? "Connecting…" : s.error ? s.error : "Disconnected";
  $("connectBtn").hidden = s.connected || s.connecting;

  const running = s.run?.status === "running";
  $("runBtn").disabled = running;
  $("instruction").disabled = running;
  $("engine").textContent = s.run?.label ?? "—";

  // question
  const q = s.question;
  $("questionBox").hidden = !q;
  if (q && $("questionBox").dataset.id !== q.id) {
    $("questionBox").dataset.id = q.id;
    $("questionText").textContent = q.question;
    const opts = $("questionOptions");
    opts.replaceChildren();
    for (const o of q.options ?? []) {
      const b = el("button", o, "small");
      b.addEventListener("click", () => answer(o));
      opts.append(b);
    }
    $("answerInput").value = "";
    $("answerInput").focus();
  }

  // summary
  renderResult(s.run);

  // log
  const ol = $("log");
  ol.replaceChildren();
  for (const entry of s.log.filter((e) => e.time >= logClearedAt)) {
    const li = el("li", entry.text, entry.kind);
    li.title = new Date(entry.time).toLocaleTimeString();
    ol.append(li);
  }
  ol.scrollTop = ol.scrollHeight;
}

function renderList(parent, title, items) {
  if (!items?.length) return;
  parent.append(el("h4", `${title} (${items.length})`));
  const ul = el("ul");
  for (const i of items) ul.append(el("li", i));
  parent.append(ul);
}

function renderResult(run) {
  const box = $("resultBox");
  const body = $("resultBody");
  if (!run || run.status === "running") {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  body.replaceChildren();
  if (run.status === "done") {
    $("resultTitle").textContent = `Done — ${run.label ?? ""}`;
    const s = run.summary ?? {};
    renderList(body, "Filled", s.filled);
    renderList(body, "Left for you", s.leftForUser);
    renderList(body, "Failed", s.failed);
    renderList(body, "Notes", s.notes);
    if (s.text) body.append(el("div", s.text, "text"));
    body.append(el("p", "Review the page, then submit it yourself — Claude never submits without your approval.", "muted small"));
  } else {
    $("resultTitle").textContent = "Stopped";
    body.append(el("div", run.message ?? "The run stopped.", "text"));
  }
  $("continueBtn").hidden = !run.offerContinue;
}

// ---------- actions ----------

async function run(engine) {
  const instruction = engine === "fm" && lastInstruction ? lastInstruction : $("instruction").value.trim();
  if (!instruction) {
    $("instruction").focus();
    return;
  }
  lastInstruction = instruction;
  logClearedAt = 0;
  try {
    await send({ type: "run", instruction, engine, windowId, tabId: pinnedTabId ?? undefined });
  } catch (err) {
    if (err.code === "E_SITE_NOT_ALLOWED") renderSite();
    const ol = $("log");
    ol.append(el("li", err.message, "error"));
  }
}

function answer(text) {
  const q = lastState?.question;
  if (!q) return;
  send({ type: "answer", id: q.id, answer: text });
}

$("runBtn").addEventListener("click", () => run("auto"));
$("instruction").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run("auto");
});
$("stopBtn").addEventListener("click", () => send({ type: "stop" }));
$("continueBtn").addEventListener("click", () => run("fm"));
$("connectBtn").addEventListener("click", () => send({ type: "connect" }));
$("clearLog").addEventListener("click", () => {
  logClearedAt = Date.now();
  if (lastState) renderState(lastState);
});
$("answerForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("answerInput").value.trim();
  if (v) answer(v);
});

// ---------- profile editor (SPEC 10.2) ----------

async function loadProfile() {
  $("profileMsg").textContent = "Loading…";
  try {
    const res = await send({ type: "profile_get" });
    $("profilePath").textContent = res.path;
    $("profile").value = JSON.stringify(res.profile ?? {}, null, 2);
    $("profileMsg").textContent = res.profile ? "" : "No profile yet.";
  } catch (err) {
    $("profileMsg").textContent = err.message;
  }
}

$("profileBox").addEventListener("toggle", () => {
  if ($("profileBox").open) loadProfile();
});
$("profileReload").addEventListener("click", loadProfile);
$("profileSave").addEventListener("click", async () => {
  let profile;
  try {
    profile = JSON.parse($("profile").value);
  } catch (err) {
    $("profileMsg").textContent = `Not valid JSON: ${err.message}`;
    return;
  }
  try {
    await send({ type: "profile_set", profile });
    $("profileMsg").textContent = "Saved.";
  } catch (err) {
    $("profileMsg").textContent = err.message;
  }
});

// ---------- init ----------

(async () => {
  windowId = (await browser.windows.getCurrent()).id;
  const port = browser.runtime.connect({ name: "ui" });
  port.onMessage.addListener((m) => m.type === "state" && renderState(m.state));
  renderSite();
  browser.tabs.onActivated.addListener((info) => info.windowId === windowId && renderSite());
  browser.tabs.onUpdated.addListener((_id, info, tab) => tab.windowId === windowId && tab.active && info.url && renderSite());
  browser.permissions.onAdded.addListener(renderSite);
  browser.permissions.onRemoved.addListener(renderSite);
})();
