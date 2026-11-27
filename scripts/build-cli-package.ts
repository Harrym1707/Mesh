/**
 * Build the shippable MESH CLI as THREE artifacts:
 *
 *   pkg/mesh               the tiny bootstrap users download. Contains no
 *                          product code — it fetches, checksum-verifies, caches
 *                          and runs the runtime, and self-updates.
 *   pkg/mesh-runtime       the client runtime (proxy + reducer + ledger + Theo),
 *                          scoped: no `analyse`, so billing/router/observability
 *                          code never ships. Stamped with the git commit. It
 *                          carries the bootstrap's text, so an install that
 *                          updates its runtime gets the current bootstrap too.
 *   pkg/mesh-version.json  { version, sha256, runtime } — the update manifest
 *                          the bootstrap checks and verifies against.
 *
 * Hosting: /mesh = bootstrap, /mesh-runtime = runtime, /mesh-version.json.
 * npm: @harrym1707/mesh ships the self-contained runtime as its `mesh` bin (npm
 * handles versioning there, so no bootstrap/CDN dependency on that path).
 *
 * Nothing here contacts a registry; it smoke-tests the runtime by running
 * `mesh-runtime verify`.
 */
import { execSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);
const esbuild = require_(
  path.join(root, "node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild"),
) as typeof import("esbuild");

const cliDir = path.join(root, "packages/cli");
const outDir = path.join(cliDir, "pkg");

const commit = (() => {
  try { return execSync("git rev-parse --short HEAD", { cwd: root }).toString().trim(); }
  catch { return "unknown"; }
})();
const version = (() => {
  const pkg = require_(path.join(cliDir, "package.json")) as { version?: string };
  return pkg.version ?? "0.0.0";
})();

const BANNER = `#!/usr/bin/env node
import { createRequire as __cr } from "node:module";
const require = __cr(import.meta.url);`;

