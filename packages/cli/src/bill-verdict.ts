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
