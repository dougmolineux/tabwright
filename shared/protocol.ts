// Message types, error codes and chunking helpers shared by every hop (SPEC section 7).
// This file must stay free of Node-only APIs: it is also bundled into the extension.

export const PROTOCOL_VERSION = 1;

export const ERROR_CODES = [
  "E_NOT_CONNECTED",
  "E_SITE_NOT_ALLOWED",
  "E_NO_TAB",
  "E_STALE_REF",
  "E_AMBIGUOUS",
  "E_NOT_INTERACTABLE",
  "E_TIMEOUT",
  "E_APPROVAL_DENIED",
  "E_APPROVAL_TIMEOUT",
  "E_STOPPED",
  "E_REFUSED_SENSITIVE",
  "E_FILE_NOT_ALLOWED",
  "E_TOO_LARGE",
  "E_INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface BridgeError {
  code: ErrorCode;
  message: string;
  data?: unknown;
}

export interface RequestMessage {
  v: 1;
  id: string;
  type: "request";
  method: string;
  params?: Record<string, unknown>;
}

export interface ResponseMessage {
  v: 1;
  id: string;
  type: "response";
  result?: unknown;
  error?: BridgeError;
}

export interface EventMessage {
  v: 1;
  type: "event";
  name: string;
  data?: unknown;
}

export interface ChunkMessage {
  v: 1;
  type: "chunk";
  id: string;
  seq: number;
  total: number;
  data: string;
}

export type Message = RequestMessage | ResponseMessage | EventMessage;
export type WireMessage = Message | ChunkMessage;

/** Messages larger than this (serialized) are split into chunks. */
export const CHUNK_THRESHOLD = 900 * 1024;
/** Size of each base64 slice; leaves room for the chunk envelope under the threshold. */
export const CHUNK_SLICE = 600 * 1024;
export const MAX_REASSEMBLED_BYTES = 20 * 1024 * 1024;
export const CHUNK_TTL_MS = 30_000;

export class BridgeException extends Error {
  code: ErrorCode;
  data?: unknown;
  constructor(code: ErrorCode, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
  toJSON(): BridgeError {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data };
  }
}

export function isErrorCode(x: unknown): x is ErrorCode {
  return typeof x === "string" && (ERROR_CODES as readonly string[]).includes(x);
}

export function toBridgeError(err: unknown): BridgeError {
  if (err instanceof BridgeException) return err.toJSON();
  if (err && typeof err === "object" && isErrorCode((err as any).code)) {
    const e = err as any;
    return { code: e.code, message: String(e.message ?? e.code), ...(e.data !== undefined ? { data: e.data } : {}) };
  }
  return { code: "E_INTERNAL", message: err instanceof Error ? err.message : String(err) };
}

export function request(id: string, method: string, params?: Record<string, unknown>): RequestMessage {
  return { v: 1, id, type: "request", method, ...(params ? { params } : {}) };
}

export function response(id: string, result: unknown): ResponseMessage {
  return { v: 1, id, type: "response", result };
}

export function errorResponse(id: string, err: unknown): ResponseMessage {
  return { v: 1, id, type: "response", error: toBridgeError(err) };
}

export function event(name: string, data?: unknown): EventMessage {
  return { v: 1, type: "event", name, ...(data !== undefined ? { data } : {}) };
}

/** Validates the envelope of an incoming message. Returns an error string, or null when valid. */
export function validateMessage(m: unknown): string | null {
  if (!m || typeof m !== "object" || Array.isArray(m)) return "message must be an object";
  const msg = m as Record<string, unknown>;
  if (msg.v !== PROTOCOL_VERSION) return `unsupported protocol version ${String(msg.v)}`;
  switch (msg.type) {
    case "request":
      if (typeof msg.id !== "string" || !msg.id) return "request needs a string id";
      if (typeof msg.method !== "string" || !msg.method) return "request needs a method";
      if (msg.params !== undefined && (typeof msg.params !== "object" || msg.params === null || Array.isArray(msg.params)))
        return "params must be an object";
      return null;
    case "response":
      if (typeof msg.id !== "string" || !msg.id) return "response needs a string id";
      if (msg.error !== undefined) {
        const e = msg.error as Record<string, unknown>;
        if (!e || typeof e !== "object" || !isErrorCode(e.code) || typeof e.message !== "string") return "malformed error";
      }
      return null;
    case "event":
      if (typeof msg.name !== "string" || !msg.name) return "event needs a name";
      return null;
    case "chunk":
      if (typeof msg.id !== "string" || !msg.id) return "chunk needs an id";
      if (!Number.isInteger(msg.seq) || !Number.isInteger(msg.total)) return "chunk needs integer seq and total";
      if ((msg.total as number) < 1 || (msg.seq as number) < 0 || (msg.seq as number) >= (msg.total as number))
        return "chunk seq out of range";
      if (typeof msg.data !== "string") return "chunk data must be a string";
      return null;
    default:
      return `unknown message type ${String(msg.type)}`;
  }
}

