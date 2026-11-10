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
 * Reconciliation / rounding / currency / period-boundary edge cases that are
 * provable WITHOUT a live Stripe. These sit on top of the six money-safety
 * fixes: they pin behaviour at the boundaries the fixes imply but do not each
 * assert directly — per-period isolation, the aggregate-savings ceiling as an
 * explicit cross-period invariant, the sub-cent rounding floor, currency
 * passthrough, and the conservative-under-claim allowance.
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
      return { id: invoiceId, status: "open" };
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

function spool(events: BillableEvent[]): LedgerRecord[] {
  const records: LedgerRecord[] = [];
  let prev: LedgerRecord | undefined;
  for (const e of events) {
    prev = chainLedgerRecord(e, prev);
    records.push(prev);
  }
  return records;
}

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

/** A lossless saving in a given period (no usage → not re-derived, nets straight through). */
function saving(requestId: string, period: string, day: string, savedUsd: number): BillableEvent {
  return event({ requestId, invoicePeriod: period, timestamp: `${period}-${day}T10:00:00.000Z`, levers: [{ leverId: "schema", kind: "lossless", savedUsd }] });
}

const CAT = { catalogue: publishedModelPrices } as const;

describe("period-boundary isolation", () => {
  it("settling one period bills only that period's events, and each period settles independently", async () => {
    const { stripe, calls } = recordingStripe();
    const { accounts, id } = store();
    // One spool spanning two periods, as a late-October run would see.
    const records = spool([
      saving("o1", "2026-10", "10", 100),
      saving("n1", "2026-11", "03", 500),
    ]);

    // Settle October: only the $100 October saving bills → 10% = 1000¢.
    const oct = await settleAccountBilling(stripe, accounts, accounts.get(id)!, records, "2026-10", CAT);
    expect(oct.status).toBe("billed");
    if (oct.status === "billed") expect(oct.amountCents).toBe(1000);
    expect(createdInvoices(calls)).toBe(1);

    // November is a DIFFERENT period: its billed-record is separate, so it still
    // bills ($500 → 10% = 5000¢) — the October charge did not consume it.
    const nov = await settleAccountBilling(stripe, accounts, accounts.get(id)!, records, "2026-11", CAT);
    expect(nov.status).toBe("billed");
    if (nov.status === "billed") expect(nov.amountCents).toBe(5000);
    expect(createdInvoices(calls)).toBe(2);

    // Re-running October is still a no-op — isolation does not weaken idempotency.
    const octAgain = await settleAccountBilling(stripe, accounts, accounts.get(id)!, records, "2026-10", CAT);
    expect(octAgain.status).toBe("already_billed");
    expect(createdInvoices(calls)).toBe(2);
  });
});

describe("aggregate-savings ceiling across periods (fee ≤ feePercent% of Σ verified savings)", () => {
  it("deficits net losing periods into winning ones so cumulative fees never exceed the contracted share", async () => {
    const { stripe, calls } = recordingStripe();
    const { accounts, id } = store(); // bank_transfer, fee 10%

    // Jul +$10, Aug -$4 (deficit rolls), Sep +$10 (only $6 billable after carry).
    const jul = spool([saving("j", "2026-07", "05", 10)]);
    const aug = spool([saving("a", "2026-08", "05", -4)]);
    const sep = spool([saving("s", "2026-09", "05", 10)]);

    const julOut = await settleAccountBilling(stripe, accounts, accounts.get(id)!, jul, "2026-07", CAT);
    expect(julOut.status).toBe("billed");
    const augOut = await settleAccountBilling(stripe, accounts, accounts.get(id)!, aug, "2026-08", CAT);
    expect(augOut.status).toBe("skipped"); // do_not_charge; $4 deficit carried
    expect(accounts.get(id)!.carryForwardDeficitUsd).toBeCloseTo(4, 9);
    const sepOut = await settleAccountBilling(stripe, accounts, accounts.get(id)!, sep, "2026-09", CAT);
    expect(sepOut.status).toBe("billed");

    const charged = [julOut, sepOut]
      .map((o) => (o.status === "billed" ? o.amountCents : 0))
      .reduce((a, b) => a + b, 0);

    // Σ net verified savings = 10 - 4 + 10 = $16 = 1600¢.
    // Σ fees charged = 100¢ (Jul $10) + 60¢ (Sep $6 after carry) = 160¢.
    const aggregateNetVerifiedCents = 1600;
    expect(charged).toBe(160);
    // The ceiling invariant, stated two ways:
    expect(charged).toBeLessThanOrEqual(Math.round(aggregateNetVerifiedCents * 0.1)); // ≤ feePercent% of Σ savings
    expect(charged).toBeLessThanOrEqual(aggregateNetVerifiedCents); // and far below Σ savings itself
    expect(accounts.get(id)!.carryForwardDeficitUsd).toBe(0);
    expect(createdInvoices(calls)).toBe(2); // Aug never created an invoice
  });
});

