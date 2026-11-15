import type { IncomingMessage, ServerResponse } from "node:http";
import {
  decideBilling,
  invoiceForAccount,
  redactAccount,
  runAccountBilling,
  verifyLedgerChain,
  type Account,
  type AccountBillingOutcome,
} from "../../../packages/core/dist/src/index.js";
import type { ServerContext } from "./context.js";
import { authorizeAdmin } from "./account-auth.js";
import { isRecord, readJsonBody, sendJson } from "./http-util.js";

/**
 * The agent-operable admin API — authenticated endpoints, NOT a human
 * dashboard. Everything the operator (or an agent acting for them) needs to run
 * the business: list accounts, inspect ledger health, preview and trigger a
 * billing run, and issue refunds. All under /v1/admin, gated by the operator
 * token. Billing actions stay in Stripe test mode via the shared client.
 */

function ledgerHealth(ctx: ServerContext, account: Account, period?: string): Record<string, unknown> {
  const records = ctx.ledger.readRecords(account.id);
  const chain = verifyLedgerChain(records);
  const { invoice, chainVerified } = invoiceForAccount(account, records, period);
  return {
    accountId: account.id,
    githubLogin: account.githubLogin,
    records: records.length,
    tailSeq: ctx.ledger.tail(account.id)?.seq ?? -1,
    chainOk: chain.ok,
    ...(chain.ok ? {} : { chainBreakSeq: chain.seq, chainReason: chain.reason }),
    invoice: {
      period: invoice.period,
      netVerifiedSavingsUsd: invoice.netVerifiedSavingsUsd,
      verdict: invoice.verdict,
      eventsBilled: invoice.eventsBilled,
      unpricedEvents: invoice.unpricedEvents,
      amountDueCents: invoice.amountDueCents ?? 0,
    },
    billable: chainVerified && invoice.verdict === "charge",
  };
}

export async function handleAdminRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: ServerContext,
): Promise<boolean> {
  if (!url.pathname.startsWith("/v1/admin/")) return false;
  if (!authorizeAdmin(req, res, ctx)) return true;

  const period = url.searchParams.get("period") ?? undefined;

  // GET /v1/admin/accounts — list every account (redacted) with its ledger tail.
  if (req.method === "GET" && url.pathname === "/v1/admin/accounts") {
    const accounts = ctx.accounts.list().map((account) => ({
      ...redactAccount(account),
      ledgerTailSeq: ctx.ledger.tail(account.id)?.seq ?? -1,
    }));
    sendJson(res, 200, { accounts });
    return true;
  }

  // GET /v1/admin/accounts/:id/ledger-health
  const healthMatch = /^\/v1\/admin\/accounts\/([^/]+)\/ledger-health$/.exec(url.pathname);
  if (req.method === "GET" && healthMatch) {
    const account = ctx.accounts.get(decodeURIComponent(healthMatch[1]!));
    if (!account) {
      sendJson(res, 404, { error: "account_not_found" });
      return true;
    }
    sendJson(res, 200, ledgerHealth(ctx, account, period));
    return true;
  }

  // POST /v1/admin/billing/preview — decide-only across accounts (no Stripe).
  if (req.method === "POST" && url.pathname === "/v1/admin/billing/preview") {
    const body = await readJsonBody(req);
    if (!body.ok) {
      sendJson(res, body.status, { error: body.error });
      return true;
    }
    const opts = isRecord(body.value) ? body.value : {};
    const previewPeriod = typeof opts.period === "string" ? opts.period : period;
    const targets = selectTargets(ctx, typeof opts.accountId === "string" ? opts.accountId : undefined);
    const previews = targets.map((account) => {
      const records = ctx.ledger.readRecords(account.id);
      const { invoice, chainVerified } = invoiceForAccount(account, records, previewPeriod);
      const decision = decideBilling(account, invoice, chainVerified);
      return decision.action === "skip"
        ? { accountId: account.id, githubLogin: account.githubLogin, action: "skip" as const, reason: decision.reason }
        : {
            accountId: account.id,
            githubLogin: account.githubLogin,
            action: "bill" as const,
            rail: decision.rail,
            amountCents: decision.amountCents,
            currency: decision.currency,
          };
    });
    sendJson(res, 200, { period: previewPeriod ?? null, previews });
    return true;
  }

  // POST /v1/admin/billing/run — actually settle (Stripe test mode).
  if (req.method === "POST" && url.pathname === "/v1/admin/billing/run") {
    if (!ctx.stripe) {
      sendJson(res, 501, { error: "stripe_not_configured" });
      return true;
    }
    const body = await readJsonBody(req);
    if (!body.ok) {
      sendJson(res, body.status, { error: body.error });
      return true;
    }
    const opts = isRecord(body.value) ? body.value : {};
    const runPeriod = typeof opts.period === "string" ? opts.period : period;
    const mode = opts.mode === "advance_notice" ? "advance_notice" : "charge";
    const targets = selectTargets(ctx, typeof opts.accountId === "string" ? opts.accountId : undefined);
    const outcomes: Array<{ accountId: string; outcome: AccountBillingOutcome }> = [];
    for (const account of targets) {
      const records = ctx.ledger.readRecords(account.id);
      const { invoice, chainVerified } = invoiceForAccount(account, records, runPeriod);
      const outcome = await runAccountBilling(ctx.stripe, account, invoice, chainVerified, { mode });
      outcomes.push({ accountId: account.id, outcome });
    }
    sendJson(res, 200, { period: runPeriod ?? null, mode, stripeMode: ctx.stripe.mode, outcomes });
    return true;
  }

  // POST /v1/admin/refunds — refund a prior fee charge (Stripe test mode).
  if (req.method === "POST" && url.pathname === "/v1/admin/refunds") {
    if (!ctx.stripe) {
      sendJson(res, 501, { error: "stripe_not_configured" });
      return true;
    }
    const body = await readJsonBody(req);
    if (!body.ok) {
      sendJson(res, body.status, { error: body.error });
      return true;
    }
    const opts = isRecord(body.value) ? body.value : {};
    const paymentIntentId = typeof opts.paymentIntentId === "string" ? opts.paymentIntentId : undefined;
    if (!paymentIntentId) {
      sendJson(res, 400, { error: "missing_payment_intent_id" });
      return true;
    }
    const amountCents = typeof opts.amountCents === "number" && Number.isInteger(opts.amountCents) ? opts.amountCents : undefined;
    try {
      const refund = await ctx.stripe.createRefund({ paymentIntentId, ...(amountCents === undefined ? {} : { amountCents }) });
      sendJson(res, 200, { refund });
    } catch (error) {
      sendJson(res, 502, { error: "stripe_error", detail: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  sendJson(res, 404, { error: "unknown_admin_route" });
  return true;
}

function selectTargets(ctx: ServerContext, accountId?: string): Account[] {
  if (accountId) {
    const account = ctx.accounts.get(accountId);
    return account ? [account] : [];
  }
  return ctx.accounts.list();
}
