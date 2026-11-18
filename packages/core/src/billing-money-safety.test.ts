import { describe, expect, it } from "vitest";
import { AccountStore, type Account } from "./accounts.js";
import { publishedModelPrices } from "./model-prices.js";
import {
  chainLedgerRecord,
  type BillableEvent,
  type LedgerRecord,
} from "./savings-ledger.js";
import { settleAccountBilling } from "./billing-worker.js";
import type { BillingStripe, StripeInvoice, StripeInvoiceItem } from "./stripe-client.js";

/**
 * Money-safety regression suite — one failing-first group per hole the Phase-2
 * review found. Every test runs against a fake {@link BillingStripe}; no live
 * key is ever constructed.
 */

type Call = { method: string; args: Record<string, unknown> };

function recordingStripe(): { stripe: BillingStripe; calls: Call[] } {
  const calls: Call[] = [];
  let n = 0;
  const stripe: BillingStripe = {
    mode: "test",
    async createInvoice(params) {
      n += 1;
      calls.push({ method: "createInvoice", args: params as unknown as Record<string, unknown> });
      return { id: `in_${n}`, status: "draft" } satisfies StripeInvoice;
    },
    async createInvoiceItem(params) {
      calls.push({ method: "createInvoiceItem", args: params as unknown as Record<string, unknown> });
      return { id: "ii" } satisfies StripeInvoiceItem;
    },
    async finalizeInvoice(invoiceId, idempotencyKey) {
      calls.push({ method: "finalizeInvoice", args: { invoiceId, idempotencyKey } });
      return { id: invoiceId, status: "open", hosted_invoice_url: "https://pay.test/" + invoiceId };
    },
    async payInvoice(invoiceId, idempotencyKey) {
      calls.push({ method: "payInvoice", args: { invoiceId, idempotencyKey } });
      return { id: invoiceId, status: "paid" };
    },
  };
  return { stripe, calls };
}

function createdInvoices(calls: Call[]): number {
  return calls.filter((c) => c.method === "createInvoice").length;
}

function event(overrides: Partial<BillableEvent> & { requestId: string }): BillableEvent {
  return {
    schemaVersion: 1,
    applicationId: "app",
    invoicePeriod: "2026-10",
    timestamp: "2026-10-13T10:00:00.000Z",
    provider: "openai",
    model: "gpt-5",
    executionMode: "standard",
    pricingStatus: "priced",
    levers: [],
    status: "succeeded",
    ...overrides,
  };
}

/** Chain a list of events into a valid ledger spool. */
function spool(events: BillableEvent[]): LedgerRecord[] {
  const records: LedgerRecord[] = [];
  let prev: LedgerRecord | undefined;
  for (const e of events) {
    prev = chainLedgerRecord(e, prev);
    records.push(prev);
  }
  return records;
}

/** A store seeded with one billable account. Default rail: bank_transfer, fee 10%. */
function store(overrides: Partial<Account> = {}): { accounts: AccountStore; id: string } {
  const accounts = new AccountStore();
  const { account } = accounts.upsertFromGithub({ githubId: 1, githubLogin: "octo" });
  accounts.patch(account.id, {
    stripeCustomerId: "cus_TEST",
    paymentChoice: "bank_transfer",
    feePercent: 10,
    ...overrides,
  });
  return { accounts, id: account.id };
}

/** Lossless lever, no usage → not re-derived, nets straight to the invoice. */
function savingEvents(savedUsd = 100): BillableEvent[] {
  return [event({ requestId: "a", levers: [{ leverId: "schema", kind: "lossless", savedUsd }] })];
}

const CAT = { catalogue: publishedModelPrices } as const;

describe("Fix 2 — mandatory period", () => {
  it("refuses to settle without an explicit period, and charges nothing", async () => {
    const { stripe, calls } = recordingStripe();
    const { accounts, id } = store();
    const records = spool(savingEvents());
    await expect(
      settleAccountBilling(stripe, accounts, accounts.get(id)!, records, ""),
    ).rejects.toThrow(/explicit invoice period/);
    expect(calls).toHaveLength(0);
  });
});

