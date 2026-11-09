/**
 * Always-on mode: run MESH as a background service so Claude Code is optimised
 * every time, with nothing to start by hand.
 *
 *   mesh install     copy the binary somewhere stable, write a launchd agent
 *                    that runs `mesh serve`, point Claude Code at it (persistent)
 *   mesh uninstall   stop + remove the agent, restore Claude Code
 *   mesh status      is the service up? what has Theo saved so far?
 *
 * macOS (launchd) for now; on other platforms it tells you to use `mesh start`.
 */
import { connect } from "node:net";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";

import { BUILD_COMMIT, CLAUDE_SETTINGS, DEFAULT_PORT, MESH_HOME, readPolicy, summariseLedger } from "./start.js";
import { policyCoverage } from "../../sdk-js/src/theo-policy.js";
import { MESH_SIGNUP_URL } from "../../sdk-js/src/cta.js";

const LABEL = "dev.meshtoken.mesh";
const PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const DAEMON_LOG = join(MESH_HOME, "daemon.log");
const STABLE_BIN = join(MESH_HOME, "bin", "mesh");
const DEFAULT_LEDGER = join(MESH_HOME, "ledger");

function requireMac(action: string): void {
  if (platform() !== "darwin") {
    console.error(`\`mesh ${action}\` uses macOS launchd and isn't wired for this platform yet.`);
    console.error(`Use \`mesh start\` instead — it does the same thing while it's running.`);
    process.exit(1);
  }
}

function parsePort(argv: string[]): number {
  const i = argv.indexOf("--port");
  if (i >= 0 && argv[i + 1]) {
    const n = Number.parseInt(argv[i + 1]!, 10);
    if (Number.isInteger(n) && n > 0 && n < 65536) return n;
    throw new Error("--port must be 1-65535.");
  }
  return DEFAULT_PORT;
}

function launchctl(...args: string[]): void {
  try { execFileSync("launchctl", args, { stdio: "pipe" }); } catch { /* idempotent: ignore */ }
}

function isLoaded(): boolean {
  try { execFileSync("launchctl", ["list", LABEL], { stdio: "pipe" }); return true; } catch { return false; }
}

