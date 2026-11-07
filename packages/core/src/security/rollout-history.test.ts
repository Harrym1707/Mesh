import { describe, expect, it } from "vitest";
import {
  appendRolloutTransition,
  currentRolloutState,
  startRolloutHistory,
  verifyRolloutHistory,
  type RolloutRecord,
  type RolloutTransition,
} from "./rollout-history.js";

function tx(overrides: Partial<RolloutTransition> & { kind: RolloutTransition["kind"] }): RolloutTransition {
  return {
    schemaVersion: 1,
    policyId: "route-chat",
    policyDigest: "digest-v3",
    tenantId: "t1",
    actor: "user-1",
    timestamp: "2026-11-07T10:00:00.000Z",
    ...overrides,
  };
}

function history(transitions: RolloutTransition[]): RolloutRecord[] {
  let records = [startRolloutHistory(transitions[0]!)];
  for (const t of transitions.slice(1)) records = appendRolloutTransition(records, t);
  return records;
}

describe("rollout history — chaining", () => {
  it("chains transitions and verifies end to end", () => {
    const records = history([
      tx({ kind: "enable", percentage: 0 }),
      tx({ kind: "set_percentage", percentage: 25 }),
      tx({ kind: "set_percentage", percentage: 50 }),
    ]);
    expect(records.map((r) => r.seq)).toEqual([0, 1, 2]);
    expect(verifyRolloutHistory(records)).toEqual({ ok: true, length: 3 });
  });

  it("is tamper-evident: a changed percentage breaks verification at its seq", () => {
    const records = history([
      tx({ kind: "enable", percentage: 0 }),
      tx({ kind: "set_percentage", percentage: 25 }),
    ]);
    const tampered = records.map((r, i) =>
      i === 1 ? { ...r, entry: { ...r.entry, percentage: 100 } } : r,
    );
    expect(verifyRolloutHistory(tampered)).toEqual({
      ok: false,
      seq: 1,
      reason: "entryHash does not match the entry content.",
    });
  });

  it("appending does not mutate the prior chain", () => {
    const first = history([tx({ kind: "enable", percentage: 0 })]);
    const snapshot = JSON.stringify(first);
    appendRolloutTransition(first, tx({ kind: "set_percentage", percentage: 25 }));
    expect(JSON.stringify(first)).toBe(snapshot);
  });
});

describe("rollout history — validation", () => {
  it("requires a percentage for enable and set_percentage", () => {
    expect(() => startRolloutHistory(tx({ kind: "enable" }))).toThrow(/percentage between 0 and 100/);
    expect(() => startRolloutHistory(tx({ kind: "set_percentage", percentage: 150 }))).toThrow(/percentage/);
  });

  it("requires tenant scope and a cited policy digest", () => {
    expect(() => startRolloutHistory(tx({ kind: "enable", percentage: 0, tenantId: "" }))).toThrow(/tenant-scoped/);
    expect(() => startRolloutHistory(tx({ kind: "enable", percentage: 0, policyDigest: "" }))).toThrow(/policyDigest/);
  });

  it("does not require a percentage for pause/resume/rollback", () => {
    expect(() => startRolloutHistory(tx({ kind: "rollback" }))).not.toThrow();
  });
});

describe("rollout history — currentRolloutState", () => {
  it("returns undefined for an empty history", () => {
    expect(currentRolloutState([])).toBeUndefined();
  });

  it("reflects the latest percentage while active", () => {
    const records = history([
      tx({ kind: "enable", percentage: 0 }),
      tx({ kind: "set_percentage", percentage: 25 }),
      tx({ kind: "set_percentage", percentage: 50, actor: "user-2", timestamp: "2026-11-07T11:00:00.000Z" }),
    ]);
    expect(currentRolloutState(records)).toEqual({
      policyId: "route-chat",
      policyDigest: "digest-v3",
      percentage: 50,
      status: "active",
      effectivePercentage: 50,
      lastActor: "user-2",
      lastTimestamp: "2026-11-07T11:00:00.000Z",
    });
  });

  it("a pause holds the percentage but drops effective exposure to 0", () => {
    const records = history([
      tx({ kind: "enable", percentage: 0 }),
      tx({ kind: "set_percentage", percentage: 50 }),
      tx({ kind: "pause" }),
    ]);
    const state = currentRolloutState(records)!;
    expect(state.status).toBe("paused");
    expect(state.percentage).toBe(50);
    expect(state.effectivePercentage).toBe(0);
  });

  it("resume restores effective exposure to the held percentage", () => {
    const records = history([
      tx({ kind: "enable", percentage: 50 }),
      tx({ kind: "pause" }),
      tx({ kind: "resume" }),
    ]);
    const state = currentRolloutState(records)!;
    expect(state.status).toBe("active");
    expect(state.effectivePercentage).toBe(50);
  });

  it("a rollback ends the rollout with 0 effective exposure", () => {
    const records = history([
      tx({ kind: "enable", percentage: 50 }),
      tx({ kind: "rollback", reason: "quality regression" }),
    ]);
    const state = currentRolloutState(records)!;
    expect(state.status).toBe("rolled_back");
    expect(state.effectivePercentage).toBe(0);
    expect(state.percentage).toBe(50);
  });

  it("tracks the exposed signed digest across a version bump", () => {
    const records = history([
      tx({ kind: "enable", percentage: 25, policyDigest: "digest-v3" }),
      tx({ kind: "set_percentage", percentage: 25, policyDigest: "digest-v4" }),
    ]);
    expect(currentRolloutState(records)!.policyDigest).toBe("digest-v4");
  });
});
