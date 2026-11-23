/**
 * mesh-customer-key — the operator's registry of customer statement keys.
 *
 * `scripts/mesh-bill.ts` bills a customer only from a statement signed by the
 * statement key registered for that customer, and it reads that key from a
 * registry file on the operator's machine, by Stripe customer id. THIS command
 * is the only thing that writes the registry. The billing script cannot: it
 * has no code that does.
 *
 * Why a separate command. The fingerprint used to be typed on `mesh-bill`'s
 * command line on every run. An operator could then copy the fingerprint
 * printed on the statement that had just arrived, and the "who wrote it" check
 * passed for whoever wrote that statement. Now the key is registered once,
 * here, when billing is agreed, and `mesh-bill` refuses a statement that was
 * written before its key was registered.
 *
 * WHERE THE FINGERPRINT COMES FROM. From the customer, through the channel
 * agreed in writing: it is what their own `mesh statement --key` prints.
 * NEVER from a statement. This command deliberately does not read statement
 * files and refuses to be given one.
 *
 * The registry file (default ~/.config/mesh/customer-keys.jsonl, outside the
 * repository; override with --registry <file> or $MESH_CUSTOMER_KEYS):
 *   - append-only JSON Lines. Every write adds exactly one line and syncs it to
 *     disk; nothing here ever rewrites or truncates the file;
 *   - each entry is hash-chained onto the one before it, so a line edited,
 *     removed from the middle or moved is evident (`verify`);
 *   - created owner-only (folder 0700, file 0600; best effort where mode bits
 *     do not apply). It holds public fingerprints and notes: not a secret, no
 *     key material.
 *
 * What it does not do: the chain has no secret in it, so it does not stop an
 * operator who rewrites the whole file or cuts lines off its end, and the time
 * on an entry is this machine's clock. Back the file up, and note each entry's
 * hash in the operator log. The format and every rule are pure and unit-tested
 * in packages/core/src/customer-key-registry.ts; this script only calls them.
 *
 * Usage:
 *   node --import tsx scripts/mesh-customer-key.ts register --customer cus_XXX \
 *     --fingerprint <64 hex> --channel "<how it was received and confirmed>"
 *   node --import tsx scripts/mesh-customer-key.ts replace --customer cus_XXX \
 *     --fingerprint <new 64 hex> --channel "<how the change was confirmed, separately from any statement>"
 *   node --import tsx scripts/mesh-customer-key.ts revoke --customer cus_XXX --channel "<why, and who confirmed it>"
 *   node --import tsx scripts/mesh-customer-key.ts show --customer cus_XXX
 *   node --import tsx scripts/mesh-customer-key.ts list
 *   node --import tsx scripts/mesh-customer-key.ts verify
 */
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  CUSTOMER_KEY_REGISTRY_ENV,
  STATEMENT_KEY_DIR,
  STATEMENT_KEY_FILE,
  buildNextCustomerKeyEntry,
  currentCustomerKey,
  customerKeyHistory,
  parseStatementKeyFile,
  registryCustomers,
  serializeCustomerKeyEntry,
  type CustomerKeyAction,
  type CustomerKeyEntry,
} from "../packages/core/dist/src/index.js";
import { customerKeyRegistryFilePath, readCustomerKeyRegistryFile } from "./customer-key-registry-file.js";

const HELP = `mesh-customer-key — the operator's registry of customer statement keys.

mesh-bill bills a customer only from a statement signed by the key registered here for
that customer, and only when the key was registered BEFORE the statement was written.

  register --customer cus_… --fingerprint <64 hex> --channel "<text>"
      Record a customer's first statement key. <text> says how the fingerprint was
      received and confirmed with the customer.
  replace  --customer cus_… --fingerprint <new 64 hex> --channel "<text>"
      Record a changed key. The old key stops being accepted. <text> says how the
      change was confirmed with the customer, separately from any statement.
  revoke   --customer cus_… --channel "<text>"
      End the customer's current key. mesh-bill refuses to bill them until a key
      is registered again.
  show     --customer cus_…     The customer's current key, when it was registered, and its history.
  list                          Every customer in the registry.
  verify                        Check the registry's hash chain.

  --registry <file>   The registry file. Default: $${CUSTOMER_KEY_REGISTRY_ENV} if set,
                      otherwise ~/.config/mesh/customer-keys.jsonl.

The fingerprint comes from the customer, through the channel agreed in writing: it is
what their own \`mesh statement --key\` prints. It NEVER comes from a statement, and
this command does not read statement files. A fingerprint that arrived with a statement,
or that you read off one, is not a registration.

Every register, replace and revoke appends one line to the registry and never rewrites it.
Back the file up, and note each entry's hash in the operator log.`;

