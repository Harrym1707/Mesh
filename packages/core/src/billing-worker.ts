import type { Account, PaymentChoice } from "./accounts.js";
import { recomputeInvoice, verifyLedgerChain, type Invoice, type LedgerRecord } from "./savings-ledger.js";
import { buildStripeInvoicePlan } from "./stripe-billing.js";
import type { BillingStripe } from "./stripe-client.js";

/**
 * The automated per-account billing worker — the operator-run mesh-bill logic
 * promoted to run unattended, once per account, with every safety rail intact:
 *
 *   - A broken/unverified ledger chain is a hard stop: DO NOT BILL.
 *   - A non-positive net period bills nothing (do_not_charge).
 *   - Idempotency keys on customer+period+amount, so a re-run is a no-op at
 *     Stripe, never a double charge.
 *   - TEST MODE only: the worker takes a {@link BillingStripe}; the real client
 *     refuses a live key unless explicitly allowed, which the worker never does.
 *   - No prompt content is read — only the usage-derived invoice totals.
 *
 * The customer's stored payment choice decides the rail:
 *   - direct_debit: Stripe pulls the fee against the saved mandate
 *     (charge_automatically + the mandate's payment method), after an advance
 *     "upcoming charge" notice carrying the recompute-it-yourself receipt —
 *     because the amount varies period to period.
 *   - bank_transfer: Stripe finalizes and SENDS the invoice; the customer pays
 *     it themselves. No mandate, no auto-pull.
 *
 * The decision is a pure function (unit-tested without Stripe); the executor
 * performs the Stripe calls for whichever rail the decision selected.
 */

/**
 * Recompute one account's invoice from its stored ledger records, with the
 * chain verified. The single path the worker and the admin API share, so a
 * preview and the real run can never disagree about what an account owes.
 */
export function invoiceForAccount(
  account: Account,
  records: readonly LedgerRecord[],
  period?: string,
): { invoice: Invoice; chainVerified: boolean } {
  const chain = verifyLedgerChain(records);
  const invoice = recomputeInvoice(records.map((record) => record.event), {
    ...(period === undefined ? {} : { period }),
    feePercent: account.feePercent,
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
 * Branches on the stored payment choice; refuses to bill a direct-debit account
 * whose mandate is not active, and refuses entirely before a choice is made.
 */
export function decideBilling(
  account: Account,
  invoice: Invoice,
  chainVerified: boolean,
  options: DecideBillingOptions = {},
): BillingDecision {
  const currency = (options.currency ?? "usd").toLowerCase();

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
    return {
      action: "bill",
      rail,
      customerId: plan.customerId,
      amountCents: plan.amountCents,
      currency: plan.currency,
      description: plan.description,
      idempotencyKey: plan.idempotencyKey,
      metadata: plan.metadata,
      mandatePaymentMethodId: mandate.paymentMethodId,
      notice: buildNotice(account, invoice, rail, plan.amountCents, plan.currency),
    };
  }

  // bank_transfer
  return {
    action: "bill",
    rail,
    customerId: plan.customerId,
    amountCents: plan.amountCents,
    currency: plan.currency,
    description: plan.description,
    idempotencyKey: plan.idempotencyKey,
    metadata: plan.metadata,
    notice: buildNotice(account, invoice, rail, plan.amountCents, plan.currency),
  };
}

export type AccountBillingOutcome =
  | { status: "skipped"; reason: string; chainUnverified: boolean }
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
  /**
   * "advance_notice" produces the upcoming-charge notice and performs NO Stripe
   * calls (sent N days before a variable-amount pull). "charge" (default)
   * creates and settles the invoice via the chosen rail.
   */
  mode?: "advance_notice" | "charge";
  /** Days a bank-transfer invoice is payable. Default 14. */
  daysUntilDue?: number;
  /** Statement description prefix on the Stripe invoice. */
  statementPrefix?: string;
};

/**
 * Run billing for one account against a recomputed invoice. The decision is
 * pure; this performs the Stripe side-effects for the selected rail with the
 * plan's idempotency key, so a re-run never double-charges.
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
