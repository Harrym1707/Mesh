/**
 * Pointing Claude Code at the local proxy, and always pointing it back.
 *
 * `mesh start` writes ANTHROPIC_BASE_URL into ~/.claude/settings.json. If that
 * value outlives the proxy, Claude Code is broken: every request goes to a port
 * nothing listens on. So the undo has to survive every way the session can end:
 *
 *   - Ctrl+C, SIGTERM, a closed terminal (SIGHUP), an uncaught error — the
 *     caller runs the returned `restore` on each, and it is synchronous so it
 *     also works from a process "exit" handler.
 *   - A hard kill or power loss — nothing runs. What was there before is
 *     therefore written to a small record first (~/.mesh/claude-wiring.json).
 *     The next `mesh start` reads it, so it restores the user's REAL previous
 *     value instead of the dead proxy's address, and `mesh restore` /
 *     `mesh doctor` use it to repair Claude Code without starting anything.
 *
 * Tool search. Claude Code turns its tool search off whenever
 * ANTHROPIC_BASE_URL is not Anthropic's own address, and then sends every tool
 * definition in full on every request: measured on 2026-11-25 with Claude Code
 * 2.1.160, 51,602 input tokens through a local address against 33,156 direct.
 * MESH passes tool search through unchanged, so wiring also sets
 * ENABLE_TOOL_SEARCH=true, which restores the request Claude Code sends
 * directly. A value the user already set is theirs and is never changed, and
 * the undo removes only a value MESH itself wrote.
 *
 * Paths are passed in, never read from the environment here, so this is
 * testable without a subprocess.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type WiringPaths = {
  /** ~/.claude/settings.json */
  settingsPath: string;
  /** ~/.mesh/claude-wiring.json */
  statePath: string;
};

/** What Claude Code's settings held before a `mesh start` session changed them. */
export type WiringState = {
  /** The `mesh start` process that owns this record. */
  pid: number;
  /** The proxy address that session wrote into the settings. */
  proxyUrl: string;
  /** ANTHROPIC_BASE_URL before the session, or null if it was not set. */
  priorBaseUrl: string | null;
  /** Whether ~/.claude/settings.json existed before the session. */
  hadFile: boolean;
  /** Whether this session wrote ENABLE_TOOL_SEARCH (false: the user had their own value). */
  setToolSearch: boolean;
  at: string;
};

/** The value MESH writes so Claude Code keeps tool search on behind the proxy. */
export const TOOL_SEARCH_KEY = "ENABLE_TOOL_SEARCH";
export const TOOL_SEARCH_VALUE = "true";

/**
 * Turn tool search on in a Claude Code `env` block unless the user chose a
 * value. Mutates `env`; returns whether MESH wrote the value (and so owns it).
 */
export function applyToolSearch(env: Record<string, string>): boolean {
  if (env[TOOL_SEARCH_KEY] !== undefined) return false;
  env[TOOL_SEARCH_KEY] = TOOL_SEARCH_VALUE;
  return true;
}

/** Remove the value `applyToolSearch` wrote, unless it was changed since. Mutates `env`. */
export function removeToolSearch(env: Record<string, string>, meshWroteIt: boolean): void {
  if (meshWroteIt && env[TOOL_SEARCH_KEY] === TOOL_SEARCH_VALUE) delete env[TOOL_SEARCH_KEY];
}

type Settings = Record<string, unknown>;

/** Is a process with this pid running? (Signal 0 tests without signalling.) */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else. Still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readWiringState(statePath: string): WiringState | undefined {
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Partial<WiringState>;
    if (typeof parsed.pid !== "number" || typeof parsed.proxyUrl !== "string") return undefined;
    return {
      pid: parsed.pid,
      proxyUrl: parsed.proxyUrl,
      priorBaseUrl: typeof parsed.priorBaseUrl === "string" ? parsed.priorBaseUrl : null,
      hadFile: parsed.hadFile === true,
      setToolSearch: parsed.setToolSearch === true,
      at: typeof parsed.at === "string" ? parsed.at : "",
    };
  } catch {
    return undefined;
  }
}

function readSettings(settingsPath: string): Settings {
  return JSON.parse(readFileSync(settingsPath, "utf8")) as Settings;
}

