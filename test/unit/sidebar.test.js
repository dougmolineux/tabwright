// @vitest-environment jsdom
// The instruction-mode sidebar (SPEC 10.1, 10.2) with its real HTML and script: connection, site permission,
// running an instruction, questions, the summary, the step log and the profile editor.
import { afterEach, describe, expect, it } from "vitest";
import { $, baseState, fakeBrowser, flush, loadPage, texts } from "../helpers/ui-browser.js";

const JOBS = { id: 5, windowId: 1, url: "https://jobs.test/apply", active: true };
const OTHER_WINDOW = { id: 8, windowId: 2, url: "https://other.test/", active: true };
const openSidebar = (opts = {}) =>
  loadPage("sidebar/sidebar", fakeBrowser({ tabs: [JOBS, OTHER_WINDOW], granted: ["https://jobs.test/*"], ...opts }), () => import("../../extension/sidebar/sidebar.js"));

const running = (over = {}) => ({ runId: "r1", engine: "claude", label: "Claude", status: "running", instruction: "Fill it", summary: null, message: null, offerContinue: false, ...over });

afterEach(() => {
  history.replaceState(null, "", "/");
});

describe("connection", () => {
  it.each([
    [{}, "Disconnected", "dot", false],
    [{ connecting: true }, "Connecting…", "dot", true],
    [{ error: "Native host exited" }, "Native host exited", "dot error", false],
    [{ connected: true }, "Connected", "dot on", true],
    [{ connected: true, busy: true }, "Claude is acting", "dot busy", true],
  ])("%j → %s", async (over, conn, dot, connectHidden) => {
    const { port } = await openSidebar();
    expect(port.name).toBe("ui");
    port.push(baseState(over));
    expect($("conn").textContent).toBe(conn);
    expect($("dot").className).toBe(dot);
    expect($("connectBtn").hidden).toBe(connectHidden);
  });

  it("connects and stops", async () => {
    const { sent } = await openSidebar();
    $("connectBtn").click();
    $("stopBtn").click();
    expect(sent.map((m) => m.type)).toEqual(["connect", "stop"]);
  });
});

describe("site permission", () => {
  it("hides the notice on an allowed site in this window", async () => {
    const fake = await openSidebar();
    expect(fake.browser.tabs.query).toHaveBeenCalledWith({ active: true, windowId: 1 });
    expect($("allowBox").hidden).toBe(true);
  });

  it("offers to allow a site, by match pattern without the port", async () => {
    const fake = await openSidebar({ tabs: [{ id: 1, windowId: 1, url: "http://localhost:3000/x", active: true }], granted: [] });
    expect($("allowBox").hidden).toBe(false);
    expect($("allowBtn").hidden).toBe(false);
    expect($("allowText").textContent).toBe("Claude isn't allowed on localhost. Allow it to fill forms on this site.");
    $("allowBtn").click();
    expect(fake.browser.permissions.request).toHaveBeenCalledWith({ origins: ["http://localhost/*"] });
    await flush();
    expect(fake.sent).toContainEqual({ type: "site_changed" });
    expect($("allowBox").hidden).toBe(true);
  });

  it("asks for a web page when the tab isn't one", async () => {
    const fake = await openSidebar({ tabs: [{ id: 1, windowId: 1, url: "about:newtab", active: true }] });
    expect($("allowBox").hidden).toBe(false);
    expect($("allowBtn").hidden).toBe(true);
    expect($("allowText").textContent).toBe("Open a web page to use Claude here.");
    $("allowBtn").click();
    expect(fake.browser.permissions.request).not.toHaveBeenCalled();
  });

  it("re-checks when the active tab, its URL or the permissions change", async () => {
    const fake = await openSidebar();
    const calls = () => fake.browser.permissions.contains.mock.calls.length;
    const before = calls();
    fake.listeners.activated.forEach((fn) => fn({ tabId: 5, windowId: 1 }));
    fake.listeners.activated.forEach((fn) => fn({ tabId: 8, windowId: 2 })); // other window: ignored
    fake.listeners.updated.forEach((fn) => fn(5, { url: "https://jobs.test/2" }, JOBS));
    fake.listeners.updated.forEach((fn) => fn(5, { status: "loading" }, JOBS)); // no URL change: ignored
    fake.listeners.permRemoved.forEach((fn) => fn({ origins: [] }));
    await flush();
    expect(calls() - before).toBe(3);
  });

  it("acts on a pinned tab when opened as sidebar.html?tab=<id>", async () => {
    history.replaceState(null, "", "/?tab=8");
    const fake = await openSidebar({ granted: [] });
    expect(fake.browser.tabs.get).toHaveBeenCalledWith(8);
    expect($("allowText").textContent).toMatch(/other\.test/);
    $("instruction").value = "Do it";
    $("runBtn").click();
    await flush();
    expect(fake.sent.find((m) => m.type === "run")).toEqual({ type: "run", instruction: "Do it", engine: "auto", windowId: 1, tabId: 8 });
  });
});

