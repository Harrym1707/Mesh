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
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { dirname, join, resolve } from "node:path";

import { BUILD_COMMIT, CLAUDE_SETTINGS, DEFAULT_PORT, MESH_HOME, WIRING_STATE, readPolicy, summariseLedger, type LedgerSummary } from "./start.js";
import { policyCoverage, type LeverStandState, type PolicyCoverage, type TheoLeverClass } from "../../sdk-js/src/theo-policy.js";
import { defaultTheoMemoryPath, loadTheoMemory } from "../../sdk-js/src/theo-agent-store.js";
import type { TheoAutonomyLevel } from "../../sdk-js/src/theo-agent.js";
import { MESH_SIGNUP_URL } from "../../sdk-js/src/cta.js";
import type { VerdictReasonCode } from "./bill-verdict.js";
import { checkWiring, loopbackPort } from "./claude-wiring.js";
import { meshIdentity, parseFlags, parsePortFlag, writeJson, type MeshIdentity } from "./json-output.js";
import {
  LAUNCHD_LABEL as LABEL,
  LAUNCHD_PLIST as PLIST,
  portOpen as portUp,
  probeProxy,
  proxyUrls,
  resolvePort,
  serviceLoaded,
  type PortSource,
  type ProxyProbe,
} from "./machine.js";

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
  takePath("--gate-key-file"); // the PATH only — never the key value
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

// ---------------------------------------------------------------------------
// mesh status
// ---------------------------------------------------------------------------

/**
 * Where Claude Code's own settings point, as far as files and one local
 * health request can tell:
 *
 *   pointed_at_mesh           ANTHROPIC_BASE_URL is a local address and MESH answers there
 *   pointed_at_stopped_proxy  it is a local address nothing answers on (a MESH session that
 *                             ended without restoring, or a service that is down): Claude Code
 *                             cannot reach its API until `mesh restore` or the proxy is back
 *   pointed_elsewhere         it is set to something that is not a MESH proxy
 *   not_pointed               no ~/.claude/settings.json, or no ANTHROPIC_BASE_URL in it
 *   settings_invalid          the file is not valid JSON, so nothing can be said
 */
export type ClaudeCodeState =
  | "pointed_at_mesh"
  | "pointed_at_stopped_proxy"
  | "pointed_elsewhere"
  | "not_pointed"
  | "settings_invalid";

export type StatusResult = {
  schema: "mesh-status/1";
  /** True whenever status could be read. A stopped proxy or an empty ledger is a state, not a failure. */
  ok: true;
  mesh: MeshIdentity;
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
  claudeCode: {
    state: ClaudeCodeState;
    pointedAtMesh: boolean | "unknown";
    /** The local port its ANTHROPIC_BASE_URL names, when it names one. The URL itself is never repeated. */
    port: number | null;
    /** A `mesh start` session that is still running recorded that it pointed Claude Code at itself. */
    startSessionRunning: boolean;
    /** How the state was worked out. Fixed wording. */
    detectedBy: string;
  };
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
};

type StatusParts = {
  result: StatusResult;
  summary: LedgerSummary;
  coverage: PolicyCoverage;
};

const CLAUDE_DETECTED_BY =
  "env.ANTHROPIC_BASE_URL in ~/.claude/settings.json, the session record ~/.mesh/claude-wiring.json, " +
  "and a health request to the local address it names";

async function claudeCodeStatus(
  paths: { settingsPath: string; statePath: string },
  proxy: { port: number; probe: ProxyProbe },
): Promise<StatusResult["claudeCode"]> {
  const report = (
    state: ClaudeCodeState,
    pointedAtMesh: boolean | "unknown",
    port: number | null = null,
    startSessionRunning = false,
  ): StatusResult["claudeCode"] => ({ state, pointedAtMesh, port, startSessionRunning, detectedBy: CLAUDE_DETECTED_BY });
  const health = await checkWiring(paths, { portUp });
  if (health.status === "invalid") return report("settings_invalid", "unknown");

  let baseUrl: unknown;
  try {
    baseUrl = existsSync(paths.settingsPath)
      ? (JSON.parse(readFileSync(paths.settingsPath, "utf8")) as { env?: Record<string, unknown> }).env?.ANTHROPIC_BASE_URL
      : undefined;
  } catch {
    return report("settings_invalid", "unknown");
  }
  if (typeof baseUrl !== "string") return report("not_pointed", false);

  const port = loopbackPort(baseUrl) ?? null;
  if (health.status === "stranded" || health.status === "dead-local") return report("pointed_at_stopped_proxy", false, port);
  if (port === null) return report("pointed_elsewhere", false);
  // A local address something answers on: ask it whether it is MESH.
  const probe = port === proxy.port ? proxy.probe : await probeProxy(port);
  // checkWiring found no dead session behind this address, so a record that
  // names it belongs to a `mesh start` that is still running.
  const record = resolvePort(undefined, { plistPath: "", wiringStatePath: paths.statePath });
  return report(
    probe.isMesh ? "pointed_at_mesh" : "pointed_elsewhere",
    probe.isMesh,
    port,
    record.source === "start-session" && record.port === port,
  );
}

async function gatherStatus(options: StatusOptions = {}): Promise<StatusParts> {
  const meshHome = options.meshHome ?? MESH_HOME;
  const ledgerDir = options.ledgerDir ?? (options.meshHome === undefined ? DEFAULT_LEDGER : join(meshHome, "ledger"));
  const statePath = options.wiringStatePath ?? (options.meshHome === undefined ? WIRING_STATE : join(meshHome, "claude-wiring.json"));
  const settingsPath = options.claudeSettingsPath ?? CLAUDE_SETTINGS;
  const env = options.env ?? process.env;

  const { port, source } = resolvePort(options.port, {
    ...(options.plistPath === undefined ? {} : { plistPath: options.plistPath }),
    wiringStatePath: statePath,
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
  const supported = platform() === "darwin";

  const result: StatusResult = {
    schema: "mesh-status/1",
    ok: true,
    mesh: meshIdentity(),
    runtime: {
      cached,
      cachedVersion,
      launcherInstalled: existsSync(join(meshHome, "bin", "mesh")),
      runningFromCache,
    },
    service: { supported, installed: supported ? serviceLoaded() : false, manager: supported ? "launchd" : null },
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
    console.log(`  ⬢ theo    no traffic yet — use Claude Code and check back`);
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
