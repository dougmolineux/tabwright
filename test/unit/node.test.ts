// shared/node.ts: per-platform paths, config defaults and merging, the token, uploads and the file logger.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  FileLogger,
  configDir,
  configPath,
  expandHome,
  loadConfig,
  logDir,
  mimeFor,
  profilePath,
  readToken,
  readUploadFile,
  safeEqual,
  socketPath,
  tokenPath,
} from "../../shared/node.ts";

const ENV_KEYS = ["TABWRIGHT_DIR", "TABWRIGHT_SOCKET", "TABWRIGHT_LOG_DIR", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "XDG_STATE_HOME", "HOME"];
const realPlatform = process.platform;
let savedEnv: Record<string, string | undefined>;
let tmp: string;

const setPlatform = (p: NodeJS.Platform) => Object.defineProperty(process, "platform", { value: p, configurable: true });

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cb-node-")));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) if (k !== "HOME") delete process.env[k];
  process.env.HOME = path.join(tmp, "home");
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  setPlatform(realPlatform);
});

describe("paths", () => {
  const home = () => path.join(tmp, "home");

  it("expands ~ and ~/ only at the start", () => {
    expect(expandHome("~")).toBe(home());
    expect(expandHome("~/Documents")).toBe(path.join(home(), "Documents"));
    expect(expandHome("/abs/~/x")).toBe("/abs/~/x");
    expect(expandHome("~other/x")).toBe("~other/x");
    expect(expandHome("relative")).toBe("relative");
  });

  it("uses Application Support and Library/Logs on macOS", () => {
    setPlatform("darwin");
    expect(configDir()).toBe(path.join(home(), "Library", "Application Support", "Tabwright"));
    expect(socketPath()).toBe(path.join(configDir(), "bridge.sock"));
    expect(logDir()).toBe(path.join(home(), "Library", "Logs", "Tabwright"));
  });

  it("follows the XDG directories on Linux", () => {
    setPlatform("linux");
    expect(configDir()).toBe(path.join(home(), ".config", "tabwright"));
    expect(logDir()).toBe(path.join(home(), ".local", "state", "tabwright"));
    expect(socketPath()).toBe(path.join(os.tmpdir(), `tabwright-${os.userInfo().uid}`, "tabwright", "bridge.sock"));
    process.env.XDG_CONFIG_HOME = "/xdg/config";
    process.env.XDG_STATE_HOME = "/xdg/state";
    process.env.XDG_RUNTIME_DIR = "/run/user/1000";
    expect(configDir()).toBe("/xdg/config/tabwright");
    expect(logDir()).toBe("/xdg/state/tabwright");
    expect(socketPath()).toBe("/run/user/1000/tabwright/bridge.sock");
  });

  it("TABWRIGHT_DIR overrides everything, and the specific overrides win over it", () => {
    for (const p of ["darwin", "linux"] as const) {
      setPlatform(p);
      process.env.TABWRIGHT_DIR = "/custom";
      expect(configDir()).toBe("/custom");
      expect(socketPath()).toBe("/custom/bridge.sock");
      expect(logDir()).toBe("/custom/logs");
      expect(tokenPath()).toBe("/custom/token");
      expect(configPath()).toBe("/custom/config.json");
      expect(profilePath()).toBe("/custom/profile.json");
      process.env.TABWRIGHT_SOCKET = "/s/sock";
      process.env.TABWRIGHT_LOG_DIR = "/l";
      expect(socketPath()).toBe("/s/sock");
      expect(logDir()).toBe("/l");
      delete process.env.TABWRIGHT_SOCKET;
      delete process.env.TABWRIGHT_LOG_DIR;
    }
  });
});

