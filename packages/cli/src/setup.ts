/**
 * `mesh setup` — connect Mesh, or say plainly that it is not connected.
 *
 * Installing Mesh puts a launcher on disk and nothing else: no proxy runs and
 * nothing points at it. This command is the step between "installed" and
 * "working". It asks two things (or takes them as flags): do you use Claude
 * Code or your own app, and should Mesh stay on in the background. It prints
 * what it is about to change in plain words, changes it through the SAME
 * code `mesh install` uses (daemon.ts), waits for the proxy to answer its
 * health check, runs the flow detector, and says what is now true.
 *
 * Rules it keeps:
 *   - It asks questions only when stdin and stdout are a terminal. Anywhere
 *     else (an agent, a pipe, CI, `--json`) it takes flags and never waits:
 *     a missing answer is a plain error naming the flags, exit 1.
 *   - It never reads, asks for or prints an API key. A client keeps its own.
 *   - It never writes a Claude Code settings file it cannot parse, and never
 *     replaces a base URL that points somewhere other than Mesh.
 *   - Everything it changes is undone by `mesh uninstall` (the service and
 *     the address in Claude Code's settings). If the proxy does not answer
 *     after it registered a new service, it undoes that itself, so Claude
 *     Code is never left pointed at something that is not running.
 *   - Run again on a connected machine, it changes nothing and says so.
 *   - No network call beyond health requests to the local proxy port.
 *
 * `setupMesh` returns the result and never prints or exits (it reports
 * progress through `say`); `runSetup` is the thin printer.
 */
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import { checkWiring, repairWiring } from "./claude-wiring.js";
import { collectConnect, type ConnectClient } from "./connect.js";
import {
  collectStatus,
  installService,
  serviceBaseUrl,
  uninstallService,
  type ServiceTarget,
  type StatusOptions,
  type StatusResult,
} from "./daemon.js";
import type { Flow } from "./flow.js";
import { CliError, meshIdentity, parseFlags, parsePortFlag, usageError, writeJson, type MeshIdentity } from "./json-output.js";
import { DEFAULT_PORT, LAUNCHD_LABEL, LAUNCHD_PLIST, portOpen, probeProxy, proxyUrls } from "./machine.js";
import { DUE_HOUR, defaultMeshHome, readReportState } from "./report-delivery.js";
import { CLAUDE_SETTINGS, WIRING_STATE } from "./start.js";
import { isInteractive } from "./terminal.js";

export const SETUP_SCHEMA = "mesh-setup/1";

/** How long setup waits for the proxy to answer its health check after starting the service. */
export const SETUP_WAIT_MS = 8000;

export type SetupClient = "claude-code" | "app";

export type SetupArgs = {
  client?: SetupClient;
  alwaysOn?: boolean;
  port?: number;
  /** Accept the default for anything not given, and go ahead without asking. */
  yes: boolean;
  /** Print the plan and change nothing. */
  dryRun: boolean;
  json: boolean;
};

export type SetupStep = {
  id: "restore_claude_code" | "copy_launcher" | "write_service_definition" | "register_service" | "point_claude_code";
  /** What will change, in plain words: which file, which setting, which service. */
  description: string;
  /** The file written, or the service's label. */
  target: string;
};

