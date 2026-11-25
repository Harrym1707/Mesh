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
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { dirname, join, resolve } from "node:path";

import { BUILD_COMMIT, CLAUDE_SETTINGS, DEFAULT_PORT, MESH_HOME, WIRING_STATE, readPolicy, summariseLedger, type LedgerSummary } from "./start.js";
import { policyCoverage, type LeverStandState, type PolicyCoverage, type TheoLeverClass } from "../../sdk-js/src/theo-policy.js";
import { defaultTheoMemoryPath, loadTheoMemory } from "../../sdk-js/src/theo-agent-store.js";
import type { TheoAutonomyLevel } from "../../sdk-js/src/theo-agent.js";
import { MESH_SIGNUP_URL } from "../../sdk-js/src/cta.js";
import type { VerdictReasonCode } from "./bill-verdict.js";
import { loopbackPort } from "./claude-wiring.js";
import { detectFlow, flowLines, type Flow } from "./flow.js";
import { CliError, meshIdentity, parseFlags, parsePortFlag, writeJson, type MeshIdentity } from "./json-output.js";
import {
  claudeCodeStatus,
  LAUNCHD_LABEL as LABEL,
  LAUNCHD_PLIST as PLIST,
  portOpen as portUp,
  probeProxy,
  proxyUrls,
  resolvePort,
  serviceDisabledError,
  serviceLoaded,
  serviceManagerDisabled,
  systemServiceRunner,
  type ClaudeCodeState,
  type ClaudeCodeStatus,
  type PortSource,
  type ServiceRunner,
} from "./machine.js";

// Worked out in machine.ts, so `mesh start` can ask the same question without importing this module.
export type { ClaudeCodeState, ClaudeCodeStatus };

const DAEMON_LOG = join(MESH_HOME, "daemon.log");
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

// ---------------------------------------------------------------------------
// The always-on service: one implementation, used by `mesh install`,
// `mesh stop`, `mesh uninstall` and `mesh setup`.
//
// Every file it writes and every `launchctl` call is reachable through
// `ServiceTarget`, so a test (and `mesh setup`'s tests) can run the whole
// path against temporary files and a fake service manager. The defaults are
// this user's own ~/.mesh, ~/.claude and ~/Library/LaunchAgents, and the real
// `launchctl`.
// ---------------------------------------------------------------------------

/** Where the service's files live and who registers it. Every field has the real default. */
export type ServiceTarget = {
  /** Default ~/.mesh. The launcher copy, the ledger and the service log are under it. */
  meshHome?: string;
  /** Default ~/Library/LaunchAgents/dev.meshtoken.mesh.plist. */
  plistPath?: string;
  /** Default ~/.claude/settings.json. */
  claudeSettingsPath?: string;
  /** Default: the real `launchctl`. */
  runner?: ServiceRunner;
};

type ResolvedTarget = {
  meshHome: string;
  plistPath: string;
  claudeSettingsPath: string;
  runner: ServiceRunner;
  stableBin: string;
  ledgerDir: string;
  daemonLog: string;
};

/**
 * For the three calls that change the machine. With MESH_NO_SERVICE set, the
 * real service manager is refused before a single file is written.
 */
function resolveForChange(target: ServiceTarget = {}): ResolvedTarget {
  const resolved = resolveTarget(target);
  if (resolved.runner === systemServiceRunner && serviceManagerDisabled()) throw serviceDisabledError();
  return resolved;
}

function resolveTarget(target: ServiceTarget = {}): ResolvedTarget {
  const meshHome = target.meshHome ?? MESH_HOME;
  return {
    meshHome,
    plistPath: target.plistPath ?? PLIST,
    claudeSettingsPath: target.claudeSettingsPath ?? CLAUDE_SETTINGS,
    runner: target.runner ?? systemServiceRunner,
    stableBin: join(meshHome, "bin", "mesh"),
    ledgerDir: join(meshHome, "ledger"),
    daemonLog: join(meshHome, "daemon.log"),
  };
}

/** The address the service's proxy is reached on, exactly as it is written into Claude Code's settings. */
export function serviceBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

