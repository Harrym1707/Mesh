import { describe, expect, it } from "vitest";
import { chainLedgerRecord, type BillableEvent, type LedgerRecord } from "../../core/dist/src/index.js";
import { renderLedgerReport } from "./report.js";

function event(overrides: Partial<BillableEvent>): BillableEvent {
  return {
    schemaVersion: 1,
    requestId: `r-${Math.abs(JSON.stringify(overrides).length)}-${overrides.requestId ?? ""}`,
    applicationId: "app",
    invoicePeriod: "2026-10",
    timestamp: "2026-10-20T10:00:00.000Z",
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    executionMode: "standard",
    pricingStatus: "priced",
    levers: [],
    status: "succeeded",
    ...overrides,
  };
}

function chain(events: BillableEvent[]): LedgerRecord[] {
  const records: LedgerRecord[] = [];
  for (const entry of events) {
    records.push(chainLedgerRecord(entry, records[records.length - 1]));
  }
  return records;
}

const SPOOL = chain([
  event({
    requestId: "a",
    actualUsd: 0.05,
    levers: [{ leverId: "duplicate-context-removal", kind: "lossless", savedUsd: 0.012 }],
  }),
  event({
    requestId: "b",
    actualUsd: 0.04,
    levers: [{ leverId: "cache-ttl-5m", kind: "lossless", savedUsd: -0.002 }],
  }),
  event({
    requestId: "c",
    actualUsd: 0.03,
    levers: [{ leverId: "fresh-tool-result-cap", kind: "lossy", savedUsd: 0.02 }],
  }),
  event({
    requestId: "d",
    pricingStatus: "unpriced",
    pricingReason: "model not in catalogue",
    levers: [],
  }),
]);

describe("renderLedgerReport", () => {
  it("renders the invoice's own numbers: fee, negatives shown negative, unbilled lossy itemised", () => {
    const html = renderLedgerReport([{ name: "app-anthropic.jsonl", records: SPOOL }], {
      period: "2026-10",
      feePercent: 1,
      generatedAt: "2026-10-25T12:00:00Z",
    });
    // Net = 0.012 - 0.002 (lossy unapproved never bills) = 0.010. The 1% fee on
    // that is a hundredth of a cent, so the statement bills nothing and says why.
    expect(html).toContain("$0.0100");
    expect(html).toContain(
      "Amount due: $0.0000 — do_not_charge. The 1% fee on $0.0100 net verified savings is below one cent, so nothing is billed.",
    );
    expect(html).not.toContain("Amount due: $0.0001");
    expect(html).toContain("−$0.0020");
    expect(html).toContain("no approved replay gate verdict");
    expect(html).toContain("1 unpriced (never guessed)");
    expect(html).toContain("hash chain VERIFIED");
    expect(html).toContain("mesh-verify");
    // Spend = 0.05 + 0.04 + 0.03 priced events.
    expect(html).toContain("$0.1200");
  });

  it("renders DO NOT PAY, not a number, over a tampered chain", () => {
    const tampered = JSON.parse(JSON.stringify(SPOOL)) as LedgerRecord[];
    (tampered[1]!.event.levers[0] as { savedUsd: number }).savedUsd = 99;
    const html = renderLedgerReport([{ name: "x.jsonl", records: tampered }], { generatedAt: "t" });
    expect(html).toContain("hash chain BROKEN");
    expect(html).toContain("DO NOT PAY");
    expect(html).not.toContain("Amount due: $0.99");
  });

  it("bills nothing for a do_not_charge period and says so", () => {
    const lean = chain([event({ requestId: "only", actualUsd: 0.01, levers: [] })]);
    const html = renderLedgerReport([{ name: "lean.jsonl", records: lean }], { generatedAt: "t" });
    expect(html).toContain("do_not_charge");
    expect(html).toContain("Amount due: $0.0000");
  });

  const savingSpool = (requestId: string, savedUsd: number): LedgerRecord[] => chain([event({
    requestId,
    actualUsd: 1,
    levers: [{ leverId: "duplicate-context-removal", kind: "lossless", savedUsd }],
  })]);

  it("the amount due is the fee rounded down to the cent: $21.6267 at 1% is $0.21, not $0.22", () => {
    const html = renderLedgerReport([{ name: "s.jsonl", records: savingSpool("a", 21.6267) }], { generatedAt: "t" });
    expect(html).toContain("Amount due: $0.21 (1% of $21.6267 net verified savings, rounded down to the cent)");
    expect(html).not.toContain("$0.22");
    expect(html).toContain('<div class="due ">');
  });

  it("net $9.5947 at 1% is $0.09 due, never re-rounded up to $0.10", () => {
    const html = renderLedgerReport([{ name: "s.jsonl", records: savingSpool("a", 9.5947) }], { generatedAt: "t" });
    expect(html).toContain("Amount due: $0.09 (1% of $9.5947 net verified savings, rounded down to the cent)");
    expect(html).not.toContain("Amount due: $0.10");
  });

  it("positive savings whose fee is below one cent bill nothing, and are not called a period that saved nothing", () => {
    for (const net of [0.3609, 0.99]) {
      const html = renderLedgerReport([{ name: "s.jsonl", records: savingSpool("a", net) }], { generatedAt: "t" });
      expect(html).toContain(
        `Amount due: $0.0000 — do_not_charge. The 1% fee on $${net.toFixed(4)} net verified savings is below one cent, so nothing is billed.`,
      );
      expect(html).not.toContain("saved nothing");
      expect(html).toContain('<div class="due zero">');
    }
    const first = renderLedgerReport([{ name: "s.jsonl", records: savingSpool("a", 1) }], { generatedAt: "t" });
    expect(first).toContain("Amount due: $0.01 (1% of $1.0000 net verified savings, rounded down to the cent)");
  });

  it("the fee is worked out once, on the total across spools", () => {
    // $0.60 + $0.60: neither spool alone reaches a cent of fee, the $1.20 total owes 1 cent.
    const html = renderLedgerReport([
      { name: "one.jsonl", records: savingSpool("a", 0.6) },
      { name: "two.jsonl", records: savingSpool("b", 0.6) },
    ], { generatedAt: "t" });
    expect(html).toContain("Amount due: $0.01 (1% of $1.2000 net verified savings, rounded down to the cent)");
  });

  it("labels estimated-baseline line items", () => {
    const estimated = chain([event({
      requestId: "e",
      actualUsd: 0.02,
      levers: [{ leverId: "tool-schema-compaction", kind: "lossless", savedUsd: 0.004, basis: "estimated-baseline" }],
    })]);
    const html = renderLedgerReport([{ name: "est.jsonl", records: estimated }], { generatedAt: "t" });
    expect(html).toContain("estimated-baseline");
  });
});

