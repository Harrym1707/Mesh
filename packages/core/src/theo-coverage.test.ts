import { describe, expect, it } from "vitest";
import type { TokenPrice } from "./cost.js";
import { WORKLOAD_ARCHETYPES, leversFor } from "./savings-model.js";
import { coverageForProfile } from "./theo-coverage.js";

const cachingPrice: TokenPrice = { inputPerMillion: 1, cachedInputPerMillion: 0.1, outputPerMillion: 10 };

describe("coverageForProfile", () => {
  it("reports the structural gaps on a tool-heavy workload: the two architecture levers plus the held Tool Search lever", () => {
    const report = coverageForProfile(WORKLOAD_ARCHETYPES.toolHeavyAgent!, cachingPrice);

    // On a tool-heavy workload the levers the proxy does not apply by default are
    // the two agent re-architectures (code-mode, progressive-disclosure) and
    // tool-search-defer, which the proxy CAN apply but holds for its live gate.
    const gapIds = report.gaps.map((g) => g.leverId).sort();
    expect(gapIds).toEqual(["code-mode", "progressive-disclosure", "tool-search-defer"]);

    for (const gap of report.gaps) {
      expect(gap.applicable).toBe(true);
      expect(gap.applied).toBe(false);
      // Headroom is shown, but as a projection — it must be a finite number.
      expect(Number.isFinite(gap.projectedSavingUsd)).toBe(true);
    }

    // The two architecture gaps say the customer must rebuild the agent.
    for (const id of ["code-mode", "progressive-disclosure"]) {
      expect(report.gaps.find((g) => g.leverId === id)!.reason).toMatch(/[Aa]rchitecture change/);
    }
    // The Tool Search gap is held for the gate, NOT an architecture change.
    const held = report.gaps.find((g) => g.leverId === "tool-search-defer")!;
    expect(held.reason).toMatch(/[Hh]eld for the live gate/);
    expect(held.reason).not.toMatch(/[Aa]rchitecture change/);
  });

  it("coverage counts applied over applicable, and every applied lever is a real leversFor lever", () => {
    const report = coverageForProfile(WORKLOAD_ARCHETYPES.toolHeavyAgent!, cachingPrice);
    const appliedByTheo = new Set(leversFor(WORKLOAD_ARCHETYPES.toolHeavyAgent!).map((l) => l.id));

    const appliedInReport = report.levers.filter((l) => l.applied).map((l) => l.leverId);
    for (const id of appliedInReport) expect(appliedByTheo.has(id)).toBe(true);

    expect(report.appliedLevers).toBe(appliedInReport.length);
    expect(report.leverCoveragePercent).toBeCloseTo(
      (report.appliedLevers / report.applicableLevers) * 100,
      6,
    );
    expect(report.appliedLevers).toBeLessThan(report.applicableLevers); // the architecture gaps + the held Tool Search lever
  });

  it("splits the realized saving into live-now (deterministic) and held-for-replay", () => {
    const report = coverageForProfile(WORKLOAD_ARCHETYPES.toolHeavyAgent!, cachingPrice);
    expect(report.realizedDeterministicPercent).toBeGreaterThan(0);
    expect(report.realizedNeedsVerificationPercent).toBeGreaterThan(0);
    // The two parts cannot exceed the whole realized saving.
    expect(report.realizedDeterministicPercent + report.realizedNeedsVerificationPercent)
      .toBeLessThanOrEqual(report.realizedSavingPercent + 1e-6);
  });

  it("a RAG workload with no tools marks the tool-schema levers not applicable, not as gaps", () => {
    const report = coverageForProfile(WORKLOAD_ARCHETYPES.ragDocumentQa!, cachingPrice);
    const toolLever = report.levers.find((l) => l.leverId === "tool-schema-compaction")!;
    expect(toolLever.applicable).toBe(false);
    // The tool-catalogue levers only target tool schemas, so with no tools they are not gaps here.
    expect(report.gaps.map((g) => g.leverId)).not.toContain("code-mode");
    expect(report.gaps.map((g) => g.leverId)).not.toContain("progressive-disclosure");
    expect(report.gaps.map((g) => g.leverId)).not.toContain("tool-search-defer");
  });

  it("is deterministic: the same inputs produce an identical report", () => {
    const a = coverageForProfile(WORKLOAD_ARCHETYPES.supportAssistant!, cachingPrice);
    const b = coverageForProfile(WORKLOAD_ARCHETYPES.supportAssistant!, cachingPrice);
    expect(a).toEqual(b);
  });
});