function setClaudeBaseUrl(settingsPath: string, url: string): void {
  mkdirSync(dirname(settingsPath), { recursive: true });
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>; }
    catch { throw new CliError("claude_settings_invalid", "~/.claude/settings.json isn't valid JSON — fix it first; MESH won't overwrite it."); }
  }
  const env = { ...((settings.env as Record<string, string>) ?? {}), ANTHROPIC_BASE_URL: url };
  writeFileSync(settingsPath, `${JSON.stringify({ ...settings, env }, null, 2)}\n`);
}

/**
 * Take the service's address back out of Claude Code's settings. Only a local
 * address is removed: that is what `mesh install` writes. A base URL that
 * points somewhere else was set by the user or another tool and is left
 * exactly as it is. Returns whether the file was changed.
 */
function clearClaudeBaseUrl(settingsPath: string): boolean {
  if (!existsSync(settingsPath)) return false;
  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    const env = { ...((settings.env as Record<string, string>) ?? {}) };
    const current: unknown = env.ANTHROPIC_BASE_URL;
    if (current === undefined) return false;
    if (typeof current === "string" && loopbackPort(current) === undefined) return false;
    delete env.ANTHROPIC_BASE_URL;
    const next: Record<string, unknown> = { ...settings, env };
    if (Object.keys(env).length === 0) delete next.env;
    writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`);
    return true;
  } catch { return false; /* leave it */ }
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
  takePath("--gate-key-file"); // the PATH only — never the key value
  takeValue("--autonomy");
  takeValue("--theo-interval");
  takeValue("--theo-provider-url");
  if (argv.includes("--no-theo")) out.push("--no-theo");
  return out;
}

function writePlist(target: ResolvedTarget, nodePath: string, port: number, extraServeArgs: readonly string[] = []): void {
  const argv = [nodePath, target.stableBin, "serve", "--port", String(port), "--ledger", target.ledgerDir, ...extraServeArgs];
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
  <key>StandardOutPath</key><string>${esc(target.daemonLog)}</string>
  <key>StandardErrorPath</key><string>${esc(target.daemonLog)}</string>
</dict>
</plist>
`;
  mkdirSync(dirname(target.plistPath), { recursive: true });
  writeFileSync(target.plistPath, plist);
}

/** Has the proxy come up on this port? Bounded: about four seconds. */
async function waitForPort(port: number): Promise<boolean> {
  let up = false;
  for (let i = 0; i < 10 && !up; i += 1) { up = await portUp(port); if (!up) await sleep(400); }
  return up;
}

export type InstallServiceOptions = ServiceTarget & {
  port: number;
  /** Extra arguments for the service's `mesh serve` (Theo's flags). */
  serveArgs?: readonly string[];
  /** Write the proxy's address into Claude Code's settings. Default true. False for a user's own app. */
  pointClaudeCode?: boolean;
  /** The launcher to register. Default: the file that started this process. */
  launcherPath?: string;
  /** The Node binary the service runs. Default: this process's. */
  nodePath?: string;
  /** Wait for the proxy to answer. Default: poll the port for about four seconds. */
  waitForProxy?: (port: number) => Promise<boolean>;
};

export type InstallServiceResult = {
  /** The proxy answered after the service was loaded. */
  up: boolean;
  port: number;
  baseUrl: string;
  plistPath: string;
  launcherPath: string;
  ledgerDir: string;
  logPath: string;
  claudeSettingsPath: string;
  /** Claude Code's settings were written. */
  pointedClaudeCode: boolean;
};

/**
 * Register MESH as the always-on service: copy the launcher somewhere stable,
 * write the launchd agent, load it, point Claude Code at the proxy, and wait
 * for the proxy to answer. Never prints and never exits. Throws before
 * changing Claude Code's settings if that file is not valid JSON.
 */
