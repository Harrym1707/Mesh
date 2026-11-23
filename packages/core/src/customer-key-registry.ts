import { createHash } from "node:crypto";
import { join } from "node:path";
import { checkStatementSeal, isStatementKeyFingerprint } from "./manual-billing-checks.js";
import { canonicalJson } from "./price-catalogue.js";

/**
 * The operator's registry of customer statement keys.
 *
 * A manual bill accepts a statement only when it is signed by the statement
 * key the customer registered (manual-billing-checks.ts). Until this module,
 * the registered fingerprint was typed on `mesh-bill`'s command line on every
 * run, from a hand-kept log. Nothing stopped an operator copying the
 * fingerprint printed on the statement itself, and then the "who wrote it"
 * check passed for whoever wrote the statement.
 *
 * The registry closes that. It is a file on the operator's machine, outside
 * the repository, that only `scripts/mesh-customer-key.ts` writes and that
 * `scripts/mesh-bill.ts` only reads. A real bill takes the customer's key from
 * it, by Stripe customer id, and from nowhere else.
 *
 * THE FILE. Append-only JSON Lines: one entry per line, each carrying the hash
 * of the entry before it (the same construction as the savings ledger), so a
 * line that was edited, removed from the middle or moved is evident. It holds
 * public fingerprints and free-text notes; it is not a secret and holds no key
 * material.
 *
 * THE ORDER RULE. A key must have been registered BEFORE the statement it is
 * used for was written: the registration entry's `at` must be earlier than the
 * statement's own `generatedAt`. That time is inside the statement's sealed and
 * signed body, so the operator cannot change it. A fingerprint read off a
 * statement that has already arrived is, by construction, registered after that
 * statement was written, and is refused for it.
 *
 * What this does and does not show:
 *   - it shows the key was in the registry before the statement existed, and
 *     that the registry's lines were not edited one at a time;
 *   - the chain has no secret in it: an operator who rewrites the WHOLE file,
 *     recomputing every hash, produces a registry that verifies. So does one
 *     that had its last lines cut off. Backups, and a note of the head hash
 *     kept somewhere else, are the control for both;
 *   - the registration time is the operator machine's clock, and an operator
 *     who sets that clock back before registering is not stopped by it;
 *   - like the signature itself, it is NOT protection against an operator who
 *     bypasses the script, and the fingerprint is only as trustworthy as the
 *     channel it was received through.
 *
 * Everything here is pure: text and values in, results out, the clock passed
 * in. Reading and writing the file is the scripts' job.
 */

/** The format of one registry line. */
export const CUSTOMER_KEY_SCHEMA = "mesh-customer-key/1";

/** `prevHash` of the first entry. Written out so this module adds no top-level call to anything that imports core. */
export const CUSTOMER_KEY_GENESIS_HASH = "0000000000000000000000000000000000000000000000000000000000000000";

/** Where the registry lives unless the operator says otherwise: beside `stripe.env`, under the home folder. */
export const CUSTOMER_KEY_REGISTRY_DIR = [".config", "mesh"] as const;
export const CUSTOMER_KEY_REGISTRY_FILE = "customer-keys.jsonl";
/** Environment variable naming another registry file. `--registry <file>` wins over it. */
export const CUSTOMER_KEY_REGISTRY_ENV = "MESH_CUSTOMER_KEYS";

/** The shortest `channel` note accepted: enough that it has to say something. */
export const CUSTOMER_KEY_CHANNEL_MIN = 8;
export const CUSTOMER_KEY_CHANNEL_MAX = 500;

export type CustomerKeyAction = "register" | "replace" | "revoke";

export type CustomerKeyEntry = {
  schema: typeof CUSTOMER_KEY_SCHEMA;
  /** Position in the file, from 0. */
  seq: number;
  /** `entryHash` of the entry before this one; CUSTOMER_KEY_GENESIS_HASH for the first. */
  prevHash: string;
  /** When the entry was written: ISO 8601, UTC, to the millisecond, by the operator machine's clock. */
  at: string;
  action: CustomerKeyAction;
  /** The Stripe customer id the key belongs to (`cus_…`). */
  customer: string;
  /** The statement key fingerprint that becomes current (register, replace). Absent for revoke. */
  fingerprint?: string;
  /** The fingerprint that stops being current (replace, revoke). Absent for register. */
  replaces?: string;
  /** Free text: how the fingerprint was received and confirmed with the customer. */
  channel: string;
  /** sha256 of this entry as canonical JSON without this field. */
  entryHash: string;
};

