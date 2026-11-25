/**
 * `mesh update` — force a runtime refresh now (instead of waiting for the
 * bootstrap's daily check), with a one-step rollback.
 *
 *   mesh update              fetch the manifest, and if newer, download +
 *                            checksum-verify the runtime, keeping the current
 *                            one as a backup, then swap it in
 *   mesh update --rollback   restore the previous runtime
 *
 * It verifies the sha256 against the manifest before swapping (release-signature
 * verification is added in the signing track). It never overwrites a working
 * runtime until the replacement has passed its checksum.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = (process.env.MESH_BASE_URL ?? "https://www.mesh-technology.com").replace(/\/$/, "");
const DIR = join(homedir(), ".mesh", "runtime");
const RUNTIME = join(DIR, "mesh-runtime.mjs");
const VERSION_FILE = join(DIR, "version");
const SHA_FILE = join(DIR, "sha256");
const BACKUP = join(DIR, "mesh-runtime.previous.mjs");
const BACKUP_VERSION = join(DIR, "version.previous");
const BACKUP_SHA = join(DIR, "sha256.previous");

type Manifest = { version: string; sha256: string; runtime?: string };

function read(path: string): string | null {
  try { return readFileSync(path, "utf8").trim(); } catch { return null; }
}

/**
 * For the always-on daemon: fetch the manifest and, if a newer runtime is
 * published, download + checksum-verify it and swap it in (keeping a rollback
 * copy), exactly as `mesh update` does — but with no printing and no exit.
 * Returns the new version when it swapped the runtime, else null (already
 * current, unreachable, or a failed checksum — never a partial/unsafe write).
 * The daemon then restarts so launchd relaunches it on the new runtime.
 */
export async function pullNewerRuntime(): Promise<string | null> {
  mkdirSync(DIR, { recursive: true });
  const have = existsSync(VERSION_FILE) ? read(VERSION_FILE) : null;
  let manifest: Manifest;
  try {
    const res = await fetch(`${BASE}/mesh-version.json`);
    if (!res.ok) return null;
    manifest = (await res.json()) as Manifest;
  } catch { return null; }
  if (have === manifest.version) return null;

  let bytes: Buffer;
  try {
    const res = await fetch(`${BASE}/${manifest.runtime ?? "mesh-runtime"}`);
    if (!res.ok) return null;
    bytes = Buffer.from(await res.arrayBuffer());
  } catch { return null; }
  // Never install a runtime whose bytes don't match the published checksum.
  if (createHash("sha256").update(bytes).digest("hex") !== manifest.sha256) return null;

  if (existsSync(RUNTIME)) {
    copyFileSync(RUNTIME, BACKUP);
    if (have !== null) writeFileSync(BACKUP_VERSION, have);
    if (existsSync(SHA_FILE)) copyFileSync(SHA_FILE, BACKUP_SHA);
  }
  writeFileSync(RUNTIME, bytes);
  writeFileSync(VERSION_FILE, manifest.version);
  writeFileSync(SHA_FILE, manifest.sha256);
  return manifest.version;
}

function rollback(): void {
  if (!existsSync(BACKUP)) {
    console.error("No previous runtime to roll back to.");
    process.exit(1);
  }
  copyFileSync(BACKUP, RUNTIME);
  const prev = read(BACKUP_VERSION) ?? "previous";
  writeFileSync(VERSION_FILE, prev);
  if (existsSync(BACKUP_SHA)) copyFileSync(BACKUP_SHA, SHA_FILE);
  console.log(`Rolled back to ${prev}.`);
}

export async function runUpdate(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(
      "Usage: mesh update [--rollback]\n\n" +
      "  Check for a newer runtime now and, if there is one, download it, verify its\n" +
      "  checksum and switch to it, keeping the current one as a rollback point.\n\n" +
      "  --rollback   Go back to the previous runtime.\n" +
      "  --help       Show this message. Checks nothing and changes nothing.",
    );
    return;
  }
  if (argv.includes("--rollback")) { rollback(); return; }

  mkdirSync(DIR, { recursive: true });
  const have = existsSync(VERSION_FILE) ? read(VERSION_FILE) : null;

  let manifest: Manifest;
  try {
    const res = await fetch(`${BASE}/mesh-version.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    manifest = (await res.json()) as Manifest;
  } catch (error) {
    console.error(`Couldn't reach ${BASE} to check for updates (${String(error)}).`);
    process.exit(1);
  }

  if (have === manifest.version) { console.log(`Already up to date (${have}).`); return; }

  process.stdout.write(`Updating ${have ?? "(none)"} → ${manifest.version}… `);
  let bytes: Buffer;
  try {
    const res = await fetch(`${BASE}/${manifest.runtime ?? "mesh-runtime"}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    bytes = Buffer.from(await res.arrayBuffer());
  } catch (error) {
    console.log("failed");
    console.error(String(error));
    process.exit(1);
  }
  if (createHash("sha256").update(bytes).digest("hex") !== manifest.sha256) {
    console.log("failed");
    console.error("The downloaded runtime failed its checksum — refusing to install it.");
    process.exit(1);
  }

  // Keep the current runtime as a rollback point, then swap atomically-enough.
  if (existsSync(RUNTIME)) {
    copyFileSync(RUNTIME, BACKUP);
    if (have !== null) writeFileSync(BACKUP_VERSION, have);
    if (existsSync(SHA_FILE)) copyFileSync(SHA_FILE, BACKUP_SHA);
  }
  writeFileSync(RUNTIME, bytes);
  writeFileSync(VERSION_FILE, manifest.version);
  writeFileSync(SHA_FILE, manifest.sha256); // so `mesh verify` can re-check the cached runtime
  console.log("done.");
  console.log(`Now on ${manifest.version}. Roll back with: mesh update --rollback`);
}