describe("carry-forward and waste metering on the statement", () => {
  it("applies the carried deficit to the amount due and names it", () => {
    const html = renderLedgerReport([{ name: "s.jsonl", records: SPOOL }], {
      period: "2026-10", feePercent: 1, carryForwardDeficitUsd: 0.004, generatedAt: "t",
    });
    expect(html).toContain("deficit carried in");
    expect(html).toContain("$0.0060");
    // The $0.0060 left after the deficit is positive, but its fee is below one cent.
    expect(html).toContain(
      "Amount due: $0.0000 — do_not_charge. The 1% fee on $0.0060 net verified savings (after $0.0040 deficit carried in) is below one cent, so nothing is billed.",
    );
  });

  it("bills the fee on what is left after a carried deficit, rounded down", () => {
    const spool = chain([event({
      requestId: "big",
      actualUsd: 5,
      levers: [{ leverId: "duplicate-context-removal", kind: "lossless", savedUsd: 30 }],
    })]);
    const html = renderLedgerReport([{ name: "s.jsonl", records: spool }], {
      feePercent: 1, carryForwardDeficitUsd: 8.37, generatedAt: "t",
    });
    // 30 - 8.37 = 21.63; 1% is 21.63 cents; billed 21.
    expect(html).toContain("Amount due: $0.21 (1% of $21.6300 net verified savings after $8.3700 deficit carried in, rounded down to the cent)");
  });

  it("carries a residual deficit forward and bills nothing", () => {
    const html = renderLedgerReport([{ name: "s.jsonl", records: SPOOL }], {
      period: "2026-10", feePercent: 1, carryForwardDeficitUsd: 0.5, generatedAt: "t",
    });
    expect(html).toContain("deficit carries forward");
    expect(html).toContain("Amount due: $0.0000");
  });

  it("shows the output-waste line when diagnostics are present", () => {
    const wasteSpool = chain([event({
      requestId: "w",
      actualUsd: 0.02,
      levers: [],
      outputDiagnostics: { inspectedOutputTokens: 1000, reEmittedOutputTokens: 240, reEmittedCodeTokens: 200 },
      duplicateOfRequestId: "earlier",
    })]);
    const html = renderLedgerReport([{ name: "w.jsonl", records: wasteSpool }], { generatedAt: "t" });
    expect(html).toContain("output waste observed");
    expect(html).toContain("24%");
    expect(html).toContain("1 byte-identical retried request");
    expect(html).toContain("measured, not billed");
  });
});