export type SetupResult = {
  schema: typeof SETUP_SCHEMA;
  /** True when Mesh is connected at the end, or when a dry run printed its plan. */
  ok: boolean;
  mesh: MeshIdentity;
  dryRun: boolean;
  client: SetupClient;
  alwaysOn: boolean;
  /** The answers that were not given and were taken as the defaults. */
  defaulted: Array<"client" | "alwaysOn">;
  port: number;
  baseUrls: { anthropic: string; openai: string };
  /** What setup set out to change. Empty when nothing on this machine needed changing. */
  plan: SetupStep[];
  /** Something on this machine was changed by this run and is still changed. */
  changed: boolean;
  /** The person at the terminal said no to the plan. */
  declined: boolean;
  /** The proxy did not answer after a new service was registered, so setup removed it again. */
  rolledBack: boolean;
  /** Requests can reach Mesh: for Claude Code, it is pointed at a Mesh that answers; for an app, the proxy answers. */
  connected: boolean;
  /** `connected` was already true before this run. */
  alreadyConnected: boolean;
  /** How it is connected, when it is. */
  via: "service" | "terminal-session" | null;
  /** The flow detector's answer after everything setup did (the same object as `mesh status --json`). */
  flow: Flow;
  /** The one command to run next when not connected; null when connected. */
  fix: string | null;
  /** What to do next, one plain sentence each, in order. */
  next: string[];
  /** For the user's own app: how each kind of client is pointed at Mesh. Empty for Claude Code. */
  clients: ConnectClient[];
  weeklyReport: {
    notifications: "on" | "off";
    /** When the weekly notification arrives while it is on. */
    arrives: string;
    read: "mesh report";
    turnOff: "mesh report --off";
    turnOn: "mesh report --on";
  };
  dashboard: "mesh dashboard";
  /** The commands that undo what setup changed. Empty when it changed nothing. */
  undo: string[];
  /** Present when `ok` is false. */
  error?: { code: "not_connected"; message: string };
};

/** What `setupMesh` works on. Every default is this user's own machine. */
export type SetupOptions = ServiceTarget & {
  /** Default <meshHome>/claude-wiring.json. */
  wiringStatePath?: string;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  now?: Date;
  timeZone?: string;
  /** The launcher the service is registered with. Default: the file that started this process. */
  launcherPath?: string;
  nodePath?: string;
  /** Wait for the proxy to answer its health check. Default: poll for SETUP_WAIT_MS. */
  waitForProxy?: (port: number) => Promise<boolean>;
  /** Ask the person at the terminal one question. Leave out anywhere a question cannot be answered. */
  ask?: (question: string) => Promise<string>;
  /** Progress, as it happens. Default: nothing. */
  say?: (line: string) => void;
};

const NEEDS_FLAGS =
  "mesh setup cannot ask questions here (this is not a terminal). Give the answers as flags: " +
  "--client claude-code or --client app; --always-on or --no-always-on; --yes to accept the defaults and go ahead; " +
  "--dry-run to see the plan and change nothing. Nothing was changed.";

/** A path as a person writes it: ~/… when it is under the home directory. */
function shown(path: string): string {
  const home = homedir();
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

/** Drop the keys whose value is undefined, so an optional field is absent rather than undefined. */
function defined<T extends object>(value: { [K in keyof T]?: T[K] | undefined }): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

async function defaultWait(port: number): Promise<boolean> {
  const deadline = Date.now() + SETUP_WAIT_MS;
  for (;;) {
    if ((await probeProxy(port, 1000)).isMesh) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((done) => setTimeout(done, 300));
  }
}

async function choose<T>(ask: (question: string) => Promise<string>, question: string, read: (answer: string) => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const value = read((await ask(question)).trim().toLowerCase());
    if (value !== undefined) return value;
  }
  throw usageError("No usable answer after three tries. Nothing was changed. Run mesh setup again, or give the answers as flags (mesh setup --help).");
}

const yesNo = (fallback: boolean) => (answer: string): boolean | undefined =>
  answer === "" ? fallback : ["y", "yes"].includes(answer) ? true : ["n", "no"].includes(answer) ? false : undefined;

/**
 * Connect Mesh on this machine, or work out that it is not connected and why.
 * Returns the result; never prints (progress goes to `say`) and never exits.
 * Throws a `CliError` when it refuses to go on: a missing answer where nobody
 * can be asked, a settings file it cannot parse, a base URL that is not Mesh's
 * to replace, a port another program holds. Nothing has been changed when it
 * throws.
 */