export async function installService(options: InstallServiceOptions): Promise<InstallServiceResult> {
  const target = resolveForChange(options);
  const pointClaudeCode = options.pointClaudeCode !== false;
  // Refuse before anything is written, not after the service is loaded.
  if (pointClaudeCode && existsSync(target.claudeSettingsPath)) {
    try { JSON.parse(readFileSync(target.claudeSettingsPath, "utf8")); }
    catch { throw new CliError("claude_settings_invalid", "~/.claude/settings.json isn't valid JSON — fix it first; MESH won't overwrite it."); }
  }
  mkdirSync(dirname(target.stableBin), { recursive: true });
  mkdirSync(target.ledgerDir, { recursive: true });

  // Register the self-updating bootstrap (not the runtime) with launchd, copied
  // to a stable home so moving the download can't break the service. The
  // bootstrap sets MESH_BOOTSTRAP_PATH before running us; fall back to argv[1].
  const self = resolve(options.launcherPath ?? process.env.MESH_BOOTSTRAP_PATH ?? process.argv[1] ?? "");
  if (self !== target.stableBin) copyFileSync(self, target.stableBin);
  chmodSync(target.stableBin, 0o755);

  if (serviceLoaded(target.runner, "darwin")) target.runner.launchctl(["unload", target.plistPath]);
  writePlist(target, options.nodePath ?? process.execPath, options.port, options.serveArgs);
  target.runner.launchctl(["load", "-w", target.plistPath]);
  const baseUrl = serviceBaseUrl(options.port);
  if (pointClaudeCode) setClaudeBaseUrl(target.claudeSettingsPath, baseUrl);

  // Confirm it actually came up.
  const up = await (options.waitForProxy ?? waitForPort)(options.port);
  return {
    up,
    port: options.port,
    baseUrl,
    plistPath: target.plistPath,
    launcherPath: target.stableBin,
    ledgerDir: target.ledgerDir,
    logPath: target.daemonLog,
    claudeSettingsPath: target.claudeSettingsPath,
    pointedClaudeCode: pointClaudeCode,
  };
}

export type RemoveServiceResult = {
  /** The service was registered before this call. */
  wasLoaded: boolean;
  /** The service definition file was there and has been removed. */
  removedDefinition: boolean;
  /** The service's address was taken back out of Claude Code's settings. */
  restoredClaudeCode: boolean;
  ledgerDir: string;
};

/** Stop and remove the service and take its address out of Claude Code's settings. The ledger is kept. */
export function uninstallService(target: ServiceTarget = {}): RemoveServiceResult {
  const resolved = resolveForChange(target);
  const wasLoaded = serviceLoaded(resolved.runner, "darwin");
  resolved.runner.launchctl(["unload", "-w", resolved.plistPath]);
  const removedDefinition = existsSync(resolved.plistPath);
  rmSync(resolved.plistPath, { force: true });
  const restoredClaudeCode = clearClaudeBaseUrl(resolved.claudeSettingsPath);
  return { wasLoaded, removedDefinition, restoredClaudeCode, ledgerDir: resolved.ledgerDir };
}

/** Stop the service but keep its definition. Changes nothing when it is not registered. */
export function stopService(target: ServiceTarget = {}): RemoveServiceResult {
  const resolved = resolveForChange(target);
  if (!serviceLoaded(resolved.runner, "darwin")) {
    return { wasLoaded: false, removedDefinition: false, restoredClaudeCode: false, ledgerDir: resolved.ledgerDir };
  }
  resolved.runner.launchctl(["unload", "-w", resolved.plistPath]);
  const restoredClaudeCode = clearClaudeBaseUrl(resolved.claudeSettingsPath);
  return { wasLoaded: true, removedDefinition: false, restoredClaudeCode, ledgerDir: resolved.ledgerDir };
}

const wantsHelp = (argv: readonly string[]): boolean => argv.includes("--help") || argv.includes("-h");

const INSTALL_USAGE = `Usage: mesh install [options]

Always-on (macOS): run MESH as a background service that starts at login and
restarts if it stops, and point Claude Code at it. Writes
~/Library/LaunchAgents/${LABEL}.plist, copies the launcher to ~/.mesh/bin/mesh
and sets env.ANTHROPIC_BASE_URL in ~/.claude/settings.json. Undo: mesh uninstall.
For a guided version that says whether it ended connected: mesh setup.

  --port <n>              Port for the service's proxy. Default ${DEFAULT_PORT}.
  --capture <file>        Record your own requests to <file> so Theo can prove
                          lossy levers on real traffic (see mesh start --help).
  --gate-key-file <path>  Provider key file for the unattended gate (the path
                          only is stored).
  --autonomy <level>      Theo's autonomy: observe | recommend | test | optimise.
  --theo-interval <dur>   How often Theo runs a cycle (15m, 1h).
  --no-theo               Do not run Theo alongside the proxy.
  --help                  Show this message. Changes nothing.`;

