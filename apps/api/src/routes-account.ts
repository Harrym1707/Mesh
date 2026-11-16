import type { IncomingMessage, ServerResponse } from "node:http";
import { redactAccount } from "../../../packages/core/dist/src/index.js";
import type { ServerContext } from "./context.js";
import { authenticateAccount } from "./account-auth.js";
import { sendJson } from "./http-util.js";

/**
 * Account self-service, authenticated by the Mesh account key:
 *   GET  /v1/account            — the account's public view
 *   POST /v1/account/rotate-key — mint a new key, invalidate the old one
 */
export async function handleAccountRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: ServerContext,
): Promise<boolean> {
  if (req.method === "GET" && url.pathname === "/v1/account") {
    const account = authenticateAccount(req, res, ctx);
    if (!account) return true;
    sendJson(res, 200, { account: redactAccount(account), apiBaseUrl: ctx.publicBaseUrl });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/v1/account/rotate-key") {
    const account = authenticateAccount(req, res, ctx);
    if (!account) return true;
    const rotated = ctx.accounts.rotateAccountKey(account.id);
    if (!rotated) {
      sendJson(res, 404, { error: "account_not_found" });
      return true;
    }
    sendJson(res, 200, { account: redactAccount(rotated.account), accountKey: rotated.accountKey });
    return true;
  }

  return false;
}
