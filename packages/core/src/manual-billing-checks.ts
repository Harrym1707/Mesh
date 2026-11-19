import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { canonicalJson } from "./price-catalogue.js";
import type { LedgerRecord } from "./savings-ledger.js";

/**
 * Checks a manual bill must pass before anything is sent to Stripe.
 *
 * `scripts/mesh-bill.ts` bills one customer for one period from the ledger
 * files the customer sent. Three things can go wrong that a hash chain alone
 * does not catch, and each used to be left to the operator's eye:
 *
 *   - a spool is missing, or its tail was cut off in transit. What remains
 *     still verifies as a chain, so the bill would be silently short (or, with
 *     a negative lever cut off, silently over);
 *   - the period has not ended, so the figures can still change;
 *   - the bill's figure is not the figure the customer saw on their own
 *     statement.
 *
 * The customer's `mesh statement` file records, per spool, the head hash and
 * record counts it was computed from, and is sealed. Matching the files in
 * hand against it closes all three. Everything here is pure (the clock is
 * passed in) so it is unit-tested without a ledger folder or a Stripe key.
 *
 * The seal lives here, and only here: the customer's command
 * (packages/cli/src/statement.ts) and the operator's script both import it, so
 * the two cannot drift. The same holds for the signature below.
 *
 * WHO WROTE THE STATEMENT. The seal is a checksum: anyone holding the spools
 * can write a statement over them and seal it, including the operator, and a
 * statement the operator wrote from whatever files arrived matches those files
 * trivially. So a statement is also SIGNED, with a key that is created on the
 * customer's own machine and never leaves it, and the bill compares the
 * signing key's fingerprint with the one the customer registered when billing
 * was agreed.
 *
 * What that does and does not show:
 *   - it shows the statement was written by an install holding the registered
 *     key, so the operator cannot produce it from the files in hand;
 *   - it does NOT show the customer's ledger was complete on their machine (a
 *     customer who drops spools lowers their own savings and fee, and their
 *     recomputation wins anyway);
 *   - it is NOT protection against an operator who bypasses the script;
 *   - the fingerprint is only as trustworthy as the channel it was registered
 *     through.
 */

/** The statement file format `mesh statement` writes and a manual bill accepts. */
export const STATEMENT_SCHEMA = "mesh-statement/1";

/** How a statement's seal is computed, printed in the statement file itself. */
export const STATEMENT_SEAL_RULE =
  "sha256 of this document as canonical JSON (keys sorted, no whitespace) without the sha256, sha256Of and signature fields";

/**
 * The seal over a statement's content. The signature is made over the seal, so
 * like the seal fields it is not part of what is sealed. A statement written
 * before statements were signed has no signature field, and its seal is the
 * same under this rule as under the one it was written with.
 */
export function statementSeal(body: Record<string, unknown>): string {
  const { sha256: _sha256, sha256Of: _sha256Of, signature: _signature, ...content } = body;
  return createHash("sha256").update(canonicalJson(content)).digest("hex");
}

/** True when a statement file's content still matches its seal. */
export function checkStatementSeal(document: unknown): boolean {
  if (typeof document !== "object" || document === null || Array.isArray(document)) return false;
  const record = document as Record<string, unknown>;
  return typeof record.sha256 === "string" && record.sha256 === statementSeal(record);
}

// ---------------------------------------------------------------------------
// Who wrote the statement? The per-install statement key and the signature.
// ---------------------------------------------------------------------------

/** The first MESH release whose `mesh statement` signs what it writes. Earlier releases (0.2.4) write unsigned statements. */
export const STATEMENT_SIGNING_SINCE = "0.2.5";

export const STATEMENT_SIGNATURE_ALGORITHM = "ed25519";

/** Exactly what a statement's signature is over, printed in the statement file itself. */
export const STATEMENT_SIGNATURE_RULE =
  "ed25519 signature, by the statement key of the MESH install that wrote this file, over the value of this " +
  "document's sha256 field (its 64 lowercase hexadecimal characters as UTF-8 bytes)";

