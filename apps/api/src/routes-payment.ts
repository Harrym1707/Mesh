import type { IncomingMessage, ServerResponse } from "node:http";
import {
  redactAccount,
  type Account,
  type PaymentChoice,
} from "../../../packages/core/dist/src/index.js";
import type { ServerContext } from "./context.js";
import { authenticateAccount } from "./account-auth.js";
import { isRecord, readJsonBody, sendHtml, sendJson } from "./http-util.js";

/**
 * Payment setup for both rails the customer chooses between:
 *
 *   - direct_debit: a Stripe Checkout Session in `setup` mode collects the
 *     mandate (ACH/BACS/SEPA — the enabled set is config, region-agnostic).
 *     The success redirect confirms the mandate and marks it active, so the
 *     billing worker can later pull the variable fee against it.
 *   - bank_transfer: nothing to collect up front; the worker finalizes and
 *     SENDS each invoice and the customer pays it themselves.
 *
 * Every write is authenticated by the Mesh account key, except the mandate
 * confirm redirect, which the customer's browser hits without the key — it is
 * authorized instead by the Stripe session belonging to the account's own
 * customer (checked on confirm).
 */

function isPaymentChoice(value: unknown): value is PaymentChoice {
  return value === "direct_debit" || value === "bank_transfer";
}

async function createMandateSession(ctx: ServerContext, account: Account): Promise<string | undefined> {
  if (!ctx.stripe || !account.stripeCustomerId) return undefined;
  const session = await ctx.stripe.createMandateCheckoutSession({
    customerId: account.stripeCustomerId,
    paymentMethodTypes: ctx.directDebitPaymentMethods,
    currency: "usd",
    successUrl: `${ctx.publicBaseUrl}/v1/account/payment/mandate/confirm?account=${encodeURIComponent(account.id)}&session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${ctx.publicBaseUrl}/claim`,
  });
  return session.url ?? undefined;
}

/** Read the completed checkout session, activate the mandate, and persist it. */
async function confirmMandate(
  ctx: ServerContext,
  account: Account,
  sessionId: string,
): Promise<{ ok: true; account: Account } | { ok: false; status: number; error: string }> {
  if (!ctx.stripe || !account.stripeCustomerId) return { ok: false, status: 501, error: "stripe_not_configured" };
  const session = await ctx.stripe.getCheckoutSession(sessionId);
  // Authorize the keyless confirm: the session must belong to THIS account's
  // own Stripe customer, so a guessed session id for another account is refused.
  if (session.customer !== account.stripeCustomerId) {
    return { ok: false, status: 403, error: "session_customer_mismatch" };
  }
  if (session.setup_intent === null) return { ok: false, status: 400, error: "session_has_no_setup_intent" };
  const setupIntent = await ctx.stripe.getSetupIntent(session.setup_intent);
  if (setupIntent.status !== "succeeded" || !setupIntent.payment_method) {
    const pending = ctx.accounts.patch(account.id, {
      directDebitMandate: { setupIntentId: setupIntent.id, status: "pending" },
    });
    return { ok: true, account: pending ?? account };
  }
  await ctx.stripe.setDefaultPaymentMethod(account.stripeCustomerId, setupIntent.payment_method);
  const updated = ctx.accounts.patch(account.id, {
    paymentChoice: "direct_debit",
    directDebitMandate: { setupIntentId: setupIntent.id, paymentMethodId: setupIntent.payment_method, status: "active" },
  });
  return { ok: true, account: updated ?? account };
}

