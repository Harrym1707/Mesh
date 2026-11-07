import type { Account, BilledPeriodRecord, PaymentChoice } from "./accounts.js";
import type { AccountStore } from "./accounts.js";
import type { PriceCatalogue } from "./price-catalogue.js";
import {
  recomputeInvoice,
  reconcileInvoiceSavings,
  verifyLedgerChain,
  type Invoice,
  type LedgerRecord,
} from "./savings-ledger.js";
import { buildStripeInvoicePlan } from "./stripe-billing.js";
import type { BillingStripe } from "./stripe-client.js";

/**
 * The automated per-account billing worker — the operator-run mesh-bill logic
 * promoted to run unattended, once per account, with every safety rail intact:
 *
 *   - A broken/unverified ledger chain is a hard stop: DO NOT BILL.
 *   - A non-positive net period bills nothing (do_not_charge).
 *   - PERSISTENT idempotency: a durable per-account, per-period billed-record
 *     (not just Stripe's 24h idempotency key) means a period charged once never
 *     charges again — independent of Stripe's window AND of any amount change.
 *   - MANDATORY period: charging always targets ONE explicit period, never a
 *     growing cumulative total.
 *   - A direct-debit pull is bounded by a configurable max-charge ceiling and
 *     gated on a prior advance-notice step — no unbounded, un-announced pulls.
 *   - Fees are offset by a persisted carry-forward deficit, so aggregate fees
 *     can never exceed aggregate verified savings.
 *   - Savings are RE-DERIVED from provider-verbatim usage at bill time; a stored
 *     figure that cannot be reproduced is withheld, never billed.
 *   - TEST MODE only: the worker takes a {@link BillingStripe}; the real client
 *     refuses a live key unless explicitly allowed, which the worker never does.
 *   - No prompt content is read — only the usage-derived invoice totals.
 *
 * The customer's stored payment choice decides the rail:
 *   - direct_debit: Stripe pulls the fee against the saved mandate
 *     (charge_automatically + the mandate's payment method), AFTER an advance
 *     "upcoming charge" notice carrying the recompute-it-yourself receipt —
 *     because the amount varies period to period.
 *   - bank_transfer: Stripe finalizes and SENDS the invoice; the customer pays
 *     it themselves. No mandate, no auto-pull.
 *
 * The decision is a pure function (unit-tested without Stripe); the executor
 * performs the Stripe calls for whichever rail the decision selected; and
 * {@link settleAccountBilling} ties both to the durable account-store state.
 */

/** Default max-charge ceiling (cents). A product default — see PR notes. */
export const DEFAULT_MAX_CHARGE_CENTS = 50_000; // $500.00

/**
 * Recompute one account's invoice from its stored ledger records, with the
 * chain verified and the account's persisted carry-forward deficit applied. The
 * single path the worker and the admin API share, so a preview and the real run
 * can never disagree about what an account owes.
 *
 * `carryForwardDeficitUsd` defaults to the account's persisted running deficit;
 * pass it explicitly only to preview a hypothetical.
 */
export function invoiceForAccount(
  account: Account,
  records: readonly LedgerRecord[],
  period?: string,
  carryForwardDeficitUsd: number = account.carryForwardDeficitUsd ?? 0,
): { invoice: Invoice; chainVerified: boolean } {
  const chain = verifyLedgerChain(records);
  const invoice = recomputeInvoice(records.map((record) => record.event), {
    ...(period === undefined ? {} : { period }),
    feePercent: account.feePercent,
    ...(carryForwardDeficitUsd > 0 ? { carryForwardDeficitUsd } : {}),
  });
  return { invoice, chainVerified: chain.ok };
}

/** The advance notice a variable-amount charge sends before it is pulled. */
export type AdvanceChargeNotice = {
  accountId: string;
  period: string;
  rail: PaymentChoice;
  feePercent: number;
  netVerifiedSavingsUsd: number;
  amountDueCents: number;
  currency: string;
  /** How the customer re-derives the charge from their own hash-chained ledger. */
  recompute: { command: string; note: string };
};

