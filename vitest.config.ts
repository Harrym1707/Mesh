import { defineConfig } from "vitest/config";

// vitest 4 collects compiled test copies under dist/ by default; only the
// TypeScript sources are the tests of record.
export default defineConfig({
  test: {
    include: ["packages/**/src/**/*.test.ts", "apps/**/src/**/*.test.ts", "evals/**/*.test.ts"],
    exclude: ["**/dist/**", "**/node_modules/**"],
  },
});