export async function handlePaymentRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: ServerContext,
): Promise<boolean> {
  // Choose a rail (and, for direct debit, hand back the mandate setup URL).
  if (req.method === "POST" && url.pathname === "/v1/account/payment-choice") {
    const account = authenticateAccount(req, res, ctx);
    if (!account) return true;
    const body = await readJsonBody(req);
    if (!body.ok) {
      sendJson(res, body.status, { error: body.error });
      return true;
    }
    const choice = isRecord(body.value) ? body.value.choice : undefined;
    if (!isPaymentChoice(choice)) {
      sendJson(res, 400, { error: "invalid_payment_choice", allowed: ["direct_debit", "bank_transfer"] });
      return true;
    }
    const updated = ctx.accounts.patch(account.id, {
      paymentChoice: choice,
      ...(choice === "direct_debit" && !account.directDebitMandate ? { directDebitMandate: { status: "pending" } } : {}),
    }) ?? account;

    let mandateSetupUrl: string | undefined;
    if (choice === "direct_debit") {
      try {
        mandateSetupUrl = await createMandateSession(ctx, updated);
      } catch {
        mandateSetupUrl = undefined; // the customer can retry via the setup endpoint
      }
    }
    sendJson(res, 200, {
      account: redactAccount(updated),
      ...(mandateSetupUrl ? { mandateSetupUrl } : {}),
      ...(choice === "bank_transfer"
        ? { note: "Bank transfer selected. Each period's invoice is finalized and sent to you; you pay it directly." }
        : {}),
    });
    return true;
  }

  // (Re)create the mandate setup session, e.g. after a cancelled checkout.
  if (req.method === "POST" && url.pathname === "/v1/account/payment/mandate/setup") {
    const account = authenticateAccount(req, res, ctx);
    if (!account) return true;
    if (!ctx.stripe) {
      sendJson(res, 501, { error: "stripe_not_configured" });
      return true;
    }
    try {
      const mandateSetupUrl = await createMandateSession(ctx, account);
      if (!mandateSetupUrl) {
        sendJson(res, 502, { error: "could_not_create_mandate_session" });
        return true;
      }
      sendJson(res, 200, { mandateSetupUrl });
    } catch (error) {
      sendJson(res, 502, { error: "stripe_error", detail: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  // Confirm redirect hit by the customer's browser after completing checkout.
  if (req.method === "GET" && url.pathname === "/v1/account/payment/mandate/confirm") {
    const accountId = url.searchParams.get("account") ?? "";
    const sessionId = url.searchParams.get("session_id") ?? "";
    const account = ctx.accounts.get(accountId);
    if (!account || !sessionId) {
      sendHtml(res, 400, "<p>Invalid mandate confirmation link.</p>");
      return true;
    }
    try {
      const result = await confirmMandate(ctx, account, sessionId);
      if (!result.ok) {
        sendHtml(res, result.status, `<p>Could not confirm the mandate: ${result.error}.</p>`);
        return true;
      }
      const active = result.account.directDebitMandate?.status === "active";
      sendHtml(res, 200, `<!doctype html><meta charset="utf-8"><title>Mesh — mandate</title>` +
        `<body style="font:15px/1.6 system-ui;max-width:640px;margin:3rem auto;padding:0 1rem">` +
        `<p>⬢ MESH</p><h1>${active ? "Direct debit is set up" : "Mandate pending"}</h1>` +
        `<p>${active
          ? "Mesh will pull the fee on your verified savings automatically, after an advance notice you can recompute yourself."
          : "Your bank is still confirming the mandate. Mesh will activate it once your bank completes it."}</p>` +
        `</body>`);
    } catch (error) {
      sendHtml(res, 502, `<p>Stripe error confirming the mandate: ${error instanceof Error ? error.message : String(error)}.</p>`);
    }
    return true;
  }

  // Agent-driven confirm (JSON), authenticated by the account key.
  if (req.method === "POST" && url.pathname === "/v1/account/payment/mandate/confirm") {
    const account = authenticateAccount(req, res, ctx);
    if (!account) return true;
    const body = await readJsonBody(req);
    if (!body.ok) {
      sendJson(res, body.status, { error: body.error });
      return true;
    }
    const sessionId = isRecord(body.value) ? body.value.sessionId : undefined;
    if (typeof sessionId !== "string" || sessionId === "") {
      sendJson(res, 400, { error: "missing_session_id" });
      return true;
    }
    try {
      const result = await confirmMandate(ctx, account, sessionId);
      if (!result.ok) {
        sendJson(res, result.status, { error: result.error });
        return true;
      }
      sendJson(res, 200, { account: redactAccount(result.account) });
    } catch (error) {
      sendJson(res, 502, { error: "stripe_error", detail: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  return false;
}
