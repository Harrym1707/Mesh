import { createHash } from "node:crypto";
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
 * the two cannot drift.
 */

/** The statement file format `mesh statement` writes and a manual bill accepts. */
export const STATEMENT_SCHEMA = "mesh-statement/1";

/** How a statement's seal is computed, printed in the statement file itself. */
export const STATEMENT_SEAL_RULE =
  "sha256 of this document as canonical JSON (keys sorted, no whitespace) without the sha256 and sha256Of fields";

/** The seal over a statement's content. */
export function statementSeal(body: Record<string, unknown>): string {
  const { sha256: _sha256, sha256Of: _sha256Of, ...content } = body;
  return createHash("sha256").update(canonicalJson(content)).digest("hex");
}

/** True when a statement file's content still matches its seal. */
export function checkStatementSeal(document: unknown): boolean {
  if (typeof document !== "object" || document === null || Array.isArray(document)) return false;
  const record = document as Record<string, unknown>;
  return typeof record.sha256 === "string" && record.sha256 === statementSeal(record);
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

/** Net savings are sums of floats; two honest recomputes can differ in the last bits, never by a billable amount. */
function sameUsd(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left), Math.abs(right));
}

/**
 * Check the customer's statement against the bill, in a fixed order, stopping
 * at the first step that fails:
 *
 *   1. the sha256 seal (the file was not edited after it was written);
 *   2. it is a statement of the expected schema, valid for billing, over a
 *      ledger whose chain verified;
 *   3. it is for the period being billed, and says that period is closed;
 *   4. the spools passed are exactly the spools it was computed from: each one
 *      matched by head hash, total record count and record count in the
 *      period, with none missing and none extra;
 *   5. its net verified savings and its fee in cents are the bill's own.
 */
export function checkStatementForBilling(input: StatementBillingCheckInput): StatementBillingCheck {
  const { statement, period, spools, bill } = input;
  const fail = (reason: string): StatementBillingCheck => ({ ok: false, reason });

  // 1. The seal.
  if (!isRecord(statement)) return fail("the statement file is not a statement (it is not a JSON object).");
  if (!checkStatementSeal(statement)) {
    return fail("the statement does not match its sha256 seal: it was edited or damaged after it was written.");
  }

  // 2. What it is.
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

  // 3. The period.
  const statementPeriod = statement.period;
  if (!isRecord(statementPeriod) || statementPeriod.id !== period) {
    const got = isRecord(statementPeriod) ? JSON.stringify(statementPeriod.id) : "none";
    return fail(`the statement is for period ${got}, but the bill is for period ${period}.`);
  }
  const warnings: string[] = [];
  if (statementPeriod.closed !== true) {
    const notClosed =
      `the statement was written before period ${period} had ended (closed: false), so its figures could still change. ` +
      "Ask for a statement produced after the period ended.";
    if (input.periodMustBeClosed !== false) return fail(notClosed);
    warnings.push(notClosed);
  }

  // 4. The spools.
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

  // 5. The figures.
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
      `net verified savings $${bill.netVerifiedSavingsUsd.toFixed(4)}, fee ${count(bill.feeCents, "cent")}`,
    spools: spools.length,
    records,
    recordsInPeriod,
    netVerifiedSavingsUsd: bill.netVerifiedSavingsUsd,
    feeCents: bill.feeCents,
    warnings,
  };
}
