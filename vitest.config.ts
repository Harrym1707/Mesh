import { defineConfig } from "vitest/config";

// vitest 4 collects compiled test copies under dist/ by default; only the
// TypeScript sources are the tests of record.
export default defineConfig({
  test: {
    include: ["packages/**/src/**/*.test.ts", "apps/**/src/**/*.test.ts", "evals/**/*.test.ts", "lab/**/*.test.ts"],
    exclude: ["**/dist/**", "**/node_modules/**"],
    // No test, and no `mesh` process a test starts, may show a real desktop
    // notification (packages/cli/src/report-delivery.ts honours this), or
    // reach the real service manager: with MESH_NO_SERVICE set, `launchctl`
    // is never run, "is the service registered?" is answered no, and anything
    // that would register, stop or remove it throws
    // (packages/cli/src/machine.ts). launchd registers an agent for the
    // logged-in user whatever HOME says, so a temporary HOME is not enough.
    env: { MESH_NO_NOTIFY: "1", MESH_NO_SERVICE: "1" },
  },
});
