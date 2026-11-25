/**
 * The verdict the CLI shows a customer is the bill's own.
 *
 * `mesh verify`, `mesh status`, the `mesh start` summary lines and the
 * dashboard all recompute the invoice here, at the contracted fee, so the word
 * they print next to the savings ("charge" or "do_not_charge") is the decision
 * the bill itself makes. Recomputing without a fee only says whether net
 * savings are positive, which told a customer who owed nothing "(charge)".
 *
 * Nothing here rounds a fee: the cents come from the invoice recompute, which
 * rounds the fee in one place (`feeCents` in core's savings-ledger.ts).
 */
// Direct module imports, not the package barrels (see start.ts).
import { DEFAULT_FEE_PERCENT } from "../../core/src/accounts.js";
import { recomputeInvoice, type BillableEvent, type Invoice } from "../../core/src/savings-ledger.js";

/** The contracted fee every customer-facing recompute in the CLI uses. */
export const CONTRACTED_FEE_PERCENT = DEFAULT_FEE_PERCENT;

/** Recompute the invoice exactly as the bill does: at the contracted fee. */
export function recomputeBillInvoice(events: readonly BillableEvent[]): Invoice {
  return recomputeInvoice(events, { feePercent: CONTRACTED_FEE_PERCENT });
}

/** True when savings are positive but the fee on them is below one cent, so nothing is billed. */
export function feeIsBelowOneCent(invoice: Invoice): boolean {
  const billableNetUsd = invoice.netVerifiedSavingsUsd - (invoice.carryForwardDeficitInUsd ?? 0);
  return invoice.verdict === "do_not_charge" && billableNetUsd > 0;
}

/**
 * The verdict as printed beside a savings figure: "charge", "do_not_charge",
 * or, when savings are positive but too small to bill, the verdict with the
 * reason, so a customer is never left wondering why real savings owe nothing.
 */
export function verdictNote(invoice: Invoice): string {
  if (feeIsBelowOneCent(invoice)) {
    return `do_not_charge: the ${invoice.feePercent ?? CONTRACTED_FEE_PERCENT}% fee is below one cent`;
  }
  return invoice.verdict;
}

/** Why nothing is charged. Stable codes for machine readers; the sentence is for people. */
export type VerdictReasonCode = "no_requests" | "fee_below_one_cent" | "savings_not_positive";

/**
 * The bill's decision as data, for JSON output and in-process callers. Every
 * figure is read off the invoice recompute; nothing is worked out here.
 */
export type BillVerdict = {
  verdict: "charge" | "do_not_charge";
  /** Present when the verdict is do_not_charge. */
  reasonCode?: VerdictReasonCode;
  reason?: string;
  feePercent: number;
  /** The fee as billed: whole cents, rounded down. Zero whenever nothing is charged. */
  feeCents: number;
  feeUsd: number;
};

export function billVerdict(invoice: Invoice): BillVerdict {
  const feePercent = invoice.feePercent ?? CONTRACTED_FEE_PERCENT;
  if (invoice.verdict === "charge") {
    const feeCents = invoice.amountDueCents ?? 0;
    return { verdict: "charge", feePercent, feeCents, feeUsd: feeCents / 100 };
  }
  if (invoice.eventsConsidered === 0) {
    return { verdict: "do_not_charge", reasonCode: "no_requests", reason: "no requests are recorded", feePercent, feeCents: 0, feeUsd: 0 };
  }
  return feeIsBelowOneCent(invoice)
    ? { verdict: "do_not_charge", reasonCode: "fee_below_one_cent", reason: `the ${feePercent}% fee is below one cent`, feePercent, feeCents: 0, feeUsd: 0 }
    : { verdict: "do_not_charge", reasonCode: "savings_not_positive", reason: "net verified savings are not positive", feePercent, feeCents: 0, feeUsd: 0 };
}
