// Client for the Swift helper (claude-bridge-fm) that wraps Apple's Foundation Models framework.
// Protocol: one JSON object per line on stdin/stdout, matched by id.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface FmAvailability {
  available: boolean;
  reason?: string;
  contextSize?: number;
}

export type PlanStep =
  | { kind: "fillForm" }
  | { kind: "skipFields"; labels: string[] }
  | { kind: "uploadResume" }
  | { kind: "scrollTo"; text: string }
  | { kind: "stop" };

export interface Plan {
  steps: PlanStep[];
  unsupportedReason?: string | null;
}

export interface FieldAnswer {
  profileKey: string | null;
  option: string | null;
  askUser: boolean;
}

export function fmHelperPath(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.CLAUDE_BRIDGE_FM_HELPER,
    path.join(here, "claude-bridge-fm"),
    path.resolve(here, "../../fm-helper/.build/release/claude-bridge-fm"),
    path.resolve(here, "../fm-helper/.build/release/claude-bridge-fm"),
  ].filter(Boolean) as string[];
  return candidates.find((p) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }) ?? null;
}

export class FmHelper {
  private child: ChildProcess | null = null;
  private buf = "";
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  constructor(private bin: string) {}

  private ensure(): ChildProcess {
    if (this.child && this.child.exitCode === null) return this.child;
    const child = spawn(this.bin, [], { stdio: ["pipe", "pipe", "ignore"] });
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (d: string) => {
      this.buf += d;
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          const p = this.pending.get(msg.id);
          if (!p) continue;
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error) p.reject(new Error(msg.error));
          else p.resolve(msg.result);
        } catch {
          /* ignore malformed */
        }
      }
    });
    const failAll = (why: string) => {
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(why));
        this.pending.delete(id);
      }
    };
    child.on("exit", (code) => failAll(`on-device helper exited (${code})`));
    child.on("error", (err) => failAll(`on-device helper failed: ${err.message}`));
    this.child = child;
    return child;
  }

  call<T>(op: string, args: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<T> {
    const child = this.ensure();
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`on-device ${op} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin!.write(JSON.stringify({ id, op, ...args }) + "\n");
    });
  }

  availability(): Promise<FmAvailability> {
    return this.call("availability", {}, 15_000);
  }

  plan(instruction: string): Promise<Plan> {
    return this.call("plan", { instruction });
  }

  match(label: string, kind: string, options: string[], profileKeys: string[]): Promise<FieldAnswer> {
    return this.call("match", { label, kind, options, profileKeys });
  }

  draft(question: string, profileSummary: string): Promise<{ text: string }> {
    return this.call("draft", { question, profileSummary }, 90_000);
  }

  close(): void {
    this.child?.kill();
    this.child = null;
  }
}