type Command = "register" | "replace" | "revoke" | "show" | "list" | "verify";
const COMMANDS: readonly string[] = ["register", "replace", "revoke", "show", "list", "verify"];

type Args = { command?: Command; customer?: string; fingerprint?: string; channel?: string; registry?: string; help: boolean };

const NO_STATEMENTS =
  "This command does not read statement files. A customer's fingerprint comes from the customer, through the channel " +
  "agreed in writing (their own `mesh statement --key` prints it), never from a statement: pass it with --fingerprint.";

function parseArgs(argv: string[]): Args {
  const args: Args = { help: false };
  const value = (flag: string, index: number): string => {
    const next = argv[index];
    if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value.`);
    return next;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h" || a === "help") args.help = true;
    else if (a === "--customer") args.customer = value(a, ++i);
    else if (a === "--fingerprint") args.fingerprint = value(a, ++i);
    else if (a === "--channel") args.channel = value(a, ++i);
    else if (a === "--registry") args.registry = value(a, ++i);
    else if (a === "--statement" || a === "--from-statement") throw new Error(NO_STATEMENTS);
    else if (a.startsWith("--")) throw new Error(`Unknown flag ${a}. Run with --help for the commands.`);
    else if (args.command === undefined && COMMANDS.includes(a)) args.command = a as Command;
    else if (args.command === undefined) throw new Error(`Unknown command ${JSON.stringify(a)}. Run with --help for the commands.`);
    else throw new Error(`Unexpected argument ${JSON.stringify(a)}. ${NO_STATEMENTS}`);
  }
  return args;
}

/**
 * The fingerprint of the statement key of the Mesh install on THIS machine, if
 * it has one, read the way scripts/mesh-bill.ts reads it (~/.mesh/identity/
 * statement-key.json; only the fingerprint is taken, nothing is printed). It
 * is never a customer's key. A file that is there but cannot be read is a hard
 * stop: the check it feeds could not be made.
 */
function operatorKeyFingerprint(): string | undefined {
  const path = join(homedir(), ".mesh", STATEMENT_KEY_DIR, STATEMENT_KEY_FILE);
  if (!existsSync(path)) return undefined;
  try {
    return parseStatementKeyFile(readFileSync(path, "utf8")).fingerprint;
  } catch (error) {
    throw new Error(
      `this machine's own statement key file (${path}) could not be read as a statement key ` +
      `(${error instanceof Error ? (error as NodeJS.ErrnoException).code ?? error.message : "unreadable"}), so the command ` +
      "cannot rule out that the fingerprint given is this machine's own.",
    );
  }
}

/** Best effort: owner-only. A filesystem without mode bits (Windows, some mounts) is left as it is. */
function ownerOnly(path: string, mode: number): void {
  try {
    if ((statSync(path).mode & 0o777) !== mode) chmodSync(path, mode);
  } catch { /* no mode bits here */ }
}

/**
 * Add one line to the end of the registry and sync it to disk. Opened for
 * append only: this never rewrites, truncates or replaces the file. A folder
 * this creates is owner-only; one that already exists is left as it is.
 */
function appendEntry(path: string, entry: CustomerKeyEntry): { created: boolean } {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    ownerOnly(dir, 0o700);
  }
  const created = !existsSync(path);
  const handle = openSync(path, "a", 0o600);
  try {
    writeSync(handle, serializeCustomerKeyEntry(entry));
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  ownerOnly(path, 0o600);
  return { created };
}

