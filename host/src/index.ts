// Native messaging host (SPEC section 11). Firefox starts it; it bridges native messaging on
// stdin/stdout to a Unix socket the MCP server connects to. It also runs instruction mode (runner.ts).
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import {
  BridgeException,
  Reassembler,
  chunkMessage,
  errorResponse,
  event,
  request,
  response,
  validateMessage,
  type ChunkMessage,
  type Message,
  type RequestMessage,
  type ResponseMessage,
  type WireMessage,
} from "../../shared/protocol.ts";
import { FileLogger, readToken, safeEqual, socketPath } from "../../shared/node.ts";
import { handleHostRequest } from "./handlers.ts";
import { Runner } from "./runner.ts";

const log = new FileLogger("host.log");
const HELLO_TIMEOUT_MS = 2000;

// ---------- native messaging (stdin/stdout) ----------

const reassembler = new Reassembler();
let stdinBuf: Buffer = Buffer.alloc(0);

function writeNative(msg: Message): void {
  let parts: WireMessage[];
  try {
    parts = chunkMessage(msg);
  } catch (err) {
    log.log("dropping oversized message to extension", (err as Error).message);
    if (msg.type === "request") routeFromExtension(errorResponse(msg.id, err));
    return;
  }
  for (const part of parts) {
    const body = Buffer.from(JSON.stringify(part), "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0); // native byte order on every supported platform (x86_64, arm64)
    process.stdout.write(Buffer.concat([header, body]));
  }
}

function onStdinData(chunk: Buffer): void {
  stdinBuf = stdinBuf.length ? Buffer.concat([stdinBuf, chunk]) : chunk;
  while (stdinBuf.length >= 4) {
    const len = stdinBuf.readUInt32LE(0);
    if (stdinBuf.length < 4 + len) break;
    const body = stdinBuf.subarray(4, 4 + len).toString("utf8");
    stdinBuf = stdinBuf.subarray(4 + len);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      log.log("bad JSON from extension");
      continue;
    }
    const problem = validateMessage(parsed);
    if (problem) {
      log.log("invalid message from extension:", problem);
      continue;
    }
    let msg: Message | null = parsed as Message;
    if ((parsed as WireMessage).type === "chunk") {
      try {
        msg = reassembler.add(parsed as ChunkMessage);
      } catch (err) {
        const id = (parsed as ChunkMessage).id;
        log.log("chunk reassembly failed", id, (err as Error).message);
        routeFromExtension(errorResponse(id, err));
        continue;
      }
      if (!msg) continue;
    }
    routeFromExtension(msg);
  }
}

// ---------- requests the host itself sends to the extension (runner) ----------

let hostSeq = 0;
const hostPending = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: NodeJS.Timeout }>();

export function callExtension(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<any> {
  const id = `h-${++hostSeq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      hostPending.delete(id);
      reject(new BridgeException("E_TIMEOUT", `${method} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    hostPending.set(id, { resolve, reject, timer });
    writeNative(request(id, method, params));
  });
}

export function emitToExtension(name: string, data?: unknown): void {
  writeNative(event(name, data));
}

// ---------- socket clients (MCP servers) ----------

interface Client {
  id: number;
  socket: net.Socket;
  role: "primary" | "run" | "pending";
  buf: string;
}

const clients = new Map<number, Client>();
let clientSeq = 0;
/** Forwarded request id -> client that sent it and its original id. */
const socketPending = new Map<string, { client: Client; origId: string }>();

const runner = new Runner({ callExtension, emit: emitToExtension, log: (...a) => log.log("[runner]", ...a) });

function sendLine(client: Client, obj: unknown): void {
  if (!client.socket.destroyed) client.socket.write(JSON.stringify(obj) + "\n");
}

