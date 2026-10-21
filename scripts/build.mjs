// Bundles the host and MCP server into single files, and the shared protocol into the extension.
import { build } from "esbuild";
import { chmod } from "node:fs/promises";

const node = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: "linked",
  // Some CommonJS dependencies call require(); give ESM bundles a working one.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "info",
};

await Promise.all([
  build({ ...node, entryPoints: ["host/src/index.ts"], outfile: "host/dist/index.js" }),
  build({ ...node, entryPoints: ["mcp-server/src/index.ts"], outfile: "mcp-server/dist/index.js" }),
  build({
    entryPoints: ["shared/protocol.ts"],
    outfile: "extension/lib/protocol.js",
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "firefox128",
    banner: { js: "// Generated from shared/protocol.ts by scripts/build.mjs. Do not edit." },
    logLevel: "info",
  }),
]);
await chmod("host/claude-bridge-host", 0o755).catch(() => {});