// ---------- base64 (works in Node 18+ and browsers) ----------

export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    out += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + step)));
  }
  return btoa(out);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ---------- chunking ----------

let chunkCounter = 0;

/**
 * Serializes a message for a size-limited hop. Returns the message itself when it is small enough,
 * or a list of chunk messages otherwise.
 */
export function chunkMessage(msg: Message, threshold = CHUNK_THRESHOLD, slice = CHUNK_SLICE): WireMessage[] {
  const json = JSON.stringify(msg);
  // Cheap pre-check: UTF-8 is at most 3 bytes per UTF-16 unit.
  if (json.length * 3 <= threshold) return [msg];
  const bytes = encoder.encode(json);
  if (bytes.length <= threshold) return [msg];
  if (bytes.length > MAX_REASSEMBLED_BYTES) {
    throw new BridgeException("E_TOO_LARGE", `message is ${bytes.length} bytes; limit is ${MAX_REASSEMBLED_BYTES}`);
  }
  const b64 = bytesToBase64(bytes);
  // Slices must stay on 4-character boundaries so they can be concatenated and decoded once.
  const size = Math.max(4, slice - (slice % 4));
  const total = Math.ceil(b64.length / size);
  const id = "id" in msg && msg.id ? msg.id : `c-${++chunkCounter}`;
  const chunks: ChunkMessage[] = [];
  for (let seq = 0; seq < total; seq++) {
    chunks.push({ v: 1, type: "chunk", id, seq, total, data: b64.slice(seq * size, (seq + 1) * size) });
  }
  return chunks;
}

interface Pending {
  total: number;
  parts: (string | undefined)[];
  received: number;
  size: number;
  started: number;
}

/** Reassembles chunked messages by id. Incomplete transfers are dropped after CHUNK_TTL_MS. */
export class Reassembler {
  private pending = new Map<string, Pending>();
  constructor(
    private ttlMs = CHUNK_TTL_MS,
    private maxBytes = MAX_REASSEMBLED_BYTES,
    private now: () => number = Date.now,
  ) {}

  /**
   * Feeds one chunk. Returns the reassembled message when complete, null while waiting.
   * Throws BridgeException(E_TOO_LARGE) when the transfer exceeds the size limit (it is then discarded).
   */
  add(chunk: ChunkMessage): Message | null {
    this.sweep();
    let p = this.pending.get(chunk.id);
    if (!p || p.total !== chunk.total) {
      p = { total: chunk.total, parts: new Array(chunk.total), received: 0, size: 0, started: this.now() };
      this.pending.set(chunk.id, p);
    }
    if (p.parts[chunk.seq] === undefined) {
      p.parts[chunk.seq] = chunk.data;
      p.received++;
      p.size += chunk.data.length;
    }
    if ((p.size * 3) / 4 > this.maxBytes) {
      this.pending.delete(chunk.id);
      throw new BridgeException("E_TOO_LARGE", `chunked message ${chunk.id} exceeds ${this.maxBytes} bytes`, { id: chunk.id });
    }
    if (p.received < p.total) return null;
    this.pending.delete(chunk.id);
    const json = decoder.decode(base64ToBytes(p.parts.join("")));
    return JSON.parse(json) as Message;
  }

  sweep(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, p] of this.pending) if (p.started < cutoff) this.pending.delete(id);
  }

  get size(): number {
    return this.pending.size;
  }
}

// ---------- method names ----------

/** Methods the MCP server (and the host's runner) send to the extension. */
export const EXTENSION_METHODS = [
  "status",
  "list_tabs",
  "select_tab",
  "open_tab",
  "navigate",
  "snapshot",
  "screenshot",
  "get_text",
  "click",
  "type",
  "select",
  "check",
  "upload",
  "press_key",
  "scroll",
  "wait_for",
  "fill_form",
  "ask_user",
  "form_fields",
] as const;

export type ExtensionMethod = (typeof EXTENSION_METHODS)[number];

/** Methods the extension sends to the native host. */
export const HOST_METHODS = ["profile_get", "profile_set", "run_start", "run_stop", "host_info"] as const;
