// host/src/index.ts in-process: native messaging framing on a fake stdin/stdout, socket authentication,
// request forwarding and routing, events, the run-token client, and shutdown. The integration suite
// covers the same paths against the built bundle; this one counts toward coverage and probes edge cases.
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Reassembler, chunkMessage, type Message } from "../../shared/protocol.ts";
import { Runner } from "../../host/src/runner.ts";

let dir: string;
let token: string;
let sock: string;
let stdin: PassThrough;
let host: typeof import("../../host/src/index.ts");
const fromHost: Message[] = [];
const reassembler = new Reassembler();
let outBuf = Buffer.alloc(0);
const realWrite = process.stdout.write.bind(process.stdout);
const realStdin = Object.getOwnPropertyDescriptor(process, "stdin")!;
const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
// The run token only goes to the run's MCP server (in its config file); read it from the host's runner.
const startSpy = vi.spyOn(Runner.prototype, "start");
const runToken = () => (startSpy.mock.contexts.at(-1) as Runner | undefined)?.activeRunToken() ?? null;

/** Frames a message the way Firefox does: 4-byte little-endian length, then UTF-8 JSON. */
function frame(obj: unknown): Buffer {
  const body = Buffer.from(typeof obj === "string" ? obj : JSON.stringify(obj));
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length);
  return Buffer.concat([head, body]);
}
const toHost = (msg: unknown) => stdin.write(frame(msg));

function onHostBytes(b: Buffer) {
  outBuf = Buffer.concat([outBuf, b]);
  while (outBuf.length >= 4) {
    const len = outBuf.readUInt32LE(0);
    if (outBuf.length < 4 + len) return;
    let msg: any = JSON.parse(outBuf.subarray(4, 4 + len).toString("utf8"));
    outBuf = outBuf.subarray(4 + len);
    if (msg.type === "chunk") {
      msg = reassembler.add(msg);
      if (!msg) continue;
    }
    fromHost.push(msg);
  }
}

async function next(pred: (m: any) => boolean, ms = 3000): Promise<any> {
  let found: any;
  await vi.waitFor(() => {
    const i = fromHost.findIndex(pred);
    if (i < 0) throw new Error("not yet");
    [found] = fromHost.splice(i, 1);
  }, { timeout: ms, interval: 5 });
  return found;
}
const responseTo = (id: string) => next((m) => m.type === "response" && m.id === id);

/** A raw socket client speaking the newline-delimited JSON the MCP server uses. */
function connect(): Promise<{ s: net.Socket; send: (o: unknown) => void; line: () => Promise<any>; closed: Promise<void> }> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(sock);
    const queue: any[] = [];
    const waiters: ((v: any) => void)[] = [];
    let buf = "";
    let onClose!: () => void;
    const closed = new Promise<void>((r) => (onClose = r));
    s.setEncoding("utf8");
    s.on("data", (d: string) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const m = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        const w = waiters.shift();
        if (w) w(m);
        else queue.push(m);
      }
    });
    s.on("close", () => {
      waiters.splice(0).forEach((w) => w({ closed: true }));
      onClose();
    });
    s.on("error", () => {});
    s.on("connect", () =>
      resolve({
        s,
        send: (o) => s.write((typeof o === "string" ? o : JSON.stringify(o)) + "\n"),
        line: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r))),
        closed,
      }),
    );
    s.on("error", reject);
  });
}

async function primary() {
  const c = await connect();
  c.send({ type: "hello", token });
  expect(await c.line()).toEqual({ type: "hello_ok", role: "primary" });
  return c;
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-hostidx-"));
  token = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(path.join(dir, "token"), token, { mode: 0o600 });
  process.env.TABWRIGHT_DIR = dir;
  process.env.TABWRIGHT_CLAUDE_BIN = path.join(dir, "no-claude");
  process.env.TABWRIGHT_FM_HELPER = path.join(dir, "no-fm");
  sock = path.join(dir, "bridge.sock");
  fs.writeFileSync(sock, "stale"); // a leftover socket file is replaced

  stdin = new PassThrough();
  Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
  process.stdout.write = ((chunk: any, ...rest: any[]) => {
    if (Buffer.isBuffer(chunk)) {
      onHostBytes(chunk);
      return true;
    }
    return realWrite(chunk, ...rest);
  }) as typeof process.stdout.write;

  host = await import("../../host/src/index.ts");
  await vi.waitFor(() => expect(fs.statSync(sock).isSocket()).toBe(true), { timeout: 3000 });
});

