import { z } from "zod";
import { BridgeException } from "../../../shared/protocol.ts";
import { approvalTimeouts, handle, result, tabIdSchema, text, wrapPage, type ToolContext } from "./util.ts";

export function registerTabTools(ctx: ToolContext): void {
  const { server, bridge } = ctx;

  server.registerTool(
    "browser_status",
    {
      description: "Connection state, Firefox version, the sites Claude is allowed on, and the selected tab.",
      inputSchema: {},
    },
    handle(async () => {
      if (!bridge.connected) {
        try {
          await bridge.connectOnce();
        } catch {
          return text(JSON.stringify({ connected: false, message: bridge.statusMessage }, null, 2));
        }
      }
      const status = await bridge.call("status");
      return text(JSON.stringify({ connected: true, ...status }, null, 2));
    }),
  );

  server.registerTool(
    "browser_list_tabs",
    {
      description: "List open Firefox tabs with id, title, URL, whether it is active, and whether Claude is allowed on its site.",
      inputSchema: {},
    },
    handle(async () => {
      const { tabs } = await bridge.call("list_tabs");
      return text(wrapPage("tab titles", JSON.stringify(tabs, null, 2)));
    }),
  );

  server.registerTool(
    "browser_select_tab",
    {
      description: "Choose the tab later tools act on by default, and bring it to the front.",
      inputSchema: { tabId: z.number().int() },
    },
    handle(async (args) => result(await bridge.call("select_tab", args))),
  );

  server.registerTool(
    "browser_open_tab",
    {
      description:
        "Open a URL in a new tab and select it. Reading or acting on it still requires the user to allow the site.",
      inputSchema: { url: z.string().url() },
    },
    handle(async (args) => result(await bridge.call("open_tab", args, 45_000))),
  );

  server.registerTool(
    "browser_navigate",
    {
      description: "Navigate a tab to a URL, or go back, forward or reload. Returns the final URL after load.",
      inputSchema: {
        tabId: tabIdSchema,
        url: z.string().url().optional(),
        action: z.enum(["back", "forward", "reload"]).optional(),
      },
    },
    handle(async (args) => {
      if (!args.url && !args.action) throw new BridgeException("E_INTERNAL", "Provide url or action.");
      const { callTimeoutMs, approvalTimeoutMs } = approvalTimeouts(ctx);
      return result(await bridge.call("navigate", { ...args, approvalTimeoutMs }, callTimeoutMs + 30_000));
    }),
  );
}
