// Node-only helpers shared by the native host and the MCP server: paths, config, token, uploads.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BridgeException } from "./protocol.ts";

export interface BridgeConfig {
  allowedUploadDirs: string[];
  maxUploadBytes: number;
  snapshotCharLimit: number;
  approvalTimeoutSec: number;
  /** Instruction mode: let the on-device model draft free-text answers (SPEC 10.4 step 5). */
  draftFreeText: boolean;
}

export const DEFAULT_CONFIG: BridgeConfig = {
  allowedUploadDirs: ["~/Documents"],
  maxUploadBytes: 10 * 1024 * 1024,
  snapshotCharLimit: 25_000,
  approvalTimeoutSec: 120,
  draftFreeText: false,
};

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Directory holding config.json, token, profile.json (and the socket on macOS). */
export function configDir(): string {
  if (process.env.CLAUDE_BRIDGE_DIR) return process.env.CLAUDE_BRIDGE_DIR;
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "ClaudeBridge");
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdg, "claude-bridge");
}

export function socketPath(): string {
  if (process.env.CLAUDE_BRIDGE_SOCKET) return process.env.CLAUDE_BRIDGE_SOCKET;
  if (process.platform === "darwin" || process.env.CLAUDE_BRIDGE_DIR) return path.join(configDir(), "bridge.sock");
  const runtime = process.env.XDG_RUNTIME_DIR || path.join(os.tmpdir(), `claude-bridge-${os.userInfo().uid}`);
  return path.join(runtime, "claude-bridge", "bridge.sock");
}

export function logDir(): string {
  if (process.env.CLAUDE_BRIDGE_LOG_DIR) return process.env.CLAUDE_BRIDGE_LOG_DIR;
  if (process.env.CLAUDE_BRIDGE_DIR) return path.join(process.env.CLAUDE_BRIDGE_DIR, "logs");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Logs", "ClaudeBridge");
  const state = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(state, "claude-bridge");
}

export const tokenPath = () => path.join(configDir(), "token");
export const configPath = () => path.join(configDir(), "config.json");
export const profilePath = () => path.join(configDir(), "profile.json");

export function loadConfig(): BridgeConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    return { ...DEFAULT_CONFIG, ...raw };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function readToken(): string {
  try {
    return fs.readFileSync(tokenPath(), "utf8").trim();
  } catch {
    throw new BridgeException("E_NOT_CONNECTED", `Bridge token not found at ${tokenPath()}. Run scripts/install.sh.`);
  }
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".txt": "text/plain",
  ".rtf": "application/rtf",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".csv": "text/csv",
  ".json": "application/json",
  ".zip": "application/zip",
};

export function mimeFor(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

export interface UploadFile {
  fileName: string;
  mimeType: string;
  size: number;
  base64: string;
}

/**
 * Reads a file for upload, enforcing SPEC 8.4: the real path (symlinks resolved) must be inside one
 * of the allowed directories (also resolved), and the file must fit the size limit.
 */
export async function readUploadFile(requested: string, cfg: BridgeConfig = loadConfig()): Promise<UploadFile> {
  const expanded = path.resolve(expandHome(requested));
  let real: string;
  try {
    real = await fsp.realpath(expanded);
  } catch {
    throw new BridgeException("E_FILE_NOT_ALLOWED", `File not found: ${requested}`);
  }
  const allowed: string[] = [];
  for (const d of cfg.allowedUploadDirs) {
    try {
      allowed.push(await fsp.realpath(path.resolve(expandHome(d))));
    } catch {
      /* missing directory: ignore */
    }
  }
  const inside = allowed.some((dir) => real === dir || real.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep));
  if (!inside) {
    throw new BridgeException(
      "E_FILE_NOT_ALLOWED",
      `${requested} is not inside an allowed upload directory (${cfg.allowedUploadDirs.join(", ")}). ` +
        `Add its folder to allowedUploadDirs in ${configPath()}.`,
    );
  }
  const st = await fsp.stat(real);
  if (!st.isFile()) throw new BridgeException("E_FILE_NOT_ALLOWED", `${requested} is not a regular file`);
  if (st.size > cfg.maxUploadBytes) {
    throw new BridgeException("E_TOO_LARGE", `${requested} is ${st.size} bytes; the limit is ${cfg.maxUploadBytes}`);
  }
  const buf = await fsp.readFile(real);
  return { fileName: path.basename(real), mimeType: mimeFor(real), size: buf.length, base64: buf.toString("base64") };
}

/** Appends to a log file, rotating it at 5 MB. Never writes to stdout. */
export class FileLogger {
  private file: string;
  constructor(name: string, private maxBytes = 5 * 1024 * 1024) {
    const dir = logDir();
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {
      /* ignore */
    }
    this.file = path.join(dir, name);
  }
  log(...parts: unknown[]): void {
    const line = `${new Date().toISOString()} ${parts.map((p) => (typeof p === "string" ? p : safeJson(p))).join(" ")}\n`;
    try {
      try {
        if (fs.statSync(this.file).size > this.maxBytes) fs.renameSync(this.file, this.file + ".1");
      } catch {
        /* no file yet */
      }
      fs.appendFileSync(this.file, line, { mode: 0o600 });
    } catch {
      /* logging must never crash the process */
    }
  }
}

function safeJson(x: unknown): string {
  try {
    const s = JSON.stringify(x);
    return s.length > 2000 ? s.slice(0, 2000) + "…" : s;
  } catch {
    return String(x);
  }
}