const entries = (n: number): string => `${n} ${n === 1 ? "entry" : "entries"}`;

/** One entry of a customer's history, as two lines. */
function historyLines(entry: CustomerKeyEntry): string[] {
  const what =
    entry.action === "register" ? `register  ${entry.fingerprint}`
    : entry.action === "replace" ? `replace   ${entry.fingerprint}  (replaces ${entry.replaces})`
    : `revoke    (ends ${entry.replaces})`;
  return [`    seq ${entry.seq}  ${entry.at}  ${what}`, `           channel: ${entry.channel}`];
}

/** A customer's block for `show` and `list`. Returns whether they have a current key. */
function printCustomer(all: readonly CustomerKeyEntry[], customer: string): boolean {
  const current = currentCustomerKey(all, customer);
  const history = customerKeyHistory(all, customer);
  console.log(customer);
  if (current === undefined) {
    console.log(
      history.length === 0
        ? "  no statement key: this customer is not in the registry. mesh-bill refuses to bill them."
        : "  no current statement key (revoked). mesh-bill refuses to bill them until a key is registered again.",
    );
  } else {
    console.log(`  current statement key: ${current.fingerprint}`);
    console.log(`  registered at:         ${current.at} (registry entry seq ${current.seq}, ${current.action})`);
    console.log(`  channel:               ${current.channel}`);
  }
  if (history.length > 0) {
    console.log("  history, oldest first:");
    for (const entry of history) for (const line of historyLines(entry)) console.log(line);
  }
  return current !== undefined;
}