/** A customer's current key, and the entry that made it current. */
export type CustomerKeyRegistration = {
  fingerprint: string;
  /** The registry entry that made this key current. */
  seq: number;
  /** That entry's time: the key counts as registered from here. */
  at: string;
  action: "register" | "replace";
  channel: string;
};

const HEX_64 = /^[0-9a-f]{64}$/;
const CUSTOMER_ID = /^cus_[A-Za-z0-9]{1,64}$/;
const ISO_UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const ENTRY_KEYS = ["schema", "seq", "prevHash", "at", "action", "customer", "fingerprint", "replaces", "channel", "entryHash"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Milliseconds since the epoch for an exact `YYYY-MM-DDTHH:MM:SS.mmmZ` instant; undefined for anything else. */
function exactInstant(value: unknown): number | undefined {
  if (typeof value !== "string" || !ISO_UTC_MS.test(value)) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : undefined;
}

/** True for something shaped like a Stripe customer id. */
export function isCustomerId(value: unknown): value is string {
  return typeof value === "string" && CUSTOMER_ID.test(value);
}

/** The registry file to use: `--registry`, else the environment variable, else `~/.config/mesh/customer-keys.jsonl`. */
export function customerKeyRegistryPath(input: { flag?: string; env?: string; home: string }): string {
  const flag = input.flag?.trim();
  if (flag !== undefined && flag !== "") return flag;
  const env = input.env?.trim();
  if (env !== undefined && env !== "") return env;
  return join(input.home, ...CUSTOMER_KEY_REGISTRY_DIR, CUSTOMER_KEY_REGISTRY_FILE);
}

/** The hash of one entry: sha256 over its canonical JSON without `entryHash`. Covers its position and its predecessor. */
export function customerKeyEntryHash(entry: Omit<CustomerKeyEntry, "entryHash"> & { entryHash?: string }): string {
  const { entryHash: _entryHash, ...content } = entry;
  return createHash("sha256").update(canonicalJson(content)).digest("hex");
}

/** One entry as its line in the file, newline included. */
export function serializeCustomerKeyEntry(entry: CustomerKeyEntry): string {
  return `${JSON.stringify(entry)}\n`;
}

// ---------------------------------------------------------------------------
// Reading the file
// ---------------------------------------------------------------------------

export type CustomerKeyRegistryParse =
  | { ok: true; entries: CustomerKeyEntry[] }
  | { ok: false; /** 1-based line in the file. */ line: number; reason: string };

/**
 * Turn the registry file's text into entries. Strict, because only one command
 * ever writes the file: every line must be one JSON object with exactly the
 * fields of an entry, each of the right type, and the file must end with a
 * newline. This checks shape only; whether the entries form a chain and follow
 * the rules is verifyCustomerKeyRegistry.
 */
export function parseCustomerKeyRegistry(text: string): CustomerKeyRegistryParse {
  if (text === "") return { ok: true, entries: [] };
  const lines = text.split("\n");
  if (lines.at(-1) !== "") {
    return { ok: false, line: lines.length, reason: "the file does not end with a newline: its last line was cut short or edited by hand." };
  }
  lines.pop();
  const entries: CustomerKeyEntry[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const bad = (reason: string): CustomerKeyRegistryParse => ({ ok: false, line: index + 1, reason });
    const line = lines[index]!;
    if (line.trim() === "") return bad("the line is empty.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return bad("the line is not valid JSON.");
    }
    if (!isRecord(parsed)) return bad("the line is not a registry entry (not a JSON object).");
    const unknown = Object.keys(parsed).find((key) => !ENTRY_KEYS.includes(key));
    if (unknown !== undefined) return bad(`the entry has a field this format does not have (${JSON.stringify(unknown).slice(0, 40)}).`);
    if (parsed.schema !== CUSTOMER_KEY_SCHEMA) return bad(`the entry's schema is not ${CUSTOMER_KEY_SCHEMA}.`);
    if (typeof parsed.seq !== "number" || !Number.isInteger(parsed.seq) || parsed.seq < 0) return bad("the entry's seq is not a whole number.");
    if (typeof parsed.prevHash !== "string" || !HEX_64.test(parsed.prevHash)) return bad("the entry's prevHash is not a sha256 hash.");
    if (typeof parsed.entryHash !== "string" || !HEX_64.test(parsed.entryHash)) return bad("the entry's entryHash is not a sha256 hash.");
    if (exactInstant(parsed.at) === undefined) return bad("the entry's time (at) is not an ISO 8601 UTC instant.");
    if (parsed.action !== "register" && parsed.action !== "replace" && parsed.action !== "revoke") {
      return bad("the entry's action is not register, replace or revoke.");
    }
    if (typeof parsed.customer !== "string") return bad("the entry's customer is not text.");
    if (typeof parsed.channel !== "string") return bad("the entry's channel is not text.");
    if (parsed.fingerprint !== undefined && typeof parsed.fingerprint !== "string") return bad("the entry's fingerprint is not text.");
    if (parsed.replaces !== undefined && typeof parsed.replaces !== "string") return bad("the entry's replaces is not text.");
    entries.push({
      schema: CUSTOMER_KEY_SCHEMA,
      seq: parsed.seq,
      prevHash: parsed.prevHash,
      at: parsed.at as string,
      action: parsed.action,
      customer: parsed.customer,
      ...(parsed.fingerprint === undefined ? {} : { fingerprint: parsed.fingerprint }),
      ...(parsed.replaces === undefined ? {} : { replaces: parsed.replaces }),
      channel: parsed.channel,
      entryHash: parsed.entryHash,
    });
  }
  return { ok: true, entries };
}

// ---------------------------------------------------------------------------
// The rules every entry follows
// ---------------------------------------------------------------------------

type CurrentKeys = Map<string, CustomerKeyRegistration>;

type EntryChange = {
  action: CustomerKeyAction;
  customer: string;
  fingerprint?: string;
  channel: string;
};

const shortSeq = (registration: CustomerKeyRegistration): string => `registry entry seq ${registration.seq}, ${registration.at}`;

/**
 * Whether a change is allowed, given which key each customer holds now. One
 * definition, used to build the next entry and to check every entry already in
 * the file. Returns the refusal, or undefined when the change is allowed.
 */
function refusalForChange(current: CurrentKeys, change: EntryChange): string | undefined {
  const { action, customer, fingerprint } = change;
  if (!isCustomerId(customer)) {
    return "the customer must be a Stripe customer id (cus_ followed by letters and digits).";
  }
  const channel = change.channel.trim();
  if (channel !== change.channel || channel.length < CUSTOMER_KEY_CHANNEL_MIN) {
    return (
      `the channel note must say how the fingerprint was received and confirmed with the customer ` +
      `(at least ${CUSTOMER_KEY_CHANNEL_MIN} characters, no space at either end).`
    );
  }
  if (channel.length > CUSTOMER_KEY_CHANNEL_MAX) return `the channel note is longer than ${CUSTOMER_KEY_CHANNEL_MAX} characters.`;
  if (CONTROL_CHARACTER.test(channel)) return "the channel note must be one line of plain text.";

  const held = current.get(customer);
  if (action === "revoke") {
    if (fingerprint !== undefined) return "a revoke names no fingerprint: it ends the customer's current key.";
    if (held === undefined) return `${customer} has no current statement key to revoke.`;
    return undefined;
  }

  if (!isStatementKeyFingerprint(fingerprint)) {
    return (
      "the fingerprint is not a statement key fingerprint: it is the 64 lowercase hexadecimal characters the customer's " +
      "`mesh statement --key` prints."
    );
  }
  for (const [other, registration] of current) {
    if (other !== customer && registration.fingerprint === fingerprint) {
      return (
        `statement key ${fingerprint} is already the current key of another customer, ${other} (${shortSeq(registration)}). ` +
        "One install's key cannot be two customers' key: check which customer sent it."
      );
    }
  }
  if (action === "register") {
    if (held !== undefined) {
      return (
        `${customer} already has a current statement key (${held.fingerprint}, ${shortSeq(held)}). ` +
        "A changed key is a replace, not a register: confirm the change with the customer through the agreed channel, " +
        "separately from any statement, then use replace."
      );
    }
    return undefined;
  }
  // replace
  if (held === undefined) return `${customer} has no current statement key to replace: use register.`;
  if (held.fingerprint === fingerprint) {
    return `statement key ${fingerprint} is already ${customer}'s current key (${shortSeq(held)}): there is nothing to replace.`;
  }
  return undefined;
}

/** Apply an entry already found allowed. */
function applyEntry(current: CurrentKeys, entry: CustomerKeyEntry): void {
  if (entry.action === "revoke" || entry.fingerprint === undefined) {
    current.delete(entry.customer);
    return;
  }
  current.set(entry.customer, {
    fingerprint: entry.fingerprint,
    seq: entry.seq,
    at: entry.at,
    action: entry.action,
    channel: entry.channel,
  });
}

function currentKeys(entries: readonly CustomerKeyEntry[]): CurrentKeys {
  const current: CurrentKeys = new Map();
  for (const entry of entries) applyEntry(current, entry);
  return current;
}

// ---------------------------------------------------------------------------
// Verifying the chain
// ---------------------------------------------------------------------------

export type CustomerKeyRegistryVerification =
  | { ok: true; length: number; /** `entryHash` of the last entry; the genesis hash for an empty registry. */ headHash: string }
  | { ok: false; /** The first entry that is wrong, by the seq it carries. */ seq: number; reason: string };

/**
 * Verify the registry end to end and report the first entry that is wrong.
 * An edited line (its hash no longer matches its content), a line removed from
 * the middle and a line moved are each caught here, with the seq where the
 * chain breaks. So is an entry the rules would not have allowed, and an entry
 * dated before the one above it.
 *
 * What this cannot catch: lines cut off the END (what is left is still a
 * chain), and a file rewritten in full with every hash recomputed. Compare
 * `headHash` and `length` with a note kept elsewhere for those.
 */
export function verifyCustomerKeyRegistry(entries: readonly CustomerKeyEntry[]): CustomerKeyRegistryVerification {
  let prevHash = CUSTOMER_KEY_GENESIS_HASH;
  let prevTime = Number.NEGATIVE_INFINITY;
  const current: CurrentKeys = new Map();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const bad = (reason: string): CustomerKeyRegistryVerification => ({ ok: false, seq: entry.seq, reason });
    if (entry.seq !== index) return bad(`expected seq ${index}, found ${entry.seq}: an entry was removed, added or moved.`);
    if (entry.prevHash !== prevHash) return bad("prevHash does not match the entry before it.");
    if (entry.entryHash !== customerKeyEntryHash(entry)) return bad("entryHash does not match the entry's content: the line was edited.");
    const time = exactInstant(entry.at);
    if (time === undefined) return bad("its time (at) is not an ISO 8601 UTC instant.");
    if (time < prevTime) return bad("its time (at) is earlier than the entry before it.");
    const refusal = refusalForChange(current, {
      action: entry.action,
      customer: entry.customer,
      ...(entry.fingerprint === undefined ? {} : { fingerprint: entry.fingerprint }),
      channel: entry.channel,
    });
    if (refusal !== undefined) return bad(`it is not an entry the registry's rules allow: ${refusal}`);
    const held = current.get(entry.customer)?.fingerprint;
    if (entry.replaces !== held) {
      return bad(
        entry.action === "register"
          ? "a register entry must not name a key it replaces."
          : "its replaces field is not the key the customer held before it.",
      );
    }
    applyEntry(current, entry);
    prevHash = entry.entryHash;
    prevTime = time;
  }
  return { ok: true, length: entries.length, headHash: prevHash };
}