/** The key file's format, and where it lives under the MESH home (~/.mesh): one definition for the CLI and the bill. */
export const STATEMENT_KEY_SCHEMA = "mesh-statement-key/1";
export const STATEMENT_KEY_DIR = "identity";
export const STATEMENT_KEY_FILE = "statement-key.json";

/** Written into the key file, so whoever opens it knows what it is. */
export const STATEMENT_KEY_NOTE =
  "PRIVATE. This is the statement key of this MESH install: it signs the statements `mesh statement` writes. " +
  "Never share, send or commit this file. The only part to give MESH is the fingerprint, printed by `mesh statement --key`.";

/** The signature object a signed statement carries beside its seal. Fixed-format fields only. */
export type StatementSignature = {
  algorithm: typeof STATEMENT_SIGNATURE_ALGORITHM;
  /** The raw 32-byte Ed25519 public key, base64. */
  publicKey: string;
  /** Lowercase hex sha256 of the raw public key: what the customer registers with MESH. */
  fingerprint: string;
  /** STATEMENT_SIGNATURE_RULE. */
  signs: string;
  /** The raw 64-byte signature, base64. */
  value: string;
};

/** A statement key in memory. `privateKey` (the raw 32-byte seed, base64) never leaves the machine it was made on. */
export type StatementKey = { publicKey: string; privateKey: string; fingerprint: string };

const HEX_64 = /^[0-9a-f]{64}$/;
// DER wrappers for a raw Ed25519 key (RFC 8410): the 32 raw bytes follow.
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Decode base64 of exactly `length` bytes, in its one canonical spelling; anything else is not a key or a signature. */
function exactBase64(value: unknown, length: number): Buffer | undefined {
  if (typeof value !== "string") return undefined;
  const bytes = Buffer.from(value, "base64");
  return bytes.length === length && bytes.toString("base64") === value ? bytes : undefined;
}

function publicKeyObject(raw: Buffer): KeyObject {
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

function privateKeyObject(rawSeed: Buffer): KeyObject {
  return createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, rawSeed]), format: "der", type: "pkcs8" });
}

/** The fingerprint of a statement key: lowercase hex sha256 of the raw 32-byte public key (given as base64 or bytes). */
export function statementKeyFingerprint(publicKey: string | Uint8Array): string {
  const raw = typeof publicKey === "string" ? exactBase64(publicKey, 32) : Buffer.from(publicKey);
  if (raw === undefined || raw.length !== 32) throw new Error("A statement public key is 32 bytes (base64).");
  return createHash("sha256").update(raw).digest("hex");
}

/** True for something shaped like a statement key fingerprint (64 lowercase hex characters). */
export function isStatementKeyFingerprint(value: unknown): value is string {
  return typeof value === "string" && HEX_64.test(value);
}

/** The whole key from its private half. Throws on anything that is not a 32-byte Ed25519 seed. */
export function statementKeyFromPrivate(privateKey: string): StatementKey {
  const seed = exactBase64(privateKey, 32);
  if (seed === undefined) throw new Error("A statement private key is 32 bytes (base64).");
  const spki = createPublicKey(privateKeyObject(seed)).export({ format: "der", type: "spki" });
  const raw = Buffer.from(spki.subarray(spki.length - 32));
  const publicKey = raw.toString("base64");
  return { publicKey, privateKey, fingerprint: statementKeyFingerprint(raw) };
}

/** Make a new statement key. The only function here that is not deterministic. */
export function generateStatementKey(): StatementKey {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" });
  return statementKeyFromPrivate(Buffer.from(pkcs8.subarray(pkcs8.length - 32)).toString("base64"));
}

/** The key file's text. It holds the private key: the caller writes it owner-only and never prints it. */
export function serializeStatementKeyFile(key: StatementKey, createdAt: string): string {
  return `${JSON.stringify({
    schema: STATEMENT_KEY_SCHEMA,
    note: STATEMENT_KEY_NOTE,
    algorithm: STATEMENT_SIGNATURE_ALGORITHM,
    createdAt,
    fingerprint: key.fingerprint,
    publicKey: key.publicKey,
    privateKey: key.privateKey,
  }, null, 2)}\n`;
}

