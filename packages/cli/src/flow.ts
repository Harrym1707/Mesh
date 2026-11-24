/**
 * Is anything flowing through Mesh, and if not, exactly why and what fixes it.
 *
 * Installing Mesh does not connect it: a machine can have the launcher, no
 * running proxy, a Claude Code that still talks straight to its provider and
 * an empty ledger, and nothing used to say so. `detectFlow` reads one
 * `StatusResult` (what `mesh status --json` already collects) and returns
 * the one state this machine is in, in a sentence a non-engineer can read,
 * with the ONE command that fixes it (or none when nothing needs fixing or
 * no command can).
 *
 * Pure: no file, no network, no clock of its own. The caller passes the time.
 * Every sentence is fixed wording plus numbers from the status; nothing here
 * repeats a URL, a key or any text taken from a request.
 *
 * Used by `mesh status` (first lines, and `flow` in --json), `mesh doctor`,
 * bare `mesh` and `mesh setup`, so they cannot disagree.
 */
import type { StatusResult } from "./daemon.js";

/**
 * After this many days without a request, a connected Mesh is reported as
 * idle and a running one that nothing points at as stale. Three days covers
 * a weekend without a false alarm on Monday morning.
 */
export const IDLE_AFTER_DAYS = 3;

/**
 *   flowing                    the proxy answers and a request went through within IDLE_AFTER_DAYS
 *   connected_idle             the proxy answers and a client is pointed at it, but no request yet
 *                              (or none for more than IDLE_AFTER_DAYS)
 *   not_set_up                 installed, never connected: nothing runs, nothing points at Mesh, empty ledger
 *   proxy_down_client_pointed  Claude Code is pointed at a local address nothing answers on:
 *                              its requests are failing
 *   proxy_down                 Mesh ran here before (or its service is installed) but does not answer now
 *   port_taken                 another program answers on Mesh's port, so Mesh cannot run there
 *   client_not_pointed         the proxy answers but neither Claude Code nor this terminal points at it,
 *                              and no request arrived within IDLE_AFTER_DAYS
 *   pointed_elsewhere          the proxy answers but Claude Code is pointed at some other address
 *   ledger_not_verified        the ledger fails its check, so there is no savings figure
 *   settings_invalid           Claude Code's settings file is not valid JSON; Mesh will not touch it
 */
export type FlowState =
  | "flowing"
  | "connected_idle"
  | "not_set_up"
  | "proxy_down_client_pointed"
  | "proxy_down"
  | "port_taken"
  | "client_not_pointed"
  | "pointed_elsewhere"
  | "ledger_not_verified"
  | "settings_invalid";

export type Flow = {
  state: FlowState;
  /** One plain sentence: what is true right now. */
  headline: string;
  /** One to three more sentences: why, and anything that is not known. */
  detail: string;
  /** The one command to run, or null when nothing needs running or no command can fix it. */
  fix: string | null;
};

/** What the detector reads. `flow` itself is left out so a status can be re-read. */
export type FlowInput = Omit<StatusResult, "flow">;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The calendar date (YYYY-MM-DD) of an instant in a time zone. */
function calendarDate(instantMs: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instantMs);
  } catch {
    return new Date(instantMs).toISOString().slice(0, 10);
  }
}

const plural = (value: number, unit: string): string => `${value} ${unit}${value === 1 ? "" : "s"}`;

/**
 * How long ago, as a person says it: "less than a minute ago", "2 minutes
 * ago", "3 hours ago", "yesterday", "4 days ago". Days are calendar days in
 * `timeZone`. A time in the future (a clock that moved) reads as just now.
 */
