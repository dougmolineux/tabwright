// Client side of the Unix socket to the native host (SPEC 7.4).
import net from "node:net";
import { BridgeException, request, validateMessage, type EventMessage, type ResponseMessage } from "../../shared/protocol.ts";
import { readToken, socketPath } from "../../shared/node.ts";

const RETRY_EVERY_MS = 2000;
const RETRY_FOR_MS = 30_000;

type Pending = { resolve: (v: any) => void; reject: (e: unknown) => void; timer: NodeJS.Timeout };

export class BridgeClient {
  private socket: net.Socket | null = null;
  private ready = false;
  private buf = "";
  private seq = 0;
  private pending = new Map<string, Pending>();
  private connecting: Promise<void> | null = null;
  private closed = false;
  private lastError = "Firefox isn't connected yet. Open Firefox and click Connect in the Tabwright toolbar popup.";
  onEvent: (e: EventMessage) => void = () => {};

  get connected(): boolean {
    return this.ready;
  }

  get statusMessage(): string {
    return this.ready ? "connected" : this.lastError;
  }

  /** Background retry loop used at startup: every 2 s for up to 30 s. */
  startBackgroundConnect(): void {
    const deadline = Date.now() + RETRY_FOR_MS;
    const attempt = () => {
      if (this.ready || this.closed) return;
      this.connectOnce().catch(() => {
        if (Date.now() < deadline) setTimeout(attempt, RETRY_EVERY_MS);
      });
    };
    attempt();
  }

  /** One connection attempt (shared by concurrent callers). */
  connectOnce(): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      let token: string;
      try {
        token = process.env.TABWRIGHT_RUN_TOKEN || readToken();
      } catch (err) {
        this.lastError = (err as Error).message;
        reject(err);
        return;
      }
      const sock = net.createConnection(socketPath());
      let settled = false;
      const fail = (msg: string) => {
        this.lastError = msg;
        if (!settled) {
          settled = true;
          reject(new BridgeException("E_NOT_CONNECTED", msg));
        }
        sock.destroy();
      };
      const helloTimer = setTimeout(() => fail("Timed out waiting for the native host"), 4000);
      sock.setEncoding("utf8");
      sock.on("connect", () => sock.write(JSON.stringify({ type: "hello", token }) + "\n"));
      sock.on("data", (data: string) => {
        this.buf += data;
        let nl: number;
        while ((nl = this.buf.indexOf("\n")) >= 0) {
          const line = this.buf.slice(0, nl);
          this.buf = this.buf.slice(nl + 1);
          if (!line.trim()) continue;
          let msg: any;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (!this.ready) {
            clearTimeout(helloTimer);
            if (msg.type === "hello_ok") {
              this.ready = true;
              this.socket = sock;
              settled = true;
              resolve();
            } else {
              fail(msg.message ?? "Native host refused the connection");
            }
            continue;
          }
          this.onMessage(msg);
        }
      });
      sock.on("error", (err: NodeJS.ErrnoException) => {
        clearTimeout(helloTimer);
        fail(
          err.code === "ENOENT" || err.code === "ECONNREFUSED"
            ? "Firefox isn't connected. Open Firefox and click Connect in the Tabwright toolbar popup."
            : `Socket error: ${err.message}`,
        );
      });
      sock.on("close", () => {
        clearTimeout(helloTimer);
        const wasReady = this.ready;
        this.ready = false;
        this.socket = null;
        this.buf = "";
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new BridgeException("E_NOT_CONNECTED", "Connection to Firefox was lost"));
          this.pending.delete(id);
        }
        if (wasReady) {
          this.lastError = "Firefox disconnected. Click Connect in the Tabwright popup.";
          this.startBackgroundConnect();
        }
        if (!settled) fail("Connection closed by the native host");
      });
    }).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private onMessage(msg: any): void {
    if (validateMessage(msg)) return;
    if (msg.type === "event") {
      this.onEvent(msg as EventMessage);
      return;
    }
    if (msg.type !== "response") return;
    const res = msg as ResponseMessage;
    const p = this.pending.get(res.id);
    if (!p) return;
    this.pending.delete(res.id);
    clearTimeout(p.timer);
    if (res.error) p.reject(new BridgeException(res.error.code, res.error.message, res.error.data));
    else p.resolve(res.result);
  }

  async call<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    if (!this.ready) {
      try {
        await this.connectOnce();
      } catch {
        throw new BridgeException("E_NOT_CONNECTED", this.lastError);
      }
    }
    const id = `m-${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeException("E_TIMEOUT", `${method} timed out after ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.write(JSON.stringify(request(id, method, params)) + "\n");
    });
  }

  /** Disconnects for good: no background reconnect afterwards. */
  close(): void {
    this.closed = true;
    this.socket?.destroy();
  }
}
