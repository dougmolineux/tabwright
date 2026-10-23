// host/src/fm.ts against a fake tabwright-fm that speaks the same line protocol as the Swift helper:
// { id, op, ...args } in, { id, result } or { id, error } out, one JSON object per line.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FmHelper, fmHelperPath } from "../../host/src/fm.ts";

let dir: string;
let bin: string;
const helpers: FmHelper[] = [];
const helper = (b = bin) => {
  const h = new FmHelper(b);
  helpers.push(h);
  return h;
};

const FAKE = `#!${process.execPath}
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
require("readline").createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l);
  switch (m.op) {
    case "availability": return out({ id: m.id, result: { available: true, contextSize: 4096 } });
    case "plan": return out({ id: m.id, result: { steps: [{ kind: "fillForm" }], unsupportedReason: null, echo: m.instruction } });
    case "match": return out({ id: m.id, result: { profileKey: m.profileKeys[0] ?? null, option: null, askUser: false, args: m } });
    case "draft": return out({ id: m.id, result: { text: "Draft: " + m.question + " / " + m.profileSummary } });
    case "pid": return out({ id: m.id, result: process.pid });
    case "fail": return out({ id: m.id, error: "boom" });
    case "crash": return process.exit(3);
    case "hang": return;
    case "noise": {
      // Blank lines, junk, a reply for an unknown id, then the real reply split across writes.
      process.stdout.write("\\n   \\nnot json\\n" + JSON.stringify({ id: 99999, result: "stray" }) + "\\n");
      const s = JSON.stringify({ id: m.id, result: "clean" }) + "\\n";
      process.stdout.write(s.slice(0, 5));
      return setTimeout(() => process.stdout.write(s.slice(5)), 30);
    }
    case "slow": return setTimeout(() => out({ id: m.id, result: m.n }), m.ms);
    default: return out({ id: m.id, error: "unknown op " + m.op });
  }
});
`;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-fm-"));
  bin = path.join(dir, "tabwright-fm");
  fs.writeFileSync(bin, FAKE, { mode: 0o755 });
});
afterEach(() => {
  for (const h of helpers.splice(0)) h.close();
  delete process.env.TABWRIGHT_FM_HELPER;
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("fmHelperPath", () => {
  it("prefers TABWRIGHT_FM_HELPER when it is executable", () => {
    process.env.TABWRIGHT_FM_HELPER = bin;
    expect(fmHelperPath()).toBe(bin);
  });

  it("treats an override that isn't executable as no helper, without searching further", () => {
    // Otherwise a local fm-helper build would be found and the real on-device model used.
    const plain = path.join(dir, "not-exec");
    fs.writeFileSync(plain, "x", { mode: 0o644 });
    process.env.TABWRIGHT_FM_HELPER = plain;
    expect(fmHelperPath()).toBeNull();
    process.env.TABWRIGHT_FM_HELPER = path.join(dir, "missing");
    expect(fmHelperPath()).toBeNull();
  });
});

describe("FmHelper", () => {
  it("speaks the protocol for each op", async () => {
    const fm = helper();
    expect(await fm.availability()).toEqual({ available: true, contextSize: 4096 });
    expect(await fm.plan("Fill this")).toMatchObject({ steps: [{ kind: "fillForm" }], echo: "Fill this" });
    const ans: any = await fm.match("Email", "email", ["a"], ["email", "phone"]);
    expect(ans).toMatchObject({ profileKey: "email", askUser: false });
    expect(ans.args).toMatchObject({ op: "match", label: "Email", kind: "email", options: ["a"], profileKeys: ["email", "phone"] });
    expect(await fm.draft("Why us?", "Jane Doe")).toEqual({ text: "Draft: Why us? / Jane Doe" });
  });

  it("keeps one process for many calls and matches concurrent replies by id", async () => {
    const fm = helper();
    const pid = await fm.call("pid");
    const results = await Promise.all([
      fm.call("slow", { n: 1, ms: 120 }),
      fm.call("slow", { n: 2, ms: 10 }),
      fm.call("slow", { n: 3, ms: 60 }),
    ]);
    expect(results).toEqual([1, 2, 3]);
    expect(await fm.call("pid")).toBe(pid);
  });

  it("turns { error } replies into rejections", async () => {
    const fm = helper();
    await expect(fm.call("fail")).rejects.toThrow("boom");
    await expect(fm.call("nope")).rejects.toThrow("unknown op nope");
    expect(await fm.call("pid")).toBeTypeOf("number"); // still usable
  });

  it("ignores blank, malformed and unknown-id lines, and reassembles split lines", async () => {
    const fm = helper();
    expect(await fm.call("noise")).toBe("clean");
  });

  it("times out a call that gets no reply", async () => {
    const fm = helper();
    await expect(fm.call("hang", {}, 100)).rejects.toThrow("on-device hang timed out");
    expect(await fm.call("pid")).toBeTypeOf("number");
  });

  it("rejects pending calls when the helper exits, and restarts on the next call", async () => {
    const fm = helper();
    const pid1 = await fm.call("pid");
    const pending = fm.call("hang", {}, 5000);
    await expect(fm.call("crash", {}, 5000)).rejects.toThrow("on-device helper exited (3)");
    await expect(pending).rejects.toThrow(/exited/);
    const pid2 = await fm.call("pid");
    expect(pid2).not.toBe(pid1);
  });

  it("rejects instead of crashing when the helper can't be started", async () => {
    const fm = helper(path.join(dir, "missing-binary"));
    await expect(fm.availability()).rejects.toThrow(/on-device helper (failed|exited)/);
  });

  it("close() kills the helper and fails what's pending; a later call starts a new one", async () => {
    const fm = helper();
    const pid1 = await fm.call("pid");
    const pending = fm.call("hang", {}, 5000);
    fm.close();
    await expect(pending).rejects.toThrow(/exited/);
    const pid2 = await fm.call("pid");
    expect(pid2).not.toBe(pid1);
  });

  it("a call made right after close() isn't failed by the old process exiting", async () => {
    const fm = helper();
    await fm.call("pid");
    fm.close();
    // The old child's exit arrives after this call is pending on the new child.
    await expect(fm.call("slow", { n: 7, ms: 150 }, 5000)).resolves.toBe(7);
  });
});
