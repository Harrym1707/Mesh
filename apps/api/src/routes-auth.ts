import type { IncomingMessage, ServerResponse } from "node:http";
import {
  buildAuthorizeUrl,
  createOAuthState,
  exchangeCodeForIdentity,
  redactAccount,
  verifyOAuthState,
  type Account,
} from "../../../packages/core/dist/src/index.js";
import type { ServerContext } from "./context.js";
import { redirect, sendHtml, sendJson } from "./http-util.js";
import { claimPageHtml } from "./claim-page.js";

/**
 * The signup entry points. GitHub OAuth is the only identity step and the first
 * login auto-creates the account — no approval. The callback mints the account
 * key (shown once), creates the Stripe customer, and renders the claim page.
 *
 * An agent that prefers JSON can pass `?format=json` to the callback and drive
 * the whole flow headlessly.
 */

/** Ensure a Stripe customer exists for this account, persisting the id. Best-effort: never blocks signup. */
async function ensureStripeCustomer(ctx: ServerContext, account: Account): Promise<Account> {
  if (account.stripeCustomerId || !ctx.stripe) return account;
  try {
    const customer = await ctx.stripe.createCustomer({
      ...(account.email === undefined ? {} : { email: account.email }),
      metadata: { mesh_account_id: account.id, github_login: account.githubLogin, github_id: String(account.githubId) },
      idempotencyKey: `mesh-customer-${account.id}`,
    });
    return ctx.accounts.patch(account.id, { stripeCustomerId: customer.id }) ?? account;
  } catch {
    // Stripe being briefly unreachable must not cost the user their account or
    // key. The customer is created lazily on the next account/billing call.
    return account;
  }
}

export async function handleAuthRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: ServerContext,
): Promise<boolean> {
  if (req.method === "GET" && url.pathname === "/v1/auth/github/start") {
    if (!ctx.githubOAuth) {
      sendJson(res, 501, { error: "github_oauth_not_configured" });
      return true;
    }
    const intent = url.searchParams.get("intent") === "reissue" ? "reissue" : "signin";
    // The intent rides in the state's associated redirect so the callback knows
    // whether a returning user explicitly asked to reissue their key.
    const state = `${createOAuthState(ctx.githubOAuth.stateSecret)}~${intent}`;
    redirect(res, buildAuthorizeUrl(ctx.githubOAuth, state));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/v1/auth/github/callback") {
    if (!ctx.githubOAuth) {
      sendJson(res, 501, { error: "github_oauth_not_configured" });
      return true;
    }
    const code = url.searchParams.get("code");
    const rawState = url.searchParams.get("state") ?? "";
    const [stateToken, intent] = rawState.split("~");
    if (!code || !stateToken || !verifyOAuthState(ctx.githubOAuth.stateSecret, stateToken)) {
      sendJson(res, 400, { error: "invalid_oauth_callback" });
      return true;
    }

    let identity;
    try {
      identity = await exchangeCodeForIdentity(ctx.githubOAuth, code);
    } catch (error) {
      sendJson(res, 502, { error: "github_exchange_failed", detail: error instanceof Error ? error.message : String(error) });
      return true;
    }

    const upsert = ctx.accounts.upsertFromGithub(identity);
    let account = upsert.account;
    let accountKey = upsert.accountKey;

    // A returning user who proves GitHub ownership can reissue a lost key; a
    // normal login never rotates, so a working key stays valid across logins.
    if (!upsert.created && intent === "reissue") {
      const rotated = ctx.accounts.rotateAccountKey(account.id);
      if (rotated) {
        account = rotated.account;
        accountKey = rotated.accountKey;
      }
    }

    account = await ensureStripeCustomer(ctx, account);

    if (url.searchParams.get("format") === "json") {
      sendJson(res, 200, {
        account: redactAccount(account),
        created: upsert.created,
        apiBaseUrl: ctx.publicBaseUrl,
        ...(accountKey === undefined ? {} : { accountKey }),
      });
      return true;
    }

    sendHtml(res, 200, claimPageHtml({
      account: redactAccount(account),
      apiBaseUrl: ctx.publicBaseUrl,
      ...(accountKey === undefined ? {} : { accountKey }),
      ...(accountKey === undefined ? { reissueUrl: `${ctx.publicBaseUrl}/v1/auth/github/start?intent=reissue` } : {}),
    }));
    return true;
  }

  return false;
}
