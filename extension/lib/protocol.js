// Generated from shared/protocol.ts by scripts/build.mjs. Do not edit.

// shared/protocol.ts
var PROTOCOL_VERSION = 1;
var ERROR_CODES = [
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
  "E_INTERNAL"
];
var CHUNK_THRESHOLD = 900 * 1024;
var CHUNK_SLICE = 600 * 1024;
var MAX_REASSEMBLED_BYTES = 20 * 1024 * 1024;
var CHUNK_TTL_MS = 3e4;
var BridgeException = class extends Error {
  code;
  data;
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
  toJSON() {
    return this.data === void 0 ? { code: this.code, message: this.message } : { code: this.code, message: this.message, data: this.data };
  }
};
function isErrorCode(x) {
  return typeof x === "string" && ERROR_CODES.includes(x);
}
function toBridgeError(err) {
  if (err instanceof BridgeException) return err.toJSON();
  if (err && typeof err === "object" && isErrorCode(err.code)) {
    const e = err;
    return { code: e.code, message: String(e.message ?? e.code), ...e.data !== void 0 ? { data: e.data } : {} };
  }
  return { code: "E_INTERNAL", message: err instanceof Error ? err.message : String(err) };
}
function request(id, method, params) {
  return { v: 1, id, type: "request", method, ...params ? { params } : {} };
}
function response(id, result) {
  return { v: 1, id, type: "response", result };
}
function errorResponse(id, err) {
  return { v: 1, id, type: "response", error: toBridgeError(err) };
}
function event(name, data) {
  return { v: 1, type: "event", name, ...data !== void 0 ? { data } : {} };
}
function validateMessage(m) {
  if (!m || typeof m !== "object" || Array.isArray(m)) return "message must be an object";
  const msg = m;
  if (msg.v !== PROTOCOL_VERSION) return `unsupported protocol version ${String(msg.v)}`;
  switch (msg.type) {
    case "request":
      if (typeof msg.id !== "string" || !msg.id) return "request needs a string id";
      if (typeof msg.method !== "string" || !msg.method) return "request needs a method";
      if (msg.params !== void 0 && (typeof msg.params !== "object" || msg.params === null || Array.isArray(msg.params)))
        return "params must be an object";
      return null;
    case "response":
      if (typeof msg.id !== "string" || !msg.id) return "response needs a string id";
      if (msg.error !== void 0) {
        const e = msg.error;
        if (!e || typeof e !== "object" || !isErrorCode(e.code) || typeof e.message !== "string") return "malformed error";
      }
      return null;
    case "event":
      if (typeof msg.name !== "string" || !msg.name) return "event needs a name";
      return null;
    case "chunk":
      if (typeof msg.id !== "string" || !msg.id) return "chunk needs an id";
      if (!Number.isInteger(msg.seq) || !Number.isInteger(msg.total)) return "chunk needs integer seq and total";
      if (msg.total < 1 || msg.seq < 0 || msg.seq >= msg.total)
        return "chunk seq out of range";
      if (typeof msg.data !== "string") return "chunk data must be a string";
      return null;
    default:
      return `unknown message type ${String(msg.type)}`;
  }
}
function bytesToBase64(bytes) {
  let out = "";
  const step = 32768;
  for (let i = 0; i < bytes.length; i += step) {
    out += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + step)));
  }
  return btoa(out);
}
function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
var encoder = new TextEncoder();
var decoder = new TextDecoder();
var chunkCounter = 0;
function chunkMessage(msg, threshold = CHUNK_THRESHOLD, slice = CHUNK_SLICE) {
  const json = JSON.stringify(msg);
  if (json.length * 3 <= threshold) return [msg];
  const bytes = encoder.encode(json);
  if (bytes.length <= threshold) return [msg];
  if (bytes.length > MAX_REASSEMBLED_BYTES) {
    throw new BridgeException("E_TOO_LARGE", `message is ${bytes.length} bytes; limit is ${MAX_REASSEMBLED_BYTES}`);
  }
  const b64 = bytesToBase64(bytes);
  const size = Math.max(4, slice - slice % 4);
  const total = Math.ceil(b64.length / size);
  const id = "id" in msg && msg.id ? msg.id : `c-${++chunkCounter}`;
  const chunks = [];
  for (let seq = 0; seq < total; seq++) {
    chunks.push({ v: 1, type: "chunk", id, seq, total, data: b64.slice(seq * size, (seq + 1) * size) });
  }
  return chunks;
}
var Reassembler = class {
  constructor(ttlMs = CHUNK_TTL_MS, maxBytes = MAX_REASSEMBLED_BYTES, now = Date.now) {
    this.ttlMs = ttlMs;
    this.maxBytes = maxBytes;
    this.now = now;
  }
  ttlMs;
  maxBytes;
  now;
  pending = /* @__PURE__ */ new Map();
  /**
   * Feeds one chunk. Returns the reassembled message when complete, null while waiting.
   * Throws BridgeException(E_TOO_LARGE) when the transfer exceeds the size limit (it is then discarded).
   */
  add(chunk) {
    this.sweep();
    let p = this.pending.get(chunk.id);
    if (!p || p.total !== chunk.total) {
      p = { total: chunk.total, parts: new Array(chunk.total), received: 0, size: 0, started: this.now() };
      this.pending.set(chunk.id, p);
    }
    if (p.parts[chunk.seq] === void 0) {
      p.parts[chunk.seq] = chunk.data;
      p.received++;
      p.size += chunk.data.length;
    }
    if (p.size * 3 / 4 > this.maxBytes) {
      this.pending.delete(chunk.id);
      throw new BridgeException("E_TOO_LARGE", `chunked message ${chunk.id} exceeds ${this.maxBytes} bytes`, { id: chunk.id });
    }
    if (p.received < p.total) return null;
    this.pending.delete(chunk.id);
    const json = decoder.decode(base64ToBytes(p.parts.join("")));
    return JSON.parse(json);
  }
  sweep() {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, p] of this.pending) if (p.started < cutoff) this.pending.delete(id);
  }
  get size() {
    return this.pending.size;
  }
};
var EXTENSION_METHODS = [
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
  "form_fields"
];
var HOST_METHODS = ["profile_get", "profile_set", "run_start", "run_stop", "host_info"];
export {
  BridgeException,
  CHUNK_SLICE,
  CHUNK_THRESHOLD,
  CHUNK_TTL_MS,
  ERROR_CODES,
  EXTENSION_METHODS,
  HOST_METHODS,
  MAX_REASSEMBLED_BYTES,
  PROTOCOL_VERSION,
  Reassembler,
  base64ToBytes,
  bytesToBase64,
  chunkMessage,
  errorResponse,
  event,
  isErrorCode,
  request,
  response,
  toBridgeError,
  validateMessage
};
