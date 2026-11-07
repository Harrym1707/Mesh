import { describe, expect, it } from "vitest";
import { recomputeInvoice, type BillableEvent } from "./savings-ledger.js";
import { groupWorkflowSessions } from "./workflow-sessions.js";

function event(
  requestId: string,
  timestamp: string,
  overrides: Partial<BillableEvent> = {},
): BillableEvent {
  return {
    schemaVersion: 1,
    applicationId: "app",
    invoicePeriod: "2026-10",
    timestamp,
    provider: "openai",
    model: "gpt-5",
    executionMode: "standard",
    pricingStatus: "priced",
    levers: [{ leverId: "execution-tier-flex", kind: "tier", savedUsd: 1 }],
    status: "succeeded",
    requestId,
    ...overrides,
  };
}

describe("groupWorkflowSessions", () => {
  it("splits one app's stream into sessions on an activity gap beyond gapMinutes", () => {
    const events = [
      event("a", "2026-10-13T10:00:00.000Z"),
      event("b", "2026-10-13T10:05:00.000Z"), // +5m → same session
      event("c", "2026-10-13T11:00:00.000Z"), // +55m → new session (gap 30m)
    ];
    const sessions = groupWorkflowSessions(events, { gapMinutes: 30 });
    expect(sessions).toHaveLength(2);
    // Most-recent first.
    expect(sessions[0]!.requests).toBe(1);
    expect(sessions[1]!.requests).toBe(2);
    expect(sessions[1]!.startedAt).toBe("2026-10-13T10:00:00.000Z");
    expect(sessions[1]!.endedAt).toBe("2026-10-13T10:05:00.000Z");
  });

  it("separates sessions by applicationId even when interleaved in time", () => {
    const events = [
      event("a1", "2026-10-13T10:00:00.000Z", { applicationId: "cli" }),
      event("b1", "2026-10-13T10:01:00.000Z", { applicationId: "web" }),
      event("a2", "2026-10-13T10:02:00.000Z", { applicationId: "cli" }),
    ];
    const sessions = groupWorkflowSessions(events);
    expect(sessions).toHaveLength(2);
    const byApp = Object.fromEntries(sessions.map((s) => [s.applicationId, s]));
    expect(byApp.cli!.requests).toBe(2);
    expect(byApp.web!.requests).toBe(1);
  });

  it("per-session savings match recomputeInvoice over exactly that session's events", () => {
    const first = [
      event("a", "2026-10-13T10:00:00.000Z", { levers: [{ leverId: "execution-tier-flex", kind: "tier", savedUsd: 1.25 }] }),
      event("b", "2026-10-13T10:01:00.000Z", { levers: [{ leverId: "exact-response-cache", kind: "exact_cache", savedUsd: 0.4 }] }),
    ];
    const sessions = groupWorkflowSessions(first, { gapMinutes: 30 });
    expect(sessions).toHaveLength(1);
    const expected = recomputeInvoice(first);
    expect(sessions[0]!.netVerifiedSavingsUsd).toBe(expected.netVerifiedSavingsUsd);
    expect(sessions[0]!.verdict).toBe(expected.verdict);
    // Every billable line item surfaces as a session lever.
    expect(sessions[0]!.levers.map((l) => l.leverId).sort())
      .toEqual(expected.lineItems.map((l) => l.leverId).sort());
  });

  it("counts succeeded vs failed requests per session", () => {
    const events = [
      event("a", "2026-10-13T10:00:00.000Z"),
      event("b", "2026-10-13T10:01:00.000Z", { status: "failed", levers: [] }),
    ];
    const [session] = groupWorkflowSessions(events);
    expect(session!.succeeded).toBe(1);
    expect(session!.failed).toBe(1);
    expect(session!.requests).toBe(2);
  });

  it("honours the limit and is deterministic", () => {
    const events = [
      event("a", "2026-10-13T10:00:00.000Z"),
      event("b", "2026-10-13T11:00:00.000Z"),
      event("c", "2026-10-13T12:00:00.000Z"),
    ];
    const limited = groupWorkflowSessions(events, { gapMinutes: 30, limit: 2 });
    expect(limited).toHaveLength(2); // three gap-split sessions, capped to 2 most-recent
    expect(groupWorkflowSessions(events, { gapMinutes: 30 })).toEqual(groupWorkflowSessions(events, { gapMinutes: 30 }));
  });

  it("returns nothing for an empty ledger", () => {
    expect(groupWorkflowSessions([])).toEqual([]);
  });
});
