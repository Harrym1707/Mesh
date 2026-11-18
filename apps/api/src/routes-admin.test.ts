import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import {
  AccountStore,
  chainLedgerRecord,
  openFileLedgerStore,
  type BillableEvent,
  type LedgerRecord,
  type StripeClient,
} from "../../../packages/core/dist/src/index.js";
import type { ServerContext } from "./context.js";
import { handleAdminRequest } from "./routes-admin.js";

function billable(requestId: string, savedUsd: number): BillableEvent {
  return {
    schemaVersion: 1,
    requestId,
    applicationId: "app",
    invoicePeriod: "2026-10",
    timestamp: "2026-10-10T00:00:00.000Z",
    provider: "anthropic",
    model: "m",
    executionMode: "standard",
    pricingStatus: "priced",
    actualUsd: 0.01,
    levers: [{ leverId: "tool-schema", kind: "lossless", savedUsd }],
    status: "succeeded",
  };
}

function mockReq(method: string, path: string, body?: unknown, auth?: string): { req: IncomingMessage; url: URL } {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const stream = Readable.from(payload === "" ? [] : [Buffer.from(payload)]);
  const req = Object.assign(stream, {
    method,
    url: path,
    headers: auth ? { authorization: `Bearer ${auth}` } : {},
  }) as unknown as IncomingMessage;
  return { req, url: new URL(path, "http://127.0.0.1") };
}

function mockRes(): { res: ServerResponse; result: () => { status: number; body: unknown } } {
  let status = 0;
  let body: unknown;
  const res = {
    writeHead(code: number) {
      status = code;
      return this;
    },
    end(chunk?: string) {
      body = chunk ? JSON.parse(chunk) : undefined;
    },
  } as unknown as ServerResponse;
  return { res, result: () => ({ status, body }) };
}

function fakeStripe(): StripeClient {
  return {
    mode: "test",
    async createInvoice() {
      return { id: "in_1", status: "draft" };
    },
    async createInvoiceItem() {
      return { id: "ii_1" };
    },
    async finalizeInvoice(id: string) {
      return { id, status: "open", hosted_invoice_url: "https://pay.test/in_1" };
    },
    async payInvoice(id: string) {
      return { id, status: "paid" };
    },
    async createRefund() {
      return { id: "re_1", status: "succeeded" };
    },
  } as unknown as StripeClient;
}

function context(withStripe = true, adminToken: string | null = "admin-secret"): {
  ctx: ServerContext;
  accountId: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "mesh-admin-"));
  const accounts = new AccountStore();
  const { account } = accounts.upsertFromGithub({ githubId: 1, githubLogin: "octo" });
  accounts.patch(account.id, { stripeCustomerId: "cus_TEST", paymentChoice: "bank_transfer" });
  const ledger = openFileLedgerStore(join(dir, "ledger"));
  let prev: LedgerRecord | undefined;
  for (const id of ["a", "b"]) {
    prev = chainLedgerRecord(billable(id, 5), prev);
    ledger.append(account.id, [prev]);
  }
  const ctx: ServerContext = {
    accounts,
    ledger,
    publicBaseUrl: "https://mesh.test",
    dataDir: dir,
    directDebitPaymentMethods: ["us_bank_account"],
    defaultFeePercent: 1,
    maxChargeCents: 50_000,
    ...(withStripe ? { stripe: fakeStripe() } : {}),
    ...(adminToken ? { adminToken } : {}),
  };
  return { ctx, accountId: account.id };
}

async function call(ctx: ServerContext, method: string, path: string, body?: unknown, auth?: string) {
  const { req, url } = mockReq(method, path, body, auth);
  const { res, result } = mockRes();
  const handled = await handleAdminRequest(req, res, url, ctx);
  return { handled, ...result() };
}

describe("admin API", () => {
  it("returns 501 when the admin API is disabled", async () => {
    const { ctx } = context(true, null);
    const out = await call(ctx, "GET", "/v1/admin/accounts", undefined, "anything");
    expect(out.status).toBe(501);
  });

  it("rejects a missing or wrong admin token", async () => {
    const { ctx } = context();
    expect((await call(ctx, "GET", "/v1/admin/accounts")).status).toBe(401);
    expect((await call(ctx, "GET", "/v1/admin/accounts", undefined, "wrong")).status).toBe(401);
  });

  it("lists accounts with their ledger tail", async () => {
    const { ctx, accountId } = context();
    const out = await call(ctx, "GET", "/v1/admin/accounts", undefined, "admin-secret");
    expect(out.status).toBe(200);
    const accounts = (out.body as { accounts: Array<{ id: string; ledgerTailSeq: number; accountKeyHash?: string }> }).accounts;
    expect(accounts[0]!.id).toBe(accountId);
    expect(accounts[0]!.ledgerTailSeq).toBe(1);
    expect(accounts[0]!.accountKeyHash).toBeUndefined(); // redacted
  });

  it("reports ledger health including the recomputed invoice", async () => {
    const { ctx, accountId } = context();
    const out = await call(ctx, "GET", `/v1/admin/accounts/${accountId}/ledger-health?period=2026-10`, undefined, "admin-secret");
    expect(out.status).toBe(200);
    const body = out.body as { chainOk: boolean; billable: boolean; invoice: { netVerifiedSavingsUsd: number; verdict: string } };
    expect(body.chainOk).toBe(true);
    expect(body.billable).toBe(true);
    expect(body.invoice.netVerifiedSavingsUsd).toBe(10);
    expect(body.invoice.verdict).toBe("charge");
  });

  it("previews billing without touching Stripe", async () => {
    const { ctx } = context();
    const out = await call(ctx, "POST", "/v1/admin/billing/preview", { period: "2026-10" }, "admin-secret");
    expect(out.status).toBe(200);
    const previews = (out.body as { previews: Array<{ action: string; rail?: string; amountCents?: number }> }).previews;
    expect(previews[0]).toMatchObject({ action: "bill", rail: "bank_transfer", amountCents: 10 });
  });

  it("runs billing through the chosen rail in test mode", async () => {
    const { ctx } = context();
    const out = await call(ctx, "POST", "/v1/admin/billing/run", { period: "2026-10" }, "admin-secret");
    expect(out.status).toBe(200);
    const body = out.body as { stripeMode: string; outcomes: Array<{ outcome: { status: string; rail?: string } }> };
    expect(body.stripeMode).toBe("test");
    expect(body.outcomes[0]!.outcome).toMatchObject({ status: "billed", rail: "bank_transfer" });
  });

  it("issues a refund", async () => {
    const { ctx } = context();
    const out = await call(ctx, "POST", "/v1/admin/refunds", { paymentIntentId: "pi_123" }, "admin-secret");
    expect(out.status).toBe(200);
    expect((out.body as { refund: { status: string } }).refund.status).toBe("succeeded");
  });

  it("requires a payment intent id to refund", async () => {
    const { ctx } = context();
    const out = await call(ctx, "POST", "/v1/admin/refunds", {}, "admin-secret");
    expect(out.status).toBe(400);
  });
});
