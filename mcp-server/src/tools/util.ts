import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { BridgeException, toBridgeError } from "../../../shared/protocol.ts";
import type { BridgeConfig } from "../../../shared/node.ts";
import type { BridgeClient } from "../bridge.ts";

export interface ToolContext {
  server: McpServer;
  bridge: BridgeClient;
  config: () => BridgeConfig;
}

export const tabIdSchema = z
  .number()
  .int()
  .optional()
  .describe("Tab to act on. Defaults to the tab chosen with browser_select_tab, else the active tab.");

export const refSchema = z.string().regex(/^e\d+$/).describe('Element ref from the latest snapshot, e.g. "e12".');

export const targetSchema = z
  .object({
    label: z.string().optional().describe("Match a form control by its label"),
    text: z.string().optional().describe("Match a button or link by its text"),
  })
  .optional()
  .describe("Fallback when you don't have a ref. Ambiguous matches return E_AMBIGUOUS with candidates.");

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** Neutralizes attempts by page text to close the wrapper early. */
function escapeBody(s: string): string {
  return s.replace(/<\/?page_content/gi, (m) => m.replace("<", "&lt;"));
}

/** SPEC 8.5: page-derived content is wrapped and marked untrusted. */
export function wrapPage(origin: string, body: string): string {
  return `<page_content origin="${escapeAttr(origin || "unknown")}" untrusted="true">\n${escapeBody(body)}\n</page_content>`;
}

export function text(s: string): CallToolResult {
  return { content: [{ type: "text", text: s }] };
}

/** Formats a result object. Anything that came from a page (it carries `origin`) is wrapped. */
export function result(obj: any): CallToolResult {
  if (obj && typeof obj === "object" && typeof obj.origin === "string") {
    const { origin, ...rest } = obj;
    return text(wrapPage(origin, JSON.stringify(rest, null, 2)));
  }
  return text(JSON.stringify(obj, null, 2));
}

export function errorResult(err: unknown): CallToolResult {
  const e = toBridgeError(err);
  let body = `${e.code}: ${e.message}`;
  if (e.data !== undefined) {
    const data = e.data as any;
    const json = JSON.stringify(data, null, 2);
    body += "\n" + (data && typeof data === "object" && typeof data.origin === "string" ? wrapPage(data.origin, json) : json);
  }
  return { isError: true, content: [{ type: "text", text: body }] };
}

/** Wraps a tool handler so bridge errors become MCP tool errors instead of protocol errors. */
export function handle<A>(fn: (args: A) => Promise<CallToolResult>): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (err) {
      return errorResult(err);
    }
  };
}

export function requireRefOrTarget(args: { ref?: string; target?: { label?: string; text?: string } }): void {
  if (!args.ref && !args.target?.label && !args.target?.text) {
    throw new BridgeException("E_INTERNAL", "Provide either ref or target.");
  }
}

export function approvalTimeouts(ctx: ToolContext): { approvalTimeoutMs: number; callTimeoutMs: number } {
  const sec = Math.max(10, Math.min(600, ctx.config().approvalTimeoutSec || 120));
  return { approvalTimeoutMs: sec * 1000, callTimeoutMs: (sec + 30) * 1000 };
}