/**
 * Read a key file's text. Throws, with a reason that never quotes the file,
 * unless it is a complete and self-consistent key: the public key must be the
 * one the private key produces, and the fingerprint must be that key's.
 */
export function parseStatementKeyFile(text: string): StatementKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("it is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("it is not a statement key file");
  const file = parsed as Record<string, unknown>;
  if (file.schema !== STATEMENT_KEY_SCHEMA) throw new Error(`its schema is not ${STATEMENT_KEY_SCHEMA}`);
  if (file.algorithm !== STATEMENT_SIGNATURE_ALGORITHM) throw new Error(`its algorithm is not ${STATEMENT_SIGNATURE_ALGORITHM}`);
  if (exactBase64(file.privateKey, 32) === undefined) throw new Error("its private key is missing or is not 32 bytes of base64");
  let key: StatementKey;
  try {
    key = statementKeyFromPrivate(file.privateKey as string);
  } catch {
    throw new Error("its private key is not a usable ed25519 key");
  }
  if (file.publicKey !== key.publicKey) throw new Error("its public key is not the one its private key produces");
  if (file.fingerprint !== key.fingerprint) throw new Error("its fingerprint is not the fingerprint of its public key");
  return key;
}

/**
 * Sign a statement's seal. What is signed is the seal value itself, the 64
 * lowercase hex characters, as UTF-8 bytes (STATEMENT_SIGNATURE_RULE). The seal
 * covers every other field of the statement, so the signature does too.
 * Ed25519 signatures are deterministic: the same key and seal give the same value.
 */
export function signStatementSeal(seal: string, privateKey: string): StatementSignature {
  if (!HEX_64.test(seal)) throw new Error("A statement seal is 64 lowercase hexadecimal characters.");
  const key = statementKeyFromPrivate(privateKey);
  const seed = exactBase64(privateKey, 32)!;
  return {
    algorithm: STATEMENT_SIGNATURE_ALGORITHM,
    publicKey: key.publicKey,
    fingerprint: key.fingerprint,
    signs: STATEMENT_SIGNATURE_RULE,
    value: sign(null, Buffer.from(seal, "utf8"), privateKeyObject(seed)).toString("base64"),
  };
}

export type StatementSignatureCheck =
  | {
      ok: true;
      /** Fingerprint of the key that signed it. Says which key, never whose. */
      fingerprint: string;
    }
  | {
      ok: false;
      /**
       * seal: the content no longer matches its seal. unsigned: there is no
       * signature at all. malformed: there is one, but it is not a signature
       * object of this format. invalid: well-formed, and it does not verify.
       */
      code: "seal" | "unsigned" | "malformed" | "invalid";
      reason: string;
    };

/**
 * Does a statement file's signature verify against the key the file itself
 * names? Checks the seal first, so `ok` means: the content matches the seal,
 * and the seal was signed by the holder of the key with this fingerprint.
 *
 * This shows the file is consistent with itself. It does not show whose key it
 * is: anyone can make a key and sign with it. Only comparing the fingerprint
 * with one registered beforehand does that (checkStatementForBilling).
 */