export async function setupMesh(args: SetupArgs, options: SetupOptions = {}): Promise<SetupResult> {
  const say = options.say ?? (() => {});
  const os = options.platform ?? platform();
  const supported = os === "darwin";
  const env = options.env ?? process.env;
  // Questions are asked only when someone can answer and has not waived them.
  const ask = args.json || args.yes || args.dryRun ? undefined : options.ask;
  const takeDefaults = args.yes || args.dryRun;

  const meshHome = options.meshHome ?? defaultMeshHome();
  const settingsPath = options.claudeSettingsPath ?? CLAUDE_SETTINGS;
  const statePath = options.wiringStatePath ?? (options.meshHome === undefined ? WIRING_STATE : join(meshHome, "claude-wiring.json"));
  const plistPath = options.plistPath ?? LAUNCHD_PLIST;
  const target: ServiceTarget = defined<ServiceTarget>({
    meshHome: options.meshHome,
    plistPath: options.plistPath,
    claudeSettingsPath: options.claudeSettingsPath,
    runner: options.runner,
  });
  const readStatus = (port?: number): Promise<StatusResult> =>
    collectStatus(defined<StatusOptions>({
      port,
      meshHome: options.meshHome,
      claudeSettingsPath: options.claudeSettingsPath,
      wiringStatePath: options.wiringStatePath,
      plistPath: options.plistPath,
      env,
      now: options.now,
      timeZone: options.timeZone,
      runner: options.runner,
      platform: os,
    }));

  // ---- the answers: flags, then questions, then defaults, else a plain error ----
  const defaulted: SetupResult["defaulted"] = [];
  let client = args.client;
  if (client === undefined) {
    if (ask !== undefined) {
      say("");
      say("  What do you use with Mesh?");
      say("    1. Claude Code");
      say("    2. My own app or agent (anything that takes a base URL)");
      client = await choose<SetupClient>(ask, "  Answer 1 or 2 [1]: ", (answer) =>
        ["", "1", "c", "claude", "claude code", "claude-code"].includes(answer)
          ? "claude-code"
          : ["2", "a", "app", "my own app"].includes(answer) ? "app" : undefined);
    } else if (takeDefaults) {
      client = "claude-code";
      defaulted.push("client");
    } else {
      throw usageError(NEEDS_FLAGS);
    }
  }
  let alwaysOn = args.alwaysOn;
  if (alwaysOn === true && !supported) {
    throw new CliError(
      "unsupported_platform",
      "Always-on uses the macOS background service (launchd) and is not available on this platform. " +
      `Run mesh setup --client ${client} --no-always-on: it explains ${client === "app" ? "mesh proxy" : "mesh start"}, which runs Mesh in a terminal while you work. Nothing was changed.`,
    );
  }
  if (alwaysOn === undefined) {
    if (!supported) {
      alwaysOn = false;
    } else if (ask !== undefined) {
      say("");
      say("  Keep Mesh always on? It runs in the background, starts when you log in and restarts if it stops.");
      say(client === "claude-code"
        ? "  If not, you run mesh start in a terminal each time you work."
        : "  If not, you run mesh proxy in a terminal each time you work.");
      alwaysOn = await choose<boolean>(ask, "  Always on? [Y/n]: ", yesNo(true));
    } else if (takeDefaults) {
      alwaysOn = true;
      defaulted.push("alwaysOn");
    } else {
      throw usageError(NEEDS_FLAGS);
    }
  }

  // ---- what is true now ----
  let status = await readStatus(args.port);
  let port = status.proxy.port;
  const other = port < 65535 ? port + 1 : port - 1;
  const plan: SetupStep[] = [];
  const notes: string[] = [];
  let install = false;
  let restore = false;

  if (client === "claude-code") {
    const state = status.claudeCode.state;
    if (state === "settings_invalid") {
      throw new CliError(
        "claude_settings_invalid",
        `Claude Code's settings file (${shown(settingsPath)}) cannot be read as JSON, so Mesh will not touch it. ` +
        "Fix the file or move it aside, then run mesh setup again. Nothing was changed.",
      );
    }
    if (state === "pointed_elsewhere") {
      throw new CliError(
        "claude_pointed_elsewhere",
        `Claude Code is pointed at another address (ANTHROPIC_BASE_URL in ${shown(settingsPath)}), not at Mesh. Mesh will not replace it: ` +
        "mesh uninstall could not put it back. If it is out of date, remove that setting and run mesh setup again. " +
        "To put Mesh in front of it, run mesh start --anthropic-base <that address>. Nothing was changed.",
      );
    }
    if (state === "pointed_at_stopped_proxy") {
      const wiring = await checkWiring({ settingsPath, statePath }, { portUp: portOpen });
      const sameAddress = status.claudeCode.port === port;
      if (wiring.status === "stranded") {
        // A `mesh start` that was killed left its address behind. The record of
        // what was there before exists, so put that back first (mesh restore).
        if (wiring.state.priorBaseUrl !== null) {
          throw new CliError(
            "claude_pointed_elsewhere",
            "A Mesh session ended without putting Claude Code's settings back, and before it Claude Code was pointed at another address. " +
            "Run mesh restore to put that address back; Mesh will not replace it. Nothing was changed.",
          );
        }
        restore = true;
      } else if (!sameAddress) {
        throw new CliError(
          "claude_pointed_elsewhere",
          `Claude Code is pointed at a local address${status.claudeCode.port === null ? "" : ` on port ${status.claudeCode.port}`} where nothing answers, ` +
          `and it is not the address this setup would use (port ${port}). If a Mesh session left it there, run mesh restore and then mesh setup again. ` +
          "If it belongs to another tool, start that tool or remove the setting. Nothing was changed.",
        );
      } else if (!alwaysOn && !status.service.installed) {
        // Mesh's own address with nothing behind it: take it out, so Claude Code
        // works again now and a later mesh start does not restore a dead address.
        restore = true;
      }
      if (restore) {
        plan.push({
          id: "restore_claude_code",
          description:
            `Take the address of a Mesh that is no longer running out of ${shown(settingsPath)} (what mesh restore does), ` +
            "so Claude Code reaches its provider again. Everything else in that file is kept.",
          target: settingsPath,
        });
      }
    }
  }

  const pointedAtMesh = client === "claude-code" && status.claudeCode.state === "pointed_at_mesh";
  if (pointedAtMesh && status.claudeCode.port !== null && status.claudeCode.port !== port) {
    // Connected already, to a Mesh on another port than the one asked about.
    notes.push(`Claude Code is already connected to Mesh on port ${status.claudeCode.port}, not port ${port}. To move it, run mesh uninstall first, then mesh setup --port ${port}.`);
    status = await readStatus(status.claudeCode.port);
    port = status.proxy.port;
  }
  const wasConnected = client === "claude-code" ? status.claudeCode.pointedAtMesh === true : status.proxy.reachable;
  const viaOf = (current: StatusResult): SetupResult["via"] => (current.service.installed ? "service" : "terminal-session");

  if (alwaysOn && !wasConnected) {
    if (status.proxy.reachable && !status.service.installed) {
      throw new CliError(
        "mesh_already_running",
        `Mesh is already running on port ${port} in a terminal (mesh start or mesh proxy), so a background service cannot use that port. ` +
        `Stop it there (Ctrl+C) and run mesh setup again, or set up always-on on another port: mesh setup --port ${other}. Nothing was changed.`,
      );
    }
    if (status.proxy.portOpen && !status.proxy.reachable) {
      throw new CliError(
        "port_in_use",
        `Port ${port} is in use by another program, so Mesh cannot run there. Use a free port: mesh setup --port ${other}. Nothing was changed.`,
      );
    }
    install = true;
  } else if (alwaysOn && wasConnected && !status.service.installed) {
    notes.push(
      "Mesh is running in a terminal on this machine, not as a background service, so it is connected only while that terminal stays open. " +
      "To make it always-on, stop it there (Ctrl+C) and run mesh setup again.",
    );
  } else if (!alwaysOn && status.service.installed) {
    notes.push("Mesh's background service is already installed on this machine. Choosing not to keep Mesh always on does not remove it: mesh uninstall does.");
  }

  if (install) {
    const resolvedTarget = { stableBin: join(meshHome, "bin", "mesh"), log: join(meshHome, "daemon.log") };
    const launcher = resolve(options.launcherPath ?? env.MESH_BOOTSTRAP_PATH ?? process.argv[1] ?? "");
    if (launcher !== resolvedTarget.stableBin) {
      plan.push({
        id: "copy_launcher",
        description: `Copy the Mesh launcher to ${shown(resolvedTarget.stableBin)} (from ${shown(launcher)}), so the service keeps working if the download moves.`,
        target: resolvedTarget.stableBin,
      });
    }
    plan.push({
      id: "write_service_definition",
      description:
        `Write the background service's definition to ${shown(plistPath)}. It runs "mesh serve --port ${port}" when you log in ` +
        `and restarts it if it stops. Its log is ${shown(resolvedTarget.log)}.`,
      target: plistPath,
    });
    plan.push({
      id: "register_service",
      description: `Register that service (${LAUNCHD_LABEL}) with macOS, which starts Mesh now on ${serviceBaseUrl(port)}.`,
      target: LAUNCHD_LABEL,
    });
    if (client === "claude-code") {
      plan.push({
        id: "point_claude_code",
        description:
          `Set env.ANTHROPIC_BASE_URL to ${serviceBaseUrl(port)} in ${shown(settingsPath)}, so Claude Code sends its requests through Mesh. ` +
          (existsSync(settingsPath) ? "Everything else in that file is kept." : "That file does not exist yet and will be created."),
        target: settingsPath,
      });
    }
  }

  // ---- say what is about to happen, before anything changes ----
  const forWhom = client === "claude-code" ? "Claude Code" : "your own app";
  const how = alwaysOn ? "always on (a background service)" : supported ? "not always on (you start it in a terminal)" : "started in a terminal (always-on is macOS only)";
  say("");
  say(`  mesh setup: ${forWhom}, ${how}, port ${port}.`);
  if (defaulted.length > 0) {
    say(`  These are the defaults; choose with --client claude-code|app and --always-on or --no-always-on.`);
  }
  say("");
  if (plan.length === 0) {
    say(wasConnected ? "  Nothing on this machine needs changing." : "  This changes nothing on your machine.");
  } else {
    say(args.dryRun ? "  Mesh would make these changes:" : "  Mesh will make these changes:");
    plan.forEach((step, index) => say(`    ${index + 1}. ${step.description}`));
    say("");
    say("  Mesh does not read, ask for or store your API key: your client keeps it and Mesh passes it straight through.");
    if (install) say("  Undo all of it at any time with: mesh uninstall");
  }
  for (const note of notes) { say(""); say(`  ${note}`); }

  let declined = false;
  let changed = false;
  let rolledBack = false;
  if (plan.length > 0 && !args.dryRun) {
    if (!args.yes) {
      if (ask === undefined) {
        throw usageError(
          "mesh setup would change this machine and cannot ask you here (this is not a terminal). " +
          "Add --yes to go ahead, or --dry-run to see the plan and change nothing. Nothing was changed.",
        );
      }
      say("");
      declined = !(await choose<boolean>(ask, "  Go ahead? [Y/n]: ", yesNo(true)));
    }
    if (!declined) {
      if (restore) {
        const repaired = await repairWiring({ settingsPath, statePath }, { portUp: portOpen });
        changed = changed || repaired.changed;
        say("");
        say(`  ${repaired.message}`);
      }
      if (install) {
        const hadService = status.service.installed;
        say("");
        say(`  Starting Mesh and waiting for it to answer on ${serviceBaseUrl(port)} ...`);
        const installed = await installService({
          ...target,
          port,
          pointClaudeCode: client === "claude-code",
          waitForProxy: options.waitForProxy ?? defaultWait,
          ...(options.launcherPath === undefined ? {} : { launcherPath: options.launcherPath }),
          ...(options.nodePath === undefined ? {} : { nodePath: options.nodePath }),
        });
        changed = true;
        if (!installed.up && !hadService) {
          // Never leave Claude Code pointed at a proxy that did not start.
          uninstallService(target);
          rolledBack = true;
          changed = false;
          say(`  Mesh did not answer within ${Math.round(SETUP_WAIT_MS / 1000)} seconds, so setup removed the service again and put Claude Code's settings back.`);
        }
      }
      status = await readStatus(port);
    }
  }

  // ---- what is true now ----
  const connected = client === "claude-code" ? status.claudeCode.pointedAtMesh === true : status.proxy.reachable;
  const urls = proxyUrls(port);
  const portFlag = port === DEFAULT_PORT ? "" : ` --port ${port}`;
  const clients = client === "app"
    ? (await collectConnect({ port, plistPath, wiringStatePath: statePath })).clients.filter((entry) => entry.id !== "claude-code")
    : [];
  const report = readReportState(meshHome);
  const serviceNow = status.service.installed;

  let fix: string | null = null;
  const next: string[] = [];
  if (connected) {
    if (client === "claude-code") {
      next.push("Open a new Claude Code session; your next message goes through Mesh.");
    } else {
      next.push(`Point your app at Mesh and keep your own API key: ANTHROPIC_BASE_URL=${urls.anthropic} for Anthropic-style clients, OPENAI_BASE_URL=${urls.openai} for OpenAI-style clients.`);
    }
    next.push("See whether requests are flowing at any time: mesh");
  } else if (args.dryRun && plan.length > 0) {
    fix = `mesh setup --client ${client} ${alwaysOn ? "--always-on" : "--no-always-on"}${portFlag} --yes`;
    next.push(`Make these changes: ${fix}`);
  } else if (declined) {
    fix = "mesh setup";
    next.push("Run mesh setup again when you are ready.");
  } else if (rolledBack) {
    fix = "mesh doctor";
    next.push(`See why Mesh did not start: mesh doctor, and the service's log at ${shown(join(meshHome, "daemon.log"))}.`);
    next.push(client === "claude-code" ? "Until then, mesh start runs Mesh in a terminal while you work." : "Until then, mesh proxy runs Mesh in a terminal while you work.");
  } else if (install || serviceNow) {
    // The service is registered and still does not answer: the detector knows which case.
    fix = status.flow.fix ?? "mesh doctor";
    next.push(`Run: ${fix}`);
  } else if (client === "claude-code") {
    fix = `mesh start${portFlag}`;
    next.push(`Run ${fix} in its own terminal and leave it open while you work. It points Claude Code at Mesh while it runs and puts the settings back when you stop it (Ctrl+C).`);
    next.push("Then open a new Claude Code session; your next message goes through Mesh.");
  } else {
    fix = `mesh proxy${portFlag}`;
    next.push(`Run ${fix} in its own terminal and leave it open while your app runs.`);
    next.push(`Point your app at Mesh and keep your own API key: ANTHROPIC_BASE_URL=${urls.anthropic} for Anthropic-style clients, OPENAI_BASE_URL=${urls.openai} for OpenAI-style clients.`);
    if (supported) next.push("To have Mesh always on instead: mesh setup --client app --always-on");
  }

  const ok = args.dryRun ? true : connected;
  return {
    schema: SETUP_SCHEMA,
    ok,
    mesh: meshIdentity(),
    dryRun: args.dryRun,
    client,
    alwaysOn,
    defaulted,
    port,
    baseUrls: { anthropic: urls.anthropic, openai: urls.openai },
    plan,
    changed,
    declined,
    rolledBack,
    connected,
    alreadyConnected: wasConnected,
    via: connected ? viaOf(status) : null,
    flow: status.flow,
    fix,
    next,
    clients,
    weeklyReport: {
      notifications: report.notifications,
      arrives: `once a week, after Monday ${String(DUE_HOUR).padStart(2, "0")}:00 on this machine's clock, while Mesh is running`,
      read: "mesh report",
      turnOff: "mesh report --off",
      turnOn: "mesh report --on",
    },
    dashboard: "mesh dashboard",
    undo: (install && changed) || (connected && serviceNow) ? ["mesh uninstall"] : [],
    ...(ok ? {} : { error: { code: "not_connected" as const, message: `Mesh is not connected. ${status.flow.headline}${fix === null ? "" : ` Next: ${fix}`}` } }),
  };
}

