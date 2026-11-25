/**
 * What is true on this machine right now: is the background service
 * registered, which port is MESH configured on, and is the proxy answering.
 * Read-only. Shared by status, doctor, connect and restore so they cannot
 * disagree about where the proxy is.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir, platform } from "node:os";
import { join } from "node:path";

import { checkWiring, loopbackPort, pidAlive, readWiringState } from "./claude-wiring.js";
import { CliError } from "./json-output.js";

export const DEFAULT_PORT = 8787;
export const LAUNCHD_LABEL = "dev.meshtoken.mesh";
export const LAUNCHD_PLIST = join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
const WIRING_STATE = join(homedir(), ".mesh", "claude-wiring.json");

/** Is anything accepting TCP connections on this loopback port? */
export function portOpen(port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((res) => {
    const sock = connect({ host: "127.0.0.1", port });
    const done = (ok: boolean): void => { sock.destroy(); res(ok); };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

/**
 * The one place MESH talks to the service manager. Everything that registers,
 * removes or asks about the background service goes through a runner, so a
 * caller (and every test) can pass its own instead of the real `launchctl`:
 * launchd registers an agent for the logged-in user whatever HOME says, so a
 * test must never reach the real one.
 */
export type ServiceRunner = {
  /** Run `launchctl` with these arguments. True when it exited 0. */
  launchctl: (args: readonly string[]) => boolean;
};

/**
 * MESH_NO_SERVICE: set it (to anything) and MESH never calls the service
 * manager. Asking whether the service is registered is answered "no" without
 * asking; registering, stopping or removing it is refused with an error.
 *
 * It exists for the test suite: vitest.config.ts sets it for every test and
 * every `mesh` process a test starts, so a test that reached the real
 * `launchctl` with anything that changes the machine fails instead of
 * registering an agent for whoever is logged in. A user can set it too, to
 * rule the background service out on a machine.
 */
export function serviceManagerDisabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.MESH_NO_SERVICE !== undefined && env.MESH_NO_SERVICE !== "";
}

/** The error every refused service-manager call carries. */
export function serviceDisabledError(): CliError {
  return new CliError(
    "service_disabled",
    "MESH_NO_SERVICE is set, so Mesh will not register, stop or remove the background service here. Nothing was changed.",
  );
}

/** The real service manager: `launchctl` for the logged-in user. */
export const systemServiceRunner: ServiceRunner = {
  launchctl: (args) => {
    if (serviceManagerDisabled()) {
      if (args[0] === "list") return false;
      throw serviceDisabledError();
    }
    try { execFileSync("launchctl", [...args], { stdio: "pipe" }); return true; } catch { return false; }
  },
};

/** Is the launchd service registered? Always false off macOS. */
export function serviceLoaded(
  runner: ServiceRunner = systemServiceRunner,
  os: NodeJS.Platform = platform(),
): boolean {
  if (os !== "darwin") return false;
  return runner.launchctl(["list", LAUNCHD_LABEL]);
}

export type ProxyProbe = {
  /** Something accepts connections on the port. */
  portOpen: boolean;
  /** That something answered as the MESH proxy. */
  isMesh: boolean;
};

/**
 * Ask the port whether it is MESH. A current build answers its health check;
 * a build from before the health check answers 404 with its own "MESH proxy"
 * sentence. Both are MESH. One local request, no key, nothing forwarded.
 */
export async function probeProxy(port: number, timeoutMs = 1500): Promise<ProxyProbe> {
  if (!(await portOpen(port, Math.min(timeoutMs, 800)))) return { portOpen: false, isMesh: false };
  try {
    const response = await fetch(`http://127.0.0.1:${port}/mesh/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text();
    return { portOpen: true, isMesh: text.includes('"mesh-proxy"') || text.includes("MESH proxy") };
  } catch {
    return { portOpen: true, isMesh: false };
  }
}

/** Where a port number came from, most specific first. */
export type PortSource = "flag" | "service" | "start-session" | "default";

/** The `--port` the launchd service was installed with, if a service definition exists. */
function servicePort(plistPath: string, os: NodeJS.Platform = platform()): number | undefined {
  if (os !== "darwin" || !existsSync(plistPath)) return undefined;
  try {
    const match = /<string>--port<\/string>\s*<string>(\d+)<\/string>/.exec(readFileSync(plistPath, "utf8"));
    const port = match ? Number(match[1]) : Number.NaN;
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The port a running `mesh start` session recorded when it pointed Claude Code
 * at itself (~/.mesh/claude-wiring.json), if that session is still alive.
 */
function startSessionPort(statePath: string): number | undefined {
  const state = readWiringState(statePath);
  if (state === undefined || !pidAlive(state.pid)) return undefined;
  return loopbackPort(state.proxyUrl);
}

/**
 * The port MESH is configured on for this machine: a `--port` flag if given,
 * else the installed service's port, else the port of a running `mesh start`
 * session, else the default. A `mesh proxy --port N` leaves no record (it
 * changes nothing on the machine), so name its port with `--port N`.
 */
export function resolvePort(
  flag?: number,
  paths: { plistPath?: string; wiringStatePath?: string; platform?: NodeJS.Platform } = {},
): { port: number; source: PortSource } {
  if (flag !== undefined) return { port: flag, source: "flag" };
  const fromService = servicePort(paths.plistPath ?? LAUNCHD_PLIST, paths.platform);
  if (fromService !== undefined) return { port: fromService, source: "service" };
  const fromSession = startSessionPort(paths.wiringStatePath ?? WIRING_STATE);
  if (fromSession !== undefined) return { port: fromSession, source: "start-session" };
  return { port: DEFAULT_PORT, source: "default" };
}

/** The addresses a client uses to reach the proxy on `port`. */
export function proxyUrls(port: number): { anthropic: string; openai: string; health: string } {
  const base = `http://127.0.0.1:${port}`;
  return { anthropic: base, openai: `${base}/v1`, health: `${base}/mesh/health` };
}

// ---------------------------------------------------------------------------
// Where Claude Code points
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

export type ClaudeCodeStatus = {
  state: ClaudeCodeState;
  pointedAtMesh: boolean | "unknown";
  /** The local port its ANTHROPIC_BASE_URL names, when it names one. The URL itself is never repeated. */
  port: number | null;
  /** A `mesh start` session that is still running recorded that it pointed Claude Code at itself. */
  startSessionRunning: boolean;
  /** How the state was worked out. Fixed wording. */
  detectedBy: string;
};

const CLAUDE_DETECTED_BY =
  "env.ANTHROPIC_BASE_URL in ~/.claude/settings.json, the session record ~/.mesh/claude-wiring.json, " +
  "and a health request to the local address it names";

/**
 * Where Claude Code's settings point right now. Reads the settings file and
 * the session record, and asks the local address they name whether it is
 * MESH. Changes nothing. Used by `mesh status` and by `mesh start` when its
 * port is taken, so both say the same thing about the same machine.
 */
export async function claudeCodeStatus(
  paths: { settingsPath: string; statePath: string },
  proxy: { port: number; probe: ProxyProbe },
): Promise<ClaudeCodeStatus> {
  const report = (
    state: ClaudeCodeState,
    pointedAtMesh: boolean | "unknown",
    port: number | null = null,
    startSessionRunning = false,
  ): ClaudeCodeStatus => ({ state, pointedAtMesh, port, startSessionRunning, detectedBy: CLAUDE_DETECTED_BY });
  const health = await checkWiring(paths, { portUp: portOpen });
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
