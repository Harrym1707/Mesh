import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { startMeshProxy } from "../packages/sdk-js/src/proxy.js";
import { formatSavingsCta, savingsBadge } from "../packages/sdk-js/src/cta.js";
import { savingsSnapshotFromSpoolDir } from "../packages/sdk-js/src/savings-snapshot.js";

/**
 * Boot the MESH proxy locally. An application then needs ONE config change:
 * point its base_url here. Its own API key passes through untouched; MESH
 * holds no credentials, prompts never leave the machine, and every request
 * appends one hash-chained ledger event under the spool directory.
 *
 *   MESH_PROXY_PORT        port to listen on (default 8787)
 *   MESH_PROXY_LEDGER_DIR  spool directory (default ./mesh-ledger)
 *   MESH_PROXY_CACHE_TTL   "5m" | "1h" to enable the Anthropic cache stamp
 *
 * Reduction is lossless-only by default (schema compaction, duplicate
 * removal, prefix repair). Lossy levers stay off until a replay gate approves
 * them on recorded traffic, exactly as in the SDK.
 */

const port = Number(process.env.MESH_PROXY_PORT ?? 8787);
const ledgerDirectory = process.env.MESH_PROXY_LEDGER_DIR ?? join(process.cwd(), "mesh-ledger");
mkdirSync(ledgerDirectory, { recursive: true });

const cacheTtl = process.env.MESH_PROXY_CACHE_TTL;
if (cacheTtl !== undefined && cacheTtl !== "5m" && cacheTtl !== "1h") {
  throw new Error(`MESH_PROXY_CACHE_TTL must be "5m" or "1h", got ${JSON.stringify(cacheTtl)}.`);
}

// The provably-blind learning stream. Set MESH_PROXY_BLIND_KEY to a stable
// secret so features correlate across restarts and conversations; otherwise a
// per-boot key is generated (features are still blind, just not comparable
// across restarts). The key must live only in the gateway — in production,
// sealed inside the enclave.
const blindKeyFromEnv = process.env.MESH_PROXY_BLIND_KEY;
const generatedBlindKey = blindKeyFromEnv === undefined || blindKeyFromEnv.trim() === "";
const blindFeaturesKey = generatedBlindKey ? randomBytes(32).toString("hex") : blindKeyFromEnv!.trim();

const proxy = await startMeshProxy({
  port,
  ledgerDirectory,
  blindFeaturesKey,
  tokenReduction: {
    toolSchemas: true,
    duplicateContext: true,
    repairCachePrefix: true,
    ...(cacheTtl === undefined ? {} : { cacheTtl }),
  },
});

console.log(`MESH proxy listening on ${proxy.url}`);
console.log(`Ledger spools: ${ledgerDirectory} (one hash-chained JSONL per app + provider)`);
console.log(`Blind learning stream: ${ledgerDirectory}/<app>-<provider>.features.jsonl ` +
  `(irreversible keyed hashes + counts, NO prompt content)` +
  (generatedBlindKey ? " — per-boot key; set MESH_PROXY_BLIND_KEY for a stable one" : ""));
console.log("");
console.log("Point a client here, keeping its own key:");
console.log(`  Anthropic SDK:  new Anthropic({ baseURL: "${proxy.url}" })`);
console.log(`  OpenAI SDK:     new OpenAI({ baseURL: "${proxy.url}/v1" })`);
console.log(`  curl:           ${proxy.url}/v1/messages | /v1/responses | /v1/chat/completions`);
console.log("");
console.log("Optional header X-Mesh-Application names the app on the invoice.");
console.log("Ctrl-C to stop.");

// On exit, print the verified savings for this session straight from the
// spool, then invite the signup. The number is honest: a do_not_charge verdict
// asks for nothing, and a broken chain is withheld.
let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const snap = savingsSnapshotFromSpoolDir(ledgerDirectory);
  console.log("");
  console.log(formatSavingsCta(snap));
  if (snap.chainOk && snap.verdict === "charge" && snap.savedUsd > 0) {
    console.log("Show it off — paste this into your README:");
    console.log(`  ${savingsBadge(snap).markdown}`);
    console.log("");
  }
  await proxy.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
