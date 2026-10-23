// host/src/runner.ts (SPEC 10): engine selection and fallback, the Claude engine against a fake `claude`
// that prints stream-json, the on-device pipeline against a fake tabwright-fm, and the rules engine.
// The extension is a stub `callExtension`. Nothing here calls the real Claude or the real on-device model.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const dnsLookup = vi.hoisted(() => vi.fn(async () => ({ address: "127.0.0.1", family: 4 })));
vi.mock("node:dns/promises", () => ({ default: { lookup: dnsLookup } }));

import { Runner, availableEngines, classifyClaudeFailure, findClaude, unsupportedByRules } from "../../host/src/runner.ts";

type Ev = { name: string; data: any };
const realPlatform = process.platform;
const setPlatform = (p: NodeJS.Platform) => Object.defineProperty(process, "platform", { value: p, configurable: true });

let dir: string;
let fakeClaude: string;
let fakeFm: string;
let claudeLog: string;
let docs: string;

// Prints the stream-json lines Claude Code emits, per FAKE_CLAUDE mode, and records its args and MCP config.
const FAKE_CLAUDE = `#!${process.execPath}
const fs = require("fs");
const args = process.argv.slice(2);
const cfg = args[args.indexOf("--mcp-config") + 1];
fs.writeFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, cwd: process.cwd(), mcp: JSON.parse(fs.readFileSync(cfg, "utf8")), mode: fs.statSync(cfg).mode & 0o777 }));
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const init = (status = "connected") => out({ type: "system", subtype: "init", mcp_servers: [{ name: "tabwright", status }] });
switch (process.env.FAKE_CLAUDE) {
  case "ok":
    process.stdout.write("not json\\n\\n");
    init();
    init();
    out({ type: "assistant", message: { content: [{ type: "text", text: "  Filling the form  " }, { type: "tool_use", name: "mcp__tabwright__browser_snapshot" }, { type: "text", text: "   " }] } });
    out({ type: "result", subtype: "success", is_error: false, result: "Filled 3 fields." });
    break;
  case "login":
    process.stderr.write("Invalid API key · Please run /login\\n");
    process.exit(1);
  case "limit":
    init();
    out({ type: "result", subtype: "error_during_execution", is_error: true, result: "Claude AI usage limit reached" });
    process.exit(1);
  case "partway":
    init();
    out({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__tabwright__browser_click" }] } });
    out({ type: "result", subtype: "success", is_error: true, result: "Something odd happened\\nsecond line" });
    process.exit(1);
  case "partway-network":
    init();
    out({ type: "assistant", message: { content: [{ type: "tool_use", name: "x" }] } });
    process.stderr.write("fetch failed: ECONNRESET\\n");
    process.exit(1);
  case "mcpfail":
    init("failed");
    setInterval(() => {}, 1000);
    break;
  case "unknown-error":
    process.stderr.write("segfault in the matrix\\n");
    process.exit(2);
  case "hang":
    init();
    setInterval(() => {}, 1000);
    break;
  case "silent":
    setInterval(() => {}, 1000);
    break;
}
`;

// Answers like tabwright-fm, per the JSON in FAKE_FM: { availability, plan, match: { label: answer }, draft, crash }.
const FAKE_FM = `#!${process.execPath}
const cfg = JSON.parse(process.env.FAKE_FM || "{}");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
require("readline").createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l);
  if (cfg.crash === m.op) process.exit(4);
  if (cfg.error === m.op) return out({ id: m.id, error: "model said no" });
  if (m.op === "availability") return out({ id: m.id, result: cfg.availability ?? { available: true, contextSize: 4096 } });
  if (m.op === "plan") return out({ id: m.id, result: cfg.plan ?? { steps: [{ kind: "fillForm" }], unsupportedReason: null } });
  if (m.op === "match") {
    if (cfg.log) require("fs").appendFileSync(cfg.log, JSON.stringify(m) + "\\n");
    return out({ id: m.id, result: (cfg.match ?? {})[m.label] ?? { profileKey: null, option: null, askUser: false } });
  }
  if (m.op === "draft") return out({ id: m.id, result: { text: cfg.draft ?? "" } });
});
`;

const PROFILE = {
  firstName: "Jane",
  lastName: "Doe",
  email: "jane@example.com",
  phone: "(555) 010-0199",
  city: "Springfield",
  state: "IL",
  country: "United States",
  resumePath: "",
  answers: { yearsExperience: 7, workAuthorizedNoSponsorship: null, willingToRelocate: "Yes", salaryExpectation: null },
};

function writeProfile(p: unknown = PROFILE) {
  fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify(p));
}
function writeConfig(c: Record<string, unknown>) {
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ allowedUploadDirs: [docs], ...c }));
}

/** A runner wired to a stub extension that answers from `handlers` and records every call and event. */
function setup(handlers: Record<string, (p: any) => any> = {}) {
  const events: Ev[] = [];
  const calls: { method: string; params: any; timeoutMs?: number }[] = [];
  const logs: unknown[][] = [];
  let finish!: (e: Ev) => void;
  const finished = new Promise<Ev>((r) => (finish = r));
  const runner = new Runner({
    callExtension: async (method, params = {}, timeoutMs) => {
      calls.push({ method, params, timeoutMs });
      const h = handlers[method];
      if (!h) throw Object.assign(new Error(`no handler for ${method}`), { code: "E_INTERNAL" });
      return h(params);
    },
    emit: (name, data) => {
      const e = { name, data };
      events.push(e);
      if (name === "run_done" || name === "run_failed") finish(e);
    },
    log: (...parts) => logs.push(parts),
  });
  const fills = () => calls.filter((c) => c.method === "fill_form").flatMap((c) => c.params.fields);
  const steps = () => events.filter((e) => e.name === "run_log").map((e) => e.data.text);
  const engine = () => events.find((e) => e.name === "run_engine")?.data;
  return { runner, events, calls, logs, finished, fills, steps, engine };
}