export type BillingDecision =
  | { action: "skip"; reason: string; chainUnverified: boolean }
  /** A period already charged — the persistent idempotency short-circuit. */
  | { action: "already_billed"; reason: string; invoiceId?: string; chargedCents?: number }
  /** A charge was formed but must be withheld (ceiling / no advance notice / savings mismatch). */
  | { action: "hold"; reason: string; rail: PaymentChoice; amountCents: number; currency: string }
  | {
      action: "bill";
      rail: PaymentChoice;
      customerId: string;
      amountCents: number;
      currency: string;
      description: string;
      idempotencyKey: string;
      metadata: Record<string, string>;
      /** The mandate's payment method, present (and required) only for direct_debit. */
      mandatePaymentMethodId?: string;
      notice: AdvanceChargeNotice;
    };

export type DecideBillingOptions = {
  /** Currency for the fee invoice. Default usd. */
  currency?: string;
  /**
   * "advance_notice" forms the upcoming-charge notice only; the charge-side
   * gates (ceiling, advance-notice requirement) do not apply to issuing a
   * notice. "charge" (default) applies every gate before a pull.
   */
  mode?: "advance_notice" | "charge";
  /**
   * Reject/hold any charge above this many cents. Applied only in charge mode.
   * Undefined means no ceiling — callers on the money path always pass one.
   */
  maxChargeCents?: number;
  /**
   * Whether an advance notice has already been issued for this period. A
   * direct-debit pull in charge mode is HELD until this is true.
   */
  advanceNoticeIssued?: boolean;
  /**
   * The result of server-side savings re-derivation for this period. When it
   * reports a mismatch, a charge is HELD rather than billed at the stored figure.
   */
  savingsCheck?: { ok: boolean; reason?: string };
  /** The durable billing record already persisted for this period, for idempotency. */
  priorBilling?: BilledPeriodRecord;
};

const RECOMPUTE_COMMAND = "npx -y -p @harrym1707/verify mesh-verify <your spool>";

function buildNotice(
  account: Account,
  invoice: Invoice,
  rail: PaymentChoice,
  amountCents: number,
  currency: string,
): AdvanceChargeNotice {
  return {
    accountId: account.id,
    period: invoice.period ?? "all-recorded-periods",
    rail,
    feePercent: invoice.feePercent ?? account.feePercent,
    netVerifiedSavingsUsd: invoice.netVerifiedSavingsUsd,
    amountDueCents: amountCents,
    currency,
    recompute: {
      command: RECOMPUTE_COMMAND,
      note: "Recompute this charge from your own hash-chained ledger. If your recomputation disagrees, yours wins.",
    },
  };
}

/**
 * Decide how (and whether) to bill one account for a recomputed invoice. Pure.
 * Branches on the stored payment choice and the money-safety gates; refuses to
 * bill a direct-debit account whose mandate is not active, refuses entirely
 * before a choice is made, and — in charge mode — holds a charge that is over
 * the ceiling, un-announced, or over an unverifiable savings figure.
 */
