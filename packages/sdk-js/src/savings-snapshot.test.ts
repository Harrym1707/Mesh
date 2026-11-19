import { describe, expect, it } from "vitest";
import { recomputeInvoice, type BillableEvent } from "../../core/dist/src/index.js";
import { formatSavingsCta, savingsBadge } from "./cta.js";
import { savingsSnapshotFromEvents } from "./savings-snapshot.js";

const saved = (requestId: string, savedUsd: number, actualUsd = 1): BillableEvent => ({
  schemaVersion: 1,
  requestId,
  applicationId: "app",
  invoicePeriod: "2026-11",
  timestamp: "2026-11-10T10:00:00.000Z",
  provider: "anthropic",
  model: "claude-sonnet-5-5",
  executionMode: "standard",
  pricingStatus: "priced",
  actualUsd,
  levers: [{ leverId: "duplicate-context-removal", kind: "lossless", savedUsd }],
  status: "succeeded",
});

describe("savings snapshot: its verdict is about savings, not about a bill", () => {
  it("real savings too small to bill are still savings: the invitation and badge do not call the stack 'already lean'", () => {
    const events = [saved("a", 0.3609)];
    // The bill owes nothing on $0.3609 at 1%...
    expect(recomputeInvoice(events, { feePercent: 1 }).verdict).toBe("do_not_charge");
    // ...but the snapshot still says money was saved, as it did before.
    const snap = savingsSnapshotFromEvents(events);
    expect(snap).toMatchObject({ requests: 1, savedUsd: 0.3609, spendUsd: 1, verdict: "charge", chainOk: true });
    const cta = formatSavingsCta(snap);
    expect(cta).toContain("saved you $0.3609");
    expect(cta).not.toContain("already lean");
    expect(savingsBadge(snap).imageUrl).not.toContain("already%20lean");
  });

  it("savings that round to nothing, zero or negative, read do_not_charge", () => {
    expect(savingsSnapshotFromEvents([saved("a", 0.0024)]).verdict).toBe("do_not_charge");
    expect(savingsSnapshotFromEvents([saved("a", 0)]).verdict).toBe("do_not_charge");
    expect(savingsSnapshotFromEvents([saved("a", -0.5)]).verdict).toBe("do_not_charge");
    expect(formatSavingsCta(savingsSnapshotFromEvents([saved("a", 0.0024)]))).toContain("already lean");
  });

  it("a broken chain or an empty spool reports nothing", () => {
    expect(savingsSnapshotFromEvents([saved("a", 5)], false)).toMatchObject({ savedUsd: 0, verdict: "do_not_charge", chainOk: false });
    expect(savingsSnapshotFromEvents([])).toMatchObject({ requests: 0, savedUsd: 0, verdict: "do_not_charge" });
  });
});
