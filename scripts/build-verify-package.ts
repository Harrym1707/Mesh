/**
 * Build the publishable @harrym1707/verify artifact into packages/verify/pkg:
 *   - index.js / index.cjs  (bundles; the needed @harrym1707/core sources inlined)
 *   - types/                (hand-rolled entry + copied core declarations)
 *   - bin/mesh-verify.mjs   (chain-verify + recompute an invoice from a spool)
 *   - LICENSE               (MIT — deliberately, see below)
 *   - package.json, README.md
 *
 * WHY THIS PACKAGE EXISTS: MESH's product is BUSL-1.1, but an honesty claim
 * you cannot independently check is worthless. The tools that CHECK MESH —
 * hash-chain verification and invoice recomputation — are published
 * separately under MIT so a customer (or a sceptic) can audit any MESH
 * number with no commercial terms attached. Zero dependencies, no network
 * access, no telemetry.
 *
 *   node --import tsx scripts/build-verify-package.ts
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);
const esbuild = require_(
  path.join(root, "node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild"),
) as typeof import("esbuild");

const verifyDir = path.join(root, "packages/verify");
const coreDist = path.join(root, "packages/core/dist/src");
const outDir = path.join(verifyDir, "pkg");
const entry = path.join(verifyDir, "src/index.ts");

if (!existsSync(coreDist)) {
  console.error(`Missing ${coreDist}; run ./node_modules/.bin/tsc -b first.`);
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(path.join(outDir, "types/core"), { recursive: true });
mkdirSync(path.join(outDir, "bin"), { recursive: true });

for (const format of ["esm", "cjs"] as const) {
  const outfile = path.join(outDir, format === "esm" ? "index.js" : "index.cjs");
  const result = esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    target: "node18",
    format,
    outfile,
    sourcemap: false,
    logLevel: "silent",
  });
  if (result.errors.length > 0) {
    console.error(`esbuild ${format} bundle failed:`, result.errors);
    process.exit(1);
  }
  const bundled = readFileSync(outfile, "utf8");
  // The verifier must stay auditable at a glance: no outbound calls, ever.
  if (/\bfetch\s*\(|node:http|node:https|node:net/.test(bundled)) {
    console.error(`SANITY FAILED: the ${format} verifier bundle contains network code.`);
    process.exit(1);
  }
  console.log(`bundled ${path.relative(root, outfile)}`);
}

// Types: copy the core declarations the entry re-exports from, plus their
// local imports, then a small hand-written entry mapping the public names.
let copied = 0;
for (const name of readdirSync(coreDist)) {
  if (!name.endsWith(".d.ts") || name.endsWith(".test.d.ts")) continue;
  copyFileSync(path.join(coreDist, name), path.join(outDir, "types/core", name));
  copied += 1;
}
console.log(`copied ${copied} core declaration file(s)`);
writeFileSync(path.join(outDir, "types/index.d.ts"), `export {
  LEDGER_GENESIS_HASH,
  auditEventPricing,
  chainLedgerRecord,
  ledgerEventHash,
  recomputeInvoice,
  verifyLedgerChain,
  type BillableEvent,
  type LedgerChainVerification,
  type LedgerRecord,
} from "./core/savings-ledger.js";
export { canonicalJson } from "./core/price-catalogue.js";
`, "utf8");

writeFileSync(path.join(outDir, "bin/mesh-verify.mjs"), `#!/usr/bin/env node
// Verify a MESH ledger spool and recompute its invoice — independently.
// Usage: mesh-verify <spool.jsonl>
// Exit 0: chain intact, invoice printed. Exit 1: broken chain or unreadable spool.
import { readFileSync } from "node:fs";
import { recomputeInvoice, verifyLedgerChain } from "../index.js";

const spoolPath = process.argv[2];
if (!spoolPath) {
  console.error("Usage: mesh-verify <spool.jsonl>   (a MESH ledger file, e.g. mesh-ledger/proxy-anthropic.jsonl)");
  process.exit(1);
}
let records;
try {
  records = readFileSync(spoolPath, "utf8").trim().split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line));
} catch (cause) {
  console.error(\`Could not read \${spoolPath}: \${cause.message}\`);
  process.exit(1);
}
const chain = verifyLedgerChain(records);
if (!chain.ok) {
  console.error(\`CHAIN BROKEN at seq \${chain.seq}: \${chain.reason}\`);
  console.error("This spool has been altered or corrupted since it was written. Do not pay an invoice computed from it.");
  process.exit(1);
}
console.log(\`chain verified: \${chain.length} record(s), every hash links\`);
const invoice = recomputeInvoice(records.map((record) => record.event));
console.log(JSON.stringify(invoice, null, 2));
console.log(\`\\nverdict: \${invoice.verdict} — net verified savings $\${invoice.netVerifiedSavingsUsd.toFixed(4)}\`);
console.log("If MESH quoted you a different number from this same file, MESH is wrong: this recomputation is the contract.");
`, "utf8");

writeFileSync(path.join(outDir, "LICENSE"), `MIT License

Copyright (c) 2026 Flux AI Technologies Limited

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`, "utf8");

writeFileSync(path.join(outDir, "README.md"), `# @harrym1707/verify

The verification half of [MESH](https://www.mesh-technology.com), under MIT.

MESH bills 1% of verified LLM API savings from an append-only, hash-chained
ledger that lives on the customer's own disk. An honesty claim you cannot
independently check is worthless — so the tools that CHECK MESH's numbers are
published here, separately, under MIT, with zero dependencies and no network
access. The MESH product itself is source-available under BUSL-1.1; this
package is not, on purpose.

\`\`\`bash
npx -y -p @harrym1707/verify mesh-verify mesh-ledger/proxy-anthropic.jsonl
\`\`\`

verifies every hash link in the spool and recomputes the invoice from its
events. If your recomputation disagrees with a number MESH quoted you, yours
wins — that is the contract.

Library use:

\`\`\`js
import { verifyLedgerChain, recomputeInvoice } from "@harrym1707/verify";
\`\`\`

Ledger format and methodology: https://www.mesh-technology.com/methodology.html
`, "utf8");

const manifest = {
  name: "@harrym1707/verify",
  version: "0.1.0",
  description: "Independently verify a MESH savings ledger: hash-chain verification and invoice recomputation, MIT-licensed, zero dependencies.",
  license: "MIT",
  type: "module",
  main: "./index.cjs",
  module: "./index.js",
  types: "./types/index.d.ts",
  exports: {
    ".": { types: "./types/index.d.ts", import: "./index.js", require: "./index.cjs" },
  },
  bin: { "mesh-verify": "bin/mesh-verify.mjs" },
  files: ["index.js", "index.cjs", "bin", "types", "README.md", "LICENSE"],
  engines: { node: ">=18" },
  repository: { type: "git", url: "git+https://github.com/Harrym1707/Mesh.git", directory: "packages/verify/pkg" },
  bugs: "https://github.com/Harrym1707/Mesh/issues",
  homepage: "https://www.mesh-technology.com",
  keywords: ["llm", "cost", "ledger", "verification", "anthropic", "openai", "mesh"],
};
writeFileSync(path.join(outDir, "package.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

console.log(`artifact ready at ${path.relative(root, outDir)}`);