export function timeAgo(thenMs: number, nowMs: number, timeZone: string): string {
  const elapsed = Math.max(0, nowMs - thenMs);
  if (elapsed < MINUTE) return "less than a minute ago";
  if (elapsed < HOUR) return `${plural(Math.floor(elapsed / MINUTE), "minute")} ago`;
  const days = Math.round(
    (Date.parse(`${calendarDate(nowMs, timeZone)}T00:00:00Z`) - Date.parse(`${calendarDate(thenMs, timeZone)}T00:00:00Z`)) / DAY,
  );
  if (elapsed < 12 * HOUR || days <= 0) return `${plural(Math.floor(elapsed / HOUR), "hour")} ago`;
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

function localZone(): string {
  try { return new Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

/**
 * The one state this machine is in. `now` is the clock; `timeZone` (default:
 * this machine's) only decides where "yesterday" begins.
 */
export function detectFlow(status: FlowInput, now: Date, timeZone: string = localZone()): Flow {
  const { proxy, service, claudeCode, callerEnvironment, ledger } = status;
  const port = proxy.port;
  const base = proxy.baseUrls.anthropic;
  const requests = `${ledger.requests} ${ledger.requests === 1 ? "request" : "requests"}`;

  // When the last request was, in words, and whether that is recent. A ledger
  // with requests but no readable time is not called recent: it is not known.
  const lastMs = ledger.lastRequestAt === null ? Number.NaN : Date.parse(ledger.lastRequestAt);
  const lastKnown = Number.isFinite(lastMs);
  const ago = lastKnown ? timeAgo(lastMs, now.getTime(), timeZone) : null;
  const recent = lastKnown && now.getTime() - lastMs <= IDLE_AFTER_DAYS * DAY;
  const lastSeen = ledger.empty
    ? "Mesh has not seen a request yet."
    : ago === null
      ? `Mesh has recorded ${requests}, but when the last one was is not known.`
      : `The last request Mesh saw was ${ago}.`;

  const clientPointed =
    claudeCode.state === "pointed_at_mesh" ||
    callerEnvironment.anthropicBaseUrlPointsAtMesh ||
    callerEnvironment.openaiBaseUrlPointsAtMesh;

  // 1. Claude Code is pointed at a local address nothing answers on. Nothing
  //    else matters until this is fixed: its requests cannot reach a provider.
  if (claudeCode.state === "pointed_at_stopped_proxy") {
    const where = claudeCode.port === null ? "a local address" : `port ${claudeCode.port}`;
    if (service.installed) {
      return {
        state: "proxy_down_client_pointed",
        headline: "Claude Code is pointed at Mesh but Mesh is not running, so Claude Code's requests are FAILING until this is fixed.",
        detail:
          `The background service is installed but nothing answers on ${where}. Restart it with mesh install; its log is ~/.mesh/daemon.log. ` +
          "To stop using Mesh and point Claude Code back at its provider instead: mesh uninstall.",
        fix: "mesh install",
      };
    }
    return {
      state: "proxy_down_client_pointed",
      headline: "Claude Code is pointed at Mesh but Mesh is not running, so Claude Code's requests are FAILING until this is fixed.",
      detail:
        `Claude Code's settings name ${where}, where nothing answers: a Mesh session ended without putting them back. ` +
        "mesh restore points Claude Code back at its provider straight away. To use Mesh again after that: " +
        `${service.supported ? "mesh setup" : "mesh start"}.` +
        (proxy.reachable && claudeCode.port !== port ? ` (Mesh is answering on port ${port}, which is not the port Claude Code is pointed at.)` : ""),
      fix: "mesh restore",
    };
  }

  // 2. A ledger that fails its check has no figure, whatever else is true.
  if (!ledger.chainVerified) {
    const where = ledger.brokenAt === undefined
      ? ""
      : ` (spool ${ledger.brokenAt.spool}${ledger.brokenAt.seq === undefined ? "" : `, record ${ledger.brokenAt.seq}`})`;
    return {
      state: "ledger_not_verified",
      headline: "Mesh's ledger did not pass its check, so there is no savings figure.",
      detail:
        `The record of requests on this machine does not verify${where}. Run mesh verify to see where it stops. ` +
        "Nothing is counted or billed from a ledger that does not verify." +
        (proxy.reachable ? "" : " Mesh is also not running right now."),
      fix: "mesh verify",
    };
  }

  if (proxy.reachable) {
    // 3. Requests are going through. Where they come from (Claude Code or the
    //    user's own app) does not matter: nothing to fix, nothing to nag about.
    if (recent) {
      return {
        state: "flowing",
        headline: `Mesh is working: the last request went through it ${ago}.`,
        detail:
          `${requests} recorded on this machine so far, ledger verified. ` +
          (claudeCode.state === "pointed_at_mesh" ? "Claude Code is pointed at Mesh." : "The requests are coming from an app pointed at Mesh."),
        fix: null,
      };
    }
    // 4. Connected, but quiet.
    if (clientPointed) {
      const who = claudeCode.state === "pointed_at_mesh" ? "Claude Code is pointed at it" : "this terminal's base URL points at it";
      if (ledger.empty) {
        return {
          state: "connected_idle",
          headline: "Mesh is connected but has not seen a request yet.",
          detail:
            `Mesh is running on ${base} and ${who}. Open a new Claude Code session; your next message goes through Mesh. ` +
            "A session that was already open keeps its old address until it is restarted.",
          fix: null,
        };
      }
      return {
        state: "connected_idle",
        headline: ago === null
          ? "Mesh is connected, but when it last saw a request is not known."
          : `Mesh is connected but has seen no request for more than ${IDLE_AFTER_DAYS} days (the last was ${ago}).`,
        detail:
          `Mesh is running on ${base} and ${who}. That is normal if you have not used it since. If you have, open a new ` +
          "Claude Code session and send a message; if it still does not show here, run mesh doctor.",
        fix: null,
      };
    }
    if (claudeCode.state === "settings_invalid") {
      return {
        state: "settings_invalid",
        headline: "Claude Code's settings file cannot be read, so Mesh cannot tell whether Claude Code is connected and will not touch the file.",
        detail:
          `~/.claude/settings.json is not valid JSON. Fix it (or move it aside), then run mesh setup. Mesh itself is running on ${base}. ${lastSeen}`,
        fix: null,
      };
    }
    if (claudeCode.state === "pointed_elsewhere") {
      return {
        state: "pointed_elsewhere",
        headline: "Claude Code is pointed at another address, not at Mesh, so Mesh sees none of its requests.",
        detail:
          "The address is ANTHROPIC_BASE_URL in ~/.claude/settings.json; Mesh does not print it and will not replace it. " +
          "If it is out of date, remove it and run mesh setup. To put Mesh in front of it, run mesh start --anthropic-base <that address>. " +
          lastSeen,
        fix: null,
      };
    }
    return {
      state: "client_not_pointed",
      headline: ledger.empty
        ? "Mesh is running but has seen no requests: Claude Code is not pointed at it."
        : ago === null
          ? "Mesh is running, but Claude Code is not pointed at it and when it last saw a request is not known."
          : `Mesh is running but has seen no request for more than ${IDLE_AFTER_DAYS} days (the last was ${ago}): Claude Code is not pointed at it.`,
      detail:
        "Neither Claude Code's settings nor the terminal this was run from points at Mesh. For Claude Code, run mesh setup. " +
        `For your own app, set its base URL to ${base} (mesh connect shows how for each kind of client).`,
      fix: "mesh setup",
    };
  }

  // From here on Mesh does not answer on its port.
  // 5. Something else does.
  if (proxy.portOpen) {
    const other = port < 65535 ? port + 1 : port - 1;
    return {
      state: "port_taken",
      headline: `Another program is using port ${port}, so Mesh cannot run there and nothing is going through it.`,
      detail:
        `Something answers on port ${port}, and it is not Mesh. Set Mesh up on a free port instead` +
        (service.installed ? "; the installed background service is on the taken port." : ".") +
        ` ${lastSeen}`,
      fix: `mesh setup --port ${other}`,
    };
  }
  // 6. The service is registered, but its proxy is down.
  if (service.installed) {
    return {
      state: "proxy_down",
      headline: "Mesh's background service is installed but not answering, so nothing is going through it.",
      detail:
        `Nothing answers on port ${port}. Restart the service with mesh install; its log is ~/.mesh/daemon.log. ${lastSeen}` +
        (claudeCode.state === "settings_invalid" ? " Claude Code's settings file also cannot be read as JSON; Mesh will not touch it." : ""),
      fix: "mesh install",
    };
  }
  if (claudeCode.state === "settings_invalid") {
    return {
      state: "settings_invalid",
      headline: "Claude Code's settings file cannot be read, so Mesh cannot tell whether Claude Code is connected and will not touch the file.",
      detail:
        `~/.claude/settings.json is not valid JSON. Fix it (or move it aside), then run mesh setup. Mesh is also not running. ${lastSeen}`,
      fix: null,
    };
  }
  const elsewhere = claudeCode.state === "pointed_elsewhere"
    ? " Claude Code is pointed at another address (ANTHROPIC_BASE_URL in ~/.claude/settings.json), which Mesh will not replace."
    : "";
  // 7. Mesh ran here before and is not running now.
  if (!ledger.empty) {
    return {
      state: "proxy_down",
      headline: ago === null
        ? "Mesh is not running, so nothing is going through it."
        : `Mesh is not running, so nothing is going through it. The last request it saw was ${ago}.`,
      detail:
        "Mesh only sees requests while it runs. " +
        (service.supported
          ? "mesh setup offers always-on (it starts at login and stays up); mesh start runs it in a terminal while you work."
          : "mesh start runs it in a terminal while you work (mesh proxy for your own app).") +
        (ago === null ? ` Mesh has recorded ${requests}, but when the last one was is not known.` : "") +
        elsewhere,
      fix: service.supported ? "mesh setup" : "mesh start",
    };
  }
  // 8. Installed, never connected.
  return {
    state: "not_set_up",
    headline: "Mesh is installed but not connected, so it has seen nothing and saved nothing.",
    detail:
      "Nothing is running and Claude Code is not pointed at Mesh. Installing Mesh does not connect it; mesh setup does, " +
      "and says so when it is done." +
      elsewhere,
    fix: "mesh setup",
  };
}

/** The two lines every command prints first: the headline, then the fix when there is one. */
export function flowLines(flow: Flow): string[] {
  return flow.fix === null ? [flow.headline] : [flow.headline, `Fix: ${flow.fix}`];
}