export type CustomerKeyRegistryRead =
  | { ok: true; entries: CustomerKeyEntry[]; headHash: string }
  | { ok: false; /** What is wrong, naming the line or the seq. */ reason: string; /** Present when the chain check failed. */ seq?: number };

/** Parse and verify in one step: the only way the scripts turn the file's text into entries they act on. */
export function readCustomerKeyRegistry(text: string): CustomerKeyRegistryRead {
  const parsed = parseCustomerKeyRegistry(text);
  if (!parsed.ok) return { ok: false, reason: `line ${parsed.line} cannot be read as a registry entry: ${parsed.reason}` };
  const chain = verifyCustomerKeyRegistry(parsed.entries);
  if (!chain.ok) return { ok: false, seq: chain.seq, reason: `the chain is broken at seq ${chain.seq}: ${chain.reason}` };
  return { ok: true, entries: parsed.entries, headHash: chain.headHash };
}

// ---------------------------------------------------------------------------
// Looking a customer up
// ---------------------------------------------------------------------------

/** The customer's current key and the entry that made it current, or undefined when they have none (never registered, or revoked). */
export function currentCustomerKey(entries: readonly CustomerKeyEntry[], customer: string): CustomerKeyRegistration | undefined {
  return currentKeys(entries).get(customer);
}

