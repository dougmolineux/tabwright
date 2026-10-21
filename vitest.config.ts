import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.{ts,js}", "test/integration/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