const UNINSTALL_USAGE = `Usage: mesh uninstall

Stop and remove the background service (macOS) and take MESH's address back
out of ~/.claude/settings.json. A base URL that points somewhere other than a
local address is left as it is. Your ledger is kept.

  --help   Show this message. Changes nothing.`;

const STOP_USAGE = `Usage: mesh stop

Stop the background service (macOS) without removing it, and take MESH's
address back out of ~/.claude/settings.json so Claude Code never points at a
stopped proxy. Resume with: mesh install. Your ledger is untouched.

  --help   Show this message. Changes nothing.`;

/**
 * `target` is where the service lives and who registers it; the default is
 * this user's own machine. The dispatcher's tests pass temporary paths and a
 * fake runner. `--help` is answered before anything else is looked at.
 */
export async function runInstall(argv: string[], target: ServiceTarget = {}): Promise<void> {
  if (wantsHelp(argv)) { console.log(INSTALL_USAGE); return; }
  requireMac("install");
  const port = parsePort(argv);
  const { up, ledgerDir, logPath } = await installService({ ...target, port, serveArgs: theoServeArgs(argv) });

  console.log("");
  if (up) {
    console.log(`  ⬢ theo — MESH is now always on.  build ${BUILD_COMMIT}`);
    console.log(`  service  launchd ${LABEL} (starts at login, restarts if it stops)`);
    console.log(`  proxy    http://127.0.0.1:${port}  ·  ledger ${ledgerDir}`);
    console.log(`  claude   pointed at MESH permanently via ~/.claude/settings.json`);
    console.log(`  log      ${logPath}`);
    console.log("");
    console.log(`  Just use Claude Code — every session is optimised. Check savings with: mesh status`);
    console.log(`  Turn it off any time with: mesh uninstall`);
  } else {
    console.log(`  ⚠ The service was installed but the proxy didn't answer on port ${port}.`);
    console.log(`  Check ${logPath}, then re-run \`mesh install\`, or use \`mesh start\` instead.`);
    process.exitCode = 1;
  }
  console.log("");
}

export function runUninstall(argv: string[], target: ServiceTarget = {}): void {
  if (wantsHelp(argv)) { console.log(UNINSTALL_USAGE); return; }
  requireMac("uninstall");
  const { ledgerDir } = uninstallService(target);
  console.log("");
  console.log(`  ⬢ theo — always-on removed. The service is stopped and Claude Code is back to normal.`);
  console.log(`  Your ledger is kept at ${ledgerDir} — recompute any time with: mesh verify`);
  console.log("");
}

/** Stop the background service without removing it. Claude Code reverts to
 *  normal; the service definition stays so `mesh install` resumes it. */
export function runStop(argv: string[], target: ServiceTarget = {}): void {
  if (wantsHelp(argv)) { console.log(STOP_USAGE); return; }
  requireMac("stop");
  if (!stopService(target).wasLoaded) {
    console.log("");
    console.log(`  No MESH background service is running.`);
    console.log(`  (A foreground \`mesh start\` is stopped with Ctrl+C.)`);
    console.log("");
    return;
  }
  console.log("");
  console.log(`  ⬢ theo — MESH service stopped. Claude Code is back to normal.`);
  console.log(`  The service is kept — resume always-on any time with: mesh install`);
  console.log(`  Your ledger is untouched.`);
  console.log("");
}

// ---------------------------------------------------------------------------
// mesh status
// ---------------------------------------------------------------------------