/** Resolve whether the local proxy is actually accepting connections. */
function portUp(port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((res) => {
    const sock = connect({ host: "127.0.0.1", port });
    const done = (ok: boolean): void => { sock.destroy(); res(ok); };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

function setClaudeBaseUrl(url: string): void {
  mkdirSync(dirname(CLAUDE_SETTINGS), { recursive: true });
  let settings: Record<string, unknown> = {};
  if (existsSync(CLAUDE_SETTINGS)) {
    try { settings = JSON.parse(readFileSync(CLAUDE_SETTINGS, "utf8")) as Record<string, unknown>; }
    catch { throw new Error("~/.claude/settings.json isn't valid JSON — fix it first; MESH won't overwrite it."); }
  }
  const env = { ...((settings.env as Record<string, string>) ?? {}), ANTHROPIC_BASE_URL: url };
  writeFileSync(CLAUDE_SETTINGS, `${JSON.stringify({ ...settings, env }, null, 2)}\n`);
}

function clearClaudeBaseUrl(): void {
  if (!existsSync(CLAUDE_SETTINGS)) return;
  try {
    const settings = JSON.parse(readFileSync(CLAUDE_SETTINGS, "utf8")) as Record<string, unknown>;
    const env = { ...((settings.env as Record<string, string>) ?? {}) };
    delete env.ANTHROPIC_BASE_URL;
    const next: Record<string, unknown> = { ...settings, env };
    if (Object.keys(env).length === 0) delete next.env;
    writeFileSync(CLAUDE_SETTINGS, `${JSON.stringify(next, null, 2)}\n`);
  } catch { /* leave it */ }
}

/** Forward Theo-related flags from `mesh install` into the daemon's `mesh serve`
 * command, so the always-on service runs Theo as the user asked. A --capture path
 * is resolved to absolute (the daemon runs from a different working directory). */
function theoServeArgs(argv: string[]): string[] {
  const out: string[] = [];
  const takePath = (flag: string): void => {
    const i = argv.indexOf(flag);
    if (i >= 0 && argv[i + 1]) out.push(flag, resolve(argv[i + 1]!));
  };
  const takeValue = (flag: string): void => {
    const i = argv.indexOf(flag);
    if (i >= 0 && argv[i + 1]) out.push(flag, argv[i + 1]!);
  };
  takePath("--capture");
  takeValue("--autonomy");
  takeValue("--theo-interval");
  takeValue("--theo-provider-url");
  if (argv.includes("--no-theo")) out.push("--no-theo");
  return out;
}

function writePlist(port: number, extraServeArgs: string[] = []): void {
  const argv = [process.execPath, STABLE_BIN, "serve", "--port", String(port), "--ledger", DEFAULT_LEDGER, ...extraServeArgs];
  const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const argXml = argv.map((a) => `      <string>${esc(a)}</string>`).join("\n");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${esc(DAEMON_LOG)}</string>
  <key>StandardErrorPath</key><string>${esc(DAEMON_LOG)}</string>
</dict>
</plist>
`;
  mkdirSync(dirname(PLIST), { recursive: true });
  writeFileSync(PLIST, plist);
}

export async function runInstall(argv: string[]): Promise<void> {
  requireMac("install");
  const port = parsePort(argv);
  mkdirSync(join(MESH_HOME, "bin"), { recursive: true });
  mkdirSync(DEFAULT_LEDGER, { recursive: true });

  // Register the self-updating bootstrap (not the runtime) with launchd, copied
  // to a stable home so moving the download can't break the service. The
  // bootstrap sets MESH_BOOTSTRAP_PATH before running us; fall back to argv[1].
  const self = resolve(process.env.MESH_BOOTSTRAP_PATH ?? process.argv[1] ?? "");
  if (self !== STABLE_BIN) copyFileSync(self, STABLE_BIN);
  chmodSync(STABLE_BIN, 0o755);

  if (isLoaded()) launchctl("unload", PLIST);
  writePlist(port, theoServeArgs(argv));
  launchctl("load", "-w", PLIST);
  setClaudeBaseUrl(`http://127.0.0.1:${port}`);

  // Confirm it actually came up.
  let up = false;
  for (let i = 0; i < 10 && !up; i += 1) { up = await portUp(port); if (!up) await sleep(400); }

  console.log("");
  if (up) {
    console.log(`  ⬢ theo — MESH is now always on.  build ${BUILD_COMMIT}`);
    console.log(`  service  launchd ${LABEL} (starts at login, restarts if it stops)`);
    console.log(`  proxy    http://127.0.0.1:${port}  ·  ledger ${DEFAULT_LEDGER}`);
    console.log(`  claude   pointed at MESH permanently via ~/.claude/settings.json`);
    console.log(`  log      ${DAEMON_LOG}`);
    console.log("");
    console.log(`  Just use Claude Code — every session is optimised. Check savings with: mesh status`);
    console.log(`  Turn it off any time with: mesh uninstall`);
  } else {
    console.log(`  ⚠ The service was installed but the proxy didn't answer on port ${port}.`);
    console.log(`  Check ${DAEMON_LOG}, then re-run \`mesh install\`, or use \`mesh start\` instead.`);
    process.exitCode = 1;
  }
  console.log("");
}

export function runUninstall(_argv: string[]): void {
  requireMac("uninstall");
  launchctl("unload", "-w", PLIST);
  rmSync(PLIST, { force: true });
  clearClaudeBaseUrl();
  console.log("");
  console.log(`  ⬢ theo — always-on removed. The service is stopped and Claude Code is back to normal.`);
  console.log(`  Your ledger is kept at ${DEFAULT_LEDGER} — recompute any time with: mesh verify`);
  console.log("");
}

/** Stop the background service without removing it. Claude Code reverts to
 *  normal; the service definition stays so `mesh install` resumes it. */
export function runStop(_argv: string[]): void {
  requireMac("stop");
  if (!isLoaded()) {
    console.log("");
    console.log(`  No MESH background service is running.`);
    console.log(`  (A foreground \`mesh start\` is stopped with Ctrl+C.)`);
    console.log("");
    return;
  }
  launchctl("unload", "-w", PLIST);
  clearClaudeBaseUrl();
  console.log("");
  console.log(`  ⬢ theo — MESH service stopped. Claude Code is back to normal.`);
  console.log(`  The service is kept — resume always-on any time with: mesh install`);
  console.log(`  Your ledger is untouched.`);
  console.log("");
}

export async function runStatus(_argv: string[]): Promise<void> {
  const loaded = platform() === "darwin" ? isLoaded() : false;
  const port = DEFAULT_PORT;
  const up = await portUp(port);
  const s = summariseLedger(DEFAULT_LEDGER);
  console.log("");
  console.log(`  mesh status — build ${BUILD_COMMIT}`);
  console.log(`  service   ${loaded ? "installed (launchd)" : "not installed"}`);
  console.log(`  proxy     ${up ? `up on http://127.0.0.1:${port}` : "not responding"}`);
  if (s.events > 0) {
    console.log(`  ⬢ theo    ${s.events} requests seen · $${s.savedUsd.toFixed(4)} verified saved (${s.verdict})`);
  } else {
    console.log(`  ⬢ theo    no traffic yet — use Claude Code and check back`);
  }
  if (s.chainOk && s.verdict === "charge" && s.savedUsd > 0) {
    console.log(`  claim     keep these savings metered → ${MESH_SIGNUP_URL}`);
  }
  const cov = policyCoverage(readPolicy());
  console.log(
    `  coverage  live on ${cov.activeCount}/${cov.enforceableCount} enforceable levers ` +
    `(${cov.activeCoveragePercent.toFixed(0)}%)` +
    `${cov.heldCount ? ` · ${cov.heldCount} held for proof` : ""}` +
    `${cov.availableCount ? ` · ${cov.availableCount} not yet adopted` : ""}`,
  );
  if (!up && loaded) console.log(`  note      service is registered but the proxy is down; see ${DAEMON_LOG}`);
  console.log("");
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