/** Every entry about one customer, oldest first. */
export function customerKeyHistory(entries: readonly CustomerKeyEntry[], customer: string): CustomerKeyEntry[] {
  return entries.filter((entry) => entry.customer === customer);
}

/** Every customer the registry has an entry for, in the order they first appear. */
export function registryCustomers(entries: readonly CustomerKeyEntry[]): string[] {
  return [...new Set(entries.map((entry) => entry.customer))];
}

// ---------------------------------------------------------------------------
// Adding an entry
// ---------------------------------------------------------------------------

export type NextCustomerKeyEntryInput = {
  /** The registry as it stands. Verified here first: nothing is added to a registry that does not verify. */
  entries: readonly CustomerKeyEntry[];
  action: CustomerKeyAction;
  customer: string;
  /** The new current fingerprint. Required for register and replace; must be absent for revoke. */
  fingerprint?: string;
  channel: string;
  /** The time the entry is written. Passed in, never read from the clock here. */
  now: Date;
  /**
   * The fingerprint of the statement key of the MESH install on the operator's
   * own machine, when it has one. It is never a customer's key: a statement
   * signed by it was written by the operator.
   */
  operatorKeyFingerprint?: string;
};

export type NextCustomerKeyEntry = { ok: true; entry: CustomerKeyEntry } | { ok: false; reason: string };