describe("Fix 1 — persistent idempotency", () => {
  it("charges a period exactly once; an immediate re-run is a Stripe no-op", async () => {
    const { stripe, calls } = recordingStripe();
    const { accounts, id } = store();
    const records = spool(savingEvents());

    const first = await settleAccountBilling(stripe, accounts, accounts.get(id)!, records, "2026-10", CAT);
    expect(first.status).toBe("billed");
    expect(createdInvoices(calls)).toBe(1);

    const again = await settleAccountBilling(stripe, accounts, accounts.get(id)!, records, "2026-10", CAT);
    expect(again.status).toBe("already_billed");
    expect(createdInvoices(calls)).toBe(1); // no second charge
  });

  it("does not charge twice even simulated >24h later (independent of Stripe's key window)", async () => {
    const { stripe, calls } = recordingStripe();
    const { accounts, id } = store();
    const records = spool(savingEvents());

    await settleAccountBilling(stripe, accounts, accounts.get(id)!, records, "2026-10", {
      ...CAT,
      now: () => "2026-11-01T00:00:00.000Z",
    });
    // 40 days later — far outside Stripe's ~24h idempotency-key window. The
    // durable billed-record is the thing that blocks the second charge.
    const later = await settleAccountBilling(stripe, accounts, accounts.get(id)!, records, "2026-10", {
      ...CAT,
      now: () => "2026-12-11T00:00:00.000Z",
    });
    expect(later.status).toBe("already_billed");
    expect(createdInvoices(calls)).toBe(1);
  });

  it("adding usage then re-running does not re-bill the already-billed period", async () => {
    const { stripe, calls } = recordingStripe();
    const { accounts, id } = store();

    const first = await settleAccountBilling(stripe, accounts, accounts.get(id)!, spool(savingEvents(100)), "2026-10", CAT);
    expect(first.status).toBe("billed");

    // More usage arrives for the same period and the run repeats.
    const grown = spool([
      event({ requestId: "a", levers: [{ leverId: "schema", kind: "lossless", savedUsd: 100 }] }),
      event({ requestId: "b", levers: [{ leverId: "schema", kind: "lossless", savedUsd: 500 }] }),
    ]);
    const again = await settleAccountBilling(stripe, accounts, accounts.get(id)!, grown, "2026-10", CAT);
    expect(again.status).toBe("already_billed");
    expect(createdInvoices(calls)).toBe(1);
  });
});

describe("Fix 5 — server-side savings re-derivation", () => {
  it("holds a charge whose stored savedUsd exceeds the catalogue-derived value", async () => {
    const { stripe, calls } = recordingStripe();
    const { accounts, id } = store();
    // gpt-6-astra batch on 1M input tokens re-derives tierSavedUsd = 5 (and
    // actualUsd = 5). The stored lever claims 50 — a 10x overstatement.
    const inflated = event({
      requestId: "a",
      provider: "openai",
      model: "gpt-6-astra",
      executionMode: "batch",
      usage: { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0 },
      actualUsd: 5,
      levers: [{ leverId: "execution-tier-batch", kind: "tier", savedUsd: 50 }],
    });
    const outcome = await settleAccountBilling(stripe, accounts, accounts.get(id)!, spool([inflated]), "2026-10", CAT);
    expect(outcome.status).toBe("held");
    if (outcome.status === "held") expect(outcome.reason).toMatch(/re-derivation|exceeds re-derived/);
    expect(calls).toHaveLength(0);
  });

  it("bills the honest figure when stored savedUsd matches the re-derivation", async () => {
    const { stripe, calls } = recordingStripe();
    const { accounts, id } = store();
    const honest = event({
      requestId: "a",
      provider: "openai",
      model: "gpt-6-astra",
      executionMode: "batch",
      usage: { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0 },
      actualUsd: 5,
      levers: [{ leverId: "execution-tier-batch", kind: "tier", savedUsd: 5 }],
    });
    const outcome = await settleAccountBilling(stripe, accounts, accounts.get(id)!, spool([honest]), "2026-10", CAT);
    expect(outcome.status).toBe("billed");
    expect(createdInvoices(calls)).toBe(1);
  });
});