export function decideBilling(
  account: Account,
  invoice: Invoice,
  chainVerified: boolean,
  options: DecideBillingOptions = {},
): BillingDecision {
  const currency = (options.currency ?? "usd").toLowerCase();
  const mode = options.mode ?? "charge";

  // Persistent idempotency: a period already charged NEVER charges again. This
  // is independent of Stripe's 24h idempotency-key window and of any later
  // amount change, so adding usage and re-running cannot re-bill the period.
  if (options.priorBilling?.status === "charged") {
    return {
      action: "already_billed",
      reason: `Period already charged${options.priorBilling.invoiceId ? ` (invoice ${options.priorBilling.invoiceId})` : ""}.`,
      ...(options.priorBilling.invoiceId === undefined ? {} : { invoiceId: options.priorBilling.invoiceId }),
      ...(options.priorBilling.chargedCents === undefined ? {} : { chargedCents: options.priorBilling.chargedCents }),
    };
  }

  if (!account.stripeCustomerId) {
    return { action: "skip", reason: "Account has no Stripe customer yet.", chainUnverified: false };
  }

  const plan = buildStripeInvoicePlan(invoice, chainVerified, {
    stripeCustomerId: account.stripeCustomerId,
    currency,
    mode: "finalize",
    customerLabel: account.githubLogin,
  });
  if (plan.action === "do_not_bill") {
    return { action: "skip", reason: plan.reason, chainUnverified: plan.chainUnverified };
  }

  const rail = account.paymentChoice;
  if (rail === undefined) {
    return { action: "skip", reason: "Customer has not chosen a payment method yet.", chainUnverified: false };
  }

  if (rail === "direct_debit") {
    const mandate = account.directDebitMandate;
    if (!mandate || mandate.status !== "active" || !mandate.paymentMethodId) {
      return { action: "skip", reason: "Direct-debit mandate is not active.", chainUnverified: false };
    }
  }

  const bill: Extract<BillingDecision, { action: "bill" }> = {
    action: "bill",
    rail,
    customerId: plan.customerId,
    amountCents: plan.amountCents,
    currency: plan.currency,
    description: plan.description,
    idempotencyKey: plan.idempotencyKey,
    metadata: plan.metadata,
    ...(rail === "direct_debit" && account.directDebitMandate?.paymentMethodId
      ? { mandatePaymentMethodId: account.directDebitMandate.paymentMethodId }
      : {}),
    notice: buildNotice(account, invoice, rail, plan.amountCents, plan.currency),
  };

  // Issuing an advance notice is not a charge: the charge-side gates below do
  // not apply. runAccountBilling turns this intent into a "noticed" outcome.
  if (mode === "advance_notice") return bill;

  // --- charge-mode money gates, in order of severity ---

  // Server-side savings re-derivation (Fix 5): never bill a figure we cannot
  // reproduce from provider-verbatim usage × catalogue.
  if (options.savingsCheck && !options.savingsCheck.ok) {
    return {
      action: "hold",
      reason: `savings re-derivation mismatch — ${options.savingsCheck.reason ?? "stored savings exceed the re-derived figure"}`,
      rail,
      amountCents: plan.amountCents,
      currency: plan.currency,
    };
  }

  // Max-charge ceiling (Fix 3): a charge over the bound is held for review.
  if (options.maxChargeCents !== undefined && plan.amountCents > options.maxChargeCents) {
    return {
      action: "hold",
      reason: `charge ${plan.amountCents}¢ exceeds the ${options.maxChargeCents}¢ max-charge ceiling`,
      rail,
      amountCents: plan.amountCents,
      currency: plan.currency,
    };
  }

  // Advance-notice gate (Fix 3): an automatic direct-debit pull requires a
  // prior advance notice to have been issued for this period.
  if (rail === "direct_debit" && options.advanceNoticeIssued !== true) {
    return {
      action: "hold",
      reason: "no advance notice issued before this direct-debit pull",
      rail,
      amountCents: plan.amountCents,
      currency: plan.currency,
    };
  }

  return bill;
}

export type AccountBillingOutcome =
  | { status: "skipped"; reason: string; chainUnverified: boolean }
  | { status: "already_billed"; reason: string; invoiceId?: string; chargedCents?: number }
  | { status: "held"; reason: string; rail: PaymentChoice; amountCents: number; currency: string }
  | { status: "noticed"; rail: PaymentChoice; notice: AdvanceChargeNotice }
  | {
      status: "billed";
      rail: PaymentChoice;
      invoiceId: string;
      invoiceStatus: string;
      amountCents: number;
      currency: string;
      hostedInvoiceUrl?: string;
      notice: AdvanceChargeNotice;
    };

export type RunBillingOptions = DecideBillingOptions & {
  /** Days a bank-transfer invoice is payable. Default 14. */
  daysUntilDue?: number;
  /** Statement description prefix on the Stripe invoice. */
  statementPrefix?: string;
};

/**
 * Run billing for one account against a recomputed invoice. The decision is
 * pure; this performs the Stripe side-effects for the selected rail with the
 * plan's idempotency key, so a re-run never double-charges. It does NOT touch
 * the durable account store — {@link settleAccountBilling} wraps it with the
 * persistent idempotency record and deficit bookkeeping.
 */
