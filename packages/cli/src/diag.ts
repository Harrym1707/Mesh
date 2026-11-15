/**
 * `mesh version` and `mesh doctor` — the "is this installed and healthy?"
 * commands every professional CLI has.
 *
 *   version  build + runtime identity, machine-readable with --json
 *   doctor   environment diagnostics: Node version, the proxy, Claude Code
 *            wiring, the background service, and the ledger — each ✓ / ⚠ / ✗
 *            with a one-line fix. Exits non-zero if any check is a hard failure.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir, platform } from "node:os";
import { join } from "node:path";

import { BUILD_COMMIT, CLAUDE_SETTINGS, DEFAULT_PORT, MESH_HOME, WIRING_STATE, summariseLedger } from "./start.js";
import { checkWiring, repairWiring } from "./claude-wiring.js";

const WIRING_PATHS = { settingsPath: CLAUDE_SETTINGS, statePath: WIRING_STATE };

declare const __MESH_VERSION__: string | undefined;
const VERSION = typeof __MESH_VERSION__ !== "undefined" ? __MESH_VERSION__ : (process.env.MESH_VERSION ?? "0.0.0");
const LAUNCHD_LABEL = "dev.meshtoken.mesh";

const nodeMajor = (): number => Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);

function portUp(port: number, timeoutMs = 700): Promise<boolean> {
  return new Promise((res) => {
    const sock = connect({ host: "127.0.0.1", port });
    const done = (ok: boolean): void => { sock.destroy(); res(ok); };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

function serviceLoaded(): boolean {
  if (platform() !== "darwin") return false;
  try { execFileSync("launchctl", ["list", LAUNCHD_LABEL], { stdio: "pipe" }); return true; } catch { return false; }
}

export function runVersion(argv: string[]): void {
  const info = { version: VERSION, build: BUILD_COMMIT, node: process.versions.node, platform: `${platform()}-${process.arch}` };
  if (argv.includes("--json")) { console.log(JSON.stringify(info)); return; }
  console.log(`mesh ${info.version} (build ${info.build}) · node ${info.node} · ${info.platform}`);
}

type Check = { ok: boolean; warn?: boolean; name: string; detail: string; fix?: string };

export async function runDoctor(argv: string[]): Promise<void> {
  const checks: Check[] = [];
  const port = DEFAULT_PORT;

  // 1. Node runtime — the runtime is built for Node 22 (esbuild target node22),
  // so anything older is a hard failure, matching the installer's floor.
  const nodeOk = nodeMajor() >= 22;
  checks.push({
    ok: nodeOk,
    name: "node", detail: `v${process.versions.node}${nodeOk ? "" : " (Node 22 LTS required)"}`,
    fix: nodeOk ? undefined : "Upgrade to Node 22 LTS: https://nodejs.org",
  });

  // 2. Installed runtime cache
  const runtimeVersion = existsSync(join(MESH_HOME, "runtime", "version"))
    ? readFileSync(join(MESH_HOME, "runtime", "version"), "utf8").trim() : null;
  checks.push({
    ok: true, name: "runtime", detail: runtimeVersion ? `cached ${runtimeVersion}` : "running in place (no fetched runtime cached yet)",
  });

  // 3. Proxy reachable
  const up = await portUp(port);
  checks.push({ ok: true, warn: !up, name: "proxy", detail: up ? `up on 127.0.0.1:${port}` : `not running on :${port}`, fix: up ? undefined : "Start it with: mesh start" });

  // 4. Claude Code wiring. A base URL that points at a proxy which is no longer
  // running breaks Claude Code outright, so that is a hard failure with a fix.
  const wiring = await checkWiring(WIRING_PATHS, { portUp });
  const wiringBroken = wiring.status === "stranded" || wiring.status === "dead-local";
  checks.push({
    ok: wiring.status === "ok",
    name: "claude",
    detail: wiring.detail,
    fix: wiring.status === "ok"
      ? undefined
      : wiringBroken
        ? "Claude Code cannot reach its API like this. Put it back with: mesh restore   (or bring the proxy up: mesh start)"
        : "Fix or remove ~/.claude/settings.json; MESH won't overwrite invalid JSON.",
  });

  // 5. Background service (macOS)
  if (platform() === "darwin") {
    const loaded = serviceLoaded();
    checks.push({ ok: true, name: "service", detail: loaded ? "launchd service installed (always-on)" : "not installed (foreground only)" });
  }

  // 6. Ledger health
  const s = summariseLedger(join(MESH_HOME, "ledger"));
  checks.push({
    ok: s.chainOk, name: "ledger",
    detail: s.events === 0 ? "no ledger yet" : `${s.events} records${s.chainOk ? ", chain verified" : `, CHAIN BROKEN at ${s.brokenAt}`}`,
    fix: s.chainOk ? undefined : "Run `mesh verify` and report this — the ledger should never break.",
  });

  if (argv.includes("--json")) { console.log(JSON.stringify({ checks })); return; }
  console.log("");
  console.log(`  mesh doctor — build ${BUILD_COMMIT}`);
  console.log("");
  let hardFail = false;
  for (const c of checks) {
    hardFail = hardFail || !c.ok;
    const mark = !c.ok ? "✗" : c.warn ? "⚠" : "✓";
    console.log(`  ${mark} ${c.name.padEnd(9)} ${c.detail}`);
    if (c.fix) console.log(`              ↳ ${c.fix}`);
  }
  console.log("");
  console.log(hardFail ? "  Some checks failed — see above." : "  Looks healthy.");
  if (hardFail) process.exitCode = 1;
}

/**
 * `mesh restore` — put Claude Code back the way it was before MESH pointed it at
 * a proxy that is no longer running. For the cases no shutdown handler can
 * cover: a hard kill, a crash of the machine, a session from an older build.
 * Changes nothing when Claude Code's configuration is working.
 */
export async function runRestore(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(
      "Usage: mesh restore\n\n" +
      "  If Claude Code is still pointed at a MESH proxy that is no longer running\n" +
      "  (the session was killed, or the machine went down), put its settings back\n" +
      "  to what they were before. Does nothing if the configuration is working.",
    );
    return;
  }
  const health = await checkWiring(WIRING_PATHS, { portUp });
  if (health.status === "dead-local" && platform() === "darwin" && serviceLoaded()) {
    // The always-on service owns this address and launchd restarts it; removing
    // the address would silently turn MESH off.
    console.log(
      "The background service is installed but not answering right now. " +
      "Restart it with: mesh install   (or remove it: mesh uninstall)",
    );
    return;
  }
  const result = await repairWiring(WIRING_PATHS, { portUp });
  console.log(result.message);
  if (result.changed) console.log("Open a new Claude Code session for it to take effect.");
}
