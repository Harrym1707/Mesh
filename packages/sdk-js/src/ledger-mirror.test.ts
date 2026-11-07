import { describe, expect, it } from "vitest";
import { chainLedgerRecord, type BillableEvent, type LedgerRecord } from "../../core/dist/src/savings-ledger.js";
import { LedgerMirror } from "./ledger-mirror.js";

function event(id: string): BillableEvent {
  return {
    schemaVersion: 1,
    requestId: id,
    applicationId: "app",
    invoicePeriod: "2026-11",
    timestamp: "2026-11-01T00:00:00.000Z",
    provider: "anthropic",
    model: "claude-3-5-sonnet",
    executionMode: "standard",
    pricingStatus: "priced",
    actualUsd: 0.01,
    levers: [],
    status: "succeeded",
  };
}

function chain(n: number): LedgerRecord[] {
  const out: LedgerRecord[] = [];
  let prev: LedgerRecord | undefined;
  for (let i = 0; i < n; i += 1) {
    prev = chainLedgerRecord(event(`req-${i}`), prev);
    out.push(prev);
  }
  return out;
}

type Capture = { url: string; auth?: string; records: LedgerRecord[] };

function fakeFetch(
  onCall: (capture: Capture) => { status: number; tailSeq?: number },
): { fetch: typeof fetch; calls: Capture[] } {
  const calls: Capture[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { records: LedgerRecord[] };
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const capture: Capture = { url: String(input), auth: headers.authorization, records: body.records };
    calls.push(capture);
    const { status, tailSeq } = onCall(capture);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => (tailSeq === undefined ? {} : { tailSeq }),
    } as unknown as Response;
  }) as typeof fetch;
  return { fetch: impl, calls };
}

describe("LedgerMirror", () => {
  it("pushes records to the metering endpoint with the account key as bearer", async () => {
    const { fetch, calls } = fakeFetch((c) => ({ status: 202, tailSeq: c.records[c.records.length - 1]!.seq }));
    const mirror = new LedgerMirror({ apiUrl: "https://api.mesh.test/", accountKey: "mesh_sk_test", fetch });
    const records = chain(3);
    for (const record of records) mirror.enqueue(record);
    await mirror.flush();

    const delivered = calls.flatMap((c) => c.records.map((r) => r.seq));
    expect(delivered).toEqual([0, 1, 2]);
    expect(calls[0]!.url).toBe("https://api.mesh.test/v1/ledger/events");
    expect(calls.every((c) => c.auth === "Bearer mesh_sk_test")).toBe(true);
  });

  it("does not re-send records the server already confirmed", async () => {
    const { fetch, calls } = fakeFetch((c) => ({ status: 202, tailSeq: c.records[c.records.length - 1]!.seq }));
    const mirror = new LedgerMirror({ apiUrl: "https://api.mesh.test", accountKey: "k", fetch });
    const records = chain(2);
    for (const record of records) mirror.enqueue(record);
    await mirror.flush();
    const before = calls.length;
    mirror.enqueue(records[0]!); // a stale re-enqueue
    await mirror.flush();
    expect(calls.length).toBe(before);
  });

  it("self-heals a gap by re-sending the contiguous buffer", async () => {
    let fail = true;
    const { fetch, calls } = fakeFetch((c) => (fail ? { status: 500 } : { status: 202, tailSeq: c.records[c.records.length - 1]!.seq }));
    const mirror = new LedgerMirror({ apiUrl: "https://api.mesh.test", accountKey: "k", fetch, maxRetries: 0 });
    const records = chain(2);
    mirror.enqueue(records[0]!);
    await mirror.flush(); // fails, buffers seq 0
    fail = false;
    mirror.enqueue(records[1]!);
    await mirror.flush(); // succeeds, must send seq 0 AND 1 contiguously

    const successful = calls[calls.length - 1]!;
    expect(successful.records.map((r) => r.seq)).toEqual([0, 1]);
  });

  it("disables itself on an auth failure and stops pushing", async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 401 }));
    const mirror = new LedgerMirror({ apiUrl: "https://api.mesh.test", accountKey: "bad", fetch, maxRetries: 0 });
    const records = chain(2);
    mirror.enqueue(records[0]!);
    await mirror.flush();
    const after401 = calls.length;
    mirror.enqueue(records[1]!);
    await mirror.flush();
    expect(calls.length).toBe(after401); // no further attempts
  });

  it("never throws into the caller even when fetch rejects", async () => {
    const impl = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const mirror = new LedgerMirror({ apiUrl: "https://api.mesh.test", accountKey: "k", fetch: impl, maxRetries: 0 });
    expect(() => mirror.enqueue(chain(1)[0]!)).not.toThrow();
    await expect(mirror.flush()).resolves.toBeUndefined();
  });
});