/**
 * Build the entry that register, replace or revoke would append, with every
 * rule enforced:
 *
 *   - the registry must verify as it stands;
 *   - register refuses a customer who already has a current key (that is a
 *     replace); replace and revoke need a current key;
 *   - a fingerprint is 64 lowercase hexadecimal characters;
 *   - a fingerprint that is the current key of a DIFFERENT customer is refused;
 *   - the operator machine's own statement key is refused as a customer's key;
 *   - the entry's time is not earlier than the entry before it (a clock that
 *     has gone backwards would otherwise date a registration before entries
 *     that already exist).
 *
 * Nothing is written here. The caller appends `serializeCustomerKeyEntry(entry)`.
 */
export function buildNextCustomerKeyEntry(input: NextCustomerKeyEntryInput): NextCustomerKeyEntry {
  const fail = (reason: string): NextCustomerKeyEntry => ({ ok: false, reason });
  const chain = verifyCustomerKeyRegistry(input.entries);
  if (!chain.ok) {
    return fail(`the registry's chain is broken at seq ${chain.seq} (${chain.reason}), so nothing is added to it. Restore it from its backup.`);
  }
  if (Number.isNaN(input.now.getTime())) return fail("the time given for the entry is not a time.");
  const at = input.now.toISOString();
  const last = input.entries.at(-1);
  if (last !== undefined && input.now.getTime() < Date.parse(last.at)) {
    return fail(
      `this machine's clock (${at}) is behind the registry's last entry (seq ${last.seq}, ${last.at}). ` +
      "An entry is never dated before the one above it: correct the clock and run the command again.",
    );
  }
  if (
    input.action !== "revoke" &&
    input.operatorKeyFingerprint !== undefined &&
    input.fingerprint === input.operatorKeyFingerprint
  ) {
    return fail(
      `statement key ${input.fingerprint} is this machine's own MESH install's key, not a customer's. ` +
      "A statement signed by it was written here. The fingerprint to register is the one the customer's own " +
      "`mesh statement --key` prints, sent through the channel agreed in writing.",
    );
  }
  const current = currentKeys(input.entries);
  const refusal = refusalForChange(current, {
    action: input.action,
    customer: input.customer,
    ...(input.fingerprint === undefined ? {} : { fingerprint: input.fingerprint }),
    channel: input.channel,
  });
  if (refusal !== undefined) return fail(refusal);

  const replaces = current.get(input.customer)?.fingerprint;
  const content: Omit<CustomerKeyEntry, "entryHash"> = {
    schema: CUSTOMER_KEY_SCHEMA,
    seq: input.entries.length,
    prevHash: chain.headHash,
    at,
    action: input.action,
    customer: input.customer,
    ...(input.action === "revoke" || input.fingerprint === undefined ? {} : { fingerprint: input.fingerprint }),
    ...(replaces === undefined ? {} : { replaces }),
    channel: input.channel,
  };
  return { ok: true, entry: { ...content, entryHash: customerKeyEntryHash(content) } };
}

// ---------------------------------------------------------------------------
// Is the customer's key one a statement may be billed against?
// ---------------------------------------------------------------------------

export type RegisteredKeyCheckInput = {
  /** The registry's entries, as parsed. The chain is verified here. */
  entries: readonly CustomerKeyEntry[];
  /** The Stripe customer id being billed (`--customer`). */
  customer: string;
  /** The parsed statement file, untrusted. */
  statement: unknown;
};