export function verifyStatementSignature(statement: unknown): StatementSignatureCheck {
  const bad = (code: "seal" | "unsigned" | "malformed" | "invalid", reason: string): StatementSignatureCheck =>
    ({ ok: false, code, reason });
  if (typeof statement !== "object" || statement === null || Array.isArray(statement)) {
    return bad("seal", "it is not a statement (not a JSON object).");
  }
  const record = statement as Record<string, unknown>;
  if (!checkStatementSeal(record)) return bad("seal", "its content does not match its sha256 seal.");
  const signature = record.signature;
  if (signature === undefined) return bad("unsigned", "it carries no signature.");
  if (typeof signature !== "object" || signature === null || Array.isArray(signature)) {
    return bad("malformed", "its signature field is not a signature object.");
  }
  const { algorithm, publicKey, fingerprint, signs, value } = signature as Record<string, unknown>;
  if (algorithm !== STATEMENT_SIGNATURE_ALGORITHM) return bad("malformed", `its signature algorithm is not ${STATEMENT_SIGNATURE_ALGORITHM}.`);
  if (signs !== STATEMENT_SIGNATURE_RULE) return bad("malformed", "its signature does not say it signs the statement's seal by the rule this build uses.");
  const rawPublicKey = exactBase64(publicKey, 32);
  if (rawPublicKey === undefined) return bad("malformed", "its signature's public key is not 32 bytes of base64.");
  const rawValue = exactBase64(value, 64);
  if (rawValue === undefined) return bad("malformed", "its signature value is not 64 bytes of base64.");
  const actualFingerprint = statementKeyFingerprint(rawPublicKey);
  if (fingerprint !== actualFingerprint) return bad("malformed", "its signature's fingerprint is not the fingerprint of its public key.");
  let verified = false;
  try {
    verified = verify(null, Buffer.from(record.sha256 as string, "utf8"), publicKeyObject(rawPublicKey), rawValue);
  } catch {
    verified = false;
  }
  if (!verified) return bad("invalid", "the signature does not verify against the public key in the file.");
  return { ok: true, fingerprint: actualFingerprint };
}

// ---------------------------------------------------------------------------
// Has the period ended?
// ---------------------------------------------------------------------------

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

/** The first instant AFTER a YYYY-MM period, in UTC: the period is every instant before it. */
export function periodEndsAt(period: string): Date {
  if (!PERIOD.test(period)) throw new Error(`"${period}" is not a billing period (YYYY-MM).`);
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  return new Date(Date.UTC(year, month, 1));
}

export type PeriodEndedCheck = { ended: true } | { ended: false; message: string };

/**
 * A period can be billed only once it is over in UTC: until then requests are
 * still being added to it. `now` is passed in, never read from the clock here.
 */
export function checkPeriodEnded(period: string, now: Date): PeriodEndedCheck {
  const endsAt = periodEndsAt(period);
  if (now.getTime() >= endsAt.getTime()) return { ended: true };
  return { ended: false, message: `period ${period} has not ended (it ends ${endsAt.toISOString()} UTC)` };
}

// ---------------------------------------------------------------------------
// Do the files in hand match the customer's statement?
// ---------------------------------------------------------------------------

/** What the bill knows about one spool it was passed. */
export type BillSpool = {
  /** File name, for the operator's screen only. */
  name: string;
  /** Records in the spool, all periods. */
  records: number;
  recordsInPeriod: number;
  /** Hash of the spool's last record; absent for an empty spool. */
  headHash?: string;
};

/** Describe one spool the way a statement describes it, so the two can be compared. */
export function describeBillSpool(name: string, records: readonly LedgerRecord[], period: string): BillSpool {
  const head = records.at(-1);
  return {
    name,
    records: records.length,
    recordsInPeriod: records.filter((record) => record.event.invoicePeriod === period).length,
    ...(head === undefined || typeof head.eventHash !== "string" ? {} : { headHash: head.eventHash }),
  };
}

export type StatementBillingCheckInput = {
  /** The parsed statement file, untrusted. */
  statement: unknown;
  /** The period being billed (--period). */
  period: string;
  /** Every ledger spool the bill read. */
  spools: readonly BillSpool[];
  /** The bill's own recompute. */
  bill: { netVerifiedSavingsUsd: number; feeCents: number; feePercent: number };
  /**
   * Whether a statement written before the period ended is refused. Default
   * true, and a real bill never turns it off. A dry run passes false so a
   * rehearsal during the month still compares the spools and the figures; the
   * open period then comes back as a warning instead of a refusal.
   */
  periodMustBeClosed?: boolean;
  /**
   * The statement key fingerprint the customer registered when billing was
   * agreed (64 lowercase hex characters). The statement must be signed by
   * exactly this key.
   */
  expectedKeyFingerprint?: string;
  /**
   * Whether a check with no `expectedKeyFingerprint` is refused. Default true,
   * and a real bill never turns it off. A dry run passes false: the signature
   * must still be present and verify, and the result says which key signed it,
   * with a warning that nobody compared it with a registered key.
   */
  keyMustBeRegistered?: boolean;
  /**
   * The fingerprint of the statement key of the MESH install on the machine
   * running the bill, when it has one. A statement signed by that key was
   * written here, not by the customer, and is refused whatever else is passed.
   */
  operatorKeyFingerprint?: string;
};

