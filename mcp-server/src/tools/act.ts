import { z } from "zod";
import { readUploadFile } from "../../../shared/node.ts";
import { BridgeException } from "../../../shared/protocol.ts";
import {
  approvalTimeouts,
  handle,
  refSchema,
  requireRefOrTarget,
  result,
  tabIdSchema,
  targetSchema,
  type ToolContext,
} from "./util.ts";

export function registerActionTools(ctx: ToolContext): void {
  const { server, bridge } = ctx;

  server.registerTool(
    "browser_click",
    {
      description:
        "Click an element. Clicks that would submit, send, pay, delete and similar ([consequential] in the snapshot) " +
        "pause for the user's approval in the browser and return E_APPROVAL_DENIED or E_APPROVAL_TIMEOUT if not approved.",
      inputSchema: { tabId: tabIdSchema, ref: refSchema.optional(), target: targetSchema },
    },
    handle(async (args) => {
      requireRefOrTarget(args);
      const t = approvalTimeouts(ctx);
      return result(await bridge.call("click", { ...args, approvalTimeoutMs: t.approvalTimeoutMs }, t.callTimeoutMs));
    }),
  );

  server.registerTool(
    "browser_type",
    {
      description:
        "Type into a text field (works with React/Vue inputs). Clears it first unless clear=false. Returns the value " +
        "read back from the field. Password, card and one-time-code fields are refused.",
      inputSchema: {
        tabId: tabIdSchema,
        ref: refSchema.optional(),
        target: targetSchema,
        text: z.string(),
        clear: z.boolean().optional().describe("Clear the field first (default true)."),
        perKey: z.boolean().optional().describe("Send key events per character, for sites that listen to keys."),
      },
    },
    handle(async (args) => {
      requireRefOrTarget(args);
      return result(await bridge.call("type", { ...args, clear: args.clear ?? true }, 60_000));
    }),
  );

  server.registerTool(
    "browser_select",
    {
      description:
        "Choose an option in a native <select> or a custom combobox/dropdown (e.g. react-select), by visible text or value.",
      inputSchema: {
        tabId: tabIdSchema,
        ref: refSchema.optional(),
        target: targetSchema,
        option: z.string().optional(),
        options: z.array(z.string()).optional().describe("For multi-selects."),
      },
    },
    handle(async (args) => {
      requireRefOrTarget(args);
      if (!args.option && !args.options?.length) throw new BridgeException("E_INTERNAL", "Provide option or options.");
      return result(await bridge.call("select", args, 45_000));
    }),
  );

  server.registerTool(
    "browser_check",
    {
      description: "Set a checkbox, switch or radio button to checked or unchecked (clicks only if the state differs).",
      inputSchema: { tabId: tabIdSchema, ref: refSchema.optional(), target: targetSchema, checked: z.boolean() },
    },
    handle(async (args) => {
      requireRefOrTarget(args);
      const t = approvalTimeouts(ctx);
      return result(await bridge.call("check", { ...args, approvalTimeoutMs: t.approvalTimeoutMs }, t.callTimeoutMs));
    }),
  );

  server.registerTool(
    "browser_upload",
    {
      description:
        "Upload a local file into a file input or drop zone. The path must be inside an allowed upload directory " +
        "(allowedUploadDirs in the bridge config); max 10 MB.",
      inputSchema: { tabId: tabIdSchema, ref: refSchema.optional(), target: targetSchema, path: z.string() },
    },
    handle(async (args) => {
      requireRefOrTarget(args);
      const file = await readUploadFile(args.path, ctx.config());
      const res = await bridge.call(
        "upload",
        { tabId: args.tabId, ref: args.ref, target: args.target, fileName: file.fileName, mimeType: file.mimeType, size: file.size, base64: file.base64 },
        90_000,
      );
      return result(res);
    }),
  );

  server.registerTool(
    "browser_press_key",
    {
      description:
        "Press a key on the focused element, e.g. Enter, Tab, Escape, ArrowDown. Enter in a field that would submit " +
        "its form needs the user's approval.",
      inputSchema: { tabId: tabIdSchema, key: z.string().min(1) },
    },
    handle(async (args) => {
      const t = approvalTimeouts(ctx);
      return result(await bridge.call("press_key", { ...args, approvalTimeoutMs: t.approvalTimeoutMs }, t.callTimeoutMs));
    }),
  );

  server.registerTool(
    "browser_scroll",
    {
      description: "Scroll an element into view (ref), or scroll the page by direction and amount.",
      inputSchema: {
        tabId: tabIdSchema,
        ref: refSchema.optional(),
        target: targetSchema,
        direction: z.enum(["up", "down", "left", "right"]).optional(),
        amount: z.number().positive().optional().describe("Pixels (default: most of one screen)."),
      },
    },
    handle(async (args) => result(await bridge.call("scroll", args))),
  );

  server.registerTool(
    "browser_wait_for",
    {
      description: "Wait for text to appear, text to disappear, or an element to become visible.",
      inputSchema: {
        tabId: tabIdSchema,
        text: z.string().optional(),
        textGone: z.string().optional(),
        ref: refSchema.optional(),
        timeoutMs: z.number().int().positive().max(60_000).optional().describe("Default 10000, max 60000."),
      },
    },
    handle(async (args) => {
      if (!args.text && !args.textGone && !args.ref) throw new BridgeException("E_INTERNAL", "Provide text, textGone or ref.");
      const timeoutMs = Math.min(args.timeoutMs ?? 10_000, 60_000);
      return result(await bridge.call("wait_for", { ...args, timeoutMs }, timeoutMs + 10_000));
    }),
  );

  server.registerTool(
    "browser_fill_form",
    {
      description:
        "Fill several fields at once. Each value is typed, selected or checked depending on the field type " +
        "(use true/false for checkboxes, option text for selects and radio groups). Stops at the first error. " +
        "Never clicks consequential elements; use browser_upload for files.",
      inputSchema: {
        tabId: tabIdSchema,
        fields: z
          .array(z.object({ ref: refSchema, value: z.union([z.string(), z.boolean(), z.number()]) }))
          .min(1)
          .max(100),
      },
    },
    handle(async (args) => result(await bridge.call("fill_form", args, 30_000 + args.fields.length * 15_000))),
  );

  server.registerTool(
    "browser_ask_user",
    {
      description:
        "Ask the user a question in the Firefox sidebar and wait for the answer (up to 10 minutes). Use this instead " +
        "of guessing when the profile doesn't answer a field.",
      inputSchema: {
        question: z.string().min(1).max(1000),
        options: z.array(z.string()).max(20).optional().describe("Suggested answers shown as buttons."),
      },
    },
    handle(async (args) => {
      const res = await bridge.call("ask_user", args, 10 * 60_000 + 5_000);
      return result({ answer: res.answer });
    }),
  );
}