export type RegisteredKeyCheck =
  | {
      ok: true;
      /** The customer's registered fingerprint: what the statement's signature must be by. */
      fingerprint: string;
      /** The entry that made it current. */
      registration: CustomerKeyRegistration;
      /** The statement's own `generatedAt`. */
      statementWrittenAt: string;
    }
  | {
      ok: false;
      /**
       * registry: the registry does not verify. no-key: the customer has no
       * current key. statement: the statement cannot be dated (not sealed, or
       * no time in it). order: the key was not registered before the
       * statement was written.
       */
      code: "registry" | "no-key" | "statement" | "order";
      /** Printed after "DO NOT BILL — ". */
      reason: string;
    };

/**
 * The key a statement must be signed by, for this customer, or why there is
 * none to check it against. In order:
 *
 *   1. the registry's chain verifies;
 *   2. the customer has a current key;
 *   3. the statement matches its seal and carries the time it was written;
 *   4. the key was registered BEFORE the statement was written.
 *
 * `ok` does NOT mean the statement is the customer's: it hands back the
 * fingerprint for checkStatementForBilling's `expectedKeyFingerprint`, which
 * is where the signature is verified and compared. Both must pass. The
 * statement's `generatedAt` is only worth reading because that second check
 * follows: it is inside the sealed body the registered key signed.
 *
 * Step 4 has no tolerance window, deliberately. The two times come from two
 * clocks (the registration's from the operator's machine, the statement's from
 * the customer's), which can disagree by seconds or minutes. A real
 * registration is made when billing is agreed and precedes the first statement
 * by days, so skew does not reach it; a window would only make room for a key
 * registered just after the statement that carries it arrived.
 */
export function checkRegisteredKeyForStatement(input: RegisteredKeyCheckInput): RegisteredKeyCheck {
  const { entries, customer, statement } = input;
  const fail = (code: "registry" | "no-key" | "statement" | "order", reason: string): RegisteredKeyCheck => ({ ok: false, code, reason });

  // 1. The registry.
  const chain = verifyCustomerKeyRegistry(entries);
  if (!chain.ok) {
    return fail(
      "registry",
      `the customer key registry failed its chain check at seq ${chain.seq}: ${chain.reason} ` +
      "It was edited by hand or damaged, so no key in it is trusted. Restore it from its backup; do not repair it by hand.",
    );
  }

  // 2. The customer's key.
  const registration = currentCustomerKey(entries, customer);
  if (registration === undefined) {
    const last = customerKeyHistory(entries, customer).at(-1);
    return fail(
      "no-key",
      `${customer} has no current statement key in the customer key registry` +
      (last === undefined ? "" : ` (its key was revoked at ${last.at}, registry entry seq ${last.seq})`) +
      ". Register the fingerprint the customer sent through the channel agreed in writing " +
      "(scripts/mesh-customer-key.ts register), never one read off a statement, " +
      "then ask the customer to write the statement again: a statement written before its key was registered is refused.",
    );
  }

  // 3. When the statement was written. Only a sealed statement's time is read.
  if (!isRecord(statement)) return fail("statement", "the statement file is not a statement (it is not a JSON object).");
  if (!checkStatementSeal(statement)) {
    return fail("statement", "the statement does not match its sha256 seal: it was edited or damaged after it was written.");
  }
  const writtenAt = exactInstant(statement.generatedAt);
  if (writtenAt === undefined) {
    return fail(
      "statement",
      "the statement does not say when it was written (no generatedAt time), so it cannot be shown that the customer's key " +
      "was registered before it. Ask the customer to write it again with `mesh statement`.",
    );
  }
  const statementWrittenAt = statement.generatedAt as string;

  // 4. Registered before written. Equal times are refused: "before" means before.
  const registeredAt = Date.parse(registration.at);
  if (!(registeredAt < writtenAt)) {
    const when = registeredAt === writtenAt
      ? `at ${registration.at}, the same instant this statement was written`
      : `at ${registration.at}, after this statement was written at ${statementWrittenAt}`;
    return fail(
      "order",
      `${customer}'s statement key ${registration.fingerprint} was registered ${when} (registry entry seq ${registration.seq}). ` +
      "A key registered after the statement it is used for is the case the signature exists to catch: whoever holds a " +
      "statement can read a fingerprint off it. The customer must write the statement again now that the key is registered. " +
      "If the fingerprint was copied from this statement and not confirmed with the customer through the agreed channel, " +
      "it is not a registration: revoke it.",
    );
  }

  return { ok: true, fingerprint: registration.fingerprint, registration, statementWrittenAt };
}