describe("sub-cent rounding floor", () => {
  it("a positive net whose fee rounds below one cent charges nothing (no Stripe calls)", async () => {
    const { stripe, calls } = recordingStripe();
    const { accounts, id } = store(); // fee 10%
    // net $0.04 → billableCents 4 (verdict charge), but fee = round($0.004*100) = 0¢.
    const records = spool([saving("a", "2026-10", "10", 0.04)]);
    const outcome = await settleAccountBilling(stripe, accounts, accounts.get(id)!, records, "2026-10", CAT);
    expect(outcome.status).toBe("skipped");
    if (outcome.status === "skipped") expect(outcome.reason).toMatch(/below one cent|not positive/i);
    expect(calls).toHaveLength(0);
    // Positive net, so no deficit is carried — nothing is owed and nothing rolls.
    expect(accounts.get(id)!.carryForwardDeficitUsd ?? 0).toBe(0);
  });
});

describe("currency passthrough", () => {
  it("bills the fee in the requested currency verbatim (lower-cased) on the Stripe objects", async () => {
    const { stripe, calls } = recordingStripe();
    const { accounts, id } = store();
    const records = spool([saving("a", "2026-10", "10", 100)]);
    const outcome = await settleAccountBilling(stripe, accounts, accounts.get(id)!, records, "2026-10", { ...CAT, currency: "EUR" });
    expect(outcome.status).toBe("billed");
    if (outcome.status === "billed") expect(outcome.currency).toBe("eur");
    const inv = calls.find((c) => c.method === "createInvoice");
    const item = calls.find((c) => c.method === "createInvoiceItem");
    expect(inv?.args.currency).toBe("eur");
    expect(item?.args.currency).toBe("eur");
  });
});

describe("conservative under-claim is allowed by the re-derivation guard", () => {
  it("bills a stored savedUsd that is BELOW the catalogue-derived figure (an under-claim, never a hold)", async () => {
    const { stripe, calls } = recordingStripe();
    const { accounts, id } = store();
    // gpt-6-astra batch on 1M input tokens re-derives tierSavedUsd = 5. The lever
    // claims only 3 — a conservative under-claim. Fix 5 holds OVER-statements, not
    // under-claims, so this bills the honest stored figure.
    const underclaim = event({
      requestId: "a",
      provider: "openai",
      model: "gpt-6-astra",
      executionMode: "batch",
      usage: { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0 },
      actualUsd: 5,
      levers: [{ leverId: "execution-tier-batch", kind: "tier", savedUsd: 3 }],
    });
    const outcome = await settleAccountBilling(stripe, accounts, accounts.get(id)!, spool([underclaim]), "2026-10", CAT);
    expect(outcome.status).toBe("billed");
    // fee 10% of the stored $3 = $0.30 = 30¢ (NOT the re-derived $5).
    if (outcome.status === "billed") expect(outcome.amountCents).toBe(30);
    expect(createdInvoices(calls)).toBe(1);
  });
});