const fillOk = (p: any) => ({ ok: true, results: p.fields.map((f: any) => ({ ref: f.ref, ok: true })) });
const field = (ref: string, label: string, kind = "text", extra: Record<string, unknown> = {}) => ({ ref, label, kind, value: "", ...extra });
const tick = () => new Promise((r) => setImmediate(r));

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-runner-"));
  docs = path.join(dir, "docs");
  fs.mkdirSync(docs);
  fakeClaude = path.join(dir, "fake-claude");
  fakeFm = path.join(dir, "fake-fm");
  claudeLog = path.join(dir, "claude-log.json");
  fs.writeFileSync(fakeClaude, FAKE_CLAUDE, { mode: 0o755 });
  fs.writeFileSync(fakeFm, FAKE_FM, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "mcp-server.js"), "");
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  process.env.TABWRIGHT_DIR = dir;
  process.env.TABWRIGHT_MCP_SERVER = path.join(dir, "mcp-server.js");
  process.env.TABWRIGHT_CLAUDE_BIN = path.join(dir, "no-such-claude");
  process.env.TABWRIGHT_FM_HELPER = path.join(dir, "no-such-fm");
  process.env.FAKE_CLAUDE_LOG = claudeLog;
  delete process.env.FAKE_CLAUDE;
  delete process.env.FAKE_FM;
  dnsLookup.mockClear();
  dnsLookup.mockImplementation(async () => ({ address: "127.0.0.1", family: 4 }));
  writeProfile();
  writeConfig({});
  setPlatform("darwin");
});
afterEach(() => {
  setPlatform(realPlatform);
  vi.useRealTimers();
});

const useClaude = (mode: string) => {
  process.env.TABWRIGHT_CLAUDE_BIN = fakeClaude;
  process.env.FAKE_CLAUDE = mode;
};
const useFm = (cfg: Record<string, unknown> = {}) => {
  process.env.TABWRIGHT_FM_HELPER = fakeFm;
  process.env.FAKE_FM = JSON.stringify(cfg);
};

// ---------------------------------------------------------------------------------------------

describe("discovery", () => {
  it("findClaude honours TABWRIGHT_CLAUDE_BIN only if it is executable", () => {
    process.env.TABWRIGHT_CLAUDE_BIN = fakeClaude;
    expect(findClaude()).toBe(fakeClaude);
    process.env.TABWRIGHT_CLAUDE_BIN = path.join(dir, "no-such-claude");
    expect(findClaude()).toBeNull();
    process.env.TABWRIGHT_CLAUDE_BIN = docs; // a directory isn't a binary
    expect(findClaude()).toBeNull();
  });

  it("findClaude searches PATH when there's no override", () => {
    delete process.env.TABWRIGHT_CLAUDE_BIN;
    const bin = path.join(dir, "pathdir");
    fs.mkdirSync(bin, { recursive: true });
    fs.copyFileSync(fakeClaude, path.join(bin, "claude"));
    fs.chmodSync(path.join(bin, "claude"), 0o755);
    const saved = process.env.PATH;
    process.env.PATH = ["", path.join(dir, "empty"), bin].join(path.delimiter);
    try {
      expect(findClaude()).toBe(path.join(bin, "claude"));
    } finally {
      process.env.PATH = saved;
    }
  });

  it("availableEngines always includes rules", async () => {
    expect(await availableEngines()).toEqual({ claude: false, fm: false, rules: true });
    useClaude("ok");
    useFm();
    expect(await availableEngines()).toEqual({ claude: true, fm: true, rules: true });
  });
});