export type StatementBillingCheck =
  | {
      ok: true;
      /** One line for the operator: what matched. */
      summary: string;
      spools: number;
      records: number;
      recordsInPeriod: number;
      netVerifiedSavingsUsd: number;
      feeCents: number;
      /** Fingerprint of the statement key that signed the statement. */
      signedBy: string;
      /** True when that fingerprint was compared with, and equals, the customer's registered key. */
      signerIsRegisteredKey: boolean;
      /** Things a real bill would refuse that a dry run was told to let through. Empty for a real bill. */
      warnings: string[];
    }
  | {
      ok: false;
      /** Exactly what did not match; printed after "DO NOT BILL — ". */
      reason: string;
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const count = (n: number, one: string): string => `${n} ${n === 1 ? one : `${one}s`}`;
const hashLabel = (hash: string | undefined): string => (hash === undefined ? "no records, so no head hash" : `head hash ${hash}`);

/** A release number a statement may name, e.g. 0.2.4. The field is untrusted, so anything else is not repeated. */
const PLAIN_VERSION = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/;

/**
 * What an unsigned statement says about the build that wrote it: the version
 * (only when it is a plain release number), and whether that build is from
 * before statements were signed. Two things in the file say it was written by
 * a build that signs: the seal rule it quotes (builds that sign leave the
 * signature out of the seal, and say so), and a version at or after
 * STATEMENT_SIGNING_SINCE. With neither, it counts as before: release 0.2.4
 * is where unsigned statements come from. Both fields are untrusted, and this
 * only chooses the wording of a refusal: an unsigned statement is refused
 * either way.
 */
export function unsignedStatementOrigin(statement: unknown): { version?: string; predatesSigning: boolean } {
  const mesh = isRecord(statement) ? statement.mesh : undefined;
  const text = isRecord(mesh) && typeof mesh.version === "string" ? mesh.version : "";
  const parts = PLAIN_VERSION.exec(text);
  const version = parts === null ? {} : { version: text };
  if (isRecord(statement) && statement.sha256Of === STATEMENT_SEAL_RULE) return { ...version, predatesSigning: false };
  if (parts === null) return { predatesSigning: true };
  const since = PLAIN_VERSION.exec(STATEMENT_SIGNING_SINCE)!;
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(parts[index]) - Number(since[index]);
    if (difference !== 0) return { ...version, predatesSigning: difference < 0 };
  }
  return { ...version, predatesSigning: false };
}

/** Net savings are sums of floats; two honest recomputes can differ in the last bits, never by a billable amount. */
function sameUsd(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left), Math.abs(right));
}

/**
 * Check the customer's statement against the bill, in a fixed order, stopping
 * at the first step that fails:
 *
 *   1. the sha256 seal (the file was not edited after it was written);
 *   2. the signature: present, and verifies against the key the file names;
 *      not signed by the machine running the bill; signed by the key the
 *      customer registered;
 *   3. it is a statement of the expected schema, valid for billing, over a
 *      ledger whose chain verified;
 *   4. it is for the period being billed, and says that period is closed;
 *   5. the spools passed are exactly the spools it was computed from: each one
 *      matched by head hash, total record count and record count in the
 *      period, with none missing and none extra;
 *   6. its net verified savings and its fee in cents are the bill's own.
 *
 * Step 2 is what stops a statement the operator wrote themselves from the
 * files that arrived: such a statement passes every other step trivially.
 */