function onClientLine(client: Client, line: string): void {
  if (!line.trim()) return;
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    log.log(`client ${client.id}: bad JSON`);
    return;
  }
  if (client.role === "pending") {
    if (msg?.type !== "hello" || typeof msg.token !== "string") {
      sendLine(client, { type: "hello_error", message: "Expected hello" });
      client.socket.destroy();
      return;
    }
    let token = "";
    try {
      token = readToken();
    } catch {
      /* no token -> nobody authenticates */
    }
    const runToken = runner.activeRunToken();
    if (runToken && safeEqual(msg.token, runToken)) {
      client.role = "run";
    } else if (token && safeEqual(msg.token, token)) {
      const existing = [...clients.values()].find((c) => c.role === "primary");
      if (existing) {
        sendLine(client, {
          type: "hello_error",
          code: "E_BUSY",
          message: "Another Claude Code session is already connected to Firefox. Close it (or run /mcp to disconnect) and try again.",
        });
        client.socket.end();
        return;
      }
      client.role = "primary";
    } else {
      sendLine(client, { type: "hello_error", message: "Invalid token" });
      client.socket.destroy();
      return;
    }
    log.log(`client ${client.id} authenticated as ${client.role}`);
    sendLine(client, { type: "hello_ok", role: client.role });
    return;
  }
  const problem = validateMessage(msg);
  if (problem || msg.type !== "request") {
    log.log(`client ${client.id}: ignoring message: ${problem ?? msg.type}`);
    return;
  }
  const req = msg as RequestMessage;
  const fwdId = `c${client.id}:${req.id}`;
  socketPending.set(fwdId, { client, origId: req.id });
  writeNative({ ...req, id: fwdId });
}

function routeFromExtension(msg: Message): void {
  if (msg.type === "response") {
    const host = hostPending.get(msg.id);
    if (host) {
      hostPending.delete(msg.id);
      clearTimeout(host.timer);
      if (msg.error) host.reject(new BridgeException(msg.error.code, msg.error.message, msg.error.data));
      else host.resolve(msg.result);
      return;
    }
    const fwd = socketPending.get(msg.id);
    if (fwd) {
      socketPending.delete(msg.id);
      sendLine(fwd.client, { ...msg, id: fwd.origId } satisfies ResponseMessage);
    }
    return;
  }
  if (msg.type === "event") {
    if (msg.name === "stopped") runner.stop("Stopped by user");
    for (const c of clients.values()) if (c.role !== "pending") sendLine(c, msg);
    return;
  }
  // A request from the extension to the host.
  handleHostRequest(msg, { runner, log })
    .then((result) => writeNative(response(msg.id, result)))
    .catch((err) => writeNative(errorResponse(msg.id, err)));
}

// ---------- startup / shutdown ----------

let server: net.Server | null = null;
const sockPath = socketPath();

function startSocketServer(): void {
  const dir = path.dirname(sockPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(sockPath);
  } catch {
    /* none */
  }
  server = net.createServer((socket) => {
    const client: Client = { id: ++clientSeq, socket, role: "pending", buf: "" };
    clients.set(client.id, client);
    const helloTimer = setTimeout(() => {
      if (client.role === "pending") {
        log.log(`client ${client.id}: no hello within ${HELLO_TIMEOUT_MS} ms`);
        socket.destroy();
      }
    }, HELLO_TIMEOUT_MS);
    socket.setEncoding("utf8");
    socket.on("data", (data: string) => {
      client.buf += data;
      let nl: number;
      while ((nl = client.buf.indexOf("\n")) >= 0) {
        const line = client.buf.slice(0, nl);
        client.buf = client.buf.slice(nl + 1);
        onClientLine(client, line);
      }
    });
    const cleanup = () => {
      clearTimeout(helloTimer);
      clients.delete(client.id);
      for (const [k, v] of socketPending) if (v.client === client) socketPending.delete(k);
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  });
  const oldMask = process.umask(0o177);
  server.listen(sockPath, () => {
    process.umask(oldMask);
    try {
      fs.chmodSync(sockPath, 0o600);
    } catch {
      /* ignore */
    }
    log.log(`listening on ${sockPath}`);
  });
  server.on("error", (err) => log.log("socket server error", err.message));
}

let shuttingDown = false;
function shutdown(reason: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log.log("shutting down:", reason);
  runner.stop("Firefox disconnected");
  for (const c of clients.values()) c.socket.destroy();
  server?.close();
  try {
    fs.unlinkSync(sockPath);
  } catch {
    /* already gone */
  }
  setTimeout(() => process.exit(0), 50);
}

process.stdin.on("data", onStdinData);
process.stdin.on("end", () => shutdown("stdin closed"));
process.stdin.on("error", () => shutdown("stdin error"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("uncaughtException", (err) => log.log("uncaught", err.stack ?? String(err)));
process.on("unhandledRejection", (err) => log.log("unhandled rejection", String(err)));

log.log(`host starting (pid ${process.pid}, node ${process.version}, id ${crypto.randomUUID().slice(0, 8)})`);
startSocketServer();
