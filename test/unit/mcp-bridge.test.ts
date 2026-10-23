// The MCP server's socket client (SPEC 7.4) against a fake native host listening on a real Unix socket.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeClient } from "../../mcp-server/src/bridge.ts";
import { BridgeException } from "../../shared/protocol.ts";

const TOKEN = "a".repeat(64);

let dir: string;
let host: FakeHost | null;
let bridge: BridgeClient;

/** Speaks the socket side of the native host: newline-delimited JSON, hello first. */
class FakeHost {
  server: net.Server;
  conns: net.Socket[] = [];
  hellos: any[] = [];
  requests: any[] = [];
  /** What to do with a hello: "ok", "error", "silent" or "close". */
  onHello: "ok" | "error" | "silent" | "close" = "ok";
  /** Answers requests; return undefined to leave a request unanswered. */
  respond: (req: any, sock: net.Socket) => any = (req) => ({ v: 1, id: req.id, type: "response", result: { echo: req.method } });

  constructor() {
    this.server = net.createServer((sock) => {
      this.conns.push(sock);
      let buf = "";
      let greeted = false;
      sock.setEncoding("utf8");
      sock.on("error", () => {});
      sock.on("data", (d: string) => {
        buf += d;
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const msg = JSON.parse(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          if (!greeted) {
            greeted = true;
            this.hellos.push(msg);
            if (this.onHello === "ok") sock.write(JSON.stringify({ type: "hello_ok" }) + "\n");
            else if (this.onHello === "error") sock.write(JSON.stringify({ type: "hello_error", message: "Invalid token" }) + "\n");
            else if (this.onHello === "close") sock.destroy();
            continue;
          }
          this.requests.push(msg);
          const out = this.respond(msg, sock);
          if (out !== undefined) sock.write(JSON.stringify(out) + "\n");
        }
      });
    });
  }

  listen(): Promise<void> {
    return new Promise((r) => this.server.listen(path.join(dir, "bridge.sock"), () => r()));
  }

  send(msg: unknown) {
    for (const c of this.conns) if (!c.destroyed) c.write(JSON.stringify(msg) + "\n");
  }

  dropClients() {
    for (const c of this.conns) c.destroy();
  }

  close(): Promise<void> {
    this.dropClients();
    return new Promise((r) => this.server.close(() => r()));
  }
}

async function startHost(): Promise<FakeHost> {
  host = new FakeHost();
  await host.listen();
  return host;
}

// Polls with setImmediate and performance.now so it keeps working while setTimeout and Date are faked.
const waitFor = async (cond: () => boolean, ms = 3000) => {
  const end = performance.now() + ms;
  while (!cond()) {
    if (performance.now() > end) throw new Error("condition not met");
    await new Promise((r) => setImmediate(r));
  }
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-br-"));
  fs.writeFileSync(path.join(dir, "token"), TOKEN + "\n", { mode: 0o600 });
  vi.stubEnv("TABWRIGHT_DIR", dir);
  vi.stubEnv("TABWRIGHT_SOCKET", "");
  vi.stubEnv("TABWRIGHT_RUN_TOKEN", "");
  bridge = new BridgeClient();
  host = null;
});