export type StatusResult = {
  schema: "mesh-status/1";
  /** True whenever status could be read. A stopped proxy or an empty ledger is a state, not a failure. */
  ok: true;
  mesh: MeshIdentity;
  /**
   * Is anything flowing through MESH, and if not, why and the one command
   * that fixes it (flow.ts). Worked out from the fields below and the clock.
   */
  flow: Flow;
  /** What is on disk under ~/.mesh from the website install (absent on an npm install). */
  runtime: {
    /** A downloaded, checksum-verified runtime is cached in ~/.mesh/runtime. */
    cached: boolean;
    cachedVersion: string | null;
    /** The launcher the installer puts at ~/.mesh/bin/mesh exists. */
    launcherInstalled: boolean;
    /** This process is that cached runtime (false for npm, npx or a run from source). */
    runningFromCache: boolean;
  };
  service: {
    /** The always-on service exists only on macOS (launchd). */
    supported: boolean;
    installed: boolean;
    manager: "launchd" | null;
  };
  proxy: {
    /** MESH answered its health check on `port` just now. */
    reachable: boolean;
    /** Something accepts connections on `port` (MESH or another program). */
    portOpen: boolean;
    port: number;
    /** Where `port` came from: a --port flag, the installed service, a running `mesh start`, or the default. */
    portSource: PortSource;
    baseUrls: { anthropic: string; openai: string };
    health: string;
  };
  claudeCode: ClaudeCodeStatus;
  /** The base-URL variables in the environment this command was run from. Values are never repeated. */
  callerEnvironment: {
    anthropicBaseUrlPointsAtMesh: boolean;
    openaiBaseUrlPointsAtMesh: boolean;
  };
  ledger: {
    path: string;
    empty: boolean;
    /** Requests recorded, every period. */
    requests: number;
    /** When the earliest and latest recorded requests started (ISO 8601, UTC); null when there are none. */
    firstRequestAt: string | null;
    lastRequestAt: string | null;
    chainVerified: boolean;
    /** Where the chain stops verifying: the spool's number in name order, and the sequence number. */
    brokenAt?: { spool: number; seq?: number };
  };
  currency: "USD";
  /** Null when the ledger does not verify: a ledger that fails its check has no verified figure. */
  savings: null | {
    netVerifiedUsd: number;
    netVerifiedCents: number;
    /** Net verified savings round to at least one cent. */
    hasVerifiedSavings: boolean;
  };
  /**
   * The bill's verdict at the contracted fee over EVERY request in the ledger,
   * all periods together. The figure for one billing period is `mesh statement`.
   * Null when the ledger does not verify.
   */
  bill: null | {
    scope: "all_periods";
    feePercent: number;
    verdict: "charge" | "do_not_charge";
    reasonCode?: VerdictReasonCode;
    reason?: string;
    feeCents: number;
    feeUsd: number;
  };
  coverage: {
    enforceableLevers: number;
    active: number;
    held: number;
    available: number;
    activePercent: number;
    levers: { lever: string; state: LeverStandState; class?: TheoLeverClass }[];
  };
  theo: {
    /** Theo has run at least one cycle over this ledger (his memory file exists). */
    hasRun: boolean;
    /** The autonomy level of his last cycle; "unknown" before the first one. */
    mode: TheoAutonomyLevel | "unknown";
    /** Proposals waiting for the user's yes or no (`mesh theo --proposals`). */
    pendingProposals: number;
  };
};

/** What `collectStatus` reads. Every default is this user's own ~/.mesh and ~/.claude. */
export type StatusOptions = {
  /** Look for the proxy on this port instead of the configured one. */
  port?: number;
  ledgerDir?: string;
  meshHome?: string;
  claudeSettingsPath?: string;
  wiringStatePath?: string;
  plistPath?: string;
  env?: Record<string, string | undefined>;
  /** The clock `flow` is worked out against. Default: now. */
  now?: Date;
  /** The IANA zone `flow` counts days in ("yesterday"). Default: this machine's. */
  timeZone?: string;
  /** Who is asked whether the service is registered. Default: the real `launchctl`. */
  runner?: ServiceRunner;
  /** The platform to report for. Default: this one. */
  platform?: NodeJS.Platform;
};

type StatusParts = {
  result: StatusResult;
  summary: LedgerSummary;
  coverage: PolicyCoverage;
};

