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

import { loopbackPort, pidAlive, readWiringState } from "./claude-wiring.js";

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
  /** Run `launchctl` with these arguments. True when it exited 0. Never throws. */
  launchctl: (args: readonly string[]) => boolean;
};

/** The real service manager: `launchctl` for the logged-in user. */
export const systemServiceRunner: ServiceRunner = {
  launchctl: (args) => {
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
