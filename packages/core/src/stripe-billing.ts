import type { Invoice } from "./savings-ledger.js";

/**
 * Turning a recomputed MESH invoice into a Stripe charge — the honest way.
 *
 * This module is PURE: it converts an `Invoice` (the output of
 * `recomputeInvoice`, itself a pure function over the customer's own
 * hash-chained ledger) into a `StripeInvoicePlan` — the exact set of Stripe API
 * calls that would bill it. No network here; the executor (mesh-bill script)
 * runs the plan. Keeping it pure means the billing arithmetic is unit-tested
 * without touching Stripe, and the plan can be shown to a human before anything
 * is created.
 *
 * The invariants that matter for a verified-savings vendor:
 *   - A broken/unverified ledger NEVER bills. verdict carries DO_NOT_BILL.
 *   - A non-positive net period bills nothing (do_not_charge), and a carried
 *     deficit is surfaced, never hidden. A positive net whose fee is below one
 *     cent bills nothing either, and the reason says so.
 *   - The amount is 1% (or the contracted feePercent) of NET verified savings,
 *     taken straight from the invoice — this module does not recompute savings
 *     and never rounds the fee: `amountDueCents` already carries the one
 *     rounding rule (`feeCents` in savings-ledger.ts, rounded down to the cent).
 *   - The line-item description traces to the recomputable statement, so the
 *     customer can check the charge against their own ledger.
 *   - Every create call carries an idempotency key keyed on customer+period, so
 *     re-running a month cannot double-bill.
 */

export type StripeBillingOptions = {
  /** Stripe customer id (cus_…) the fee is billed to. */
  stripeCustomerId: string;
  /** Currency for the invoice. MESH fees are USD-denominated. */
  currency?: string;
  /**
   * Whether to finalize+send the invoice or leave it as a reviewable DRAFT.
   * Default "draft": nothing is ever charged without a human finalizing it.
   */
  mode?: "draft" | "finalize";
  /** Label for the customer's statement, e.g. the spool set or app id. */
  customerLabel?: string;
};

export type StripeInvoicePlan =
  | {
      action: "bill";
      /** cus_… the invoice item + invoice attach to. */
      customerId: string;
      /** Integer minor units (cents) — Stripe never takes floats. */
      amountCents: number;
      currency: string;
      /** Human-readable, traces to the recomputable statement. */
      description: string;
      /** Keyed on customer+period so a re-run cannot double-bill. */
      idempotencyKey: string;
      finalize: boolean;
      /** Carried into the explanatory metadata on the Stripe objects. */
      metadata: Record<string, string>;
    }
  | {
      action: "do_not_bill";
      /** Why nothing is billed: do_not_charge, deficit carried, or chain broken. */
      reason: string;
      /** True only when the ledger failed verification — the hard stop. */
      chainUnverified: boolean;
    };

const DEFAULT_CURRENCY = "usd";

export type LiveChargeGate = { ok: true } | { ok: false; reason: string };

/**
 * The deliberate human gate on a LIVE charge, made real (the doc promised an
 * amount re-type that the script never implemented).
 *
 * A live key may charge real money, so before any live charge the operator must
 * (a) pass `--live` deliberately and (b) re-type the exact amount to be charged.
 * Test mode needs neither. Returning a reason rather than throwing keeps this
 * pure and unit-testable: the caller prints the reason and charges nothing.
 */
export function checkLiveChargeConfirmation(params: {
  /** The key is a live key (sk_live_…). */
  isLive: boolean;
  /** `--live` was passed. */
  requestedLive: boolean;
  /** The exact amount the plan will charge (integer cents). */
  amountCents: number;
  /** The amount the operator re-typed to confirm (integer cents), if any. */
  confirmAmountCents?: number;
}): LiveChargeGate {
  if (!params.isLive) return { ok: true };
  if (!params.requestedLive) {
    return {
      ok: false,
      reason:
        "Refusing to charge against a LIVE Stripe key. This creates real charges. Use a test key " +
        "(sk_test_…), or pass --live deliberately.",
    };
  }
  if (params.confirmAmountCents === undefined) {
    return {
      ok: false,
      reason:
        `A LIVE charge must be confirmed by re-typing the exact amount. Re-run with ` +
        `--confirm-amount-cents ${params.amountCents}.`,
    };
  }
  if (params.confirmAmountCents !== params.amountCents) {
    return {
      ok: false,
      reason:
        `Amount re-type mismatch: you typed ${params.confirmAmountCents}¢ but the plan charges ` +
        `${params.amountCents}¢. Charging nothing.`,
    };
  }
  return { ok: true };
}

