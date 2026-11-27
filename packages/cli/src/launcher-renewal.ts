/**
 * Keeping the launcher (`~/.mesh/bin/mesh`) in step with the runtime.
 *
 * An install has two files: the small launcher the user downloaded and the
 * runtime it fetches. Updates only ever replaced the runtime, so a fix made in
 * the launcher never reached anyone who had already installed: found on
 * 2026-11-26, when an install updated to 0.2.6 still ran the 0.2.5 launcher
 * and so still left the runtime running after `kill`.
 *
 * The launcher cannot fix itself (the ones already out there do not know how),
 * but every launcher does two things this relies on: it downloads the new
 * runtime, and it tells the runtime which file started it
 * (MESH_BOOTSTRAP_PATH). So each runtime carries the text of the launcher it
 * was built with and, when it starts, replaces an out-of-date launcher with it.
 * No network is involved: the launcher text arrives inside the runtime, which
 * the launcher has already checked against its published checksum.
 *
 * Only the installed launcher is touched: the file must be exactly
 * `~/.mesh/bin/mesh` and must already be the file that started this runtime.
 * A launcher saved anywhere else, an npm install, and a developer run are left
 * alone. The write is a rename over the old file, so a running launcher keeps
 * working and a failure part-way leaves the old launcher in place.
 */
import { chmodSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

declare const __MESH_BOOTSTRAP_SOURCE__: string | undefined;

/** The launcher this runtime was built with; undefined outside a packaged build. */
export function embeddedLauncher(): string | undefined {
  return typeof __MESH_BOOTSTRAP_SOURCE__ === "string" && __MESH_BOOTSTRAP_SOURCE__.length > 0
    ? __MESH_BOOTSTRAP_SOURCE__
    : undefined;
}

export type LauncherRenewal =
  /** The installed launcher was out of date and has been replaced. */
  | "renewed"
  /** The installed launcher already matches this runtime. */
  | "current"
  /** Nothing to do here: not a packaged build, or not started by the installed launcher. */
  | "not-applicable"
  /** The launcher is out of date but could not be replaced; the old one stays. */
  | "failed";

function sameFile(a: string, b: string): boolean {
  try { return realpathSync(a) === realpathSync(b); } catch { return false; }
}

/**
 * Replace the installed launcher with `source` if it differs. Never throws.
 * `startedBy` is the file the launcher says it is (MESH_BOOTSTRAP_PATH).
 */
export function renewLauncher(options: {
  source: string | undefined;
  startedBy: string | undefined;
  installedPath?: string;
  pid?: number;
}): LauncherRenewal {
  const installedPath = options.installedPath ?? join(homedir(), ".mesh", "bin", "mesh");
  if (options.source === undefined || options.startedBy === undefined || options.startedBy === "") {
    return "not-applicable";
  }
  if (!sameFile(options.startedBy, installedPath)) return "not-applicable";
  let current: string;
  try { current = readFileSync(installedPath, "utf8"); } catch { return "not-applicable"; }
  if (current === options.source) return "current";

  const temporary = join(dirname(installedPath), `.mesh-launcher-${options.pid ?? process.pid}.tmp`);
  try {
    writeFileSync(temporary, options.source, { mode: 0o755 });
    chmodSync(temporary, 0o755); // the mode option is subject to umask
    renameSync(temporary, installedPath);
    return "renewed";
  } catch {
    try { rmSync(temporary, { force: true }); } catch { /* nothing to clean */ }
    return "failed";
  }
}

/** What the runtime does on every start. */
export function renewInstalledLauncher(): LauncherRenewal {
  return renewLauncher({ source: embeddedLauncher(), startedBy: process.env.MESH_BOOTSTRAP_PATH });
}
