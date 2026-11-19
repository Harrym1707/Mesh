import { describe, expect, it } from "vitest";
import {
  STATEMENT_SCHEMA,
  STATEMENT_SEAL_RULE,
  checkPeriodEnded,
  checkStatementForBilling,
  checkStatementSeal,
  describeBillSpool,
  periodEndsAt,
  statementSeal,
  type BillSpool,
} from "./manual-billing-checks.js";
import { chainLedgerRecord, recomputeInvoice, verifyLedgerChain, type BillableEvent, type LedgerRecord } from "./savings-ledger.js";
import { buildStripeInvoicePlan } from "./stripe-billing.js";

const PERIOD = "2026-10";

let counter = 0;
const saved = (savedUsd: number, invoicePeriod = PERIOD): BillableEvent => {
  counter += 1;
  return {
    schemaVersion: 1,
    requestId: `r${counter}`,
    applicationId: "app",
    invoicePeriod,
    timestamp: `${invoicePeriod}-15T10:00:00.000Z`,
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    executionMode: "standard",
    pricingStatus: "priced",
    levers: [{ leverId: "duplicate-context-removal", kind: "lossless", savedUsd }],
    status: "succeeded",
  };
};

function chain(events: BillableEvent[]): LedgerRecord[] {
  const records: LedgerRecord[] = [];
  for (const event of events) records.push(chainLedgerRecord(event, records[records.length - 1]));
  return records;
}

type Ledger = Record<string, LedgerRecord[]>;

/** Two spools: $9.5947 net in 2026-10 across both, plus one September record. */
function ledger(): Ledger {
  counter = 0;
  return {
    "app-anthropic.jsonl": chain([saved(1, "2026-09"), saved(4), saved(3.0947), saved(0.5)]),
    "app-openai.jsonl": chain([saved(1.5), saved(0.5)]),
  };
}

/** What the bill itself computes from the files in hand: scripts/mesh-bill.ts's sequence. */
function billOf(files: Ledger, period = PERIOD) {
  const spools: BillSpool[] = Object.entries(files).map(([name, records]) => describeBillSpool(name, records, period));
  const chainVerified = Object.values(files).every((records) => verifyLedgerChain(records).ok);
  const invoice = recomputeInvoice(Object.values(files).flatMap((records) => records.map((r) => r.event)), { period, feePercent: 1 });
  const plan = buildStripeInvoicePlan(invoice, chainVerified, { stripeCustomerId: "cus_TEST" });
  return {
    spools,
    bill: {
      netVerifiedSavingsUsd: invoice.netVerifiedSavingsUsd,
      feeCents: plan.action === "bill" ? plan.amountCents : 0,
      feePercent: 1,
    },
  };
}

/** A sealed statement shaped as `mesh statement` writes it, over the given files. */
function statementOf(files: Ledger, period = PERIOD, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { spools, bill } = billOf(files, period);
  const body: Record<string, unknown> = {
    schema: STATEMENT_SCHEMA,
    kind: "statement",
    period: { id: period, timezone: "UTC", closed: true },
    currency: "USD",
    validForBilling: true,
    ledger: {
      chainVerified: true,
      spools: spools.map((spool) => ({
        records: spool.records,
        recordsInPeriod: spool.recordsInPeriod,
        chainVerified: true,
        ...(spool.headHash === undefined ? {} : { headSeq: spool.records - 1, headHash: spool.headHash }),
      })),
    },
    totals: { netVerifiedSavingsUsd: bill.netVerifiedSavingsUsd },
    fee: { ratePercent: 1, amountCents: bill.feeCents, amountUsd: bill.feeCents / 100 },
    ...overrides,
  };
  return { ...body, sha256Of: STATEMENT_SEAL_RULE, sha256: statementSeal(body) };
}

const check = (statement: unknown, files: Ledger, period = PERIOD, extra: { periodMustBeClosed?: boolean } = {}) =>
  checkStatementForBilling({ statement, period, ...billOf(files, period), ...extra });

const reasonOf = (result: ReturnType<typeof checkStatementForBilling>): string => {
  if (result.ok) throw new Error(`expected a refusal, got: ${result.summary}`);
  return result.reason;
};