export async function runAccountBilling(
  stripe: BillingStripe,
  account: Account,
  invoice: Invoice,
  chainVerified: boolean,
  options: RunBillingOptions = {},
): Promise<AccountBillingOutcome> {
  const decision = decideBilling(account, invoice, chainVerified, options);
  if (decision.action === "skip") {
    return { status: "skipped", reason: decision.reason, chainUnverified: decision.chainUnverified };
  }
  if (decision.action === "already_billed") {
    return {
      status: "already_billed",
      reason: decision.reason,
      ...(decision.invoiceId === undefined ? {} : { invoiceId: decision.invoiceId }),
      ...(decision.chargedCents === undefined ? {} : { chargedCents: decision.chargedCents }),
    };
  }
  if (decision.action === "hold") {
    return { status: "held", reason: decision.reason, rail: decision.rail, amountCents: decision.amountCents, currency: decision.currency };
  }

  if (options.mode === "advance_notice") {
    return { status: "noticed", rail: decision.rail, notice: decision.notice };
  }

  const statementPrefix = options.statementPrefix ?? "MESH statement";
  const metadata = decision.metadata;

  // Create the invoice first, then attach the fee item to it explicitly by id —
  // the empty-draft fix carried over from mesh-bill. auto_advance is false so
  // nothing settles until we finalize deliberately.
  const invoiceShell = await stripe.createInvoice({
    customerId: decision.customerId,
    currency: decision.currency,
    collectionMethod: decision.rail === "direct_debit" ? "charge_automatically" : "send_invoice",
    description: `${statementPrefix} ${decision.notice.period}`,
    autoAdvance: false,
    ...(decision.rail === "bank_transfer" ? { daysUntilDue: options.daysUntilDue ?? 14 } : {}),
    ...(decision.rail === "direct_debit" && decision.mandatePaymentMethodId
      ? { defaultPaymentMethod: decision.mandatePaymentMethodId }
      : {}),
    metadata,
    idempotencyKey: `${decision.idempotencyKey}-inv`,
  });

  await stripe.createInvoiceItem({
    customerId: decision.customerId,
    invoiceId: invoiceShell.id,
    amountCents: decision.amountCents,
    currency: decision.currency,
    description: decision.description,
    metadata,
    idempotencyKey: `${decision.idempotencyKey}-item`,
  });

  const finalized = await stripe.finalizeInvoice(invoiceShell.id, `${decision.idempotencyKey}-fin`);

  // direct_debit pulls now against the mandate; bank_transfer is already SENT
  // by finalize and the customer pays it themselves.
  let settled = finalized;
  if (decision.rail === "direct_debit") {
    settled = await stripe.payInvoice(invoiceShell.id, `${decision.idempotencyKey}-pay`);
  }

  return {
    status: "billed",
    rail: decision.rail,
    invoiceId: settled.id,
    invoiceStatus: settled.status,
    amountCents: decision.amountCents,
    currency: decision.currency,
    ...(settled.hosted_invoice_url ? { hostedInvoiceUrl: settled.hosted_invoice_url } : {}),
    notice: decision.notice,
  };
}

export type SettleBillingOptions = {
  /** advance_notice issues the upcoming-charge notice; charge (default) settles. */
  mode?: "advance_notice" | "charge";
  currency?: string;
  /** Max-charge ceiling (cents). Defaults to {@link DEFAULT_MAX_CHARGE_CENTS}. */
  maxChargeCents?: number;
  /** Tolerance (USD) for the savings re-derivation reconciliation. */
  toleranceUsd?: number;
  daysUntilDue?: number;
  statementPrefix?: string;
  /**
   * Catalogue for server-side savings re-derivation. When omitted the
   * re-derivation step is SKIPPED (the stored figure is trusted) — callers on
   * the money path always pass one.
   */
  catalogue?: PriceCatalogue;
  /** Clock, injectable for tests. */
  now?: () => string;
};

/**
 * Settle ONE explicit period for one account, end to end, against the durable
 * account store. This is the money-safe path the worker and admin API run:
 *
 *   1. MANDATORY period — refuses to run without one (no cumulative-total pull).
 *   2. Persistent idempotency — a period already charged is a no-op.
 *   3. Carry-forward — the account's persisted deficit offsets this period's fee.
 *   4. Re-derivation — stored savings are reconciled against the catalogue.
 *   5. Gated pull — ceiling + advance-notice gate for direct debit.
 *   6. Persist — the billed-record and the rolled-forward deficit are written
 *      before returning, so a crash cannot lose the "already billed" marker.
 */