/** The closing words: what is now true, where to look, how to undo. Pure. */
export function renderSetupResult(result: SetupResult): string {
  const lines: string[] = [];
  const base = result.baseUrls.anthropic;
  lines.push("");
  if (result.dryRun) {
    lines.push("  Dry run: nothing was changed.");
    if (result.connected) lines.push(`  Mesh is already connected on ${base}.`);
    else lines.push(`  Right now: ${result.flow.headline}`);
    for (const line of result.next) lines.push(`  ${line}`);
    lines.push("");
    return lines.join("\n");
  }
  if (result.connected) {
    const what = result.client === "claude-code"
      ? `Mesh is running on ${base} and Claude Code is pointed at it`
      : `Mesh is running on ${base}, ready for your app`;
    const kind = result.via === "service" ? " (always on: the background service)" : " (while the terminal running it stays open)";
    lines.push(`  ${result.alreadyConnected && !result.changed ? "Already connected" : "Connected"}. ${what}${kind}.`);
    if (!result.changed) lines.push("  Nothing was changed.");
    lines.push("");
    for (const line of result.next) lines.push(`  ${line}`);
    for (const entry of result.clients) {
      lines.push(`    ${entry.name}`);
      lines.push(`      ${entry.instruction}`);
    }
    lines.push("");
    lines.push(`  Dashboard      ${result.dashboard}`);
    lines.push(
      result.weeklyReport.notifications === "on"
        ? `  Weekly report  ON: ${result.weeklyReport.arrives}, one notification says what Mesh saved you.`
        : "  Weekly report  OFF: Mesh shows no weekly notification.",
    );
    lines.push(
      result.weeklyReport.notifications === "on"
        ? `                 Read it any time: ${result.weeklyReport.read}. Turn the notification off: ${result.weeklyReport.turnOff}`
        : `                 Read it any time: ${result.weeklyReport.read}. Turn the notification on: ${result.weeklyReport.turnOn}`,
    );
    lines.push(
      result.via === "service"
        ? "  Undo           mesh uninstall  (stops and removes the service and takes Mesh's address out of Claude Code's settings; your ledger is kept)"
        : "  Undo           Ctrl+C in the terminal running Mesh; if that terminal was killed, mesh restore",
    );
    lines.push("");
    return lines.join("\n");
  }
  lines.push(
    result.declined
      ? "  NOT connected. You said no, so nothing was changed."
      : result.rolledBack
        ? "  NOT connected. Mesh did not start, and setup undid what it had changed."
        : result.changed
          ? "  NOT connected."
          : "  NOT connected yet. Nothing was changed.",
  );
  lines.push(`  State: ${result.flow.state}. ${result.flow.headline}`);
  lines.push("");
  if (result.fix !== null) lines.push(`  Next: ${result.fix}`);
  for (const line of result.next) lines.push(`  ${line}`);
  for (const entry of result.clients) {
    lines.push(`    ${entry.name}`);
    lines.push(`      ${entry.instruction}`);
  }
  if (result.undo.length > 0) lines.push(`  Undo what was changed: ${result.undo.join(", ")}`);
  lines.push("");
  return lines.join("\n");
}