afterAll(() => {
  process.stdout.write = realWrite as typeof process.stdout.write;
  Object.defineProperty(process, "stdin", realStdin);
  exitSpy.mockRestore();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("native host (in-process)", () => {
  it("listens on a private socket, replacing a stale file", async () => {
    await vi.waitFor(() => expect(fs.readFileSync(path.join(dir, "logs", "host.log"), "utf8")).toMatch(/host starting[\s\S]*listening on/));
    expect(fs.statSync(sock).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("answers host requests from the extension", async () => {
    toHost({ v: 1, id: "x-1", type: "request", method: "host_info", params: {} });
    expect((await responseTo("x-1")).result).toMatchObject({ version: "0.1.0", configDir: dir, engines: { claude: false, fm: false, rules: true } });
    toHost({ v: 1, id: "x-2", type: "request", method: "bogus" });
    expect((await responseTo("x-2")).error).toEqual({ code: "E_INTERNAL", message: "Unknown host method bogus" });
  });

  it("handles frames split across reads and several frames in one read", async () => {
    const a = frame({ v: 1, id: "x-3", type: "request", method: "profile_get" });
    const b = frame({ v: 1, id: "x-4", type: "request", method: "profile_get" });
    const all = Buffer.concat([a, b]);
    stdin.write(all.subarray(0, 2));
    await new Promise((r) => setTimeout(r, 10));
    stdin.write(all.subarray(2, a.length + 3));
    await new Promise((r) => setTimeout(r, 10));
    stdin.write(all.subarray(a.length + 3));
    expect((await responseTo("x-3")).result).toMatchObject({ profile: null });
    expect((await responseTo("x-4")).result).toMatchObject({ profile: null });
  });

  it("skips bad JSON and invalid envelopes without stopping", async () => {
    stdin.write(frame("{ not json"));
    toHost({ v: 2, id: "x", type: "request", method: "host_info" });
    toHost({ v: 1, type: "request", method: "host_info" });
    toHost({ v: 1, id: "x-5", type: "request", method: "profile_get" });
    await responseTo("x-5");
    expect(fromHost.filter((m: any) => m.type === "response" && m.id === "x")).toHaveLength(0);
    const log = fs.readFileSync(path.join(dir, "logs", "host.log"), "utf8");
    expect(log).toContain("bad JSON from extension");
    expect(log).toMatch(/invalid message from extension: unsupported protocol version 2/);
  });

  it("reassembles chunked requests from the extension", async () => {
    const profile = { firstName: "Jane", blob: "z".repeat(1_200_000) };
    const parts = chunkMessage({ v: 1, id: "x-6", type: "request", method: "profile_set", params: { profile } });
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) toHost(p);
    expect((await responseTo("x-6")).result).toMatchObject({ ok: true });
    toHost({ v: 1, id: "x-7", type: "request", method: "profile_get" });
    expect((await responseTo("x-7")).result.profile.blob).toHaveLength(1_200_000);
  });

  it("chunks large responses toward the extension", async () => {
    // x-7 above came back reassembled from chunks; check the raw frames stayed under the 1 MB native limit.
    const sizes: number[] = [];
    const orig = process.stdout.write;
    process.stdout.write = ((b: any, ...r: any[]) => {
      if (Buffer.isBuffer(b)) sizes.push(b.length);
      return (orig as any)(b, ...r);
    }) as typeof process.stdout.write;
    toHost({ v: 1, id: "x-8", type: "request", method: "profile_get" });
    await responseTo("x-8");
    process.stdout.write = orig;
    expect(sizes.length).toBeGreaterThan(1);
    expect(Math.max(...sizes)).toBeLessThan(1024 * 1024);
  });

  describe("socket clients", () => {
    it("refuses a first message that isn't hello, and a wrong token", async () => {
      const a = await connect();
      a.send({ type: "request", id: "1", method: "status" });
      expect(await a.line()).toEqual({ type: "hello_error", message: "Expected hello" });
      await a.closed;

      const b = await connect();
      b.send({ type: "hello", token: token.slice(0, -1) + (token.endsWith("0") ? "1" : "0") });
      expect(await b.line()).toEqual({ type: "hello_error", message: "Invalid token" });
      await b.closed;

      const c = await connect();
      c.send({ type: "hello", token: 42 });
      expect((await c.line()).message).toBe("Expected hello");
    });

    it("ignores bad JSON before hello", async () => {
      const c = await connect();
      c.send("garbage");
      c.send({ type: "hello", token });
      expect(await c.line()).toEqual({ type: "hello_ok", role: "primary" });
      c.s.destroy();
      await c.closed;
    });

    it("forwards requests with a per-client id, routes the response back, and allows only one primary", async () => {
      const c = await primary();
      const other = await connect();
      other.send({ type: "hello", token });
      expect(await other.line()).toMatchObject({ type: "hello_error", code: "E_BUSY" });
      await other.closed;

      c.send({ v: 1, id: "7", type: "request", method: "snapshot", params: { tabId: 1 } });
      const fwd = await next((m) => m.type === "request" && m.method === "snapshot");
      expect(fwd.id).toMatch(/^c\d+:7$/);
      expect(fwd.params).toEqual({ tabId: 1 });
      toHost({ v: 1, id: fwd.id, type: "response", result: { text: "hi" } });
      expect(await c.line()).toEqual({ v: 1, id: "7", type: "response", result: { text: "hi" } });

      // Unknown response ids and non-request messages from the client are dropped.
      toHost({ v: 1, id: "c999:1", type: "response", result: {} });
      c.send({ v: 1, id: "8", type: "response", result: {} });
      c.send({ v: 1, type: "request", method: "x" });
      c.send("not json");
      c.send({ v: 1, id: "9", type: "request", method: "status" });
      const fwd9 = await next((m) => m.type === "request" && m.method === "status");
      expect(fwd9.id).toMatch(/:9$/);
      toHost({ v: 1, id: fwd9.id, type: "response", error: { code: "E_NO_TAB", message: "No active tab" } });
      expect(await c.line()).toEqual({ v: 1, id: "9", type: "response", error: { code: "E_NO_TAB", message: "No active tab" } });

      c.s.destroy();
      await c.closed;
      // With the primary gone, a new one may connect.
      const again = await primary();
      again.s.destroy();
      await again.closed;
    });

    it("reports a chunked response that can't be reassembled to the client that asked", async () => {
      const c = await primary();
      c.send({ v: 1, id: "big", type: "request", method: "screenshot" });
      const fwd = await next((m) => m.method === "screenshot");
      toHost({ v: 1, type: "chunk", id: fwd.id, seq: 0, total: 1, data: "AAAA" }); // decodes to non-JSON
      const r = await c.line();
      expect(r).toMatchObject({ id: "big", type: "response", error: { code: "E_INTERNAL" } });
      c.s.destroy();
      await c.closed;
    });

    it("drops responses for a client that has gone", async () => {
      const c = await primary();
      c.send({ v: 1, id: "1", type: "request", method: "list_tabs" });
      const fwd = await next((m) => m.method === "list_tabs");
      c.s.destroy();
      await c.closed;
      await new Promise((r) => setTimeout(r, 20));
      toHost({ v: 1, id: fwd.id, type: "response", result: {} });
      toHost({ v: 1, id: "x-9", type: "request", method: "profile_get" });
      await responseTo("x-9"); // still alive
    });

    it("broadcasts extension events to authenticated clients only", async () => {
      const c = await primary();
      const pending = await connect();
      toHost({ v: 1, type: "event", name: "tab_closed", data: { tabId: 3 } });
      expect(await c.line()).toEqual({ v: 1, type: "event", name: "tab_closed", data: { tabId: 3 } });
      pending.send({ type: "hello", token: "wrong" });
      expect(await pending.line()).toMatchObject({ type: "hello_error" }); // not the event
      c.s.destroy();
      await c.closed;
    });
  });

  describe("instruction runs", () => {
    it("lets the run's MCP server connect beside the primary, and a stop event ends the run", async () => {
      const c = await primary();
      fs.rmSync(path.join(dir, "profile.json"), { force: true });
      toHost({ v: 1, id: "x-10", type: "request", method: "run_start", params: { instruction: "Fill this", tabId: 5, engine: "rules" } });
      expect((await responseTo("x-10")).result.runId).toMatch(/^run-/);
      // The runner reads the profile before listing fields; with none, it fails.
      expect(await next((m) => m.type === "event" && m.name === "run_failed")).toMatchObject({ data: { message: expect.stringMatching(/No profile found/) } });

      fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify({ firstName: "Jane" }));
      toHost({ v: 1, id: "x-11", type: "request", method: "run_start", params: { instruction: "Fill this", tabId: 5, engine: "rules" } });
      await responseTo("x-11");
      const ff = await next((m) => m.type === "request" && m.method === "form_fields");
      expect(ff.id).toMatch(/^h-\d+$/);
      expect(ff.params).toEqual({ tabId: 5 });

      // A run token from the MCP config authenticates as "run" even with a primary connected.
      const runTok = runToken();
      expect(runTok).toMatch(/^[0-9a-f]{64}$/);
      const r = await connect();
      r.send({ type: "hello", token: runTok });
      expect(await r.line()).toEqual({ type: "hello_ok", role: "run" });

      // Esc / Stop in Firefox: the extension sends "stopped".
      toHost({ v: 1, type: "event", name: "stopped", data: { reason: "Esc" } });
      expect(await c.line()).toMatchObject({ type: "event", name: "stopped" });
      toHost({ v: 1, id: ff.id, type: "response", result: { fields: [{ ref: "e1", label: "First Name", kind: "text", value: "" }] } });
      expect(await next((m) => m.type === "event" && m.name === "run_failed")).toMatchObject({ data: { message: "Stopped." } });
      expect(fromHost.some((m: any) => m.method === "fill_form")).toBe(false);

      // The token stops working once the run is over.
      const late = await connect();
      late.send({ type: "hello", token: runTok });
      expect(await late.line()).toMatchObject({ type: "hello_error", message: "Invalid token" });
      for (const x of [c, r]) x.s.destroy();
    });

    it("run_stop from the extension stops the run", async () => {
      toHost({ v: 1, id: "x-12", type: "request", method: "run_start", params: { instruction: "Fill", engine: "rules" } });
      await responseTo("x-12");
      const ff = await next((m) => m.method === "form_fields");
      toHost({ v: 1, id: "x-13", type: "request", method: "run_stop" });
      expect((await responseTo("x-13")).result).toEqual({ ok: true });
      toHost({ v: 1, id: ff.id, type: "response", result: { fields: [] } });
      expect(await next((m) => m.name === "run_failed")).toMatchObject({ data: { message: "Stopped." } });
    });
  });

  describe("callExtension", () => {
    it("resolves with the result and rejects with the bridge error", async () => {
      const p = host.callExtension("status", { a: 1 });
      const req = await next((m) => m.type === "request" && m.method === "status");
      expect(req).toMatchObject({ v: 1, id: expect.stringMatching(/^h-/), params: { a: 1 } });
      toHost({ v: 1, id: req.id, type: "response", result: { ok: 1 } });
      await expect(p).resolves.toEqual({ ok: 1 });

      const q = host.callExtension("click");
      const req2 = await next((m) => m.method === "click");
      toHost({ v: 1, id: req2.id, type: "response", error: { code: "E_APPROVAL_DENIED", message: "no", data: { x: 1 } } });
      await expect(q).rejects.toMatchObject({ code: "E_APPROVAL_DENIED", message: "no", data: { x: 1 } });
    });

    it("times out, and ignores a late response", async () => {
      const p = host.callExtension("wait_for", {}, 50);
      await expect(p).rejects.toMatchObject({ code: "E_TIMEOUT", message: "wait_for timed out after 50 ms" });
      const req = await next((m) => m.method === "wait_for");
      toHost({ v: 1, id: req.id, type: "response", result: {} });
      toHost({ v: 1, id: "x-14", type: "request", method: "profile_get" });
      await responseTo("x-14");
    });

    it("rejects a request too large to send instead of writing it", async () => {
      const before = fromHost.length;
      const p = host.callExtension("upload", { base64: "a".repeat(21 * 1024 * 1024) });
      await expect(p).rejects.toMatchObject({ code: "E_TOO_LARGE" });
      expect(fromHost.length).toBe(before);
    });

    it("emitToExtension sends an event", async () => {
      host.emitToExtension("run_log", { text: "hi" });
      expect(await next((m) => m.type === "event" && m.name === "run_log" && m.data?.text === "hi")).toEqual({ v: 1, type: "event", name: "run_log", data: { text: "hi" } });
    });
  });

  it("shuts down when Firefox closes stdin: clients dropped, socket removed, exit 0", async () => {
    const c = await primary();
    stdin.end();
    await c.closed;
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0), { timeout: 2000 });
    expect(fs.existsSync(sock)).toBe(false);
    expect(fs.readFileSync(path.join(dir, "logs", "host.log"), "utf8")).toContain("shutting down: stdin closed");
  });
});

