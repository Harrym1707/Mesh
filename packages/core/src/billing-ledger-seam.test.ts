import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountStore, type Account } from "./accounts.js";
import { openFileLedgerStore, type LedgerStore } from "./ledger-store.js";
import { publishedModelPrices } from "./model-prices.js";
import {
  chainLedgerRecord,
  recomputeInvoice,
  type BillableEvent,
  type LedgerRecord,
} from "./savings-ledger.js";
import { invoiceForAccount, settleAccountBilling } from "./billing-worker.js";
import type { BillingStripe, StripeInvoice, StripeInvoiceItem } from "./stripe-client.js";

/**
 * The verified-savings-ledger ↔ invoice seam, end to end, through the REAL
 * append-only hash-chained ledger store — NOT hand-built records.
 *
 * The money-safety suite builds LedgerRecords directly. This suite instead
 * drives the whole path the running system uses:
 *
 *   meter one request  →  LedgerStore.append (chain-verification-on-ingest)
 *     →  LedgerStore.readRecords  →  settleAccountBilling  →  fake Stripe
 *
 * so the thing proven is the SEAM: the billing worker's invoice input is the
 * exact same append-only hash-chained ledger that metering writes into, ingest
 * refuses anything that would corrupt that input, and chain verification gates
 * the charge at settle time. No live key is ever constructed; a fake
 * {@link BillingStripe} records every call.
 */

type Call = { method: string; args: Record<string, unknown> };

function recordingStripe(): { stripe: BillingStripe; calls: Call[] } {
  const calls: Call[] = [];
  let n = 0;
  const stripe: BillingStripe = {
    mode: "test",
    async createInvoice(params) {
      n += 1;
      calls.push({ method: "createInvoice", args: params as unknown as Record<string, unknown> });
      return { id: `in_${n}`, status: "draft" } satisfies StripeInvoice;
    },
    async createInvoiceItem(params) {
      calls.push({ method: "createInvoiceItem", args: params as unknown as Record<string, unknown> });
      return { id: "ii" } satisfies StripeInvoiceItem;
    },
    async finalizeInvoice(invoiceId, idempotencyKey) {
      calls.push({ method: "finalizeInvoice", args: { invoiceId, idempotencyKey } });
      return { id: invoiceId, status: "open" };
    },
    async payInvoice(invoiceId, idempotencyKey) {
      calls.push({ method: "payInvoice", args: { invoiceId, idempotencyKey } });
      return { id: invoiceId, status: "paid" };
    },
  };
  return { stripe, calls };
}

function event(overrides: Partial<BillableEvent> & { requestId: string }): BillableEvent {
  return {
    schemaVersion: 1,
    applicationId: "app",
    invoicePeriod: "2026-10",
    timestamp: "2026-10-13T10:00:00.000Z",
    provider: "openai",
    model: "gpt-5",
    executionMode: "standard",
    pricingStatus: "priced",
    levers: [],
    status: "succeeded",
    ...overrides,
  };
}

/** Chain events into a valid spool, exactly as the proxy/SDK mirror would. */
function spool(events: BillableEvent[]): LedgerRecord[] {
  const records: LedgerRecord[] = [];
  let prev: LedgerRecord | undefined;
  for (const e of events) {
    prev = chainLedgerRecord(e, prev);
    records.push(prev);
  }
  return records;
}

function store(overrides: Partial<Account> = {}): { accounts: AccountStore; id: string } {
  const accounts = new AccountStore();
  const { account } = accounts.upsertFromGithub({ githubId: 1, githubLogin: "octo" });
  accounts.patch(account.id, {
    stripeCustomerId: "cus_TEST",
    paymentChoice: "bank_transfer",
    feePercent: 10,
    ...overrides,
  });
  return { accounts, id: account.id };
}

const CAT = { catalogue: publishedModelPrices } as const;