const USAGE = `Usage: mesh setup [options]

Connect Mesh on this machine, or say plainly that it is not connected.
In a terminal it asks two questions; anywhere else it takes them as flags and
never waits for input.

  --client claude-code|app   What you use with Mesh: Claude Code, or your own
                             app or agent (anything that takes a base URL).
  --always-on                Keep Mesh running as a background service that
                             starts at login (macOS). The default where it exists.
  --no-always-on             Do not; setup explains mesh start (Claude Code) or
                             mesh proxy (your own app), which run in a terminal.
  --port <n>                 The proxy's port. Default: the port already in use
                             on this machine, else 8787.
  --yes                      Accept the default for anything not given, and go
                             ahead without asking.
  --dry-run                  Print exactly what would change, and change nothing.
  --json                     Print one JSON object (schema ${SETUP_SCHEMA}) instead
                             of text. Never asks a question.
  --help                     Show this message.

It never reads, asks for or prints an API key. It will not write a Claude Code
settings file it cannot read as JSON, and will not replace a base URL that
points somewhere other than Mesh. Undo everything it does: mesh uninstall.

Exits 0 when Mesh is connected at the end (or a dry run printed its plan).
Exits 1 when it is not connected, with the state and the next command, the
same with --json.`;

export function parseSetupArgs(argv: readonly string[]): SetupArgs & { help: boolean } {
  const { values, flags } = parseFlags("setup", argv, {
    valueFlags: ["--client", "--port"],
    booleanFlags: ["--always-on", "--no-always-on", "--yes", "--dry-run"],
  });
  const client = values["--client"];
  if (client !== undefined && client !== "claude-code" && client !== "app") {
    throw usageError("--client must be claude-code or app.");
  }
  if (flags.has("--always-on") && flags.has("--no-always-on")) throw usageError("Use --always-on or --no-always-on, not both.");
  const port = parsePortFlag(values["--port"]);
  return {
    ...(client === undefined ? {} : { client }),
    ...(flags.has("--always-on") ? { alwaysOn: true } : flags.has("--no-always-on") ? { alwaysOn: false } : {}),
    ...(port === undefined ? {} : { port }),
    yes: flags.has("--yes"),
    dryRun: flags.has("--dry-run"),
    json: flags.has("--json"),
    help: flags.has("--help"),
  };
}