describe("run lifecycle", () => {
  it("returns a run id, refuses a second run while one is active, and allows one after it ends", async () => {
    const s = setup({ form_fields: () => new Promise(() => {}) });
    const { runId } = s.runner.start({ instruction: "Fill this", engine: "rules" });
    expect(runId).toMatch(/^run-/);
    expect(() => s.runner.start({ instruction: "again", engine: "rules" })).toThrowError(expect.objectContaining({ code: "E_INTERNAL" }));
    s.runner.stop("test");
    expect(s.runner.activeRunToken()).toBeNull();
    // Stopped runs can be replaced right away, even before the old one has unwound.
    const s2 = setup({ form_fields: () => ({ fields: [] }) });
    s2.runner.start({ instruction: "Fill", engine: "rules" });
    expect((await s2.finished).name).toBe("run_done");
  });

  it("exposes a fresh 32-byte run token only while running", async () => {
    let release!: () => void;
    const s = setup({ form_fields: () => new Promise((r) => (release = () => r({ fields: [] }))) });
    expect(s.runner.activeRunToken()).toBeNull();
    s.runner.start({ instruction: "Fill", engine: "rules" });
    const token = s.runner.activeRunToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    release();
    await s.finished;
    await tick();
    expect(s.runner.activeRunToken()).toBeNull();
    s.runner.start({ instruction: "Fill", engine: "rules" });
    expect(s.runner.activeRunToken()).not.toBe(token);
    s.runner.stop("done");
  });

  it("stop() is a no-op without a run, and is idempotent", () => {
    const s = setup();
    expect(() => s.runner.stop("nothing")).not.toThrow();
    s.runner.start({ instruction: "x", engine: "rules" });
    s.runner.stop("one");
    s.runner.stop("two");
    expect(s.logs.filter((l) => l[0] === "stopping run")).toHaveLength(1);
  });

  it("stopping mid-pipeline reports Stopped and fills nothing more", async () => {
    let s!: ReturnType<typeof setup>;
    s = setup({
      form_fields: () => ({ fields: [field("e1", "First Name"), field("e2", "Last Name"), field("e3", "Email")] }),
      fill_form: (p) => {
        s.runner.stop("user");
        return fillOk(p);
      },
    });
    s.runner.start({ instruction: "Fill", engine: "rules" });
    const end = await s.finished;
    expect(end).toMatchObject({ name: "run_failed", data: { message: "Stopped.", offerContinue: false } });
    expect(s.fills()).toEqual([{ ref: "e1", value: "Jane" }]);
  });

  it("a run stopped while the last call is pending reports Stopped, not done", async () => {
    let s!: ReturnType<typeof setup>;
    s = setup({
      form_fields: () => {
        s.runner.stop("user");
        return { fields: [] };
      },
    });
    s.runner.start({ instruction: "Fill", engine: "rules" });
    expect(await s.finished).toMatchObject({ name: "run_failed", data: { message: "Stopped." } });

    useFm({ plan: { steps: [{ kind: "scrollTo", text: "x" }] } });
    s = setup({
      scroll: () => {
        s.runner.stop("user");
        return { ok: true };
      },
    });
    s.runner.start({ instruction: "Scroll", engine: "fm" });
    expect(await s.finished).toMatchObject({ name: "run_failed", data: { message: "Stopped." } });
  });

  it("an extension error that isn't E_STOPPED fails the run with its message", async () => {
    const s = setup({ form_fields: () => Promise.reject(new Error("tab went away")) });
    s.runner.start({ instruction: "Fill", engine: "rules" });
    expect(await s.finished).toMatchObject({ name: "run_failed", data: { message: "tab went away", offerContinue: false } });
    expect(s.logs.some((l) => l[0] === "run failed")).toBe(true);
  });

  it("passes the tab id to every extension call, and drops a non-numeric one", async () => {
    const s = setup({ form_fields: () => ({ fields: [field("e1", "Email", "email")] }), fill_form: fillOk });
    s.runner.start({ instruction: "Fill", tabId: 12, engine: "rules" });
    await s.finished;
    expect(s.calls.every((c) => c.params.tabId === 12)).toBe(true);
    const s2 = setup({ form_fields: () => ({ fields: [] }) });
    s2.runner.start({ instruction: "Fill", tabId: "12" as any, engine: "rules" });
    await s2.finished;
    expect(s2.calls[0].params.tabId).toBeUndefined();
  });
});

describe("engine selection and fallback", () => {
  it("auto: falls from Claude (not installed) through on-device (no helper) to rules, with reasons", async () => {
    const s = setup({ form_fields: () => ({ fields: [] }) });
    s.runner.start({ instruction: "Fill", engine: "auto" });
    expect((await s.finished).name).toBe("run_done");
    expect(s.engine()).toMatchObject({ engine: "rules", label: "Rules only" });
    expect(s.engine().reasons).toEqual([
      "Claude unavailable: the claude command isn't installed",
      "On-device (Apple) unavailable: the tabwright-fm helper isn't installed",
    ]);
    expect(s.events.filter((e) => e.name === "run_log" && e.data.kind === "warn")).toHaveLength(2);
  });

  it("auto: says the network is unreachable when DNS fails", async () => {
    fs.rmSync(claudeLog, { force: true });
    useClaude("ok");
    dnsLookup.mockImplementation(async () => {
      throw new Error("ENOTFOUND");
    });
    const s = setup({ form_fields: () => ({ fields: [] }) });
    s.runner.start({ instruction: "Fill", engine: "auto" });
    await s.finished;
    expect(s.engine().reasons[0]).toBe("Claude unavailable: the network is unreachable");
    expect(fs.existsSync(claudeLog)).toBe(false); // claude was never started
  });

  it("auto: on-device needs macOS", async () => {
    useFm();
    setPlatform("linux");
    const s = setup({ form_fields: () => ({ fields: [] }) });
    s.runner.start({ instruction: "Fill", engine: "auto" });
    await s.finished;
    expect(s.engine().reasons).toContain("On-device (Apple) unavailable: requires macOS 26 on Apple Silicon");
  });

  it("auto: uses the helper's own reason when the model isn't available, or when it crashes", async () => {
    useFm({ availability: { available: false, reason: "Apple Intelligence is turned off" } });
    let s = setup({ form_fields: () => ({ fields: [] }) });
    s.runner.start({ instruction: "Fill", engine: "auto" });
    await s.finished;
    expect(s.engine().reasons).toContain("On-device (Apple) unavailable: Apple Intelligence is turned off");

    useFm({ availability: { available: false } });
    s = setup({ form_fields: () => ({ fields: [] }) });
    s.runner.start({ instruction: "Fill", engine: "auto" });
    await s.finished;
    expect(s.engine().reasons).toContain("On-device (Apple) unavailable: the model isn't available");

    useFm({ crash: "availability" });
    s = setup({ form_fields: () => ({ fields: [] }) });
    s.runner.start({ instruction: "Fill", engine: "auto" });
    await s.finished;
    expect(s.engine().reasons.join("\n")).toMatch(/On-device \(Apple\) unavailable: on-device helper exited \(4\)/);
  });

  it("explicit claude: unavailable fails the run and offers to continue", async () => {
    const s = setup();
    s.runner.start({ instruction: "Fill", engine: "claude" });
    expect(await s.finished).toMatchObject({
      name: "run_failed",
      data: { message: "Claude unavailable: the claude command isn't installed", offerContinue: true },
    });
    expect(s.engine()).toBeUndefined();
  });

  it("explicit fm: unavailable fails without offering to continue", async () => {
    const s = setup();
    s.runner.start({ instruction: "Fill", engine: "fm" });
    expect(await s.finished).toMatchObject({ name: "run_failed", data: { message: expect.stringMatching(/^On-device \(Apple\) unavailable/), offerContinue: false } });
  });

  it("explicit rules never touches Claude or the helper", async () => {
    useClaude("ok");
    useFm();
    const s = setup({ form_fields: () => ({ fields: [] }) });
    s.runner.start({ instruction: "Fill", engine: "rules" });
    await s.finished;
    expect(s.engine()).toMatchObject({ engine: "rules", reasons: [] });
    expect(dnsLookup).not.toHaveBeenCalled();
  });
});

