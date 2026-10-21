import { z } from "zod";
import { handle, refSchema, tabIdSchema, text, wrapPage, type ToolContext } from "./util.ts";

export function registerReadTools(ctx: ToolContext): void {
  const { server, bridge } = ctx;

  server.registerTool(
    "browser_snapshot",
    {
      description:
        "Text outline of the page: headings, form controls with their current values, buttons and links, each " +
        "interactive element with a ref (e.g. e12) to pass to action tools. Buttons marked [consequential] need the " +
        "user's approval in the browser. Take a new snapshot after navigation or when told a ref is stale.",
      inputSchema: {
        tabId: tabIdSchema,
        root: refSchema.optional().describe("Only snapshot this element's subtree (useful when truncated)."),
        includeText: z.boolean().optional().describe("Include visible text blocks (default true)."),
      },
    },
    handle(async (args) => {
      const snap = await bridge.call(
        "snapshot",
        { ...args, includeText: args.includeText ?? true, charLimit: ctx.config().snapshotCharLimit },
        45_000,
      );
      const header = [`page: ${JSON.stringify(snap.title ?? "")} (${snap.url})`, `snapshot: ${snap.snapshotId}`];
      if (snap.truncated) header.push("truncated: true (call browser_snapshot with root=<ref> to see a section)");
      return text(wrapPage(snap.origin, header.join("\n") + "\n" + snap.text));
    }),
  );

  server.registerTool(
    "browser_screenshot",
    {
      description:
        "JPEG of the visible part of a tab (activates the tab if needed), or of one element when ref is given. " +
        "Use when layout matters; prefer browser_snapshot otherwise.",
      inputSchema: { tabId: tabIdSchema, ref: refSchema.optional() },
    },
    handle(async (args) => {
      const shot = await bridge.call("screenshot", args, 45_000);
      const notes: string[] = [];
      if (shot.activated) notes.push("Activated the tab to capture it.");
      if (shot.note) notes.push(shot.note);
      return {
        content: [
          { type: "image" as const, data: shot.data, mimeType: shot.mimeType ?? "image/jpeg" },
          ...(notes.length ? [{ type: "text" as const, text: notes.join(" ") }] : []),
        ],
      };
    }),
  );

  server.registerTool(
    "browser_get_text",
    {
      description: "Readable text of the page, or of one element, up to 50,000 characters.",
      inputSchema: { tabId: tabIdSchema, ref: refSchema.optional() },
    },
    handle(async (args) => {
      const res = await bridge.call("get_text", args);
      return text(wrapPage(res.origin, (res.truncated ? "[truncated to 50,000 characters]\n" : "") + res.text));
    }),
  );
}