export async function runSetup(argv: string[], options: SetupOptions = {}): Promise<void> {
  const { help, ...args } = parseSetupArgs(argv);
  if (help) { console.log(USAGE); return; }

  // A question is asked only of a person at a terminal, and never in JSON mode.
  const mayAsk = !args.json && options.ask === undefined && isInteractive();
  const terminal = mayAsk ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  // A terminal that closes mid-question (Ctrl+D) is an answer of its own: stop, having changed nothing.
  const askTerminal = terminal === undefined ? undefined : (question: string): Promise<string> =>
    new Promise((answered, failed) => {
      const closed = (): void => failed(usageError("The terminal closed before an answer was given. Nothing was changed."));
      terminal.once("close", closed);
      terminal.question(question).then((answer) => { terminal.off("close", closed); answered(answer); }, failed);
    });
  try {
    const result = await setupMesh(args, {
      ...options,
      ...(askTerminal === undefined ? {} : { ask: askTerminal }),
      // In JSON mode stdout carries the one object and nothing else.
      say: args.json ? () => {} : options.say ?? ((line: string) => console.log(line)),
    });
    if (!result.ok) process.exitCode = 1;
    if (args.json) { writeJson(result); return; }
    console.log(renderSetupResult(result));
  } finally {
    terminal?.close();
  }
}
