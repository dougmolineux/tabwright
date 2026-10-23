import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.{ts,js}", "test/integration/**/*.test.ts"],
    testTimeout: 20_000,
    coverage: {
      provider: "v8",
      include: ["extension/**/*.js", "host/src/**", "mcp-server/src/**", "shared/**"],
      // Generated from shared/protocol.ts, which is measured instead.
      exclude: ["extension/lib/protocol.js"],
      reporter: ["text", "html"],
    },
  },
});