describe("running an instruction", () => {
  it("sends the trimmed instruction for this window", async () => {
    const { sent } = await openSidebar();
    $("instruction").value = "  Fill out this application  ";
    $("runBtn").click();
    await flush();
    expect(sent.find((m) => m.type === "run")).toEqual({ type: "run", instruction: "Fill out this application", engine: "auto", windowId: 1, tabId: undefined });
  });

  it("runs on Ctrl/Cmd+Enter but not plain Enter", async () => {
    const { sent } = await openSidebar();
    $("instruction").value = "Go";
    $("instruction").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    $("instruction").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true }));
    $("instruction").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true }));
    await flush();
    expect(sent.filter((m) => m.type === "run")).toHaveLength(2);
  });

  it("does nothing without an instruction", async () => {
    const { sent } = await openSidebar();
    $("instruction").value = "   ";
    $("runBtn").click();
    await flush();
    expect(sent.some((m) => m.type === "run")).toBe(false);
    expect(document.activeElement).toBe($("instruction"));
  });

  it("shows why a run couldn't start, and re-checks the site when it isn't allowed", async () => {
    const fake = await openSidebar({ responses: { run: () => ({ ok: false, error: "Allow Claude on https://jobs.test first.", code: "E_SITE_NOT_ALLOWED" }) } });
    const before = fake.browser.permissions.contains.mock.calls.length;
    $("instruction").value = "Go";
    $("runBtn").click();
    await flush();
    expect(texts("#log li.error")).toEqual(["Allow Claude on https://jobs.test first."]);
    expect(fake.browser.permissions.contains.mock.calls.length).toBe(before + 1);
  });

  it("locks the form while running and shows the engine", async () => {
    const { port } = await openSidebar();
    port.push(baseState({ connected: true, run: running({ label: "Claude (claude-opus)" }) }));
    expect($("runBtn").disabled).toBe(true);
    expect($("instruction").disabled).toBe(true);
    expect($("engine").textContent).toBe("Claude (claude-opus)");
    expect($("resultBox").hidden).toBe(true);
    port.push(baseState({ connected: true }));
    expect($("runBtn").disabled).toBe(false);
    expect($("engine").textContent).toBe("—");
  });
});

describe("result", () => {
  it("summarizes a finished run", async () => {
    const { port } = await openSidebar();
    port.push(
      baseState({
        run: running({
          status: "done",
          label: "On-device",
          summary: { filled: ["First name", "Email"], leftForUser: ["Salary"], failed: [], notes: ["Drafted 1 answer"], text: "All set." },
        }),
      }),
    );
    expect($("resultBox").hidden).toBe(false);
    expect($("resultTitle").textContent).toBe("Done — On-device");
    expect(texts("#resultBody h4")).toEqual(["Filled (2)", "Left for you (1)", "Notes (1)"]);
    expect(texts("#resultBody li")).toEqual(["First name", "Email", "Salary", "Drafted 1 answer"]);
    expect($("resultBody").textContent).toContain("All set.");
    expect($("resultBody").textContent).toContain("Claude never submits without your approval");
    expect($("continueBtn").hidden).toBe(true);
  });

  it("copes with a missing summary and label", async () => {
    const { port } = await openSidebar();
    port.push(baseState({ run: running({ status: "done", label: null, summary: null }) }));
    expect($("resultTitle").textContent).toBe("Done — ");
    expect(texts("#resultBody h4")).toEqual([]);
  });

  it("shows why a run stopped, and offers to continue on-device with the same instruction", async () => {
    const fake = await openSidebar();
    $("instruction").value = "Fill everything";
    $("runBtn").click();
    await flush();
    fake.port.push(baseState({ run: running({ status: "failed", message: "Claude is unavailable (rate limited)", offerContinue: true }) }));
    expect($("resultTitle").textContent).toBe("Stopped");
    expect($("resultBody").textContent).toBe("Claude is unavailable (rate limited)");
    expect($("continueBtn").hidden).toBe(false);
    $("instruction").value = "edited meanwhile";
    $("continueBtn").click();
    await flush();
    expect(fake.sent.filter((m) => m.type === "run").at(-1)).toMatchObject({ instruction: "Fill everything", engine: "fm" });
    fake.port.push(baseState({ run: running({ status: "failed", message: null }) }));
    expect($("resultBody").textContent).toBe("The run stopped.");
  });
});

