import { defineConfig } from "vitest/config";

// The root vitest.config.ts lists the folders it collects from and gtm/ is not
// among them; this session may not edit it. `pnpm gtm:test` runs this config.
// One line in the root config ("gtm/**/*.test.ts" in `include`) would make
// `pnpm test` and CI run these too.
export default defineConfig({
  test: {
    root: new URL("..", import.meta.url).pathname,
    include: ["gtm/**/*.test.ts"],
    exclude: ["**/dist/**", "**/node_modules/**"],
  },
});
