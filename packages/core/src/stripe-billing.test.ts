import { describe, expect, it } from "vitest";
import { buildStripeInvoicePlan, checkLiveChargeConfirmation, type StripeBillingOptions } from "./stripe-billing.js";
import type { Invoice } from "./savings-ledger.js";

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

const opts: StripeBillingOptions = { stripeCustomerId: "cus_TEST123", customerLabel: "acme-anthropic" };

describe("buildStripeInvoicePlan", () => {
  it("bills amountDueCents verbatim, never recomputing the savings itself", () => {
    const plan = buildStripeInvoicePlan(invoice(), true, opts);
    expect(plan.action).toBe("bill");
    if (plan.action !== "bill") throw new Error("expected bill");
    expect(plan.amountCents).toBe(13);
    expect(plan.currency).toBe("usd");
    expect(plan.customerId).toBe("cus_TEST123");
    expect(plan.description).toContain("1% of $12.50 net verified savings");
    expect(plan.description).toContain("mesh-verify");
    expect(plan.metadata.mesh_net_verified_savings_usd).toBe("12.5000");
    expect(plan.finalize).toBe(false); // draft by default — nothing charged without a human
  });

  it("HARD STOPS on an unverified chain — the one invariant that must never bill", () => {
    const plan = buildStripeInvoicePlan(invoice({ amountDueCents: 9_999 }), false, opts);
    expect(plan.action).toBe("do_not_bill");
    if (plan.action !== "do_not_bill") throw new Error("expected do_not_bill");
    expect(plan.chainUnverified).toBe(true);
    expect(plan.reason).toContain("unverifiable ledger");
  });

  it("does not bill a do_not_charge period", () => {
    const plan = buildStripeInvoicePlan(
      invoice({ verdict: "do_not_charge", amountDueCents: 0, amountDueUsd: 0, netVerifiedSavingsUsd: 0 }),
      true,
      opts,
    );
    expect(plan.action).toBe("do_not_bill");
    if (plan.action !== "do_not_bill") throw new Error("expected do_not_bill");
    expect(plan.chainUnverified).toBe(false);
    expect(plan.reason).toContain("do_not_charge");
  });

  it("surfaces a carried-forward deficit rather than billing through it", () => {
    const plan = buildStripeInvoicePlan(
      invoice({ verdict: "do_not_charge", amountDueCents: 0, carryForwardDeficitOutUsd: 3.2 }),
      true,
      opts,
    );
    if (plan.action !== "do_not_bill") throw new Error("expected do_not_bill");
    expect(plan.reason).toContain("deficit carries forward");
    expect(plan.reason).toContain("3.2000");
  });

  it("names the carried-in deficit in the description when one applied", () => {
    const plan = buildStripeInvoicePlan(
      invoice({ carryForwardDeficitInUsd: 2, netVerifiedSavingsUsd: 12.5 }),
      true,
      opts,
    );
    if (plan.action !== "bill") throw new Error("expected bill");
    expect(plan.description).toContain("after $2.00 deficit carried in");
    expect(plan.description).toContain("1% of $10.50 net verified savings");
  });

  it("keys idempotency on customer + period + amount so a re-run cannot double-bill", () => {
    const a = buildStripeInvoicePlan(invoice(), true, opts);
    const b = buildStripeInvoicePlan(invoice(), true, opts);
    if (a.action !== "bill" || b.action !== "bill") throw new Error("expected bill");
    expect(a.idempotencyKey).toBe(b.idempotencyKey);
    expect(a.idempotencyKey).toBe("mesh-cus_TEST123-2026-10-13");
  });

  it("refuses to build without a Stripe customer id", () => {
    expect(() => buildStripeInvoicePlan(invoice(), true, { stripeCustomerId: "" })).toThrow(/customer id/);
    expect(() => buildStripeInvoicePlan(invoice(), true, { stripeCustomerId: "acct_x" })).toThrow(/cus_/);
  });

  it("refuses to build if the invoice carried no feePercent", () => {
    expect(() => buildStripeInvoicePlan(
      invoice({ feePercent: undefined, amountDueCents: undefined }),
      true,
      opts,
    )).toThrow(/feePercent/);
  });

  it("finalize mode flags the plan to finalize, draft mode does not", () => {
    const draft = buildStripeInvoicePlan(invoice(), true, { ...opts, mode: "draft" });
    const fin = buildStripeInvoicePlan(invoice(), true, { ...opts, mode: "finalize" });
    if (draft.action !== "bill" || fin.action !== "bill") throw new Error("expected bill");
    expect(draft.finalize).toBe(false);
    expect(fin.finalize).toBe(true);
  });
});

describe("Fix 6 — checkLiveChargeConfirmation (live amount re-type gate)", () => {
  it("lets test-mode charges through without any confirmation", () => {
    expect(checkLiveChargeConfirmation({ isLive: false, requestedLive: false, amountCents: 1234 })).toEqual({ ok: true });
  });

  it("refuses a live key unless --live is passed", () => {
    const gate = checkLiveChargeConfirmation({ isLive: true, requestedLive: false, amountCents: 1234 });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toMatch(/LIVE/);
  });

  it("refuses a --live charge with no amount re-type", () => {
    const gate = checkLiveChargeConfirmation({ isLive: true, requestedLive: true, amountCents: 1234 });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toMatch(/re-typing|--confirm-amount-cents 1234/);
  });

  it("refuses a --live charge when the re-typed amount does not match the plan", () => {
    const gate = checkLiveChargeConfirmation({ isLive: true, requestedLive: true, amountCents: 1234, confirmAmountCents: 1200 });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toMatch(/mismatch/);
  });

  it("allows a --live charge only when the re-typed amount matches exactly", () => {
    expect(checkLiveChargeConfirmation({ isLive: true, requestedLive: true, amountCents: 1234, confirmAmountCents: 1234 })).toEqual({ ok: true });
  });
});