describe("Fix 3 — direct-debit ceiling + advance-notice gate", () => {
  function directDebit() {
    return store({ paymentChoice: "direct_debit", directDebitMandate: { status: "active", paymentMethodId: "pm_1" } });
  }
  // feePercent 10 on $100 net = $10 = 1000¢.
  const savings = savingEvents(100);

  it("holds a direct-debit pull when no advance notice was issued first", async () => {
    const { stripe, calls } = recordingStripe();
    const { accounts, id } = directDebit();
    const outcome = await settleAccountBilling(stripe, accounts, accounts.get(id)!, spool(savings), "2026-10", CAT);
    expect(outcome.status).toBe("held");
    if (outcome.status === "held") expect(outcome.reason).toMatch(/advance notice/);
    expect(calls.some((c) => c.method === "payInvoice")).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("pulls once an advance notice has been issued for the period", async () => {
    const { stripe, calls } = recordingStripe();
    const { accounts, id } = directDebit();
    const records = spool(savings);
    const noticed = await settleAccountBilling(stripe, accounts, accounts.get(id)!, records, "2026-10", { ...CAT, mode: "advance_notice" });
    expect(noticed.status).toBe("noticed");
    const charged = await settleAccountBilling(stripe, accounts, accounts.get(id)!, records, "2026-10", CAT);
    expect(charged.status).toBe("billed");
    expect(calls.some((c) => c.method === "payInvoice")).toBe(true);
  });

  it("holds a charge over the max-charge ceiling instead of pulling it", async () => {
    const { stripe, calls } = recordingStripe();
    const { accounts, id } = directDebit();
    const records = spool(savings);
    // Issue the advance notice so the ONLY thing left to hold the charge is the ceiling.
    await settleAccountBilling(stripe, accounts, accounts.get(id)!, records, "2026-10", { ...CAT, mode: "advance_notice" });
    const outcome = await settleAccountBilling(stripe, accounts, accounts.get(id)!, records, "2026-10", {
      ...CAT,
      maxChargeCents: 100, // the 1000¢ charge is over this
    });
    expect(outcome.status).toBe("held");
    if (outcome.status === "held") expect(outcome.reason).toMatch(/ceiling/);
    expect(calls.some((c) => c.method === "payInvoice")).toBe(false);
  });
});

describe("Fix 4 — carry-forward deficit", () => {
  it("offsets a positive period by a prior negative one; never bills more than cumulative verified savings", async () => {
    const { stripe, calls } = recordingStripe();
    const { accounts, id } = store(); // bank_transfer, feePercent 10

    // Period 2026-09: net -$3 → do_not_charge; the $3 deficit rolls forward.
    const sept = spool([
      event({ requestId: "s1", invoicePeriod: "2026-09", timestamp: "2026-09-10T00:00:00.000Z", levers: [{ leverId: "cache", kind: "lossless", savedUsd: -3 }] }),
    ]);
    const septOut = await settleAccountBilling(stripe, accounts, accounts.get(id)!, sept, "2026-09", CAT);
    expect(septOut.status).toBe("skipped");
    expect(accounts.get(id)!.carryForwardDeficitUsd).toBeCloseTo(3, 9);
    expect(createdInvoices(calls)).toBe(0);

    // Period 2026-10: net +$10. With the $3 deficit carried in, only $7 is
    // billable → fee 10% of $7 = $0.70 = 70¢ (NOT 100¢).
    const oct = spool([
      event({ requestId: "o1", invoicePeriod: "2026-10", timestamp: "2026-10-10T00:00:00.000Z", levers: [{ leverId: "schema", kind: "lossless", savedUsd: 10 }] }),
    ]);
    const octOut = await settleAccountBilling(stripe, accounts, accounts.get(id)!, oct, "2026-10", CAT);
    expect(octOut.status).toBe("billed");
    if (octOut.status === "billed") expect(octOut.amountCents).toBe(70);

    // Cumulative verified savings = -3 + 10 = $7; the fee ($0.70) is a fraction
    // of that, so aggregate fees cannot exceed aggregate verified savings.
    expect(accounts.get(id)!.carryForwardDeficitUsd).toBe(0);
  });
});