function bundle(entry: string, outfile: string, define: Record<string, string> = {}): void {
  const result = esbuild.buildSync({
    entryPoints: [path.join(cliDir, "src", entry)],
    bundle: true, platform: "node", format: "esm", target: "node22",
    outfile, banner: { js: BANNER }, define, logLevel: "warning",
  });
  if (result.errors.length > 0) { console.error(`esbuild failed on ${entry}`); process.exit(1); }
  chmodSync(outfile, 0o755);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// 1. The bootstrap (the tiny download). Built first because the runtime
//    carries its text: an update only ever replaces the runtime, so the runtime
//    is what brings an already-installed launcher up to date (launcher-renewal.ts).
const bootstrapFile = path.join(outDir, "mesh");
bundle("bootstrap.ts", bootstrapFile);
const bootstrapSource = readFileSync(bootstrapFile, "utf8");

// 2. The runtime (scoped client entry), stamped with the commit.
const runtimeFile = path.join(outDir, "mesh-runtime");
bundle("mesh-runtime.ts", runtimeFile, {
  __MESH_BUILD_COMMIT__: JSON.stringify(commit),
  __MESH_VERSION__: JSON.stringify(version),
  __MESH_BOOTSTRAP_SOURCE__: JSON.stringify(bootstrapSource),
});
const runtimeBytes = readFileSync(runtimeFile);
const runtimeSha = createHash("sha256").update(runtimeBytes).digest("hex");

// 3. The update manifest the bootstrap verifies against.
writeFileSync(
  path.join(outDir, "mesh-version.json"),
  `${JSON.stringify({ version: commit, sha256: runtimeSha, runtime: "mesh-runtime" }, null, 2)}\n`,
);

// npm manifest: ship the SELF-CONTAINED runtime as the `mesh` bin (npm versions
// it, so no CDN/bootstrap there). The website download is the bootstrap.
writeFileSync(path.join(outDir, "package.json"), `${JSON.stringify({
  name: "@harrym1707/mesh",
  version,
  description: "Cut your LLM bill, verified on your own usage. One command points Claude Code at MESH and runs Theo alongside you.",
  type: "module",
  bin: { mesh: "./mesh-runtime" },
  files: ["mesh-runtime", "README.md"],
  engines: { node: ">=22" },
  keywords: ["llm", "anthropic", "claude", "claude-code", "proxy", "cost", "tokens", "mesh"],
  license: "BUSL-1.1",
  homepage: "https://www.mesh-technology.com",
  repository: { type: "git", url: "git+https://github.com/Harrym1707/Mesh.git" },
}, null, 2)}\n`);

writeFileSync(path.join(outDir, "README.md"), `# mesh

Cut your LLM bill — verified on your own usage, never an estimate.

## Install

Download one small file (needs Node 22+); it fetches and verifies the runtime,
then keeps it up to date:

\`\`\`sh
curl -fsSL https://www.mesh-technology.com/mesh -o mesh && chmod +x mesh && ./mesh start
\`\`\`

…or with npm:

\`\`\`sh
npx @harrym1707/mesh start
\`\`\`

## Commands

\`\`\`sh
./mesh start      # proxy + point Claude Code at it + Theo; reverts on exit
./mesh install    # always-on background service (macOS)
./mesh status     # is it up, and what has Theo saved
./mesh verify     # re-prove the build, ledger chain, and invoice
\`\`\`

Your API key never leaves Claude Code. Build: ${commit}.
`);

// Smoke test: the runtime must run and pass its own self-checks.
const smoke = execSync(`node ${JSON.stringify(runtimeFile)} verify`, { cwd: root }).toString();
if (!smoke.includes("All checks passed")) {
  console.error("Smoke test FAILED — runtime did not pass `verify`:\n" + smoke);
  process.exit(1);
}

// The download must expose Theo's command: it is how a user answers a proposal.
const theoHelp = execSync(`node ${JSON.stringify(runtimeFile)} theo --help`, { cwd: root }).toString();
if (!theoHelp.includes("Usage: mesh theo") || !theoHelp.includes("--accept")) {
  console.error("Smoke test FAILED — runtime has no working `theo` command:\n" + theoHelp);
  process.exit(1);
}

// The download must expose the statement command: it is how a customer produces
// the figure for a billing period on their own machine.
const statementHelp = execSync(`node ${JSON.stringify(runtimeFile)} statement --help`, { cwd: root }).toString();
if (!statementHelp.includes("Usage: mesh statement") || !statementHelp.includes("--period")) {
  console.error("Smoke test FAILED — runtime has no working `statement` command:\n" + statementHelp);
  process.exit(1);
}

// An install that already exists must get this build's launcher: start the
// runtime the way an older launcher would, from an install folder in an empty
// home, and the launcher file there must come out identical to the one built.
{
  const home = mkdtempSync(path.join(tmpdir(), "mesh-build-launcher-"));
  const installed = path.join(home, ".mesh", "bin", "mesh");
  mkdirSync(path.dirname(installed), { recursive: true });
  writeFileSync(installed, "#!/usr/bin/env node\n// an older launcher\n", { mode: 0o755 });
  execSync(`node ${JSON.stringify(runtimeFile)} version`, {
    cwd: root,
    // The home folder comes from HOME on macOS and Linux, USERPROFILE on Windows.
    env: { ...process.env, HOME: home, USERPROFILE: home, MESH_BOOTSTRAP_PATH: installed },
  });
  // Windows has no executable bit to check.
  const executable = process.platform === "win32" || (statSync(installed).mode & 0o111) !== 0;
  const renewed = readFileSync(installed, "utf8") === bootstrapSource && executable;
  rmSync(home, { recursive: true, force: true });
  if (!renewed) {
    console.error("Smoke test FAILED — the runtime did not renew an older installed launcher.");
    process.exit(1);
  }
}

const kb = (n: number): string => `${(n / 1024).toFixed(0)}KB`;
console.log(`built CLI artifacts  (build ${commit}, v${version})`);
console.log(`  mesh (bootstrap)   ${kb(readFileSync(bootstrapFile).length)}  → the download`);
console.log(`  mesh-runtime       ${kb(runtimeBytes.length)}  sha256 ${runtimeSha.slice(0, 12)}…`);
console.log(`  mesh-version.json  update manifest`);
console.log(`  smoke test: mesh-runtime verify — All checks passed`);
console.log(`  smoke test: mesh-runtime theo --help — command present`);
console.log(`  smoke test: mesh-runtime statement --help — command present`);
console.log(`  smoke test: an older installed launcher is renewed by the runtime`);
console.log(`  publish npm with:  (cd ${path.relative(root, outDir)} && npm publish --access public)`);
