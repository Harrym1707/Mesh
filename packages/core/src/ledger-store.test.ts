import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chainLedgerRecord, type BillableEvent, type LedgerRecord } from "./savings-ledger.js";
import { openFileLedgerStore, verifyIngestBatch } from "./ledger-store.js";

function event(requestId: string): BillableEvent {
  return {
    schemaVersion: 1,
    requestId,
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

/** Build a contiguous chain of n records starting from `previous`. */
function chain(n: number, previous?: LedgerRecord): LedgerRecord[] {
  const out: LedgerRecord[] = [];
  let prev = previous;
  for (let i = 0; i < n; i += 1) {
    const record = chainLedgerRecord(event(`req-${(previous?.seq ?? -1) + 1 + i}`), prev);
    out.push(record);
    prev = record;
  }
  return out;
}

describe("verifyIngestBatch", () => {
  it("accepts a fresh chain from genesis", () => {
    const records = chain(3);
    const result = verifyIngestBatch(undefined, records);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.newRecords).toHaveLength(3);
    expect(result.skipped).toBe(0);
    expect(result.tail.seq).toBe(2);
  });

  it("rejects a tampered event hash, naming the seq", () => {
    const records = chain(2);
    const tampered: LedgerRecord = { ...records[1]!, event: { ...records[1]!.event, actualUsd: 999 } };
    const result = verifyIngestBatch(undefined, [records[0]!, tampered]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.seq).toBe(1);
    expect(result.reason).toMatch(/eventHash/);
  });

  it("rejects a reordered batch (broken internal linkage)", () => {
    const records = chain(3);
    const result = verifyIngestBatch(undefined, [records[0]!, records[2]!, records[1]!]);
    expect(result.ok).toBe(false);
  });

  it("rejects a gap above the stored tail", () => {
    const first = chain(2);
    const tailThenGap = chain(3, first[1]); // seq 2,3,4
    const result = verifyIngestBatch({ seq: 1, eventHash: first[1]!.eventHash }, tailThenGap.slice(1)); // starts at seq 3
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/Gap/);
  });

  it("treats a resend of already-stored records as an idempotent replay", () => {
    const records = chain(3);
    const tail = { seq: 2, eventHash: records[2]!.eventHash };
    const replay = verifyIngestBatch(tail, records); // all <= tail
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.newRecords).toHaveLength(0);
    expect(replay.skipped).toBe(3);
  });

  it("stores only the genuine continuation when a batch overlaps the tail", () => {
    const records = chain(4);
    const tail = { seq: 1, eventHash: records[1]!.eventHash };
    const result = verifyIngestBatch(tail, records); // seq 0,1 replay; 2,3 new
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skipped).toBe(2);
    expect(result.newRecords.map((r) => r.seq)).toEqual([2, 3]);
  });

  it("rejects a fork: a record at the tail seq with a different hash", () => {
    const records = chain(2);
    const forked = chain(2); // independent chain, same seqs, different content via requestIds? same here
    // Force a genuinely different hash at seq 1 by re-chaining a different event.
    const altSeq1 = chainLedgerRecord(event("different"), records[0]);
    const tail = { seq: 1, eventHash: records[1]!.eventHash };
    const result = verifyIngestBatch(tail, [records[0]!, altSeq1]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/fork/i);
    void forked;
  });
});

describe("openFileLedgerStore", () => {
  it("appends new records, is idempotent on replay, and resumes the tail from disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-ledger-"));
    const store = openFileLedgerStore(dir);
    const records = chain(3);

    const first = store.append("acct_1", records);
    expect(first.ok && first.stored).toBe(3);

    // Re-sending the same batch stores nothing.
    const replay = store.append("acct_1", records);
    expect(replay.ok && replay.stored).toBe(0);
    expect(replay.ok && replay.skipped).toBe(3);

    // Continue the chain.
    const more = chain(2, records[2]);
    const second = store.append("acct_1", more);
    expect(second.ok && second.stored).toBe(2);

    expect(store.readRecords("acct_1")).toHaveLength(5);

    // A fresh store instance resumes the tail from the spool.
    const reopened = openFileLedgerStore(dir);
    expect(reopened.tail("acct_1")?.seq).toBe(4);
    const next = reopened.append("acct_1", chain(1, more[1]));
    expect(next.ok && next.stored).toBe(1);
  });

  it("rejects a broken chain and stores nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-ledger-"));
    const store = openFileLedgerStore(dir);
    const records = chain(3);
    const broken: LedgerRecord = { ...records[1]!, prevHash: "deadbeef".repeat(8) };
    const result = store.append("acct_x", [records[0]!, broken, records[2]!]);
    expect(result.ok).toBe(false);
    expect(store.readRecords("acct_x")).toHaveLength(0);
  });

  it("keeps accounts isolated in separate spools", () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-ledger-"));
    const store = openFileLedgerStore(dir);
    store.append("acct_a", chain(2));
    store.append("acct_b", chain(1));
    expect(store.readRecords("acct_a")).toHaveLength(2);
    expect(store.readRecords("acct_b")).toHaveLength(1);
  });
});