describe("the statement seal (one definition, shared by the customer's command and the bill)", () => {
  it("matches an untouched statement and fails an edited one", () => {
    const statement = statementOf(ledger());
    expect(checkStatementSeal(statement)).toBe(true);
    expect(statementSeal(statement)).toBe(statement.sha256);
    expect(checkStatementSeal({ ...statement, fee: { ratePercent: 1, amountCents: 0, amountUsd: 0 } })).toBe(false);
    expect(checkStatementSeal({ ...statement, sha256: undefined })).toBe(false);
    expect(checkStatementSeal(null)).toBe(false);
    expect(checkStatementSeal([statement])).toBe(false);
  });

  it("does not depend on key order or on the seal fields themselves", () => {
    const statement = statementOf(ledger());
    const reordered = Object.fromEntries(Object.entries(statement).reverse());
    expect(statementSeal(reordered)).toBe(statement.sha256);
    expect(statementSeal({ ...statement, sha256: "x", sha256Of: "y" })).toBe(statement.sha256);
  });
});

describe("checkPeriodEnded: a period is billed only once it is over in UTC", () => {
  it("refuses the last millisecond of the month and allows the first millisecond of the next", () => {
    expect(periodEndsAt("2026-11").toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(checkPeriodEnded("2026-11", new Date("2026-11-30T23:59:59.999Z"))).toEqual({
      ended: false,
      message: "period 2026-11 has not ended (it ends 2026-12-01T00:00:00.000Z UTC)",
    });
    expect(checkPeriodEnded("2026-11", new Date("2026-12-01T00:00:00.000Z"))).toEqual({ ended: true });
  });

  it("works in UTC whatever the local offset of the time given, and across a year end", () => {
    // 1 December, 00:30 in UTC+2 is still 30 November, 22:30 UTC.
    expect(checkPeriodEnded("2026-11", new Date("2026-12-01T00:30:00.000+02:00")).ended).toBe(false);
    // 30 November, 23:30 in UTC-2 is already 1 December, 01:30 UTC.
    expect(checkPeriodEnded("2026-11", new Date("2026-11-30T23:30:00.000-02:00")).ended).toBe(true);
    expect(periodEndsAt("2026-12").toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(checkPeriodEnded("2026-12", new Date("2026-12-31T23:59:59.999Z")).ended).toBe(false);
    expect(checkPeriodEnded("2026-12", new Date("2027-01-01T00:00:00.000Z")).ended).toBe(true);
    expect(checkPeriodEnded("2026-11", new Date("2026-11-19T12:00:00.000Z")).ended).toBe(false);
    expect(checkPeriodEnded("2026-10", new Date("2026-11-19T12:00:00.000Z")).ended).toBe(true);
  });

  it("rejects something that is not a period", () => {
    expect(() => periodEndsAt("2026-13")).toThrow(/not a billing period/);
    expect(() => checkPeriodEnded("all", new Date())).toThrow(/not a billing period/);
  });
});

describe("checkStatementForBilling: the files in hand against the customer's statement", () => {
  it("a matching set passes and says what matched", () => {
    const files = ledger();
    const result = check(statementOf(files), files);
    expect(result).toEqual({
      ok: true,
      summary: "statement matched: 2 spools, 6 records (5 in 2026-10), net verified savings $9.5947, fee 9 cents",
      spools: 2,
      records: 6,
      recordsInPeriod: 5,
      netVerifiedSavingsUsd: billOf(files).bill.netVerifiedSavingsUsd,
      feeCents: 9,
      warnings: [],
    });
  });

  it("does not depend on the order the spools are passed in", () => {
    const files = ledger();
    const reversed = Object.fromEntries(Object.entries(files).reverse());
    expect(check(statementOf(files), reversed).ok).toBe(true);
  });

  it("one spool missing: refused, naming the spool the statement expects by head hash and counts", () => {
    const files = ledger();
    const statement = statementOf(files);
    const { "app-openai.jsonl": missing, ...rest } = files;
    const reason = reasonOf(check(statement, rest));
    const missingHead = missing!.at(-1)!.eventHash;
    expect(reason).toBe(
      "the ledger files passed are not the ledger the statement was computed from: " +
      `the statement lists a spool that was not passed (head hash ${missingHead}; expected 2 records, 2 in 2026-10). ` +
      "The statement covers 2 spools; 1 spool passed.",
    );
  });

  it("one spool with its last record removed: still a valid chain, and refused with expected against received", () => {
    const files = ledger();
    const statement = statementOf(files);
    const full = files["app-anthropic.jsonl"]!;
    const cut = full.slice(0, -1);
    // The cut-off spool verifies on its own: the chain alone would not catch this.
    expect(verifyLedgerChain(cut).ok).toBe(true);
    const reason = reasonOf(check(statement, { ...files, "app-anthropic.jsonl": cut }));
    expect(reason).toBe(
      "the ledger files passed are not the ledger the statement was computed from: " +
      `spool app-anthropic.jsonl (head hash ${cut.at(-1)!.eventHash}; 3 records, 2 in 2026-10) matches no spool in the statement; ` +
      `the statement lists a spool that was not passed (head hash ${full.at(-1)!.eventHash}; expected 4 records, 3 in 2026-10). ` +
      "The statement covers 2 spools; 2 spools passed.",
    );
  });

  it("an extra spool, or the same spool passed twice, is refused", () => {
    const files = ledger();
    const statement = statementOf(files);
    counter = 100;
    const extra = chain([saved(2)]);
    expect(reasonOf(check(statement, { ...files, "other-anthropic.jsonl": extra }))).toContain(
      "spool other-anthropic.jsonl (head hash " + extra.at(-1)!.eventHash + "; 1 record, 1 in 2026-10) matches no spool in the statement",
    );
    expect(reasonOf(check(statement, { ...files, "copy.jsonl": files["app-openai.jsonl"]! }))).toContain(
      "spool copy.jsonl",
    );
  });

  it("the same head hash with different counts is refused with both sets of counts", () => {
    const files = ledger();
    const statement = statementOf(files);
    const lied = statementOf(files, PERIOD, {
      ledger: {
        chainVerified: true,
        spools: (statement.ledger as { spools: Record<string, unknown>[] }).spools.map((spool, index) =>
          (index === 0 ? { ...spool, records: 9, recordsInPeriod: 7 } : spool)),
      },
    });
    expect(reasonOf(check(lied, files))).toContain(
      "the statement expects 9 records, 7 in 2026-10; received 4 records, 3 in 2026-10",
    );
  });

  it("a statement for another period is refused", () => {
    const files = ledger();
    const september = statementOf(files, "2026-09");
    expect(reasonOf(check(september, files))).toBe(
      'the statement is for period "2026-09", but the bill is for period 2026-10.',
    );
  });

  it("an edited statement is refused on its seal, before anything else is read from it", () => {
    const files = ledger();
    const statement = statementOf(files);
    const edited = { ...statement, fee: { ratePercent: 1, amountCents: 1, amountUsd: 0.01 } };
    expect(reasonOf(check(edited, files))).toBe(
      "the statement does not match its sha256 seal: it was edited or damaged after it was written.",
    );
    expect(reasonOf(check("not a statement", files))).toContain("not a JSON object");
    expect(reasonOf(check({ hello: "world" }, files))).toContain("sha256 seal");
  });

  it("a statement written before the period ended (closed: false) is refused", () => {
    const files = ledger();
    const open = statementOf(files, PERIOD, { period: { id: PERIOD, timezone: "UTC", closed: false } });
    expect(reasonOf(check(open, files))).toBe(
      "the statement was written before period 2026-10 had ended (closed: false), so its figures could still change. " +
      "Ask for a statement produced after the period ended.",
    );
  });

  it("only a dry run may let an open period through, and then as a warning with the rest still checked", () => {
    const files = ledger();
    const open = statementOf(files, PERIOD, { period: { id: PERIOD, timezone: "UTC", closed: false } });
    const rehearsal = check(open, files, PERIOD, { periodMustBeClosed: false });
    if (!rehearsal.ok) throw new Error(rehearsal.reason);
    expect(rehearsal.warnings).toHaveLength(1);
    expect(rehearsal.warnings[0]).toContain("closed: false");
    expect(rehearsal.feeCents).toBe(9);
    // The spools are still compared in a rehearsal.
    const { "app-openai.jsonl": _missing, ...rest } = files;
    expect(check(open, rest, PERIOD, { periodMustBeClosed: false }).ok).toBe(false);
  });

  it("a fee differing by one cent is refused, with both figures", () => {
    const files = ledger();
    const off = statementOf(files, PERIOD, { fee: { ratePercent: 1, amountCents: 10, amountUsd: 0.1 } });
    expect(reasonOf(check(off, files))).toBe(
      "the fee differs: the statement says 10 cents, the bill's own recompute says 9 cents.",
    );
    const under = statementOf(files, PERIOD, { fee: { ratePercent: 1, amountCents: 8, amountUsd: 0.08 } });
    expect(reasonOf(check(under, files))).toContain("the statement says 8 cents, the bill's own recompute says 9 cents");
  });

  it("differing net savings are refused; floating-point noise is not a difference", () => {
    const files = ledger();
    const net = billOf(files).bill.netVerifiedSavingsUsd;
    const off = statementOf(files, PERIOD, { totals: { netVerifiedSavingsUsd: net + 0.01 } });
    expect(reasonOf(check(off, files))).toBe(
      `net verified savings differ: the statement says $${(net + 0.01).toFixed(6)}, the bill's own recompute says $${net.toFixed(6)}.`,
    );
    const noise = statementOf(files, PERIOD, { totals: { netVerifiedSavingsUsd: net + 1e-13 } });
    expect(check(noise, files).ok).toBe(true);
  });

  it("refuses a statement at another fee rate, of another schema, not valid for billing, or over an unverified ledger", () => {
    const files = ledger();
    expect(reasonOf(check(statementOf(files, PERIOD, { fee: { ratePercent: 2, amountCents: 9 } }), files))).toBe(
      "the statement's fee rate is 2%, but the bill's is 1%.",
    );
    expect(reasonOf(check(statementOf(files, PERIOD, { schema: "mesh-statement/0" }), files))).toContain(
      "is not a mesh-statement/1 statement",
    );
    expect(reasonOf(check(statementOf(files, PERIOD, { kind: "invoice" }), files))).toContain("is not a mesh-statement/1 statement");
    expect(reasonOf(check(statementOf(files, PERIOD, { validForBilling: false }), files))).toBe(
      "the statement does not say it is valid for billing.",
    );
    expect(reasonOf(check(statementOf(files, PERIOD, { ledger: { chainVerified: false, spools: [] } }), files))).toBe(
      "the statement does not say its ledger's hash chain verified.",
    );
    expect(reasonOf(check(statementOf(files, PERIOD, { totals: {} }), files))).toContain("does not carry net verified savings");
  });

  it("a period that owes nothing still has to match: zero cents on both sides", () => {
    counter = 0;
    const files: Ledger = { "app-anthropic.jsonl": chain([saved(0.3609)]) };
    const result = check(statementOf(files), files);
    if (!result.ok) throw new Error(result.reason);
    expect(result.summary).toBe(
      "statement matched: 1 spool, 1 record (1 in 2026-10), net verified savings $0.3609, fee 0 cents",
    );
  });

  it("describeBillSpool counts records in the period and takes the head hash from the last record", () => {
    const files = ledger();
    const records = files["app-anthropic.jsonl"]!;
    expect(describeBillSpool("a.jsonl", records, PERIOD)).toEqual({
      name: "a.jsonl", records: 4, recordsInPeriod: 3, headHash: records.at(-1)!.eventHash,
    });
    expect(describeBillSpool("a.jsonl", records, "2026-09")).toMatchObject({ records: 4, recordsInPeriod: 1 });
    expect(describeBillSpool("empty.jsonl", [], PERIOD)).toEqual({ name: "empty.jsonl", records: 0, recordsInPeriod: 0 });
  });
});