/** Runs without installing MESH: the independent check of any statement. */
const VERIFY_PACKAGE_COMMAND = "npx -y -p @harrym1707/verify mesh-verify";

/**
 * How the customer checks this charge themselves, printed on the Stripe line
 * item. Their own statement for the period first (the real period filled in),
 * then the standalone verify package as the independent second check. An
 * invoice across all recorded periods has no single period to name, so it
 * never prints a `mesh statement` command that would not run.
 */
export function recomputeInstruction(period: string | null): string {
  const independent = `${VERIFY_PACKAGE_COMMAND} <your spool>`;
  const yoursWins = "If your recomputation disagrees, yours wins.";
  if (period !== null && /^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
    return `Check it on your own machine: mesh statement --period ${period}. Independent check: ${independent}. ${yoursWins}`;
  }
  return `Check it on your own machine with the independent check: ${independent}. ${yoursWins}`;
}

/**
 * Build the Stripe plan for one recomputed invoice.
 *
 * `chainVerified` is passed in (not read from the invoice) because chain
 * verification is the ledger layer's job: the caller verifies the spool and
 * tells us. An unverified chain is a hard DO_NOT_BILL — a statement over an
 * unverifiable ledger is not an invoice.
 */
export function buildStripeInvoicePlan(
  invoice: Invoice,
  chainVerified: boolean,
  options: StripeBillingOptions,
): StripeInvoicePlan {
  if (!chainVerified) {
    return {
      action: "do_not_bill",
      reason: "Ledger chain failed verification — a statement over an unverifiable ledger is not an invoice.",
      chainUnverified: true,
    };
  }
  if (!options.stripeCustomerId || !options.stripeCustomerId.startsWith("cus_")) {
    throw new Error("A Stripe customer id (cus_…) is required to build a billing plan.");
  }
  if (invoice.feePercent === undefined || invoice.amountDueCents === undefined) {
    throw new Error("Invoice was not recomputed with a feePercent; cannot build a billing plan.");
  }

  // The recompute already answers do_not_charge when the fee is below one cent;
  // the amount guard stays as defence in depth, so a hand-built or older
  // invoice that says "charge" with zero cents still bills nothing.
  if (invoice.verdict !== "charge" || invoice.amountDueCents <= 0) {
    const carried = invoice.carryForwardDeficitOutUsd ?? 0;
    const carriedIn = invoice.carryForwardDeficitInUsd ?? 0;
    const billableNetUsd = invoice.netVerifiedSavingsUsd - carriedIn;
    let reason: string;
    if (carried > 0) {
      reason = `do_not_charge: $${carried.toFixed(4)} verified-savings deficit carries forward; fees resume only after it is recovered.`;
    } else if (billableNetUsd > 0) {
      // Savings ARE positive, but the fee on them is below one cent — the
      // smallest amount that can be billed — so nothing is billed yet. Keyed on
      // the figures, not the verdict: the recompute reports this case as
      // do_not_charge. (Distinct from the zero/negative-savings case below.)
      reason =
        `do_not_charge: the ${invoice.feePercent}% fee on $${billableNetUsd.toFixed(4)} net verified savings` +
        `${carriedIn > 0 ? ` (after $${carriedIn.toFixed(4)} deficit carried in)` : ""} is below one cent, so nothing is billed yet.`;
    } else {
      reason = "do_not_charge: the period's net verified savings were not positive, so nothing is billed.";
    }
    return { action: "do_not_bill", reason, chainUnverified: false };
  }

  const currency = (options.currency ?? DEFAULT_CURRENCY).toLowerCase();
  const period = invoice.period ?? "all-recorded-periods";
  const net = invoice.netVerifiedSavingsUsd;
  const carryIn = invoice.carryForwardDeficitInUsd ?? 0;
  const label = options.customerLabel ?? options.stripeCustomerId;

  const description =
    `MESH fee — ${invoice.feePercent}% of $${(net - carryIn).toFixed(2)} net verified savings` +
    `${carryIn > 0 ? ` (after $${carryIn.toFixed(2)} deficit carried in)` : ""}, period ${period}. ` +
    recomputeInstruction(invoice.period);

  return {
    action: "bill",
    customerId: options.stripeCustomerId,
    amountCents: invoice.amountDueCents,
    currency,
    description,
    idempotencyKey: `mesh-${options.stripeCustomerId}-${period}-${invoice.amountDueCents}`,
    finalize: options.mode === "finalize",
    metadata: {
      mesh_period: period,
      mesh_fee_percent: String(invoice.feePercent),
      mesh_net_verified_savings_usd: net.toFixed(4),
      mesh_events_billed: String(invoice.eventsBilled),
      mesh_customer_label: label,
    },
  };
}