describe("config and token", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(tmp, "cfg-"));
    process.env.TABWRIGHT_DIR = dir;
  });

  it("returns the defaults when config.json is missing or broken, without sharing the object", () => {
    const a = loadConfig();
    expect(a).toEqual(DEFAULT_CONFIG);
    a.allowedUploadDirs = ["/changed"];
    a.maxUploadBytes = 1;
    expect(loadConfig()).toEqual(DEFAULT_CONFIG);
    fs.writeFileSync(path.join(dir, "config.json"), "{ not json");
    expect(loadConfig()).toEqual(DEFAULT_CONFIG);
  });

  it("merges a partial config over the defaults", () => {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ maxUploadBytes: 5, draftFreeText: true }));
    expect(loadConfig()).toEqual({ ...DEFAULT_CONFIG, maxUploadBytes: 5, draftFreeText: true });
  });

  it("ignores a config.json that isn't an object", () => {
    for (const body of ["null", "[1,2]", "42", '"str"']) {
      fs.writeFileSync(path.join(dir, "config.json"), body);
      expect(loadConfig()).toEqual(DEFAULT_CONFIG);
    }
  });

  it("falls back per key when a value has the wrong type", () => {
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ allowedUploadDirs: "~/Documents", maxUploadBytes: "big", snapshotCharLimit: -1, approvalTimeoutSec: 30, draftFreeText: "yes", extra: 1 }),
    );
    expect(loadConfig()).toEqual({ ...DEFAULT_CONFIG, approvalTimeoutSec: 30 });
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ allowedUploadDirs: ["/ok", 3] }));
    expect(loadConfig().allowedUploadDirs).toEqual(DEFAULT_CONFIG.allowedUploadDirs);
  });

  it("a string allowedUploadDirs can't widen uploads to the whole disk", async () => {
    // Iterating "~/Documents" per character would include "/", which allows every file.
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ allowedUploadDirs: "~/Documents" }));
    await expect(readUploadFile("/etc/hosts")).rejects.toMatchObject({ code: "E_FILE_NOT_ALLOWED" });
  });

  it("defaults match the documented values", () => {
    expect(DEFAULT_CONFIG).toEqual({
      allowedUploadDirs: ["~/Documents"],
      maxUploadBytes: 10 * 1024 * 1024,
      snapshotCharLimit: 25_000,
      approvalTimeoutSec: 120,
      draftFreeText: false,
    });
  });

  it("reads and trims the token, and explains how to fix a missing one", () => {
    expect(() => readToken()).toThrowError(expect.objectContaining({ code: "E_NOT_CONNECTED", message: expect.stringMatching(/install\.sh/) }));
    fs.writeFileSync(path.join(dir, "token"), "abc123\n");
    expect(readToken()).toBe("abc123");
  });
});

describe("safeEqual", () => {
  it("compares strings exactly", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("", "")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("abc", "ABC")).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(safeEqual(undefined as any, "x")).toBe(false);
    expect(safeEqual("x", null as any)).toBe(false);
    expect(safeEqual(1 as any, 1 as any)).toBe(false);
  });
});

describe("mimeFor", () => {
  it("maps known extensions case-insensitively and falls back to octet-stream", () => {
    expect(mimeFor("a.pdf")).toBe("application/pdf");
    expect(mimeFor("A.PDF")).toBe("application/pdf");
    expect(mimeFor("cv.docx")).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(mimeFor("x.jpeg")).toBe("image/jpeg");
    expect(mimeFor("x.JPG")).toBe("image/jpeg");
    expect(mimeFor("x.unknown")).toBe("application/octet-stream");
    expect(mimeFor("noext")).toBe("application/octet-stream");
  });
});