export async function settleAccountBilling(
  stripe: BillingStripe,
  store: AccountStore,
  account: Account,
  records: readonly LedgerRecord[],
  period: string,
  options: SettleBillingOptions = {},
): Promise<AccountBillingOutcome> {
  if (typeof period !== "string" || period.trim() === "") {
    throw new Error("settleAccountBilling requires an explicit invoice period (YYYY-MM); refusing to settle all recorded periods at once.");
  }
  const now = options.now ?? (() => new Date().toISOString());
  const mode = options.mode ?? "charge";
  const maxChargeCents = options.maxChargeCents ?? DEFAULT_MAX_CHARGE_CENTS;

  const prior = store.getBilledPeriod(account.id, period);
  const deficitIn = account.carryForwardDeficitUsd ?? 0;
  const { invoice, chainVerified } = invoiceForAccount(account, records, period, deficitIn);

  const savingsCheck = options.catalogue
    ? (() => {
        const r = reconcileInvoiceSavings(records.map((record) => record.event), options.catalogue!, {
          period,
          ...(options.toleranceUsd === undefined ? {} : { toleranceUsd: options.toleranceUsd }),
        });
        return { ok: r.ok, ...(r.reason === undefined ? {} : { reason: r.reason }) };
      })()
    : undefined;

  const outcome = await runAccountBilling(stripe, account, invoice, chainVerified, {
    mode,
    maxChargeCents,
    ...(options.currency === undefined ? {} : { currency: options.currency }),
    ...(options.daysUntilDue === undefined ? {} : { daysUntilDue: options.daysUntilDue }),
    ...(options.statementPrefix === undefined ? {} : { statementPrefix: options.statementPrefix }),
    ...(savingsCheck === undefined ? {} : { savingsCheck }),
    advanceNoticeIssued: prior?.advanceNoticeAt !== undefined,
    ...(prior === undefined ? {} : { priorBilling: prior }),
  });

  persistOutcome(store, account, period, invoice, chainVerified, prior, outcome, now());
  return outcome;
}

/**
 * Persist the durable billed-record and the rolled-forward deficit for a just
 * settled period. The deficit is advanced ONLY the first time a period reaches
 * a terminal state (charged or do_not_charge), so a re-run never double-counts
 * it. A held charge and configuration gaps leave the deficit untouched.
 */
function persistOutcome(
  store: AccountStore,
  account: Account,
  period: string,
  invoice: Invoice,
  chainVerified: boolean,
  prior: BilledPeriodRecord | undefined,
  outcome: AccountBillingOutcome,
  now: string,
): void {
  const alreadySettled = prior?.status === "charged" || prior?.status === "do_not_charge";

  if (outcome.status === "noticed") {
    store.recordBilledPeriod(account.id, {
      period,
      status: "noticed",
      rail: outcome.rail,
      ...(prior?.chargedCents === undefined ? {} : { chargedCents: prior.chargedCents }),
      ...(prior?.invoiceId === undefined ? {} : { invoiceId: prior.invoiceId }),
      advanceNoticeAt: now,
      updatedAt: now,
    }, now);
    return;
  }

  if (outcome.status === "billed") {
    store.recordBilledPeriod(account.id, {
      period,
      status: "charged",
      rail: outcome.rail,
      invoiceId: outcome.invoiceId,
      chargedCents: outcome.amountCents,
      ...(prior?.advanceNoticeAt === undefined ? {} : { advanceNoticeAt: prior.advanceNoticeAt }),
      chargedAt: now,
      updatedAt: now,
    }, now);
    if (!alreadySettled) store.setCarryForwardDeficit(account.id, invoice.carryForwardDeficitOutUsd ?? 0, now);
    return;
  }

  if (outcome.status === "held") {
    store.recordBilledPeriod(account.id, {
      period,
      status: "held",
      rail: outcome.rail,
      heldReason: outcome.reason,
      ...(prior?.advanceNoticeAt === undefined ? {} : { advanceNoticeAt: prior.advanceNoticeAt }),
      updatedAt: now,
    }, now);
    return;
  }

  // A verified do_not_charge period IS a settlement: nothing is owed, but its
  // deficit rolls forward. Driven by the invoice (pure savings math), not the
  // Stripe outcome, so a missing mandate or payment choice does not block the
  // deficit from advancing. Configuration-gap skips (unverified chain, etc.)
  // and already-settled re-runs leave everything untouched.
  if (outcome.status === "skipped" && chainVerified && invoice.verdict === "do_not_charge" && !alreadySettled) {
    store.recordBilledPeriod(account.id, {
      period,
      status: "do_not_charge",
      ...(prior?.advanceNoticeAt === undefined ? {} : { advanceNoticeAt: prior.advanceNoticeAt }),
      updatedAt: now,
    }, now);
    store.setCarryForwardDeficit(account.id, invoice.carryForwardDeficitOutUsd ?? 0, now);
  }
}