async function gatherStatus(options: StatusOptions = {}): Promise<StatusParts> {
  const meshHome = options.meshHome ?? MESH_HOME;
  const ledgerDir = options.ledgerDir ?? (options.meshHome === undefined ? DEFAULT_LEDGER : join(meshHome, "ledger"));
  const statePath = options.wiringStatePath ?? (options.meshHome === undefined ? WIRING_STATE : join(meshHome, "claude-wiring.json"));
  const settingsPath = options.claudeSettingsPath ?? CLAUDE_SETTINGS;
  const env = options.env ?? process.env;

  const os = options.platform ?? platform();
  const { port, source } = resolvePort(options.port, {
    ...(options.plistPath === undefined ? {} : { plistPath: options.plistPath }),
    wiringStatePath: statePath,
    platform: os,
  });
  const probe = await probeProxy(port);
  const urls = proxyUrls(port);
  const summary = summariseLedger(ledgerDir);
  const coverage = policyCoverage(readPolicy(join(meshHome, "theo-policy.json")));
  const memory = loadTheoMemory(defaultTheoMemoryPath(ledgerDir, "local"));

  const runtimeDir = join(meshHome, "runtime");
  const runtimeFile = join(runtimeDir, "mesh-runtime.mjs");
  const cached = existsSync(runtimeFile);
  let cachedVersion: string | null = null;
  try { cachedVersion = cached ? readFileSync(join(runtimeDir, "version"), "utf8").trim() || null : null; } catch { cachedVersion = null; }
  let runningFromCache = false;
  try { runningFromCache = cached && realpathSync(process.argv[1] ?? "") === realpathSync(runtimeFile); } catch { runningFromCache = false; }

  const pointsAtMesh = (value: string | undefined): boolean =>
    value !== undefined && probe.isMesh && loopbackPort(value) === port;
  const supported = os === "darwin";

  const facts: Omit<StatusResult, "flow"> = {
    schema: "mesh-status/1",
    ok: true,
    mesh: meshIdentity(),
    runtime: {
      cached,
      cachedVersion,
      launcherInstalled: existsSync(join(meshHome, "bin", "mesh")),
      runningFromCache,
    },
    service: {
      supported,
      installed: supported ? serviceLoaded(options.runner ?? systemServiceRunner, os) : false,
      manager: supported ? "launchd" : null,
    },
    proxy: {
      reachable: probe.isMesh,
      portOpen: probe.portOpen,
      port,
      portSource: source,
      baseUrls: { anthropic: urls.anthropic, openai: urls.openai },
      health: urls.health,
    },
    claudeCode: await claudeCodeStatus({ settingsPath, statePath }, { port, probe }),
    callerEnvironment: {
      anthropicBaseUrlPointsAtMesh: pointsAtMesh(env.ANTHROPIC_BASE_URL),
      openaiBaseUrlPointsAtMesh: pointsAtMesh(env.OPENAI_BASE_URL),
    },
    ledger: {
      path: ledgerDir,
      empty: summary.events === 0,
      requests: summary.events,
      firstRequestAt: summary.firstEventAt ?? null,
      lastRequestAt: summary.lastEventAt ?? null,
      chainVerified: summary.chainOk,
      ...(summary.chainOk || summary.brokenSpool === undefined
        ? {}
        : { brokenAt: { spool: summary.brokenSpool, ...(summary.brokenSeq === undefined ? {} : { seq: summary.brokenSeq }) } }),
    },
    currency: "USD",
    // A ledger that does not verify has no verified total: no figure, exactly as the text output.
    savings: summary.chainOk
      ? { netVerifiedUsd: summary.savedUsd, netVerifiedCents: summary.savedCents, hasVerifiedSavings: summary.hasVerifiedSavings }
      : null,
    bill: summary.chainOk
      ? {
          scope: "all_periods",
          feePercent: summary.bill.feePercent,
          verdict: summary.bill.verdict,
          ...(summary.bill.reasonCode === undefined ? {} : { reasonCode: summary.bill.reasonCode, reason: summary.bill.reason }),
          feeCents: summary.bill.feeCents,
          feeUsd: summary.bill.feeUsd,
        }
      : null,
    coverage: {
      enforceableLevers: coverage.enforceableCount,
      active: coverage.activeCount,
      held: coverage.heldCount,
      available: coverage.availableCount,
      activePercent: coverage.activeCoveragePercent,
      // Lever ids and states only: a held lever's reason is prose and stays out.
      levers: coverage.stands.map((stand) => ({
        lever: stand.lever,
        state: stand.state,
        ...(stand.class === undefined ? {} : { class: stand.class }),
      })),
    },
    theo: {
      hasRun: memory !== null,
      mode: memory?.autonomy ?? "unknown",
      pendingProposals: memory?.proposals?.length ?? 0,
    },
  };
  // `flow` is listed straight after `mesh`, so it is the first thing a reader of the JSON meets.
  const { schema, ok, mesh, ...rest } = facts;
  const flow = detectFlow(facts, options.now ?? new Date(), options.timeZone);
  const result: StatusResult = { schema, ok, mesh, flow, ...rest };
  return { result, summary, coverage };
}

