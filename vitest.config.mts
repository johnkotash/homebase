import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/server/test/**/*.test.ts", "apps/connector/test/**/*.test.ts", "apps/client/test/**/*.test.ts", "apps/desktop/test/**/*.test.ts", "scripts/test/**/*.test.ts"],
    testTimeout: 20000,
    pool: "forks",
  },
});