describe("ledger ↔ invoice seam (through the real append-only ledger store)", () => {
  let dir: string;
  let ledger: LedgerStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mesh-seam-"));
    ledger = openFileLedgerStore(join(dir, "ledger"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("meter → ingest → read → settle: the billing input IS the stored hash-chained ledger", async () => {
    const { stripe, calls } = recordingStripe();
    const { accounts, id } = store();

    // Metering mirrors the hash-chained records to the ledger store, which
    // chain-verifies them on INGEST before they are ever stored.
    const records = spool([
      event({ requestId: "a", levers: [{ leverId: "schema", kind: "lossless", savedUsd: 60 }] }),
      event({ requestId: "b", timestamp: "2026-10-13T11:00:00.000Z", levers: [{ leverId: "schema", kind: "lossless", savedUsd: 40 }] }),
    ]);
    const ingest = ledger.append(id, records);
    expect(ingest.ok).toBe(true);
    if (ingest.ok) expect(ingest.stored).toBe(2);

    // The worker reads back exactly what was stored, and bills from it.
    const stored = ledger.readRecords(id);
    expect(stored).toEqual(records);

    const outcome = await settleAccountBilling(stripe, accounts, accounts.get(id)!, stored, "2026-10", CAT);
    expect(outcome.status).toBe("billed");
    // fee 10% of net $100 = $10 = 1000¢.
    if (outcome.status === "billed") expect(outcome.amountCents).toBe(1000);

    // The invoice the charge is built from reproduces a direct recompute over
    // the stored events — the seam carries no hidden transformation.
    const direct = recomputeInvoice(stored.map((r) => r.event), { period: "2026-10", feePercent: 10 });
    const { invoice, chainVerified } = invoiceForAccount(accounts.get(id)!, stored, "2026-10");
    expect(chainVerified).toBe(true);
    expect(invoice.amountDueCents).toBe(direct.amountDueCents);
    expect(invoice.netVerifiedSavingsUsd).toBe(direct.netVerifiedSavingsUsd);
    expect(calls.filter((c) => c.method === "createInvoice")).toHaveLength(1);
  });

  it("ingest REJECTS a tampered batch, so a perturbed event never enters the billing input", () => {
    const { id } = store();
    const records = spool([
      event({ requestId: "a", levers: [{ leverId: "schema", kind: "lossless", savedUsd: 60 }] }),
    ]);
    // Perturb the stored event AFTER it was hash-chained — the eventHash no
    // longer matches its content.
    const tampered: LedgerRecord[] = [
      { ...records[0]!, event: { ...records[0]!.event, levers: [{ leverId: "schema", kind: "lossless", savedUsd: 6000 }] } },
    ];
    const ingest = ledger.append(id, tampered);
    expect(ingest.ok).toBe(false);
    if (!ingest.ok) expect(ingest.reason).toMatch(/eventHash/);
    // Nothing was stored — the billing input stays empty.
    expect(ledger.readRecords(id)).toHaveLength(0);
  });

  it("ingest REJECTS a forked continuation, keeping the stored chain the single source of truth", () => {
    const { id } = store();
    const base = spool([
      event({ requestId: "a", levers: [{ leverId: "schema", kind: "lossless", savedUsd: 60 }] }),
    ]);
    expect(ledger.append(id, base).ok).toBe(true);

    // A second, independently-chained spool for the same account forks at seq 0
    // (different genesis content) → its continuation does not link to the tail.
    const fork = spool([
      event({ requestId: "x", levers: [{ leverId: "schema", kind: "lossless", savedUsd: 1 }] }),
      event({ requestId: "y", timestamp: "2026-10-13T12:00:00.000Z", levers: [{ leverId: "schema", kind: "lossless", savedUsd: 9999 }] }),
    ]);
    const ingest = ledger.append(id, fork);
    expect(ingest.ok).toBe(false);
    // Only the genuine first record remains.
    expect(ledger.readRecords(id)).toHaveLength(1);
  });

  it("a spool corrupted ON DISK after storage: chain verification gates the charge — settle skips, ZERO Stripe calls, NO billed-record", async () => {
    const { stripe, calls } = recordingStripe();
    const { accounts, id } = store();

    const records = spool([
      event({ requestId: "a", levers: [{ leverId: "schema", kind: "lossless", savedUsd: 100 }] }),
    ]);
    expect(ledger.append(id, records).ok).toBe(true);

    // Simulate on-disk corruption discovered at read time: the record the worker
    // reads back no longer hashes to its content (e.g. bit-rot or tampering of
    // the stored JSONL). settleAccountBilling re-verifies the chain and refuses.
    const corruptedRead: LedgerRecord[] = [
      { ...records[0]!, event: { ...records[0]!.event, levers: [{ leverId: "schema", kind: "lossless", savedUsd: 999_999 }] } },
    ];

    const outcome = await settleAccountBilling(stripe, accounts, accounts.get(id)!, corruptedRead, "2026-10", CAT);
    expect(outcome.status).toBe("skipped");
    if (outcome.status === "skipped") expect(outcome.chainUnverified).toBe(true);
    // The hard stop: nothing was charged and no durable state was written.
    expect(calls).toHaveLength(0);
    expect(accounts.get(id)!.billedPeriods ?? []).toHaveLength(0);
    expect(accounts.get(id)!.carryForwardDeficitUsd ?? 0).toBe(0);
  });

  it("idempotent re-ingest (metering mirror retries) does not change the billed invoice", async () => {
    const { stripe, calls } = recordingStripe();
    const { accounts, id } = store();
    const records = spool([
      event({ requestId: "a", levers: [{ leverId: "schema", kind: "lossless", savedUsd: 100 }] }),
    ]);
    // The mirror is fire-and-forget with retry: the same batch arrives twice.
    expect(ledger.append(id, records).ok).toBe(true);
    const retry = ledger.append(id, records);
    expect(retry.ok).toBe(true);
    if (retry.ok) expect(retry.stored).toBe(0); // recognised as a replay
    expect(ledger.readRecords(id)).toHaveLength(1);

    const outcome = await settleAccountBilling(stripe, accounts, accounts.get(id)!, ledger.readRecords(id), "2026-10", CAT);
    expect(outcome.status).toBe("billed");
    if (outcome.status === "billed") expect(outcome.amountCents).toBe(1000);
    expect(calls.filter((c) => c.method === "createInvoice")).toHaveLength(1);
  });
});
