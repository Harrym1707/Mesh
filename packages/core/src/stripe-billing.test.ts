import { describe, expect, it } from "vitest";
import { buildStripeInvoicePlan, checkLiveChargeConfirmation, recomputeInstruction, type StripeBillingOptions } from "./stripe-billing.js";
import { recomputeInvoice, type BillableEvent, type Invoice, type InvoiceOptions } from "./savings-ledger.js";

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
    amountDueCents: 12, // 1% of $12.50 is 12.5 cents; the fee rounds down
    ...overrides,
  };
}

const opts: StripeBillingOptions = { stripeCustomerId: "cus_TEST123", customerLabel: "acme-anthropic" };

/** A real recompute at the contracted 1%, over one event saving `netUsd` in 2026-11. */
function recomputed(netUsd: number, options: InvoiceOptions = {}): Invoice {
  const event: BillableEvent = {
    schemaVersion: 1,
    requestId: "r1",
    applicationId: "app",
    invoicePeriod: "2026-11",
    timestamp: "2026-11-10T10:00:00.000Z",
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    executionMode: "standard",
    pricingStatus: "priced",
    levers: [{ leverId: "duplicate-context-removal", kind: "lossless", savedUsd: netUsd }],
    status: "succeeded",
  };
  return recomputeInvoice([event], { period: "2026-11", feePercent: 1, ...options });
}