describe("readUploadFile", () => {
  let docs: string;
  let other: string;
  beforeAll(() => {
    docs = path.join(tmp, "up", "docs");
    other = path.join(tmp, "up", "docs-evil");
    fs.mkdirSync(docs, { recursive: true });
    fs.mkdirSync(other, { recursive: true });
    fs.mkdirSync(path.join(docs, "sub"));
    fs.writeFileSync(path.join(docs, "sub", "cv.docx"), "docx");
    fs.writeFileSync(path.join(other, "x.pdf"), "x");
    fs.symlinkSync(docs, path.join(tmp, "up", "docs-link"));
  });
  const cfg = (dirs: string[], max = 1024) => ({ ...DEFAULT_CONFIG, allowedUploadDirs: dirs, maxUploadBytes: max });

  it("reads files in nested folders with the right name, type and base64", async () => {
    const f = await readUploadFile(path.join(docs, "sub", "cv.docx"), cfg([docs]));
    expect(f).toEqual({ fileName: "cv.docx", mimeType: mimeFor("cv.docx"), size: 4, base64: Buffer.from("docx").toString("base64") });
  });

  it("doesn't treat a sibling with the same prefix as inside", async () => {
    await expect(readUploadFile(path.join(other, "x.pdf"), cfg([docs]))).rejects.toMatchObject({ code: "E_FILE_NOT_ALLOWED" });
  });

  it("resolves symlinked allowed directories and ~ in both the file and the allowed dir", async () => {
    await expect(readUploadFile(path.join(docs, "sub", "cv.docx"), cfg([path.join(tmp, "up", "docs-link")]))).resolves.toMatchObject({ fileName: "cv.docx" });
    process.env.HOME = path.join(tmp, "up");
    await expect(readUploadFile("~/docs/sub/cv.docx", cfg(["~/docs"]))).resolves.toMatchObject({ fileName: "cv.docx" });
  });

  it("refuses directories, missing files, and skips missing allowed dirs", async () => {
    await expect(readUploadFile(path.join(docs, "sub"), cfg([docs]))).rejects.toMatchObject({ code: "E_FILE_NOT_ALLOWED", message: expect.stringMatching(/not a regular file/) });
    await expect(readUploadFile(path.join(docs, "nope.pdf"), cfg([docs]))).rejects.toMatchObject({ code: "E_FILE_NOT_ALLOWED", message: expect.stringMatching(/not found/) });
    await expect(readUploadFile(path.join(docs, "sub", "cv.docx"), cfg(["/no/such/dir", docs]))).resolves.toMatchObject({ size: 4 });
    await expect(readUploadFile(path.join(docs, "sub", "cv.docx"), cfg([]))).rejects.toMatchObject({ code: "E_FILE_NOT_ALLOWED" });
  });

  it("allows a file exactly at the limit and refuses one byte over", async () => {
    await expect(readUploadFile(path.join(docs, "sub", "cv.docx"), cfg([docs], 4))).resolves.toMatchObject({ size: 4 });
    await expect(readUploadFile(path.join(docs, "sub", "cv.docx"), cfg([docs], 3))).rejects.toMatchObject({ code: "E_TOO_LARGE" });
  });

  it("uses config.json when no config is passed", async () => {
    const dir = fs.mkdtempSync(path.join(tmp, "cfg-"));
    process.env.TABWRIGHT_DIR = dir;
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ allowedUploadDirs: [docs] }));
    await expect(readUploadFile(path.join(docs, "sub", "cv.docx"))).resolves.toMatchObject({ fileName: "cv.docx" });
  });
});

describe("FileLogger", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(tmp, "logs-"));
    process.env.TABWRIGHT_LOG_DIR = path.join(dir, "nested");
  });

  it("creates the log directory privately and appends timestamped lines with 0600", () => {
    const log = new FileLogger("t.log");
    log.log("hello", { a: 1 }, 2, null);
    log.log("again");
    const file = path.join(dir, "nested", "t.log");
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z hello {"a":1} 2 null$/);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(dir, "nested")).mode & 0o777).toBe(0o700);
  });

  it("rotates to .1 once the file passes the limit, replacing an older .1", () => {
    const log = new FileLogger("r.log", 100);
    const file = path.join(dir, "nested", "r.log");
    fs.writeFileSync(file + ".1", "old rotation");
    log.log("x".repeat(150));
    log.log("second");
    expect(fs.readFileSync(file + ".1", "utf8")).toContain("x".repeat(150));
    expect(fs.readFileSync(file, "utf8")).toMatch(/second\n$/);
    expect(fs.readFileSync(file, "utf8")).not.toContain("xxx");
  });

  it("truncates huge objects and survives unserializable ones", () => {
    const log = new FileLogger("j.log");
    const circular: any = {};
    circular.self = circular;
    log.log({ big: "y".repeat(5000) }, circular, 10n);
    const text = fs.readFileSync(path.join(dir, "nested", "j.log"), "utf8");
    expect(text).toContain("…");
    expect(text.length).toBeLessThan(2200);
    expect(text).toContain("[object Object]");
    expect(text).toContain(" 10\n");
  });

  it("never throws, even when the log directory can't be created", () => {
    fs.writeFileSync(path.join(dir, "file"), "");
    process.env.TABWRIGHT_LOG_DIR = path.join(dir, "file", "sub");
    const log = new FileLogger("x.log");
    expect(() => log.log("nowhere")).not.toThrow();
  });
});