export function checkStatementForBilling(input: StatementBillingCheckInput): StatementBillingCheck {
  const { statement, period, spools, bill } = input;
  const fail = (reason: string): StatementBillingCheck => ({ ok: false, reason });

  // 1. The seal.
  if (!isRecord(statement)) return fail("the statement file is not a statement (it is not a JSON object).");
  if (!checkStatementSeal(statement)) {
    return fail("the statement does not match its sha256 seal: it was edited or damaged after it was written.");
  }

  // 2. Who wrote it.
  const warnings: string[] = [];
  const signature = verifyStatementSignature(statement);
  if (!signature.ok) {
    if (signature.code === "unsigned") {
      // Statements in this state exist: release 0.2.4 wrote them. Say exactly that.
      const { version, predatesSigning } = unsignedStatementOrigin(statement);
      if (!predatesSigning) {
        return fail(
          "the statement is not signed, although it was written by a Mesh build that signs every statement" +
          `${version === undefined ? "" : ` (it says Mesh ${version})`}: ` +
          "its signature was removed, or it was not written by `mesh statement`. " +
          `The customer must run \`mesh statement --period ${period}\` again and send that file.`,
        );
      }
      return fail(
        "the statement is not signed: it was written by a Mesh release that does not sign statements " +
        `(${version === undefined ? "it does not say which" : `it says Mesh ${version}`}; signing starts with ${STATEMENT_SIGNING_SINCE}), ` +
        "so nothing shows it came from the customer's own install. " +
        `The customer must update to Mesh ${STATEMENT_SIGNING_SINCE} or later and run \`mesh statement --period ${period}\` again.`,
      );
    }
    return fail(
      `the statement's signature does not verify: ${signature.reason} ` +
      "The signature, the key or the seal was changed after the statement was signed; ask the customer to write it again.",
    );
  }
  const signedBy = signature.fingerprint;
  if (input.operatorKeyFingerprint !== undefined && signedBy === input.operatorKeyFingerprint) {
    return fail(
      "this statement was written on this machine, not by the customer: it is signed by this machine's own Mesh install " +
      `(statement key ${signedBy}). The statement must be the one the customer wrote on their own machine.`,
    );
  }
  let signerIsRegisteredKey = false;
  if (input.expectedKeyFingerprint === undefined) {
    const notCompared =
      `the statement is signed by statement key ${signedBy}, and no registered customer key was given to compare it with, ` +
      "so who wrote the statement was not checked.";
    if (input.keyMustBeRegistered !== false) return fail(notCompared);
    warnings.push(notCompared);
  } else if (!isStatementKeyFingerprint(input.expectedKeyFingerprint)) {
    return fail("the registered customer key given is not a statement key fingerprint (64 lowercase hexadecimal characters).");
  } else if (signedBy !== input.expectedKeyFingerprint) {
    return fail(
      `the statement is signed by statement key ${signedBy}, which is not the customer's registered key ` +
      `${input.expectedKeyFingerprint}. Never accept a new key that arrives with the statement: confirm a changed key ` +
      "with the customer through the agreed channel first (runbook, \"The customer's key changed\").",
    );
  } else {
    signerIsRegisteredKey = true;
  }

  // 3. What it is.
  if (statement.schema !== STATEMENT_SCHEMA || statement.kind !== "statement") {
    return fail(
      `the statement file is not a ${STATEMENT_SCHEMA} statement (schema ${JSON.stringify(statement.schema)}, kind ${JSON.stringify(statement.kind)}).`,
    );
  }
  if (statement.validForBilling !== true) return fail("the statement does not say it is valid for billing.");
  const ledger = statement.ledger;
  if (!isRecord(ledger) || ledger.chainVerified !== true) {
    return fail("the statement does not say its ledger's hash chain verified.");
  }

  // 4. The period.
  const statementPeriod = statement.period;
  if (!isRecord(statementPeriod) || statementPeriod.id !== period) {
    const got = isRecord(statementPeriod) ? JSON.stringify(statementPeriod.id) : "none";
    return fail(`the statement is for period ${got}, but the bill is for period ${period}.`);
  }
  if (statementPeriod.closed !== true) {
    const notClosed =
      `the statement was written before period ${period} had ended (closed: false), so its figures could still change. ` +
      "Ask for a statement produced after the period ended.";
    if (input.periodMustBeClosed !== false) return fail(notClosed);
    warnings.push(notClosed);
  }

  // 5. The spools.
  if (!Array.isArray(ledger.spools) || !ledger.spools.every(isRecord)) {
    return fail("the statement does not list the spools it was computed from.");
  }
  const expected = (ledger.spools as Record<string, unknown>[]).map((spool) => ({
    records: typeof spool.records === "number" ? spool.records : Number.NaN,
    recordsInPeriod: typeof spool.recordsInPeriod === "number" ? spool.recordsInPeriod : Number.NaN,
    headHash: typeof spool.headHash === "string" ? spool.headHash : undefined,
    matched: false,
  }));
  const problems: string[] = [];
  for (const spool of spools) {
    const candidate = expected.find((entry) => !entry.matched && entry.headHash === spool.headHash);
    if (candidate === undefined) {
      problems.push(
        `spool ${spool.name} (${hashLabel(spool.headHash)}; ${count(spool.records, "record")}, ${spool.recordsInPeriod} in ${period}) ` +
        "matches no spool in the statement",
      );
      continue;
    }
    candidate.matched = true;
    if (candidate.records !== spool.records || candidate.recordsInPeriod !== spool.recordsInPeriod) {
      problems.push(
        `spool ${spool.name} (${hashLabel(spool.headHash)}): the statement expects ${count(candidate.records, "record")}, ` +
        `${candidate.recordsInPeriod} in ${period}; received ${count(spool.records, "record")}, ${spool.recordsInPeriod} in ${period}`,
      );
    }
  }
  for (const entry of expected) {
    if (entry.matched) continue;
    problems.push(
      `the statement lists a spool that was not passed (${hashLabel(entry.headHash)}; expected ${count(entry.records, "record")}, ` +
      `${entry.recordsInPeriod} in ${period})`,
    );
  }
  if (problems.length > 0) {
    return fail(
      `the ledger files passed are not the ledger the statement was computed from: ${problems.join("; ")}. ` +
      `The statement covers ${count(expected.length, "spool")}; ${count(spools.length, "spool")} passed.`,
    );
  }

  // 6. The figures.
  const totals = statement.totals;
  const fee = statement.fee;
  const statementNet = isRecord(totals) && typeof totals.netVerifiedSavingsUsd === "number" ? totals.netVerifiedSavingsUsd : undefined;
  const statementFeeCents = isRecord(fee) && typeof fee.amountCents === "number" ? fee.amountCents : undefined;
  const statementRate = isRecord(fee) && typeof fee.ratePercent === "number" ? fee.ratePercent : undefined;
  if (statementNet === undefined || statementFeeCents === undefined || statementRate === undefined) {
    return fail("the statement does not carry net verified savings, a fee rate and a fee in cents.");
  }
  if (statementRate !== bill.feePercent) {
    return fail(`the statement's fee rate is ${statementRate}%, but the bill's is ${bill.feePercent}%.`);
  }
  if (!sameUsd(statementNet, bill.netVerifiedSavingsUsd)) {
    return fail(
      `net verified savings differ: the statement says $${statementNet.toFixed(6)}, the bill's own recompute says ` +
      `$${bill.netVerifiedSavingsUsd.toFixed(6)}.`,
    );
  }
  if (statementFeeCents !== bill.feeCents) {
    return fail(
      `the fee differs: the statement says ${count(statementFeeCents, "cent")}, the bill's own recompute says ${count(bill.feeCents, "cent")}.`,
    );
  }

  const records = spools.reduce((sum, spool) => sum + spool.records, 0);
  const recordsInPeriod = spools.reduce((sum, spool) => sum + spool.recordsInPeriod, 0);
  return {
    ok: true,
    summary:
      `statement matched: ${count(spools.length, "spool")}, ${count(records, "record")} (${recordsInPeriod} in ${period}), ` +
      `net verified savings $${bill.netVerifiedSavingsUsd.toFixed(4)}, fee ${count(bill.feeCents, "cent")}, ` +
      (signerIsRegisteredKey
        ? `signed by the customer's registered statement key ${signedBy}`
        : `signed by statement key ${signedBy} (not compared with a registered key)`),
    spools: spools.length,
    records,
    recordsInPeriod,
    netVerifiedSavingsUsd: bill.netVerifiedSavingsUsd,
    feeCents: bill.feeCents,
    signedBy,
    signerIsRegisteredKey,
    warnings,
  };
}