function envOf(settings: Settings): Record<string, string> {
  return { ...((settings.env as Record<string, string> | undefined) ?? {}) };
}

/**
 * Put ANTHROPIC_BASE_URL back to `priorBaseUrl` (or remove it), but only if it
 * still holds `proxyUrl`: a value the user or another tool set meanwhile is
 * theirs and is left alone. Takes ENABLE_TOOL_SEARCH out with it when this
 * session wrote it and it has not been changed since. Removes a settings file this session created and
 * that would otherwise be left empty. Returns whether anything was changed.
 */
function undoWiring(
  settingsPath: string,
  proxyUrl: string,
  priorBaseUrl: string | null,
  hadFile: boolean,
  setToolSearch: boolean,
): boolean {
  if (!existsSync(settingsPath)) return false;
  const now = readSettings(settingsPath);
  const env = envOf(now);
  if (env.ANTHROPIC_BASE_URL !== proxyUrl) return false;
  if (priorBaseUrl === null) delete env.ANTHROPIC_BASE_URL;
  else env.ANTHROPIC_BASE_URL = priorBaseUrl;
  removeToolSearch(env, setToolSearch);
  const next: Settings = { ...now, env };
  if (Object.keys(env).length === 0) delete next.env;
  if (!hadFile && Object.keys(next).length === 0) {
    rmSync(settingsPath, { force: true }); // we created it and nothing else is in it
  } else {
    writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`);
  }
  return true;
}

/**
 * Point Claude Code at `proxyUrl` and return the function that undoes it.
 * The returned function is synchronous, safe to call more than once, and never
 * throws. Throws now (before changing anything) if the settings file exists
 * but is not valid JSON: MESH does not overwrite a file it cannot read.
 */
export function wireClaudeCode(
  paths: WiringPaths,
  proxyUrl: string,
  options: { pid?: number; isAlive?: (pid: number) => boolean; now?: () => string } = {},
): () => void {
  const pid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? pidAlive;
  mkdirSync(dirname(paths.settingsPath), { recursive: true });

  let settings: Settings = {};
  let hadFile = false;
  if (existsSync(paths.settingsPath)) {
    hadFile = true;
    try {
      settings = readSettings(paths.settingsPath);
    } catch {
      throw new Error(`~/.claude/settings.json isn't valid JSON — fix or move it, then re-run. MESH won't overwrite it.`);
    }
  }
  const env = envOf(settings);
  let priorBaseUrl: string | null = env.ANTHROPIC_BASE_URL ?? null;
  // Whether a tool-search value already in the settings was written by MESH.
  let inheritedToolSearch = false;

  // A record left by an earlier session means that session never restored.
  let ownsRecord = true;
  const earlier = readWiringState(paths.statePath);
  if (earlier !== undefined) {
    if (earlier.pid !== pid && isAlive(earlier.pid)) {
      // Another `mesh start` is running and owns the record. Stack on top of it:
      // our "before" is its proxy, which is what we restore to on exit. Its
      // tool-search value stays its own to remove.
      ownsRecord = false;
    } else if (priorBaseUrl === earlier.proxyUrl) {
      // The earlier session died without restoring, so the settings still hold
      // ITS proxy address. The user's real previous value is the one it recorded.
      priorBaseUrl = earlier.priorBaseUrl;
      hadFile = earlier.hadFile;
      inheritedToolSearch = earlier.setToolSearch && env[TOOL_SEARCH_KEY] === TOOL_SEARCH_VALUE;
    }
    // Otherwise the user changed the value since; what is there now stands.
  }
  const setToolSearch = ownsRecord && (applyToolSearch(env) || inheritedToolSearch);

  if (ownsRecord) {
    // Record first, so a kill between the two writes cannot leave Claude Code
    // pointed at us with no way to know what was there before.
    const state: WiringState = {
      pid,
      proxyUrl,
      priorBaseUrl,
      hadFile,
      setToolSearch,
      at: (options.now ?? (() => new Date().toISOString()))(),
    };
    mkdirSync(dirname(paths.statePath), { recursive: true });
    writeFileSync(paths.statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  }
  env.ANTHROPIC_BASE_URL = proxyUrl;
  writeFileSync(paths.settingsPath, `${JSON.stringify({ ...settings, env }, null, 2)}\n`);

  let restored = false;
  return function restore(): void {
    if (restored) return;
    restored = true;
    try {
      undoWiring(paths.settingsPath, proxyUrl, priorBaseUrl, hadFile, setToolSearch);
    } catch {
      /* best-effort; never crash on shutdown */
    }
    if (ownsRecord) {
      try { rmSync(paths.statePath, { force: true }); } catch { /* ignore */ }
    }
  };
}

export type WiringHealth =
  | { status: "ok"; detail: string }
  /** A `mesh start` session ended without restoring; Claude Code points at nothing. */
  | { status: "stranded"; detail: string; state: WiringState }
  /** ANTHROPIC_BASE_URL is a local address nothing is listening on (no record of who set it). */
  | { status: "dead-local"; detail: string; baseUrl: string }
  | { status: "invalid"; detail: string };

/** The port of a loopback http URL, or undefined for anything else. */
export function loopbackPort(url: string): number | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:") return undefined;
    if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) return undefined;
    const port = Number(parsed.port || 80);
    return Number.isInteger(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

/** Is Claude Code pointed somewhere that works? Reads only; changes nothing. */
export async function checkWiring(
  paths: WiringPaths,
  probe: { portUp: (port: number) => Promise<boolean>; isAlive?: (pid: number) => boolean },
): Promise<WiringHealth> {
  const isAlive = probe.isAlive ?? pidAlive;
  if (!existsSync(paths.settingsPath)) {
    return { status: "ok", detail: "no ~/.claude/settings.json (Claude Code not configured for MESH)" };
  }
  let baseUrl: string | undefined;
  try {
    baseUrl = envOf(readSettings(paths.settingsPath)).ANTHROPIC_BASE_URL;
  } catch {
    return { status: "invalid", detail: "~/.claude/settings.json is not valid JSON" };
  }
  if (baseUrl === undefined) return { status: "ok", detail: "valid, but ANTHROPIC_BASE_URL not set" };

  const state = readWiringState(paths.statePath);
  if (state !== undefined && state.proxyUrl === baseUrl && !isAlive(state.pid)) {
    return {
      status: "stranded",
      state,
      detail: `ANTHROPIC_BASE_URL → ${baseUrl}, left by a MESH session that is no longer running`,
    };
  }
  const port = loopbackPort(baseUrl);
  if (port !== undefined && !(await probe.portUp(port))) {
    return { status: "dead-local", baseUrl, detail: `ANTHROPIC_BASE_URL → ${baseUrl}, but nothing is listening there` };
  }
  return { status: "ok", detail: `ANTHROPIC_BASE_URL → ${baseUrl}` };
}

/**
 * Repair what `checkWiring` found: restore the recorded previous value after a
 * stranded session, or remove a local address nothing listens on. Leaves a
 * working configuration untouched. Returns a sentence saying what it did.
 */
export async function repairWiring(
  paths: WiringPaths,
  probe: { portUp: (port: number) => Promise<boolean>; isAlive?: (pid: number) => boolean },
): Promise<{ changed: boolean; message: string }> {
  const health = await checkWiring(paths, probe);
  if (health.status === "invalid") {
    return { changed: false, message: "~/.claude/settings.json is not valid JSON. Fix or remove it; MESH won't overwrite it." };
  }
  if (health.status === "stranded") {
    const { state } = health;
    undoWiring(paths.settingsPath, state.proxyUrl, state.priorBaseUrl, state.hadFile, state.setToolSearch);
    rmSync(paths.statePath, { force: true });
    return {
      changed: true,
      message: state.priorBaseUrl === null
        ? "Claude Code restored: removed the address of a MESH session that had ended."
        : `Claude Code restored: ANTHROPIC_BASE_URL is back to ${state.priorBaseUrl}.`,
    };
  }
  if (health.status === "dead-local") {
    undoWiring(paths.settingsPath, health.baseUrl, null, true, false);
    return { changed: true, message: `Claude Code restored: removed ${health.baseUrl}, where nothing was listening.` };
  }
  // A leftover record whose settings no longer point at it is just litter.
  const state = readWiringState(paths.statePath);
  if (state !== undefined && !(probe.isAlive ?? pidAlive)(state.pid)) rmSync(paths.statePath, { force: true });
  return { changed: false, message: `Nothing to repair (${health.detail}).` };
}
