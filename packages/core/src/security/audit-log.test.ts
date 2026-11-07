import { describe, expect, it } from "vitest";
import {
  appendAuditEvent,
  filterAuditLog,
  startAuditLog,
  verifyAuditLog,
  type AuditEvent,
  type AuditRecord,
} from "./audit-log.js";
import { chainEntryHash } from "./hash-chain.js";

function evt(overrides: Partial<AuditEvent> & { action: AuditEvent["action"] }): AuditEvent {
  return {
    schemaVersion: 1,
    timestamp: "2026-11-07T10:00:00.000Z",
    tenantId: "tenant-a",
    actor: "user-1",
    outcome: "succeeded",
    ...overrides,
  };
}

function buildLog(events: AuditEvent[]): AuditRecord[] {
  let records = [startAuditLog(events[0]!)];
  for (const event of events.slice(1)) records = appendAuditEvent(records, event);
  return records;
}

describe("audit log", () => {
  it("chains events and verifies a well-formed log end to end", () => {
    const records = buildLog([
      evt({ action: "policy.publish", policyId: "p1", target: "p1@3" }),
      evt({ action: "rollout.change", policyId: "p1", metadata: { percentage: 25 } }),
      evt({ action: "rollout.rollback", policyId: "p1", outcome: "succeeded" }),
    ]);
    expect(records.map((r) => r.seq)).toEqual([0, 1, 2]);
    expect(records[0]!.prevHash).toBe("0".repeat(64));
    expect(records[1]!.prevHash).toBe(records[0]!.entryHash);
    expect(verifyAuditLog(records)).toEqual({ ok: true, length: 3 });
  });

  it("is append-only: appending never mutates the prior chain", () => {
    const first = buildLog([evt({ action: "policy.publish", policyId: "p1" })]);
    const snapshot = JSON.stringify(first);
    const extended = appendAuditEvent(first, evt({ action: "rollout.change", policyId: "p1" }));
    expect(JSON.stringify(first)).toBe(snapshot);
    expect(extended).toHaveLength(2);
    expect(first).toHaveLength(1);
  });

  it("detects a tampered event and names the exact seq", () => {
    const records = buildLog([
      evt({ action: "policy.publish", policyId: "p1" }),
      evt({ action: "access.grant", target: "role:admin" }),
      evt({ action: "rollout.change", policyId: "p1" }),
    ]);
    // Flip the outcome of record 1 without recomputing its hash.
    const tampered = records.map((r, i) =>
      i === 1 ? { ...r, entry: { ...r.entry, outcome: "denied" as const } } : r,
    );
    const result = verifyAuditLog(tampered);
    expect(result).toEqual({ ok: false, seq: 1, reason: "entryHash does not match the entry content." });
  });

  it("detects a reordered log", () => {
    const records = buildLog([
      evt({ action: "policy.publish", policyId: "p1" }),
      evt({ action: "rollout.change", policyId: "p1" }),
    ]);
    const reordered = [records[1]!, records[0]!];
    const result = verifyAuditLog(reordered);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.seq).toBe(1);
  });

  it("detects a dropped record in the middle", () => {
    const records = buildLog([
      evt({ action: "policy.publish", policyId: "p1" }),
      evt({ action: "rollout.change", policyId: "p1" }),
      evt({ action: "rollout.rollback", policyId: "p1" }),
    ]);
    const withHole = [records[0]!, records[2]!];
    const result = verifyAuditLog(withHole);
    expect(result.ok).toBe(false);
    // seq 2 at index 1: position mismatch catches the hole.
    if (!result.ok) expect(result.seq).toBe(2);
  });

  it("hashes are stable regardless of object key order", () => {
    const a = chainEntryHash(0, "0".repeat(64), { b: 2, a: 1 });
    const b = chainEntryHash(0, "0".repeat(64), { a: 1, b: 2 });
    expect(a).toBe(b);
  });

  it("rejects events that are not tenant-scoped", () => {
    expect(() => startAuditLog(evt({ action: "policy.publish", tenantId: "" }))).toThrow(/tenant-scoped/);
  });

  it("rejects an invalid timestamp and a missing actor", () => {
    expect(() => startAuditLog(evt({ action: "policy.publish", timestamp: "not-a-date" }))).toThrow(/timestamp/);
    expect(() => startAuditLog(evt({ action: "policy.publish", actor: "" }))).toThrow(/actor/);
  });

  it("filters by tenant, policy, action, outcome and time window", () => {
    const records = buildLog([
      evt({ action: "policy.publish", tenantId: "tenant-a", policyId: "p1", timestamp: "2026-11-07T09:00:00.000Z" }),
      evt({ action: "rollout.change", tenantId: "tenant-a", policyId: "p1", timestamp: "2026-11-07T10:00:00.000Z" }),
      evt({ action: "rollout.change", tenantId: "tenant-b", policyId: "p9", timestamp: "2026-11-07T11:00:00.000Z" }),
      evt({ action: "access.grant", tenantId: "tenant-a", outcome: "denied", timestamp: "2026-11-07T12:00:00.000Z" }),
    ]);

    expect(filterAuditLog(records, { tenantId: "tenant-a" })).toHaveLength(3);
    expect(filterAuditLog(records, { tenantId: "tenant-b" })).toHaveLength(1);
    expect(filterAuditLog(records, { policyId: "p1" })).toHaveLength(2);
    expect(filterAuditLog(records, { action: "rollout.change" })).toHaveLength(2);
    expect(filterAuditLog(records, { outcome: "denied" })).toHaveLength(1);

    const windowed = filterAuditLog(records, {
      since: "2026-11-07T10:00:00.000Z",
      until: "2026-11-07T12:00:00.000Z",
    });
    // 10:00 inclusive, 12:00 exclusive -> the 10:00 and 11:00 events.
    expect(windowed).toHaveLength(2);
    expect(windowed.map((r) => r.entry.timestamp)).toEqual([
      "2026-11-07T10:00:00.000Z",
      "2026-11-07T11:00:00.000Z",
    ]);
  });
});