describe("questions", () => {
  const question = { id: "q-1", question: "Are you willing to relocate?", options: ["Yes", "No"] };

  it("shows the question with option buttons and answers with one", async () => {
    const { port, sent } = await openSidebar();
    expect($("questionBox").hidden).toBe(true);
    port.push(baseState({ question }));
    expect($("questionBox").hidden).toBe(false);
    expect($("questionText").textContent).toBe("Are you willing to relocate?");
    expect(texts("#questionOptions button")).toEqual(["Yes", "No"]);
    expect(document.activeElement).toBe($("answerInput"));
    document.querySelectorAll("#questionOptions button")[1].click();
    expect(sent).toContainEqual({ type: "answer", id: "q-1", answer: "No" });
  });

  it("answers with typed text, ignoring blanks", async () => {
    const { port, sent } = await openSidebar();
    port.push(baseState({ question: { ...question, options: [] } }));
    $("answerInput").value = "   ";
    $("answerForm").dispatchEvent(new Event("submit", { cancelable: true }));
    expect(sent.some((m) => m.type === "answer")).toBe(false);
    $("answerInput").value = " Maybe, for the right role ";
    const ev = new Event("submit", { cancelable: true });
    $("answerForm").dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(sent).toContainEqual({ type: "answer", id: "q-1", answer: "Maybe, for the right role" });
  });

  it("keeps a half-typed answer across state updates for the same question", async () => {
    const { port } = await openSidebar();
    port.push(baseState({ question }));
    $("answerInput").value = "Ye";
    port.push(baseState({ question, log: [{ time: Date.now(), text: "step", kind: "step" }] }));
    expect($("answerInput").value).toBe("Ye");
    port.push(baseState({ question: { id: "q-2", question: "Salary?", options: [] } }));
    expect($("answerInput").value).toBe("");
    expect(texts("#questionOptions button")).toEqual([]);
    port.push(baseState());
    expect($("questionBox").hidden).toBe(true);
  });

  it("doesn't answer when there's no question", async () => {
    const { port, sent } = await openSidebar();
    port.push(baseState({ question }));
    const yes = document.querySelector("#questionOptions button");
    port.push(baseState());
    yes.click();
    expect(sent.some((m) => m.type === "answer")).toBe(false);
  });
});

describe("step log", () => {
  it("renders steps with their kind, and Clear hides the ones so far", async () => {
    const { port } = await openSidebar();
    const t = Date.now() - 1000;
    port.push(baseState({ log: [{ time: t, text: "Instruction: Fill it", kind: "instruction" }, { time: t, text: "Typed Jane", kind: "step" }] }));
    expect([...document.querySelectorAll("#log li")].map((li) => [li.className, li.textContent])).toEqual([
      ["instruction", "Instruction: Fill it"],
      ["step", "Typed Jane"],
    ]);
    $("clearLog").click();
    expect(texts("#log li")).toEqual([]);
    port.push(baseState({ log: [{ time: t, text: "old", kind: "step" }, { time: Date.now() + 10, text: "new", kind: "error" }] }));
    expect(texts("#log li")).toEqual(["new"]);
  });

  it("shows everything again when a new run starts", async () => {
    const { port } = await openSidebar();
    const t = Date.now() - 1000;
    port.push(baseState({ log: [{ time: t, text: "old", kind: "step" }] }));
    $("clearLog").click();
    $("instruction").value = "Again";
    $("runBtn").click();
    await flush();
    port.push(baseState({ log: [{ time: t, text: "old", kind: "step" }] }));
    expect(texts("#log li")).toEqual(["old"]);
  });

  it("clears before any state arrived without failing", async () => {
    await openSidebar();
    expect(() => $("clearLog").click()).not.toThrow();
  });
});

describe("profile editor", () => {
  const openProfile = () => {
    $("profileBox").open = true; // jsdom fires "toggle", like Firefox
    return flush();
  };

  it("loads the profile when opened", async () => {
    const fake = await openSidebar({ responses: { profile_get: () => ({ path: "/conf/profile.json", profile: { firstName: "Jane" } }) } });
    await openProfile();
    expect($("profilePath").textContent).toBe("/conf/profile.json");
    expect(JSON.parse($("profile").value)).toEqual({ firstName: "Jane" });
    expect($("profileMsg").textContent).toBe("");
    $("profileBox").open = false;
    await flush();
    expect(fake.sent.filter((m) => m.type === "profile_get")).toHaveLength(1);
  });

  it("says when there's no profile yet, and shows load errors", async () => {
    let reply = { path: "/conf/profile.json", profile: null };
    await openSidebar({ responses: { profile_get: () => reply } });
    await openProfile();
    expect($("profile").value).toBe("{}");
    expect($("profileMsg").textContent).toBe("No profile yet.");
    reply = { ok: false, error: "Couldn't connect to the native host." };
    $("profileReload").click();
    await flush();
    expect($("profileMsg").textContent).toBe("Couldn't connect to the native host.");
  });

  it("saves valid JSON and refuses invalid JSON", async () => {
    const fake = await openSidebar({ responses: { profile_get: () => ({ path: "p", profile: {} }) } });
    await openProfile();
    $("profile").value = "{ not json";
    $("profileSave").click();
    await flush();
    expect($("profileMsg").textContent).toMatch(/^Not valid JSON: /);
    expect(fake.sent.some((m) => m.type === "profile_set")).toBe(false);
    $("profile").value = '{ "firstName": "Jane", "answers": { "salaryExpectation": null } }';
    $("profileSave").click();
    await flush();
    expect(fake.sent.find((m) => m.type === "profile_set")).toEqual({ type: "profile_set", profile: { firstName: "Jane", answers: { salaryExpectation: null } } });
    expect($("profileMsg").textContent).toBe("Saved.");
  });

  it("shows save errors", async () => {
    await openSidebar({ responses: { profile_set: () => ({ ok: false, error: "profile must be an object" }) } });
    $("profile").value = "[]";
    $("profileSave").click();
    await flush();
    expect($("profileMsg").textContent).toBe("profile must be an object");
  });
});
