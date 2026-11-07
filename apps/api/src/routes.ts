import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerContext } from "./context.js";
import { handleAuthRequest } from "./routes-auth.js";
import { handleAccountRequest } from "./routes-account.js";
import { handleLedgerRequest } from "./routes-ledger.js";
import { handlePaymentRequest } from "./routes-payment.js";
import { handleAdminRequest } from "./routes-admin.js";
import { handleClaimRequest } from "./routes-claim.js";
import { sendJson } from "./http-util.js";

/**
 * The self-serve API router: GitHub signup, account self-service, metering
 * ingestion, payment setup, and the agent-operable admin API. Each handler
 * group returns true when it handled the request; the first match wins and the
 * server's telemetry/dashboard routes handle anything left over.
 *
 * Handlers never throw into the socket — a bug surfaces as a 500 rather than a
 * hung connection.
 */
export type ApiHandler = (req: IncomingMessage, res: ServerResponse, url: URL, ctx: ServerContext) => Promise<boolean>;

const HANDLERS: ApiHandler[] = [
  handleClaimRequest,
  handleAuthRequest,
  handleAccountRequest,
  handlePaymentRequest,
  handleLedgerRequest,
  handleAdminRequest,
];

export function createApiRouter(ctx: ServerContext) {
  return {
    async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
      try {
        for (const handler of HANDLERS) {
          if (await handler(req, res, url, ctx)) return true;
        }
        return false;
      } catch (error) {
        if (!res.headersSent) {
          sendJson(res, 500, { error: "internal_error", detail: error instanceof Error ? error.message : String(error) });
        }
        return true;
      }
    },
  };
}
