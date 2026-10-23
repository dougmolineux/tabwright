// host/src/handlers.ts: the requests the extension sends to the native host.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleHostRequest, readProfile } from "../../host/src/handlers.ts";
import type { Runner } from "../../host/src/runner.ts";

let dir: string;
const runner = { start: vi.fn(() => ({ runId: "run-x" })), stop: vi.fn() };
const log = { log: vi.fn() };
const call = (method: string, params?: Record<string, unknown>) =>
  handleHostRequest({ v: 1, id: "1", type: "request", method, params }, { runner: runner as unknown as Runner, log: log as any });

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-handlers-"));
  process.env.TABWRIGHT_DIR = path.join(dir, "conf");
  process.env.TABWRIGHT_CLAUDE_BIN = path.join(dir, "no-claude");
  process.env.TABWRIGHT_FM_HELPER = path.join(dir, "fm");
  fs.writeFileSync(path.join(dir, "fm"), "#!/bin/sh\n", { mode: 0o755 });
});
afterAll(() => {
  delete process.env.TABWRIGHT_DIR;
  delete process.env.TABWRIGHT_CLAUDE_BIN;
  delete process.env.TABWRIGHT_FM_HELPER;
  fs.rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => vi.clearAllMocks());

describe("host requests", () => {
  it("host_info reports versions, the config dir, draftFreeText and which engines exist", async () => {
    const info: any = await call("host_info");
    expect(info).toMatchObject({
      version: "0.1.0",
      platform: process.platform,
      node: process.version,
      configDir: path.join(dir, "conf"),
      draftFreeText: false,
      engines: { claude: false, fm: true, rules: true },
    });
  });

  it("profile_get returns null before a profile exists, and when it isn't valid JSON", async () => {
    expect(await call("profile_get")).toEqual({ path: path.join(dir, "conf", "profile.json"), profile: null });
    expect(readProfile()).toBeNull();
  });

  it("profile_set creates the directory, writes 0600 atomically, and round-trips", async () => {
    const profile = { firstName: "Jane", answers: { salaryExpectation: null } };
    expect(await call("profile_set", { profile })).toEqual({ ok: true, path: path.join(dir, "conf", "profile.json") });
    const file = path.join(dir, "conf", "profile.json");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(file + ".tmp")).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(JSON.stringify(profile, null, 2) + "\n");
    expect((await call("profile_get")) as any).toMatchObject({ profile });
    expect(log.log).toHaveBeenCalledWith("profile saved");

    fs.writeFileSync(file, "{ broken");
    expect(readProfile()).toBeNull();
  });

  it("profile_set refuses anything but a JSON object", async () => {
    for (const profile of [undefined, null, "x", 3, [1, 2]]) {
      await expect(call("profile_set", { profile })).rejects.toMatchObject({ code: "E_INTERNAL", message: "profile must be a JSON object" });
    }
  });

  it("run_start requires an instruction, trims it, and normalizes the engine", async () => {
    for (const instruction of [undefined, "", "   ", 5]) {
      await expect(call("run_start", { instruction })).rejects.toMatchObject({ code: "E_INTERNAL", message: "instruction is required" });
    }
    expect(runner.start).not.toHaveBeenCalled();
    expect(await call("run_start", { instruction: "  Fill it  ", tabId: 4, engine: "fm" })).toEqual({ runId: "run-x" });
    expect(runner.start).toHaveBeenLastCalledWith({ instruction: "Fill it", tabId: 4, engine: "fm" });
    for (const engine of ["claude", "rules", "auto"]) {
      await call("run_start", { instruction: "x", engine });
      expect(runner.start).toHaveBeenLastCalledWith(expect.objectContaining({ engine }));
    }
    for (const engine of [undefined, "gpt", 1]) {
      await call("run_start", { instruction: "x", engine });
      expect(runner.start).toHaveBeenLastCalledWith(expect.objectContaining({ engine: "auto" }));
    }
  });

  it("run_stop stops the runner", async () => {
    expect(await call("run_stop")).toEqual({ ok: true });
    expect(runner.stop).toHaveBeenCalledWith("Stopped by user");
  });

  it("rejects unknown methods, including extension methods sent the wrong way", async () => {
    await expect(call("nope")).rejects.toMatchObject({ code: "E_INTERNAL", message: "Unknown host method nope" });
    await expect(call("click")).rejects.toMatchObject({ code: "E_INTERNAL" });
  });

  it("treats missing params as empty", async () => {
    await expect(handleHostRequest({ v: 1, id: "1", type: "request", method: "run_start" }, { runner: runner as any, log: log as any })).rejects.toMatchObject({
      message: "instruction is required",
    });
  });
});
