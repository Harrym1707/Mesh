import { describe, expect, it } from "vitest";
import type { Account } from "./accounts.js";
import type { Invoice } from "./savings-ledger.js";
import type {
  BillingStripe,
  StripeInvoice,
  StripeInvoiceItem,
} from "./stripe-client.js";
import { decideBilling, runAccountBilling } from "./billing-worker.js";

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: "acct_1",
    githubId: 1,
    githubLogin: "octo",
    email: "octo@example.com",
    stripeCustomerId: "cus_TEST",
    accountKeyHash: "hash",
    accountKeyPrefix: "mesh_sk_abcd1234",
    feePercent: 1,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...overrides,
  };
}

function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    schemaVersion: 1,
    period: "2026-10",
    catalogueVersions: ["2026-10-08"],
    eventsConsidered: 10,
    eventsBilled: 8,
    failedTaskIds: [],
    eventsExcludedForFailedTasks: 0,
    unpricedEvents: 0,
    lineItems: [],
    recordedUnbilled: [],
    excludedAlreadyOwned: { providerCacheOnAppendedHistoryUsd: 0, gatewayCacheUsd: 0 },
    netVerifiedSavingsUsd: 12.5,
    netVerifiedSavingsCents: 1250,
    verdict: "charge",
    feePercent: 1,
    amountDueUsd: 0.125,
    amountDueCents: 13,
    ...overrides,
  };
}

type Call = { method: string; args: Record<string, unknown> };

function recordingStripe(): { stripe: BillingStripe; calls: Call[] } {
  const calls: Call[] = [];
  const stripe: BillingStripe = {
    mode: "test",
    async createInvoice(params) {
      calls.push({ method: "createInvoice", args: params as unknown as Record<string, unknown> });
      return { id: "in_TEST", status: "draft" } satisfies StripeInvoice;
    },
    async createInvoiceItem(params) {
      calls.push({ method: "createInvoiceItem", args: params as unknown as Record<string, unknown> });
      return { id: "ii_TEST" } satisfies StripeInvoiceItem;
    },
    async finalizeInvoice(invoiceId, idempotencyKey) {
      calls.push({ method: "finalizeInvoice", args: { invoiceId, idempotencyKey } });
      return { id: invoiceId, status: "open", hosted_invoice_url: "https://pay.stripe.test/in_TEST" };
    },
    async payInvoice(invoiceId, idempotencyKey) {
      calls.push({ method: "payInvoice", args: { invoiceId, idempotencyKey } });
      return { id: invoiceId, status: "paid" };
    },
  };
  return { stripe, calls };
}

describe("decideBilling (pure branching)", () => {
  it("hard-stops on an unverified chain without any Stripe intent", () => {
    const decision = decideBilling(account({ paymentChoice: "bank_transfer" }), invoice(), false);
    expect(decision).toEqual({ action: "skip", reason: expect.stringContaining("verification"), chainUnverified: true });
  });

  it("skips a do_not_charge invoice", () => {
    const decision = decideBilling(account({ paymentChoice: "bank_transfer" }), invoice({ verdict: "do_not_charge", amountDueCents: 0 }), true);
    expect(decision.action).toBe("skip");
  });

  it("skips until the customer has chosen a payment method", () => {
    const decision = decideBilling(account({ paymentChoice: undefined }), invoice(), true);
    expect(decision).toMatchObject({ action: "skip", reason: expect.stringContaining("payment method") });
  });

  it("skips a direct-debit account whose mandate is not active", () => {
    const decision = decideBilling(
      account({ paymentChoice: "direct_debit", directDebitMandate: { status: "pending" } }),
      invoice(),
      true,
    );
    expect(decision).toMatchObject({ action: "skip", reason: expect.stringContaining("mandate") });
  });

  it("bills a direct-debit account with an active mandate once the advance notice gate is satisfied", () => {
    const decision = decideBilling(
      account({ paymentChoice: "direct_debit", directDebitMandate: { status: "active", paymentMethodId: "pm_123" } }),
      invoice(),
      true,
      { advanceNoticeIssued: true },
    );
    expect(decision).toMatchObject({ action: "bill", rail: "direct_debit", amountCents: 13, mandatePaymentMethodId: "pm_123" });
    if (decision.action === "bill") {
      expect(decision.notice.recompute.command).toContain("mesh-verify");
      expect(decision.notice.amountDueCents).toBe(13);
    }
  });
});

describe("runAccountBilling (rail execution)", () => {
  it("direct_debit: charge_automatically, attach item, finalize, then PAY via the mandate", async () => {
    const { stripe, calls } = recordingStripe();
    const outcome = await runAccountBilling(
      stripe,
      account({ paymentChoice: "direct_debit", directDebitMandate: { status: "active", paymentMethodId: "pm_123" } }),
      invoice(),
      true,
      { advanceNoticeIssued: true },
    );
    expect(outcome.status).toBe("billed");
    if (outcome.status !== "billed") return;
    expect(outcome.rail).toBe("direct_debit");
    expect(outcome.invoiceStatus).toBe("paid");

    const create = calls.find((c) => c.method === "createInvoice")!;
    expect(create.args.collectionMethod).toBe("charge_automatically");
    expect(create.args.defaultPaymentMethod).toBe("pm_123");
    expect(calls.some((c) => c.method === "payInvoice")).toBe(true);
    // Idempotency keys are derived from the plan key.
    expect(String(create.args.idempotencyKey)).toContain("mesh-cus_TEST-2026-10-13-inv");
  });

  it("bank_transfer: send_invoice with a due date, finalize, and NO auto-pull", async () => {
    const { stripe, calls } = recordingStripe();
    const outcome = await runAccountBilling(stripe, account({ paymentChoice: "bank_transfer" }), invoice(), true, { daysUntilDue: 30 });
    expect(outcome.status).toBe("billed");
    if (outcome.status !== "billed") return;
    expect(outcome.rail).toBe("bank_transfer");
    expect(outcome.hostedInvoiceUrl).toContain("pay.stripe.test");

    const create = calls.find((c) => c.method === "createInvoice")!;
    expect(create.args.collectionMethod).toBe("send_invoice");
    expect(create.args.daysUntilDue).toBe(30);
    expect(calls.some((c) => c.method === "payInvoice")).toBe(false);
  });

  it("advance_notice mode emits the recompute receipt and performs NO Stripe calls", async () => {
    const { stripe, calls } = recordingStripe();
    const outcome = await runAccountBilling(
      stripe,
      account({ paymentChoice: "direct_debit", directDebitMandate: { status: "active", paymentMethodId: "pm_1" } }),
      invoice(),
      true,
      { mode: "advance_notice" },
    );
    expect(outcome.status).toBe("noticed");
    if (outcome.status !== "noticed") return;
    expect(outcome.notice.amountDueCents).toBe(13);
    expect(outcome.notice.recompute.command).toContain("mesh-verify");
    expect(calls).toHaveLength(0);
  });

  it("skipped accounts never touch Stripe", async () => {
    const { stripe, calls } = recordingStripe();
    const outcome = await runAccountBilling(stripe, account({ paymentChoice: "bank_transfer" }), invoice(), false);
    expect(outcome.status).toBe("skipped");
    expect(calls).toHaveLength(0);
  });
});