const RESTORE = "Restore the file from its backup; do not repair it by hand. mesh-bill refuses to bill from it as it is.";

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.command === undefined) {
    console.log(HELP);
    if (!args.help) process.exitCode = 1;
    return;
  }
  const command = args.command;
  const path = customerKeyRegistryFilePath(args.registry);
  const file = readCustomerKeyRegistryFile(path);
  if (file.state === "unreadable") throw new Error(`The registry ${path} could not be read (${file.reason}).`);
  if (file.state === "broken") throw new Error(`REGISTRY BROKEN — ${path}: ${file.reason} ${RESTORE}`);

  // --- Read-only commands -------------------------------------------------
  if (command === "verify" || command === "list" || command === "show") {
    if (command !== "show" && (args.customer !== undefined || args.fingerprint !== undefined || args.channel !== undefined)) {
      throw new Error(`${command} takes only --registry.`);
    }
    if (command === "show" && (args.fingerprint !== undefined || args.channel !== undefined)) {
      throw new Error("show takes only --customer and --registry.");
    }
    if (command === "show" && args.customer === undefined) throw new Error("show needs --customer cus_….");
    if (file.state === "missing") {
      console.log(
        `No registry at ${path}. No customer statement key has been registered here, so mesh-bill refuses every real run. ` +
        "If there was a registry on this machine, restore it from its backup; do not start a new one in its place.",
      );
      process.exitCode = 1;
      return;
    }
    const customers = registryCustomers(file.entries);
    const withKey = customers.filter((customer) => currentCustomerKey(file.entries, customer) !== undefined).length;
    const footer = `Registry: ${path} · ${entries(file.entries.length)} · chain verified · head ${file.headHash}`;
    if (command === "verify") {
      console.log(`OK — ${path}: ${entries(file.entries.length)}, chain verified.`);
      console.log(`  head hash: ${file.headHash}`);
      console.log(`  customers with a current key: ${withKey} of ${customers.length}`);
      console.log(
        "This shows no line was edited, removed from the middle or moved. It cannot show that lines were not cut off the " +
        "end, or that the whole file was not rewritten: compare the entry count and head hash with the operator log.",
      );
      return;
    }
    if (command === "show") {
      const has = printCustomer(file.entries, args.customer!);
      console.log(footer);
      if (!has) process.exitCode = 1;
      return;
    }
    if (customers.length === 0) console.log("No customer has an entry in the registry.");
    for (const customer of customers) {
      printCustomer(file.entries, customer);
      console.log("");
    }
    console.log(footer);
    return;
  }

  // --- register, replace, revoke: each appends exactly one entry -----------
  const action: CustomerKeyAction = command;
  const refused = action === "register" ? "NOT REGISTERED" : action === "replace" ? "NOT REPLACED" : "NOT REVOKED";
  if (args.customer === undefined) throw new Error(`${refused} — ${action} needs --customer cus_….`);
  if (args.channel === undefined) {
    throw new Error(
      `${refused} — ${action} needs --channel "<text>": ` +
      (action === "register" ? "how the fingerprint was received and confirmed with the customer."
        : action === "replace" ? "how the change was confirmed with the customer, separately from any statement."
        : "why the key is revoked, and who confirmed it."),
    );
  }
  if (action === "revoke" && args.fingerprint !== undefined) {
    throw new Error(`${refused} — revoke takes no --fingerprint: it ends the customer's current key, whatever it is.`);
  }
  if (action !== "revoke" && args.fingerprint === undefined) {
    throw new Error(
      `${refused} — ${action} needs --fingerprint <64 hex>: the fingerprint the customer sent through the channel agreed ` +
      "in writing (their own `mesh statement --key` prints it). Never one read off a statement.",
    );
  }
  // A fingerprint is public, so it is safe on a command line. Spaces and capitals from a paste are tidied; nothing else is.
  const fingerprint = args.fingerprint?.trim().toLowerCase();
  let localKey: string | undefined;
  if (action !== "revoke") {
    try {
      localKey = operatorKeyFingerprint();
    } catch (error) {
      throw new Error(`${refused} — ${(error as Error).message}`);
    }
  }

  const before = file.state === "ok" ? file.entries : [];
  const next = buildNextCustomerKeyEntry({
    entries: before,
    action,
    customer: args.customer.trim(),
    ...(fingerprint === undefined ? {} : { fingerprint }),
    channel: args.channel.trim(),
    now: new Date(),
    ...(localKey === undefined ? {} : { operatorKeyFingerprint: localKey }),
  });
  if (!next.ok) throw new Error(`${refused} — ${next.reason}`);
  const entry = next.entry;

  let created: boolean;
  try {
    ({ created } = appendEntry(path, entry));
  } catch (error) {
    throw new Error(`${refused} — the registry ${path} could not be written (${(error as NodeJS.ErrnoException).code ?? "error"}). Nothing was recorded.`);
  }

  // Read back what is on disk: that file, not the entry in memory, is the registry.
  const after = readCustomerKeyRegistryFile(path);
  if (after.state !== "ok" || after.headHash !== entry.entryHash) {
    throw new Error(
      `The entry was appended to ${path}, but the registry does not read back as expected` +
      `${after.state === "broken" || after.state === "unreadable" ? ` (${after.reason})` : ""}. ` +
      "Something else wrote to the file at the same time, or the disk is failing. Run verify, and restore the file from " +
      "its backup if it does not pass.",
    );
  }

  if (created) console.log(`Created a new registry at ${path}.`);
  const { customer } = entry;
  if (action === "register") console.log(`Registered: ${customer} → statement key ${entry.fingerprint}`);
  else if (action === "replace") console.log(`Replaced: ${customer} → statement key ${entry.fingerprint}`);
  else console.log(`Revoked: ${customer} has no current statement key.`);
  if (entry.replaces !== undefined) console.log(`  no longer accepted: ${entry.replaces}`);
  console.log(`  registry entry:     seq ${entry.seq}, at ${entry.at}`);
  console.log(`  entry hash:         ${entry.entryHash}`);
  console.log(`  channel:            ${entry.channel}`);
  console.log(`  registry:           ${path} (${entries(after.entries.length)})`);
  if (action === "revoke") {
    console.log(`mesh-bill refuses to bill ${customer} until a key is registered again.`);
  } else {
    console.log(
      `mesh-bill now accepts a statement from ${customer} only if it is signed by this key AND was written after ${entry.at}. ` +
      "A statement written before that is refused: the customer writes it again.",
    );
  }
  console.log("Note the entry hash in the operator log, and back the registry file up.");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