describe("buildStripeInvoicePlan", () => {
  it("bills amountDueCents verbatim, never recomputing the savings itself", () => {
    const plan = buildStripeInvoicePlan(invoice(), true, opts);
    expect(plan.action).toBe("bill");
    if (plan.action !== "bill") throw new Error("expected bill");
    expect(plan.amountCents).toBe(12);
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

  it("says the fee is below one cent, never 'not positive', when savings are positive but too small to bill", () => {
    // What the recompute returns for net $0.3609 at 1%: do_not_charge, zero cents.
    const plan = buildStripeInvoicePlan(
      invoice({ verdict: "do_not_charge", amountDueCents: 0, amountDueUsd: 0, netVerifiedSavingsUsd: 0.3609, netVerifiedSavingsCents: 36 }),
      true,
      opts,
    );
    if (plan.action !== "do_not_bill") throw new Error("expected do_not_bill");
    expect(plan.chainUnverified).toBe(false);
    expect(plan.reason).toBe(
      "do_not_charge: the 1% fee on $0.3609 net verified savings is below one cent, so nothing is billed yet.",
    );
    expect(plan.reason).not.toContain("not positive");
  });

  it("gives the same below-one-cent reason for any positive net up to $0.99, straight from the recompute", () => {
    for (const net of [0.01, 0.3609, 0.5, 0.99]) {
      const plan = buildStripeInvoicePlan(recomputed(net), true, opts);
      if (plan.action !== "do_not_bill") throw new Error(`expected do_not_bill at $${net}`);
      expect(plan.reason).toBe(
        `do_not_charge: the 1% fee on $${net.toFixed(4)} net verified savings is below one cent, so nothing is billed yet.`,
      );
    }
    // One dollar is the first amount that bills at 1%.
    const first = buildStripeInvoicePlan(recomputed(1), true, opts);
    expect(first.action).toBe("bill");
    if (first.action === "bill") expect(first.amountCents).toBe(1);
  });

  it("names the carried-in deficit when the remainder after it is positive but too small to bill", () => {
    const plan = buildStripeInvoicePlan(recomputed(0.5, { carryForwardDeficitUsd: 0.2 }), true, opts);
    if (plan.action !== "do_not_bill") throw new Error("expected do_not_bill");
    expect(plan.reason).toBe(
      "do_not_charge: the 1% fee on $0.3000 net verified savings (after $0.2000 deficit carried in) is below one cent, so nothing is billed yet.",
    );
  });

  it("zero and negative savings still read 'not positive' and a deficit still reads as a deficit", () => {
    const zero = buildStripeInvoicePlan(recomputed(0), true, opts);
    if (zero.action !== "do_not_bill") throw new Error("expected do_not_bill");
    expect(zero.reason).toContain("were not positive");
    const negative = buildStripeInvoicePlan(recomputed(-0.3), true, opts);
    if (negative.action !== "do_not_bill") throw new Error("expected do_not_bill");
    expect(negative.reason).toContain("deficit carries forward");
  });

  it("defence in depth: an invoice that says charge with zero cents still bills nothing", () => {
    const plan = buildStripeInvoicePlan(
      invoice({ verdict: "charge", amountDueCents: 0, amountDueUsd: 0.0036, netVerifiedSavingsUsd: 0.3609 }),
      true,
      opts,
    );
    if (plan.action !== "do_not_bill") throw new Error("expected do_not_bill");
    expect(plan.reason).toContain("is below one cent");
  });

  it("net $9.5947 at 1% bills 9 cents end to end, and the idempotency key carries 9, not 10", () => {
    const recomputedInvoice = recomputed(9.5947);
    expect(recomputedInvoice.amountDueCents).toBe(9);
    expect(recomputedInvoice.verdict).toBe("charge");
    const plan = buildStripeInvoicePlan(recomputedInvoice, true, opts);
    if (plan.action !== "bill") throw new Error("expected bill");
    // Nothing downstream re-rounds the fee: the plan carries the recompute's cents.
    expect(plan.amountCents).toBe(9);
    expect(plan.amountCents).toBe(recomputedInvoice.amountDueCents);
    expect(plan.idempotencyKey).toBe("mesh-cus_TEST123-2026-11-9");
    expect(plan.description).toContain("1% of $9.59 net verified savings");
    expect(plan.metadata.mesh_net_verified_savings_usd).toBe("9.5947");
  });

  it("net $21.63 at 1% bills 21 cents, not 22", () => {
    const plan = buildStripeInvoicePlan(recomputed(21.63), true, opts);
    if (plan.action !== "bill") throw new Error("expected bill");
    expect(plan.amountCents).toBe(21);
    expect(plan.idempotencyKey).toBe("mesh-cus_TEST123-2026-11-21");
  });

  it("the line item sends the customer to their own statement for the invoice's period, then the independent check", () => {
    const plan = buildStripeInvoicePlan(recomputed(9.5947), true, opts);
    if (plan.action !== "bill") throw new Error("expected bill");
    expect(plan.description).toBe(
      "MESH fee — 1% of $9.59 net verified savings, period 2026-11. " +
      "Check it on your own machine: mesh statement --period 2026-11. " +
      "Independent check: npx -y -p @harrym1707/verify mesh-verify <your spool>. " +
      "If your recomputation disagrees, yours wins.",
    );
  });

  it("an invoice with no single period never prints a mesh statement command", () => {
    const plan = buildStripeInvoicePlan(invoice({ period: null }), true, opts);
    if (plan.action !== "bill") throw new Error("expected bill");
    expect(plan.description).toBe(
      "MESH fee — 1% of $12.50 net verified savings, period all-recorded-periods. " +
      "Check it on your own machine with the independent check: npx -y -p @harrym1707/verify mesh-verify <your spool>. " +
      "If your recomputation disagrees, yours wins.",
    );
    expect(plan.description).not.toContain("mesh statement");
    expect(recomputeInstruction("all-recorded-periods")).not.toContain("mesh statement");
    expect(recomputeInstruction("2026-13")).not.toContain("mesh statement");
    expect(recomputeInstruction("2026-10")).toContain("mesh statement --period 2026-10.");
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
    expect(a.idempotencyKey).toBe("mesh-cus_TEST123-2026-10-12");
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
    if (gate.ok) throw new Error("expected a refusal");
    expect(gate.reason).toBe(
      "A LIVE charge must be confirmed by re-typing the amount it will charge, in cents, with " +
      "--confirm-amount-cents. Read the amount from the plan printed above. Charging nothing.",
    );
    // The refusal must not hand over the number, or a ready-made flag to paste.
    expect(gate.reason).not.toContain("1234");
    expect(gate.reason).not.toMatch(/--confirm-amount-cents \d/);
  });

  it("refuses a --live charge when the re-typed amount does not match the plan", () => {
    const gate = checkLiveChargeConfirmation({ isLive: true, requestedLive: true, amountCents: 1234, confirmAmountCents: 1200 });
    expect(gate.ok).toBe(false);
    if (gate.ok) throw new Error("expected a refusal");
    expect(gate.reason).toMatch(/mismatch/);
    // It may say what was typed, never what was expected.
    expect(gate.reason).toContain("1200¢");
    expect(gate.reason).not.toContain("1234");
  });

  it("never prints the expected amount, whatever it is", () => {
    for (const amountCents of [1, 9, 10, 21, 977, 50_000]) {
      const missing = checkLiveChargeConfirmation({ isLive: true, requestedLive: true, amountCents });
      const wrong = checkLiveChargeConfirmation({ isLive: true, requestedLive: true, amountCents, confirmAmountCents: 77_777 });
      for (const gate of [missing, wrong]) {
        if (gate.ok) throw new Error("expected a refusal");
        expect(gate.reason).not.toMatch(new RegExp(`(^|\\D)${amountCents}(\\D|$)`));
      }
    }
  });

  it("allows a --live charge only when the re-typed amount matches exactly", () => {
    expect(checkLiveChargeConfirmation({ isLive: true, requestedLive: true, amountCents: 1234, confirmAmountCents: 1234 })).toEqual({ ok: true });
  });
});