describe("Claude engine", () => {
  beforeEach(() => fs.rmSync(claudeLog, { force: true }));

  it("runs claude -p with a private, scoped MCP config and a prompt with the profile and instruction", async () => {
    useClaude("ok");
    const s = setup();
    s.runner.start({ instruction: "Fill the application. Leave salary for me.", tabId: 7, engine: "auto" });
    const token = s.runner.activeRunToken();
    const end = await s.finished;
    expect(end).toMatchObject({ name: "run_done", data: { engine: "claude", summary: { filled: [], text: "Filled 3 fields." } } });
    expect(s.engine()).toMatchObject({ engine: "claude", label: "Claude", reasons: [] });
    expect(s.events.filter((e) => e.name === "run_engine")).toHaveLength(1); // init seen twice, announced once
    expect(s.steps()).toContain("Filling the form");

    const rec = JSON.parse(fs.readFileSync(claudeLog, "utf8"));
    const a: string[] = rec.args;
    expect(a[0]).toBe("-p");
    expect(a).toEqual(expect.arrayContaining(["--output-format", "stream-json", "--verbose", "--strict-mcp-config", "--allowedTools", "mcp__tabwright__*"]));
    expect(rec.mode).toBe(0o600);
    expect(fs.realpathSync(rec.cwd)).toBe(fs.realpathSync(os.homedir()));
    const server = rec.mcp.mcpServers.tabwright;
    expect(server).toEqual({ command: process.execPath, args: [path.join(dir, "mcp-server.js")], env: { TABWRIGHT_RUN_TOKEN: token, TABWRIGHT_DIR: dir } });
    // The config file holds the run token, so it's removed afterwards.
    const cfgFile = a[a.indexOf("--mcp-config") + 1];
    expect(path.dirname(cfgFile)).toBe(dir);
    expect(fs.existsSync(cfgFile)).toBe(false);

    const prompt = a[1];
    expect(prompt).toContain("Work in tab 7");
    expect(prompt).toContain('"email": "jane@example.com"');
    expect(prompt).toMatch(/Instruction:\nFill the application\. Leave salary for me\.$/);
    expect(prompt).toMatch(/Never try to submit/);
    expect(prompt).toMatch(/Never fill EEO/);
    expect(prompt).toMatch(/untrusted/);
  });

  it("without a tab or profile, the prompt says so", async () => {
    useClaude("ok");
    fs.rmSync(path.join(dir, "profile.json"));
    const s = setup();
    s.runner.start({ instruction: "Do it", engine: "claude" });
    await s.finished;
    const prompt = JSON.parse(fs.readFileSync(claudeLog, "utf8")).args[1];
    expect(prompt).toContain("Work in the currently selected tab.");
    expect(prompt).toContain("```json\n{}\n```");
  });

  it("passes the socket and log dir overrides through to the MCP server", async () => {
    useClaude("ok");
    process.env.TABWRIGHT_SOCKET = path.join(dir, "s.sock");
    process.env.TABWRIGHT_LOG_DIR = path.join(dir, "logs");
    try {
      const s = setup();
      s.runner.start({ instruction: "Do it", engine: "claude" });
      await s.finished;
      expect(JSON.parse(fs.readFileSync(claudeLog, "utf8")).mcp.mcpServers.tabwright.env).toMatchObject({
        TABWRIGHT_SOCKET: path.join(dir, "s.sock"),
        TABWRIGHT_LOG_DIR: path.join(dir, "logs"),
      });
    } finally {
      delete process.env.TABWRIGHT_SOCKET;
      delete process.env.TABWRIGHT_LOG_DIR;
    }
  });

  it("not logged in, before any tool call: falls back and says why", async () => {
    useClaude("login");
    const s = setup({ form_fields: () => ({ fields: [] }) });
    s.runner.start({ instruction: "Fill", engine: "auto" });
    await s.finished;
    expect(s.engine().engine).toBe("rules");
    expect(s.engine().reasons[0]).toBe("Claude unavailable: you're not logged in to Claude Code");
  });

  it("usage limit, before any tool call: falls back", async () => {
    useClaude("limit");
    const s = setup({ form_fields: () => ({ fields: [] }) });
    s.runner.start({ instruction: "Fill", engine: "auto" });
    await s.finished;
    expect(s.engine().reasons[0]).toBe("Claude unavailable: Claude reported a usage limit");
  });

  it("the Firefox MCP server failing to start counts as unavailable", async () => {
    useClaude("mcpfail");
    const s = setup({ form_fields: () => ({ fields: [] }) });
    s.runner.start({ instruction: "Fill", engine: "auto" });
    await s.finished;
    expect(s.engine().reasons[0]).toBe("Claude unavailable: the Firefox MCP server failed to start");
  });

  it("an unrecognised failure before any tool call isn't silently switched", async () => {
    useClaude("unknown-error");
    const s = setup({ form_fields: () => ({ fields: [] }) });
    s.runner.start({ instruction: "Fill", engine: "auto" });
    expect(await s.finished).toMatchObject({ name: "run_failed", data: { message: "Claude stopped partway: segfault in the matrix", offerContinue: true } });
    expect(s.calls).toHaveLength(0);
  });

  it("failing partway (after tool calls) offers to continue instead of switching engines", async () => {
    useClaude("partway");
    const s = setup({ form_fields: () => ({ fields: [] }) });
    s.runner.start({ instruction: "Fill", engine: "auto" });
    expect(await s.finished).toMatchObject({ name: "run_failed", data: { message: "Claude stopped partway: Something odd happened", offerContinue: true } });
    expect(s.calls).toHaveLength(0);

    useClaude("partway-network");
    const s2 = setup({ form_fields: () => ({ fields: [] }) });
    s2.runner.start({ instruction: "Fill", engine: "auto" });
    expect(await s2.finished).toMatchObject({ name: "run_failed", data: { message: "Claude stopped partway: the network is unreachable", offerContinue: true } });
  });

  it("stopping kills claude and reports Stopped", async () => {
    useClaude("hang");
    const s = setup();
    s.runner.start({ instruction: "Fill", engine: "auto" });
    await vi.waitFor(() => expect(s.engine()).toBeDefined(), { timeout: 5000 });
    s.runner.stop("user");
    expect(await s.finished).toMatchObject({ name: "run_failed", data: { message: "Stopped." } });
    expect(s.calls).toHaveLength(0); // didn't fall back to another engine
  });

  it("treats no output within 20 seconds as unavailable", async () => {
    useClaude("silent");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const s = setup({ form_fields: () => ({ fields: [] }) });
    s.runner.start({ instruction: "Fill", engine: "auto" });
    await vi.waitFor(() => expect(fs.existsSync(claudeLog)).toBe(true), { timeout: 5000, interval: 20 });
    await vi.advanceTimersByTimeAsync(20_000);
    vi.useRealTimers();
    await s.finished;
    expect(s.engine().reasons[0]).toBe("Claude unavailable: no output within 20 seconds");
  });
});

