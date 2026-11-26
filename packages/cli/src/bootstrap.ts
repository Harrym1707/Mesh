/**
 * The MESH bootstrap — the small file you download.
 *
 * It keeps a verified copy of the runtime in ~/.mesh/runtime and runs it:
 *   - first run: fetch the runtime, check its sha256, cache it, run it
 *   - later runs: run the cached copy instantly; check for a newer version at
 *     most once a day and update silently in the background of a launch
 *   - offline: run the cached copy; a fresh machine with no network says so
 *
 * It contains none of the product's code — just this launcher — so the download
 * stays tiny and the runtime is fetched and verified, never shipped blind.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { exitLike, runForeground } from "./run-child.js";

const BASE = (process.env.MESH_BASE_URL ?? "https://www.mesh-technology.com").replace(/\/$/, "");
const DIR = join(homedir(), ".mesh", "runtime");
const RUNTIME = join(DIR, "mesh-runtime.mjs");
const VERSION_FILE = join(DIR, "version");
const SHA_FILE = join(DIR, "sha256");
const LAST_CHECK = join(DIR, ".last-check");
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

type Manifest = { version: string; sha256: string; runtime?: string };

function readText(path: string): string | null {
  try { return readFileSync(path, "utf8").trim(); } catch { return null; }
}
function checkedRecently(): boolean {
  const t = readText(LAST_CHECK);
  return t !== null && Date.now() - Number(t) < CHECK_INTERVAL_MS;
}
function stampCheck(): void { try { writeFileSync(LAST_CHECK, String(Date.now())); } catch { /* best effort */ } }

async function fetchManifest(ms: number): Promise<Manifest | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(`${BASE}/mesh-version.json`, { signal: ac.signal });
    if (!res.ok) return null;
    return (await res.json()) as Manifest;
  } catch { return null; } finally { clearTimeout(timer); }
}

async function ensureRuntime(): Promise<void> {
  mkdirSync(DIR, { recursive: true });
  const have = existsSync(RUNTIME) ? readText(VERSION_FILE) : null;

  // Fast path: a cached runtime we checked recently — run it, no network.
  if (have !== null && checkedRecently()) return;

  const manifest = await fetchManifest(have ? 2000 : 9000);
  if (manifest === null) {
    if (have !== null) return; // offline, but we have a runtime
    console.error(`MESH: couldn't reach ${BASE} to set up. Check your connection and try again.`);
    process.exit(1);
  }
  if (have === manifest.version) { stampCheck(); return; }

  const first = have === null;
  process.stderr.write(first ? "Setting up MESH (one-time)… " : "Updating MESH… ");
  let bytes: Buffer;
  try {
    const res = await fetch(`${BASE}/${manifest.runtime ?? "mesh-runtime"}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    bytes = Buffer.from(await res.arrayBuffer());
  } catch (error) {
    if (have !== null) { process.stderr.write("update skipped (offline)\n"); return; }
    process.stderr.write("failed\n");
    console.error(`MESH: couldn't download the runtime (${String(error)}).`);
    process.exit(1);
  }
  if (createHash("sha256").update(bytes).digest("hex") !== manifest.sha256) {
    process.stderr.write("failed\n");
    console.error("MESH: the downloaded runtime failed its checksum — refusing to run it. Try again.");
    process.exit(1);
  }
  writeFileSync(RUNTIME, bytes);
  writeFileSync(VERSION_FILE, manifest.version);
  writeFileSync(SHA_FILE, manifest.sha256); // so `mesh verify` can re-check the cached runtime
  stampCheck();
  process.stderr.write("ready.\n");
}

async function main(): Promise<void> {
  await ensureRuntime();
  // Run the cached runtime, telling it which file bootstrapped it so
  // `mesh install` can register the (self-updating) bootstrap with launchd.
  // Stay with it and pass stop signals on, so stopping `mesh` stops the runtime.
  const end = await runForeground(process.execPath, [RUNTIME, ...process.argv.slice(2)], {
    ...process.env,
    MESH_BOOTSTRAP_PATH: fileURLToPath(import.meta.url),
  });
  exitLike(end);
}

main().catch((error: unknown) => { console.error(String(error)); process.exit(1); });
