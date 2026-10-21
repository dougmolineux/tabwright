// Requests the extension sends to the native host (profile editor, instruction mode).
import fs from "node:fs";
import path from "node:path";
import { BridgeException, type RequestMessage } from "../../shared/protocol.ts";
import { configDir, loadConfig, profilePath, type FileLogger } from "../../shared/node.ts";
import type { Runner } from "./runner.ts";
import { availableEngines } from "./runner.ts";

export interface HandlerDeps {
  runner: Runner;
  log: FileLogger;
}

export function readProfile(): Record<string, any> | null {
  try {
    return JSON.parse(fs.readFileSync(profilePath(), "utf8"));
  } catch {
    return null;
  }
}

export async function handleHostRequest(msg: RequestMessage, deps: HandlerDeps): Promise<unknown> {
  const p = (msg.params ?? {}) as Record<string, any>;
  switch (msg.method) {
    case "host_info": {
      const cfg = loadConfig();
      return {
        version: "0.1.0",
        platform: process.platform,
        node: process.version,
        configDir: configDir(),
        draftFreeText: cfg.draftFreeText,
        engines: await availableEngines(),
      };
    }
    case "profile_get":
      return { path: profilePath(), profile: readProfile() };
    case "profile_set": {
      const profile = p.profile;
      if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
        throw new BridgeException("E_INTERNAL", "profile must be a JSON object");
      }
      const file = profilePath();
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(profile, null, 2) + "\n", { mode: 0o600 });
      fs.renameSync(tmp, file);
      deps.log.log("profile saved");
      return { ok: true, path: file };
    }
    case "run_start": {
      if (typeof p.instruction !== "string" || !p.instruction.trim()) {
        throw new BridgeException("E_INTERNAL", "instruction is required");
      }
      const engine = ["auto", "claude", "fm", "rules"].includes(p.engine) ? p.engine : "auto";
      return deps.runner.start({ instruction: p.instruction.trim(), tabId: p.tabId, engine });
    }
    case "run_stop":
      deps.runner.stop("Stopped by user");
      return { ok: true };
    default:
      throw new BridgeException("E_INTERNAL", `Unknown host method ${msg.method}`);
  }
}
