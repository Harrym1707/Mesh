/**
 * The one dispatcher: which function a `mesh` command runs.
 *
 * Both entry points use it (mesh-runtime.ts, the download; main.ts, which
 * adds the `analyse` dev tool), so they cannot disagree about which commands
 * exist, and a test can run any command through the real dispatch in-process.
 *
 * `context` carries what a test injects and a real run leaves out: where the
 * always-on service lives and who registers it (temporary paths and a fake
 * service manager), and the same for `mesh setup` and `mesh restore`. With
 * nothing injected every command works on this user's own machine.
 *
 * Each command's module is imported only when that command runs, so starting
 * `mesh status` does not load the proxy.
 */
import type { ServiceTarget } from "./daemon.js";
import type { RestoreOptions } from "./diag.js";
import type { SetupOptions } from "./setup.js";

export type DispatchContext = {
  /** The usage text `mesh --help` prints. Each entry point has its own list. */
  usage: string;
  /** For `install`, `stop` and `uninstall`. Default: this user's own machine and the real `launchctl`. */
  service?: ServiceTarget;
  /** For `setup`. */
  setup?: SetupOptions;
  /** For `restore`. */
  restore?: RestoreOptions;
};

/** Every command of the client runtime, as typed after `mesh`. */
export const RUNTIME_COMMANDS = [
  "setup", "start", "proxy", "serve", "install", "uninstall", "stop", "status", "update", "verify", "connect",
  "report", "statement", "doctor", "restore", "dashboard", "theo", "version", "compaction",
] as const;

export type RuntimeCommand = (typeof RUNTIME_COMMANDS)[number];

export function isRuntimeCommand(name: string | undefined): name is RuntimeCommand {
  return name !== undefined && (RUNTIME_COMMANDS as readonly string[]).includes(name);
}

/**
 * Run `mesh <argv...>`. Returns false, having done nothing, when the first
 * argument is not something the client runtime knows; the caller decides
 * what that means (an error in the download; `analyse` in main.ts).
 */
export async function dispatch(argv: readonly string[], context: DispatchContext): Promise<boolean> {
  const [sub, ...rest] = argv;
  if (sub === undefined) {
    // Bare `mesh`: the summary and the next step, not the usage text.
    await (await import("./summary.js")).runSummary();
    return true;
  }
  if (sub === "--json" && rest.length === 0) {
    // `mesh --json` is `mesh status --json`.
    await (await import("./daemon.js")).runStatus(["--json"]);
    return true;
  }
  if (sub === "--help" || sub === "-h" || sub === "help") {
    console.log(context.usage);
    return true;
  }
  if (sub === "--version" || sub === "-v") {
    (await import("./diag.js")).runVersion(rest);
    return true;
  }
  if (!isRuntimeCommand(sub)) return false;
  switch (sub) {
    case "setup": await (await import("./setup.js")).runSetup(rest, context.setup ?? {}); break;
    case "start": await (await import("./start.js")).runStart(rest); break;
    // The same proxy and Theo as `start`, for an application rather than Claude Code.
    case "proxy": await (await import("./start.js")).runStart(["--no-install", ...rest]); break;
    case "serve": await (await import("./start.js")).runServe(rest); break;
    case "install": await (await import("./daemon.js")).runInstall(rest, context.service ?? {}); break;
    case "uninstall": (await import("./daemon.js")).runUninstall(rest, context.service ?? {}); break;
    case "stop": (await import("./daemon.js")).runStop(rest, context.service ?? {}); break;
    case "status": await (await import("./daemon.js")).runStatus(rest); break;
    case "update": await (await import("./update.js")).runUpdate(rest); break;
    case "verify": await (await import("./verify.js")).runVerify(rest); break;
    case "connect": await (await import("./connect.js")).runConnect(rest); break;
    case "report": await (await import("./report-command.js")).runReport(rest); break;
    case "statement": await (await import("./statement.js")).runStatement(rest); break;
    case "doctor": await (await import("./diag.js")).runDoctor(rest); break;
    case "restore": await (await import("./diag.js")).runRestore(rest, context.restore ?? {}); break;
    case "dashboard": await (await import("./dashboard.js")).runDashboard(rest); break;
    case "theo": await (await import("./theo.js")).runTheo(rest); break;
    case "version": (await import("./diag.js")).runVersion(rest); break;
    case "compaction": await (await import("./compaction.js")).runCompaction(rest); break;
  }
  return true;
}

/** The error for a first argument that is not a command. */
export async function unknownCommand(name: string): Promise<Error> {
  const { CliError } = await import("./json-output.js");
  return new CliError("unknown_command", `Unknown command: ${name}. Run mesh --help for the list of commands.`);
}