afterEach(async () => {
  vi.useRealTimers();
  bridge.close();
  await host?.close();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("handshake", () => {
  it("sends the token from the config dir and becomes ready on hello_ok", async () => {
    await startHost();
    expect(bridge.connected).toBe(false);
    expect(bridge.statusMessage).toMatch(/Firefox isn't connected yet/);
    await bridge.connectOnce();
    expect(host!.hellos).toEqual([{ type: "hello", token: TOKEN }]); // trimmed
    expect(bridge.connected).toBe(true);
    expect(bridge.statusMessage).toBe("connected");
    await bridge.connectOnce(); // no-op once ready
    expect(host!.conns).toHaveLength(1);
  });

  it("prefers TABWRIGHT_RUN_TOKEN (a sidebar run's scoped token)", async () => {
    vi.stubEnv("TABWRIGHT_RUN_TOKEN", "run-token");
    await startHost();
    await bridge.connectOnce();
    expect(host!.hellos[0].token).toBe("run-token");
  });

  it("shares one attempt between concurrent callers", async () => {
    await startHost();
    await Promise.all([bridge.connectOnce(), bridge.connectOnce(), bridge.call("status")]);
    expect(host!.conns).toHaveLength(1);
  });

  it("rejects with the host's message on hello_error", async () => {
    await startHost();
    host!.onHello = "error";
    await expect(bridge.connectOnce()).rejects.toMatchObject({ code: "E_NOT_CONNECTED", message: "Invalid token" });
    expect(bridge.connected).toBe(false);
    expect(bridge.statusMessage).toBe("Invalid token");
  });

  it("explains how to connect when there's no socket", async () => {
    const err = await bridge.connectOnce().catch((e) => e);
    expect(err).toBeInstanceOf(BridgeException);
    expect(err.code).toBe("E_NOT_CONNECTED");
    expect(err.message).toMatch(/Firefox isn't connected\. Open Firefox and click Connect/);
  });

  it("reports a missing token file", async () => {
    fs.rmSync(path.join(dir, "token"));
    await startHost();
    await expect(bridge.connectOnce()).rejects.toMatchObject({ code: "E_NOT_CONNECTED", message: expect.stringMatching(/Bridge token not found/) });
    expect(host!.conns).toHaveLength(0);
    await expect(bridge.call("status")).rejects.toMatchObject({ code: "E_NOT_CONNECTED", message: expect.stringMatching(/Bridge token not found/) });
  });

  it("fails when the host closes the connection during the handshake", async () => {
    await startHost();
    host!.onHello = "close";
    await expect(bridge.connectOnce()).rejects.toMatchObject({ code: "E_NOT_CONNECTED", message: "Connection closed by the native host" });
  });

  it("times out a host that never answers the hello", async () => {
    await startHost();
    host!.onHello = "silent";
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const p = bridge.connectOnce();
    p.catch(() => {});
    await waitFor(() => host!.hellos.length === 1);
    vi.advanceTimersByTime(4000);
    await expect(p).rejects.toMatchObject({ code: "E_NOT_CONNECTED", message: "Timed out waiting for the native host" });
  });

  it("connects on demand when a tool calls before the background loop has", async () => {
    await startHost();
    await expect(bridge.call("status")).resolves.toEqual({ echo: "status" });
  });

  it("turns any connect failure into E_NOT_CONNECTED for callers", async () => {
    await expect(bridge.call("status")).rejects.toMatchObject({ code: "E_NOT_CONNECTED", message: expect.stringMatching(/Firefox isn't connected/) });
  });
});

describe("requests", () => {
  it("sends v1 requests and matches responses by id, in any order", async () => {
    await startHost();
    const held: any[] = [];
    host!.respond = (req) => {
      held.push(req);
      if (held.length === 2) {
        // Answer the second one first.
        host!.send({ v: 1, id: held[1].id, type: "response", result: "second" });
        host!.send({ v: 1, id: held[0].id, type: "response", result: "first" });
      }
      return undefined;
    };
    const a = bridge.call("snapshot", { tabId: 1 });
    const b = bridge.call("list_tabs");
    await expect(Promise.all([a, b])).resolves.toEqual(["first", "second"]);
    expect(host!.requests).toEqual([
      { v: 1, id: "m-1", type: "request", method: "snapshot", params: { tabId: 1 } },
      { v: 1, id: "m-2", type: "request", method: "list_tabs", params: {} },
    ]);
  });

  it("rejects with the error's code, message and data", async () => {
    await startHost();
    host!.respond = (req) => ({ v: 1, id: req.id, type: "response", error: { code: "E_AMBIGUOUS", message: "2 match", data: { candidates: [] } } });
    const err = await bridge.call("click").catch((e) => e);
    expect(err).toBeInstanceOf(BridgeException);
    expect(err).toMatchObject({ code: "E_AMBIGUOUS", message: "2 match", data: { candidates: [] } });
  });

  it("times out a request the host never answers, and ignores a late answer", async () => {
    await startHost();
    let late: any;
    host!.respond = (req) => {
      late = req;
      return undefined;
    };
    await expect(bridge.call("wait_for", {}, 50)).rejects.toMatchObject({ code: "E_TIMEOUT", message: "wait_for timed out after 0 s" });
    host!.send({ v: 1, id: late.id, type: "response", result: "too late" });
    host!.respond = (req) => ({ v: 1, id: req.id, type: "response", result: "ok" });
    await expect(bridge.call("status")).resolves.toBe("ok");
  });

  it("reassembles lines split across socket writes", async () => {
    await startHost();
    host!.respond = (req, sock) => {
      const line = JSON.stringify({ v: 1, id: req.id, type: "response", result: { big: "x".repeat(10_000) } }) + "\n";
      sock.write(line.slice(0, 7));
      setTimeout(() => sock.write(line.slice(7)), 20);
      return undefined;
    };
    const res = await bridge.call("get_text");
    expect(res.big).toHaveLength(10_000);
  });

  it("ignores blank lines, bad JSON, invalid envelopes and unknown ids", async () => {
    await startHost();
    host!.respond = (req, sock) => {
      sock.write("\n   \nnot json\n");
      sock.write(JSON.stringify({ v: 2, id: req.id, type: "response", result: "wrong version" }) + "\n");
      sock.write(JSON.stringify({ v: 1, id: req.id, type: "response", error: { code: "E_NOPE", message: "bad code" } }) + "\n");
      sock.write(JSON.stringify({ v: 1, id: "m-999", type: "response", result: "stranger" }) + "\n");
      sock.write(JSON.stringify({ v: 1, id: req.id, type: "request", method: "x" }) + "\n");
      return { v: 1, id: req.id, type: "response", result: "real" };
    };
    await expect(bridge.call("status")).resolves.toBe("real");
  });

  it("delivers host events to onEvent", async () => {
    await startHost();
    const events: any[] = [];
    bridge.onEvent = (e) => events.push(e);
    await bridge.connectOnce();
    host!.send({ v: 1, type: "event", name: "stopped", data: { reason: "Esc" } });
    await waitFor(() => events.length === 1);
    expect(events[0]).toEqual({ v: 1, type: "event", name: "stopped", data: { reason: "Esc" } });
  });
});

describe("connection loss", () => {
  it("fails pending calls, explains, and reconnects in the background", async () => {
    await startHost();
    host!.respond = () => undefined;
    const pending = bridge.call("ask_user");
    await waitFor(() => host!.requests.length === 1);
    host!.dropClients();
    await expect(pending).rejects.toMatchObject({ code: "E_NOT_CONNECTED", message: "Connection to Firefox was lost" });
    // The first background attempt is immediate and the host is still listening.
    await waitFor(() => bridge.connected);
    expect(host!.conns).toHaveLength(2);
    host!.respond = (req) => ({ v: 1, id: req.id, type: "response", result: "back" });
    await expect(bridge.call("status")).resolves.toBe("back");
  });

  it("says Firefox disconnected while it can't reconnect", async () => {
    await startHost();
    await bridge.connectOnce();
    await host!.close();
    host = null;
    await waitFor(() => !bridge.connected);
    await waitFor(() => /Firefox (disconnected|isn't connected)/.test(bridge.statusMessage));
    expect(bridge.statusMessage).toMatch(/click Connect/i);
  });

  it("close() drops the connection", async () => {
    await startHost();
    await bridge.connectOnce();
    bridge.close();
    await waitFor(() => !bridge.connected);
  });
});

describe("startBackgroundConnect", () => {
  it("retries every 2 s until the host appears", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    bridge.startBackgroundConnect();
    await waitFor(() => /Firefox isn't connected\. Open/.test(bridge.statusMessage));
    await startHost();
    expect(bridge.connected).toBe(false);
    vi.advanceTimersByTime(2000);
    await waitFor(() => bridge.connected);
  });

  it("gives up after 30 s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let attempts = 0;
    let failed = 0;
    const real = bridge.connectOnce.bind(bridge);
    bridge.connectOnce = () => {
      attempts++;
      const p = real();
      p.catch(() => failed++);
      return p;
    };
    bridge.startBackgroundConnect();
    // Each attempt fails on real socket I/O; once it has, move the clock to the next retry.
    for (let last = 0; attempts > last; ) {
      last = attempts;
      await waitFor(() => failed === attempts);
      await new Promise((r) => setImmediate(r));
      vi.advanceTimersByTime(2000);
    }
    expect(attempts).toBe(16); // t = 0, 2, ..., 30 s
    await startHost();
    vi.advanceTimersByTime(10_000);
    await new Promise((r) => setImmediate(r));
    expect(host!.conns).toHaveLength(0);
    expect(bridge.connected).toBe(false);
  });

  it("stops retrying once closed", async () => {
    await startHost();
    await bridge.connectOnce();
    bridge.close();
    await waitFor(() => !bridge.connected);
    await new Promise((r) => setTimeout(r, 30));
    expect(host!.conns).toHaveLength(1);
  });

  it("does nothing when already connected", async () => {
    await startHost();
    await bridge.connectOnce();
    bridge.startBackgroundConnect();
    await new Promise((r) => setTimeout(r, 30));
    expect(host!.conns).toHaveLength(1);
  });
});
