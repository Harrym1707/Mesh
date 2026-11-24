/**
 * The `--json` conventions, in one place. Every command an agent reads follows
 * them (docs/guide/commands.md has the same list for callers):
 *
 *   - With `--json`, stdout carries exactly ONE JSON object followed by a
 *     newline, and nothing else. Progress, warnings and everything a command
 *     would otherwise print go to stderr. No ANSI codes.
 *   - Every object has `schema` (for example "mesh-status/1") and
 *     `mesh: { version, build }`. Field names are stable within a schema
 *     number; a field is only ever added, never renamed or removed.
 *   - Amounts are numbers in US dollars; the object names the currency once
 *     (`currency: "USD"`). Where a fee appears it is also given in integer
 *     cents. Verdicts are the bill's own values, "charge" or "do_not_charge",
 *     with a `reason` when nothing is charged. Hashes are given in full.
 *   - A command that cannot do its job still prints one object,
 *     `{ schema, ok: false, mesh, error: { code, message } }`, and exits
 *     non-zero. Exit codes mean the same with and without `--json`:
 *     0 the command did its job and found nothing wrong; 1 anything else.
 *   - No object contains an API key, a prompt, a tool argument or any free
 *     text taken from a request (json-no-leak.test.ts).
 *
 * The functions that BUILD the objects (agent-api.ts) return them and never
 * print or exit, so an in-process caller such as an MCP server reuses them.
 * Only the thin `run*` printers and this module touch stdout.
 */
import { BUILD_COMMIT, VERSION } from "./build-info.js";

export type MeshIdentity = { version: string; build: string };

/** The build every JSON object names. */
export function meshIdentity(): MeshIdentity {
  return { version: VERSION, build: BUILD_COMMIT };
}

/**
 * Stable error codes. An agent branches on these, not on the message.
 *
 *   usage                  a flag was wrong, unknown or missing its value
 *   unknown_command        there is no such `mesh` command in this build
 *   port_in_use            another program holds the port
 *   mesh_already_running   MESH itself already answers on the port
 *   no_ledger              there is no ledger to read yet
 *   ledger_not_verified    the ledger's hash chain does not verify
 *   statement_not_valid    a statement file failed its seal or signature check
 *   unsupported_platform   the command is not available on this platform
 *   claude_settings_invalid  ~/.claude/settings.json is not valid JSON
 *   network                a download or update check could not reach its host
 *   unexpected             anything else; the message says what
 */
export type MeshErrorCode =
  | "usage"
  | "unknown_command"
  | "port_in_use"
  | "mesh_already_running"
  | "no_ledger"
  | "ledger_not_verified"
  | "statement_not_valid"
  | "unsupported_platform"
  | "claude_settings_invalid"
  | "network"
  | "unexpected";

/** An error with a stable code. Thrown by commands; printed by `reportFatal`. */
export class CliError extends Error {
  readonly code: MeshErrorCode;
  constructor(code: MeshErrorCode, message: string) {
    super(message);
    this.name = "CliError";
    this.code = code;
  }
}

/** A usage error: a wrong, unknown or incomplete flag. */
export function usageError(message: string): CliError {
  return new CliError("usage", message);
}

export type JsonFailure = {
  schema: string;
  ok: false;
  mesh: MeshIdentity;
  error: { code: MeshErrorCode; message: string };
};

/** The object a failed command prints in JSON mode. */
export function jsonFailure(schema: string, error: unknown): JsonFailure {
  const code: MeshErrorCode = error instanceof CliError ? error.code : "unexpected";
  const message = error instanceof Error ? error.message : String(error);
  return { schema, ok: false, mesh: meshIdentity(), error: { code, message } };
}

/** True when the arguments ask for JSON output. */
export function wantsJson(argv: readonly string[]): boolean {
  return argv.includes("--json");
}

/** Exactly one object, one line, one newline. The only stdout write in JSON mode. */
export function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/**
 * Reject anything that is not one of the flags a read-only command takes, so
 * a mistyped `--jsno` fails loudly instead of quietly printing text an agent
 * then cannot parse. `valueFlags` take one value; `booleanFlags` take none.
 */
export function parseFlags<V extends string, B extends string>(
  command: string,
  argv: readonly string[],
  spec: { valueFlags?: readonly V[]; booleanFlags?: readonly B[] },
): { values: Partial<Record<V, string>>; flags: Set<B | "--json" | "--help"> } {
  const values: Partial<Record<V, string>> = {};
  const flags = new Set<B | "--json" | "--help">();
  const valueFlags = (spec.valueFlags ?? []) as readonly string[];
  const booleanFlags = (spec.booleanFlags ?? []) as readonly string[];
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]!;
    if (key === "--json") { flags.add("--json"); continue; }
    if (key === "--help" || key === "-h") { flags.add("--help"); continue; }
    if (booleanFlags.includes(key)) { flags.add(key as B); continue; }
    if (valueFlags.includes(key)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw usageError(`${key} needs a value.`);
      values[key as V] = value;
      index += 1;
      continue;
    }
    throw usageError(`Unknown option: ${key}. See mesh ${command} --help.`);
  }
  return { values, flags };
}

/** A `--port` value as a usable port number, or a usage error. */
export function parsePortFlag(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw usageError("--port must be 1-65535.");
  return port;
}

/** The schema a command's JSON output carries, used when it fails before building one. */
export function schemaFor(command: string | undefined): string {
  switch (command) {
    case "--version":
    case "-v":
      return "mesh-version/1";
    case "--json":
      // Bare `mesh --json` is `mesh status --json`.
      return "mesh-status/1";
    case undefined:
      return "mesh-error/1";
    default:
      return /^[a-z][a-z-]*$/.test(command) ? `mesh-${command}/1` : "mesh-error/1";
  }
}

/**
 * The last line of defence in both entry points: a command threw. In JSON
 * mode print the failure object on stdout; otherwise the message on stderr.
 * Exit 1 either way, after stdout has drained.
 */
export function reportFatal(error: unknown, argv: readonly string[] = process.argv.slice(2)): void {
  const [command, ...rest] = argv;
  if (wantsJson(rest) || command === "--json") {
    const failure = jsonFailure(schemaFor(command), error);
    process.stdout.write(`${JSON.stringify(failure)}\n`, () => process.exit(1));
    return;
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