describe("on-device engine", () => {
  const form = () => ({
    fields: [
      field("e1", "First Name*", "text", { required: true }),
      field("e2", "Mobile contact"),
      field("e3", "Are you authorized to work in the US?", "select", { options: ["Yes", "No"], required: true }),
      field("e4", "Pronouns"),
      field("e5", "Favourite colour", "text", { required: true }),
      field("e6", "Tell us about a project", "textarea"),
      field("e7", "Desired salary"),
    ],
  });

  it("announces itself, keeps only skip labels the user actually said, and uses the model only for keys", async () => {
    const matchLog = path.join(dir, "match.log");
    fs.rmSync(matchLog, { force: true });
    useFm({
      log: matchLog,
      plan: { steps: [{ kind: "skipFields", labels: ["workAuthorization", "phone"] }, { kind: "fillForm" }], unsupportedReason: null },
      match: {
        "Mobile contact": { profileKey: "phone", option: "IGNORED", askUser: false },
        "Favourite colour": { profileKey: "answers.favouriteColour", option: null, askUser: true },
      },
    });
    const asked: any[] = [];
    const s = setup({
      form_fields: form,
      fill_form: fillOk,
      ask_user: (p) => {
        asked.push(p);
        return { answer: p.question === "Favourite colour" ? "  Blue  " : "" };
      },
    });
    s.runner.start({ instruction: "Fill this in, but I'll handle work authorization myself", engine: "auto" });
    const end = await s.finished;
    expect(end.name).toBe("run_done");
    expect(end.data.engine).toBe("fm");
    expect(s.engine()).toMatchObject({ engine: "fm", label: "On-device (Apple)" });
    expect(s.steps()).toContain("Leaving for you: work authorization"); // "phone" was invented by the model
    expect(s.fills()).toEqual([
      { ref: "e1", value: "Jane" },
      { ref: "e2", value: "(555) 010-0199" },
      { ref: "e5", value: "Blue" }, // a key the profile doesn't have + askUser + required -> asked
    ]);
    // Favourite colour: asked because the model said so. Desired salary: null in the profile.
    expect(asked).toEqual([{ question: "Favourite colour", options: undefined }, { question: "Desired salary", options: undefined }]);
    expect(s.steps()).toContain('Matched "Mobile contact" to phone');
    const s1 = end.data.summary;
    expect(s1.leftForUser).toEqual(
      expect.arrayContaining([
        "Are you authorized to work in the US? (you asked to fill it yourself)",
        "Pronouns (EEO questions are always left for you)",
        "Tell us about a project",
        "Desired salary",
      ]),
    );
    // The model gets labels and key names, never profile values, and never sees free-text or rule-matched fields.
    const matched = fs.readFileSync(matchLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(matched.map((m) => m.label)).toEqual(["Mobile contact", "Favourite colour"]);
    expect(matched[0].profileKeys).toContain("answers.yearsExperience");
    expect(matched[0].profileKeys).not.toContain("resumePath");
    expect(JSON.stringify(matched)).not.toContain("jane@example.com");
  });

  it("refuses out-of-scope plans from the model or from the backup patterns", async () => {
    useFm({ plan: { steps: [], unsupportedReason: "needs searching" } });
    let s = setup();
    s.runner.start({ instruction: "Fill", engine: "fm" });
    expect(await s.finished).toMatchObject({
      name: "run_failed",
      data: { message: expect.stringMatching(/^On-device mode can't do that \(needs searching\)/), offerContinue: false },
    });
    expect(s.calls).toHaveLength(0);

    useFm();
    s = setup();
    s.runner.start({ instruction: "Go to the next page and apply", engine: "fm" });
    expect(await s.finished).toMatchObject({ name: "run_failed", data: { message: expect.stringContaining("(needs navigation)") } });
  });

  it("follows scrollTo and stop steps in order", async () => {
    useFm({ plan: { steps: [{ kind: "scrollTo", text: "Apply" }, { kind: "stop" }, { kind: "fillForm" }] } });
    const s = setup({ scroll: () => ({ ok: true }) });
    s.runner.start({ instruction: "Scroll to apply", tabId: 3, engine: "fm" });
    expect((await s.finished).name).toBe("run_done");
    expect(s.calls.map((c) => c.method)).toEqual(["scroll"]);
    expect(s.calls[0].params).toEqual({ tabId: 3, target: { text: "Apply" } });
  });

  it("a failing scroll doesn't stop the run", async () => {
    useFm({ plan: { steps: [{ kind: "scrollTo", text: "Nowhere" }, { kind: "fillForm" }] } });
    const s = setup({ form_fields: () => ({ fields: [field("e1", "Email", "email")] }), fill_form: fillOk });
    s.runner.start({ instruction: "Fill", engine: "fm" });
    expect((await s.finished).name).toBe("run_done");
    expect(s.fills()).toEqual([{ ref: "e1", value: "jane@example.com" }]);
  });

  it("uploadResume on its own only touches file fields", async () => {
    fs.writeFileSync(path.join(docs, "cv.pdf"), "%PDF");
    writeProfile({ ...PROFILE, resumePath: path.join(docs, "cv.pdf") });
    useFm({ plan: { steps: [{ kind: "uploadResume" }] } });
    const s = setup({
      form_fields: () => ({ fields: [field("e1", "First Name"), field("e2", "Resume/CV", "file")] }),
      upload: (p) => ({ ok: true, fileName: p.fileName }),
    });
    s.runner.start({ instruction: "Upload my resume", engine: "fm" });
    const end = await s.finished;
    expect(s.calls.map((c) => c.method)).toEqual(["form_fields", "upload"]);
    expect(end.data.summary.filled).toEqual(["Resume/CV: cv.pdf"]);
  });

  it("drafts free-text answers only when draftFreeText is on, and marks them for review", async () => {
    writeConfig({ draftFreeText: true });
    useFm({ draft: "  I built a bridge.  " });
    const s = setup({ form_fields: () => ({ fields: [field("e6", "Tell us about a project", "textarea")] }), fill_form: fillOk, annotate: () => ({ ok: true }) });
    s.runner.start({ instruction: "Fill", engine: "fm" });
    const end = await s.finished;
    expect(s.fills()).toEqual([{ ref: "e6", value: "I built a bridge." }]);
    expect(s.calls.find((c) => c.method === "annotate")?.params).toMatchObject({ ref: "e6", note: "Review this before submitting" });
    expect(end.data.summary.filled).toEqual(["Tell us about a project (draft — review before submitting)"]);

    useFm({ draft: "   " });
    const s2 = setup({ form_fields: () => ({ fields: [field("e6", "Why do you want this job?", "text")] }), fill_form: fillOk });
    s2.runner.start({ instruction: "Fill", engine: "fm" });
    expect((await s2.finished).data.summary.leftForUser).toEqual(["Why do you want this job?"]);
  });

  it("leaves free text alone when draftFreeText is off, and survives model errors", async () => {
    useFm({ error: "match", draft: "should not be used" });
    const s = setup({ form_fields: () => ({ fields: [field("e6", "Tell us about a project", "textarea"), field("e9", "Shoe size")] }), fill_form: fillOk });
    s.runner.start({ instruction: "Fill", engine: "fm" });
    const end = await s.finished;
    expect(s.fills()).toEqual([]);
    expect(end.data.summary.leftForUser).toEqual(["Tell us about a project", "Shoe size"]);
    expect(s.logs.some((l) => l[0] === "fm match failed")).toBe(true);
  });

  it("an annotate failure doesn't lose the draft, and a draft error falls back to leaving it", async () => {
    writeConfig({ draftFreeText: true });
    useFm({ draft: "Text" });
    const s = setup({ form_fields: () => ({ fields: [field("e6", "Describe yourself", "textarea")] }), fill_form: fillOk });
    s.runner.start({ instruction: "Fill", engine: "fm" });
    expect((await s.finished).data.summary.filled).toEqual(["Describe yourself (draft — review before submitting)"]);

    useFm({ error: "draft" });
    const s2 = setup({ form_fields: () => ({ fields: [field("e6", "Describe yourself", "textarea")] }), fill_form: fillOk });
    s2.runner.start({ instruction: "Fill", engine: "fm" });
    expect((await s2.finished).data.summary.leftForUser).toEqual(["Describe yourself"]);
    expect(s2.logs.some((l) => l[0] === "draft failed")).toBe(true);
  });

  it("ignores askUser for optional fields", async () => {
    useFm({ match: { "Shoe size": { profileKey: null, option: null, askUser: true } } });
    const s = setup({ form_fields: () => ({ fields: [field("e9", "Shoe size")] }), ask_user: () => ({ answer: "x" }) });
    s.runner.start({ instruction: "Fill", engine: "fm" });
    expect((await s.finished).data.summary.leftForUser).toEqual(["Shoe size"]);
    expect(s.calls.some((c) => c.method === "ask_user")).toBe(false);
  });

  it("a helper crash mid-run fails the run with the reason", async () => {
    useFm({ crash: "plan" });
    const s = setup();
    s.runner.start({ instruction: "Fill", engine: "fm" });
    expect(await s.finished).toMatchObject({ name: "run_failed", data: { message: "on-device helper exited (4)" } });
  });
});

describe("rules engine and the fill pipeline", () => {
  const run = async (fields: any[], handlers: Record<string, (p: any) => any> = {}, instruction = "Fill this out") => {
    const s = setup({ form_fields: () => ({ fields }), fill_form: fillOk, ...handlers });
    s.runner.start({ instruction, engine: "rules" });
    const end = await s.finished;
    return { ...s, end, summary: end.data.summary };
  };

  it("fails clearly without a profile", async () => {
    fs.rmSync(path.join(dir, "profile.json"));
    const s = setup({ form_fields: () => ({ fields: [] }) });
    s.runner.start({ instruction: "Fill", engine: "rules" });
    expect(await s.finished).toMatchObject({ name: "run_failed", data: { message: expect.stringMatching(/^No profile found/) } });
    expect(s.calls).toHaveLength(0);
  });

  it("logs its steps and the skip list", async () => {
    const r = await run([field("e1", "Desired salary")], {}, "Fill this out. Leave salary and the phone fields for me.");
    expect(r.steps()).toEqual(["Leaving for you: salary, phone", "Listing form fields", "Found 1 fields"]);
    expect(r.summary.leftForUser).toEqual(["Desired salary (you asked to fill it yourself)"]);
  });

  it("never fills EEO questions, even when the profile has an answer", async () => {
    writeProfile({ ...PROFILE, gender: "Female", answers: { ...PROFILE.answers, veteranStatus: "No" } });
    const r = await run([field("e1", "Gender", "select", { options: ["Male", "Female"] }), field("e2", "Veteran status"), field("e3", "Are you Hispanic or Latino?", "radio", { options: ["Yes", "No"] })]);
    expect(r.fills()).toEqual([]);
    expect(r.summary.leftForUser.every((l: string) => l.endsWith("(EEO questions are always left for you)"))).toBe(true);
    expect(r.summary.leftForUser).toHaveLength(3);
  });

  it("skips fields that already have a value, but not 'Select...' placeholders or checkboxes", async () => {
    writeProfile({ ...PROFILE, answers: { ...PROFILE.answers, willingToRelocate: "yes" } });
    const r = await run([
      field("e1", "First Name", "text", { value: "Janet" }),
      field("e2", "Country", "combobox", { value: "Select...", options: ["Canada", "United States"] }),
      field("e3", "Willing to relocate?", "checkbox", { value: "on" }),
      field("e4", "Email", "email", { value: "   " }),
    ]);
    expect(r.fills()).toEqual([
      { ref: "e2", value: "United States" },
      { ref: "e3", value: true },
      { ref: "e4", value: "jane@example.com" },
    ]);
  });

  it("asks the user for null profile values, and leaves the field when they give no answer", async () => {
    const answers = ["Yes", "   "];
    const r = await run(
      [field("e1", "Are you authorized to work in the US?", "select", { options: ["Yes", "No"] }), field("e2", "Salary expectations")],
      { ask_user: () => ({ answer: answers.shift() }) },
    );
    expect(r.fills()).toEqual([{ ref: "e1", value: "Yes" }]);
    const asks = r.calls.filter((c) => c.method === "ask_user");
    expect(asks.map((c) => c.params)).toEqual([
      { question: "Are you authorized to work in the US?", options: ["Yes", "No"] },
      { question: "Salary expectations", options: undefined },
    ]);
    expect(asks[0].timeoutMs).toBeGreaterThan(10 * 60_000); // longer than the extension's own 10-minute wait
    expect(r.summary.leftForUser).toEqual(["Salary expectations"]);
  });

  it("a question that times out is left for the user; one that's stopped stops the run", async () => {
    const r = await run([field("e1", "Desired salary"), field("e2", "Email", "email")], {
      ask_user: () => Promise.reject(Object.assign(new Error("no answer"), { code: "E_TIMEOUT" })),
    });
    expect(r.end.name).toBe("run_done");
    expect(r.summary.leftForUser).toEqual(["Desired salary"]);
    expect(r.fills()).toEqual([{ ref: "e2", value: "jane@example.com" }]);

    const r2 = await run([field("e1", "Desired salary"), field("e2", "Email", "email")], {
      ask_user: () => Promise.reject(Object.assign(new Error("stopped"), { code: "E_STOPPED" })),
    });
    expect(r2.end).toMatchObject({ name: "run_failed", data: { message: "Stopped." } });
    expect(r2.fills()).toEqual([]);
  });

  it("leaves unlabeled fields for the user instead of asking an empty question", async () => {
    const r = await run([field("e1", "   ", "text")], { ask_user: () => ({ answer: "x" }) });
    expect(r.summary.leftForUser).toEqual(["(unlabeled field)"]);
    expect(r.calls.some((c) => c.method === "ask_user")).toBe(false);
  });

  it("checkbox values: booleans pass through, yes/true/1 strings mean checked", async () => {
    for (const [v, expected] of [[true, true], [false, false], ["Yes", true], ["1", true], ["no", false], ["maybe", false]] as const) {
      writeProfile({ ...PROFILE, answers: { willingToRelocate: v } });
      const r = await run([field("e1", "Willing to relocate", "checkbox")]);
      expect(r.fills()).toEqual([{ ref: "e1", value: expected }]);
    }
  });

  it("only chooses an option that matches, and stringifies plain values", async () => {
    const r = await run([
      field("e1", "Country", "select", { options: ["Canada", "Mexico"] }),
      field("e2", "Years of experience", "select", { options: ["0-2", "3-5", "6-10", "10+"] }),
      field("e3", "Years of experience", "number"),
      field("e4", "Full name"),
      field("e5", "Location"),
    ]);
    expect(r.summary.leftForUser).toEqual(['Country (no option matches "United States")']);
    expect(r.fills()).toEqual([
      { ref: "e2", value: "6-10" },
      { ref: "e3", value: "7" },
      { ref: "e4", value: "Jane Doe" },
      { ref: "e5", value: "Springfield, IL" },
    ]);
  });

  it("reports per-field failures and keeps going", async () => {
    const r = await run([field("e1", "First Name"), field("e2", "Last Name"), field("e3", "Email", "email")], {
      fill_form: (p) => {
        const ref = p.fields[0].ref;
        if (ref === "e1") return { ok: false, results: [{ ref, ok: false, error: { code: "E_NOT_INTERACTABLE", message: "hidden" } }] };
        if (ref === "e2") return { ok: false, results: [{ ref, ok: false }] };
        throw Object.assign(new Error("frame gone"), { code: "E_INTERNAL" });
      },
    });
    expect(r.end.name).toBe("run_done");
    expect(r.summary.failed).toEqual(["First Name: hidden", "Last Name: failed", "Email: frame gone"]);
    expect(r.summary.filled).toEqual([]);
  });

  it("an E_STOPPED from fill_form stops the run", async () => {
    const r = await run([field("e1", "First Name"), field("e2", "Email", "email")], {
      fill_form: () => Promise.reject(Object.assign(new Error("stopped"), { code: "E_STOPPED" })),
    });
    expect(r.end).toMatchObject({ name: "run_failed", data: { message: "Stopped." } });
    expect(r.calls.filter((c) => c.method === "fill_form")).toHaveLength(1);
  });

  describe("resume upload", () => {
    it("uploads the profile's resume to resume fields, with a long timeout", async () => {
      fs.writeFileSync(path.join(docs, "cv.pdf"), "%PDF-1.4");
      writeProfile({ ...PROFILE, resumePath: path.join(docs, "cv.pdf") });
      const r = await run([field("e1", "Resume/CV*", "file"), field("e2", "Cover letter", "file")], { upload: () => ({ ok: true }) });
      const up = r.calls.find((c) => c.method === "upload")!;
      expect(up.params).toMatchObject({ ref: "e1", fileName: "cv.pdf", mimeType: "application/pdf", size: 8, base64: Buffer.from("%PDF-1.4").toString("base64") });
      expect(up.timeoutMs).toBe(60_000);
      expect(r.summary.filled).toEqual(["Resume/CV*: cv.pdf"]);
      expect(r.summary.leftForUser).toEqual(["Cover letter"]);
    });

    it("refuses a resume outside allowedUploadDirs before it reaches the browser", async () => {
      const outside = path.join(dir, "outside.pdf");
      fs.writeFileSync(outside, "x");
      writeProfile({ ...PROFILE, resumePath: outside });
      const r = await run([field("e1", "Resume", "file")], { upload: () => ({ ok: true }) });
      expect(r.calls.some((c) => c.method === "upload")).toBe(false);
      expect(r.summary.failed[0]).toMatch(/^Resume: .*not inside an allowed upload directory/);
    });

    it("leaves resume fields when there's no resume, or the upload fails", async () => {
      const r = await run([field("e1", "Resume", "file")]);
      expect(r.summary.leftForUser).toEqual(["Resume"]);

      fs.writeFileSync(path.join(docs, "cv.pdf"), "%PDF");
      writeProfile({ ...PROFILE, resumePath: path.join(docs, "cv.pdf") });
      const r2 = await run([field("e1", "Resume", "file")], { upload: () => Promise.reject(new Error("input is gone")) });
      expect(r2.summary.failed).toEqual(["Resume: input is gone"]);
    });
  });
});

describe("classifyClaudeFailure and unsupportedByRules", () => {
  it("classifies each family of failure", () => {
    expect(classifyClaudeFailure("OAuth token has expired")).toMatch(/logged in/);
    expect(classifyClaudeFailure("401 Unauthorized")).toMatch(/logged in/);
    expect(classifyClaudeFailure("API Error: Overloaded")).toMatch(/usage limit/);
    expect(classifyClaudeFailure("rate limit exceeded")).toMatch(/usage limit/);
    expect(classifyClaudeFailure("connect ECONNREFUSED 1.2.3.4:443")).toMatch(/network/);
    expect(classifyClaudeFailure("ETIMEDOUT")).toMatch(/network/);
    expect(classifyClaudeFailure("no output within 20 seconds")).toBe("no output within 20 seconds");
    expect(classifyClaudeFailure("the Firefox MCP server failed to start (failed)")).toBe("the Firefox MCP server failed to start");
    expect(classifyClaudeFailure("")).toBeNull();
  });

  it("flags searching, navigation, bulk applying and messaging", () => {
    expect(unsupportedByRules("Search for remote roles")).toBe("needs searching");
    expect(unsupportedByRules("Open the careers page")).toBe("needs navigation");
    expect(unsupportedByRules("navigate to example.com")).toBe("needs navigation");
    expect(unsupportedByRules("Apply to every one of these jobs")).toBe("needs more than this one form");
    expect(unsupportedByRules("Email the recruiter a thank-you")).toBe("needs sending messages");
    expect(unsupportedByRules("Fill the form, skip the cover letter")).toBeNull();
    expect(unsupportedByRules("Upload my resume")).toBeNull();
  });
});