/**
 * `mesh status` as data. Returns; never prints and never exits. Reads files
 * under ~/.mesh and ~/.claude, asks launchd whether the service is registered,
 * and makes one health request to the local proxy port. No other network
 * call, and it changes nothing.
 */
export async function collectStatus(options: StatusOptions = {}): Promise<StatusResult> {
  return (await gatherStatus(options)).result;
}

const STATUS_USAGE = `Usage: mesh status [options]

Is the service up, is the proxy answering, and what has been verified so far?
Reads your own ledger; changes nothing.

  --port <n>       Look for the proxy on this port. Default: the installed
                   service's port, else a running \`mesh start\`, else ${DEFAULT_PORT}.
  --ledger <dir>   Ledger directory to read. Default ~/.mesh/ledger.
  --json           Print one JSON object (schema mesh-status/1) instead of text.
  --help           Show this message.

Exits 0 whenever status could be read: a stopped proxy or an empty ledger is
reported, not failed (the same with --json).`;

export async function runStatus(argv: string[]): Promise<void> {
  const { values, flags } = parseFlags("status", argv, { valueFlags: ["--port", "--ledger"] });
  if (flags.has("--help")) { console.log(STATUS_USAGE); return; }
  const port = parsePortFlag(values["--port"]);
  const { result, summary: s, coverage: cov } = await gatherStatus({
    ...(port === undefined ? {} : { port }),
    ...(values["--ledger"] === undefined ? {} : { ledgerDir: resolve(values["--ledger"]) }),
  });
  if (flags.has("--json")) { writeJson(result); return; }

  const loaded = result.service.installed;
  const up = result.proxy.portOpen;
  // First: is anything flowing, and the one command that fixes it when not.
  console.log("");
  for (const line of flowLines(result.flow)) console.log(`  ${line}`);
  console.log("");
  console.log(`  mesh status — build ${BUILD_COMMIT}`);
  console.log(`  service   ${loaded ? "installed (launchd)" : "not installed"}`);
  console.log(`  proxy     ${up ? `up on http://127.0.0.1:${result.proxy.port}` : "not responding"}`);
  if (s.events > 0 && !s.chainOk) {
    // A ledger that does not verify has no verified total: say so, never a figure.
    console.log(`  ⬢ theo    ${s.events} requests seen · ledger did NOT verify, so no savings figure · run: mesh verify`);
  } else if (s.events > 0) {
    console.log(`  ⬢ theo    ${s.events} requests seen · $${s.savedUsd.toFixed(4)} verified saved (${s.verdictNote})`);
  } else {
    // "Use Claude Code and check back" is only true once something points at MESH.
    const connected = result.flow.state === "connected_idle" || result.flow.state === "flowing";
    console.log(`  ⬢ theo    no traffic yet${connected ? " — use Claude Code and check back" : ""}`);
  }
  // The invitation is about savings existing, not about a bill being due, so
  // it keys on verified savings rather than the billing verdict.
  if (s.chainOk && s.hasVerifiedSavings) {
    console.log(`  claim     keep these savings metered → ${MESH_SIGNUP_URL}`);
  }
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
