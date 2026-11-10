import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LabLedger, DuplicateLeadError, fingerprint } from "./ledger.js";
import { assertCan, can, PermissionError } from "./permissions.js";
import { runContinuous, runToQuiescence, step } from "./orchestrator.js";
import { scoutDispatch } from "./agents/scout.js";
import { researchRun } from "./agents/research.js";
import {
  checkContentBlind,
  checkAvoidsCustomerAppChanges,
  DEFAULT_MAX_QUALITY_DEGRADATION,
} from "./constraints.js";
import { fleetSavings } from "./workloads.js";
import { qualifyOnCaptures } from "./captures.js";
import type { OptimisationLead } from "./types.js";

let root: string;
let counter: number;
const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, counter++)).toISOString();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mesh-lab-test-"));
  counter = 0;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function sampleLead(overrides: Partial<OptimisationLead> = {}): OptimisationLead {
  return {
    title: "Test dedup",
    description: "x",
    category: "deduplication",
    bucket: "core",
    techniqueKey: "dedupe-repeated-blocks",
    source: { kind: "test", reference: "t", discoveredBy: "scout", discoveredAt: now() },
    hypothesis: "removing duplicates is lossless",
    controlSurface: "deduplication",
    featureInputs: ["structural-counts", "token-counts"],
    changesCustomerApplication: false,
    expectedTokenReductionPercent: 25,
    techniqueId: "dedupe-repeated-blocks",
    defaultParams: { minimumBlockTokens: 20 },
    datasetFixtureId: "rag-duplicate-passages",
    ...overrides,
  };
}

describe("permissions", () => {
  it("gives each role only its narrow capabilities", () => {
    expect(can("scout", "lead:create")).toBe(true);
    expect(can("builder", "record:build")).toBe(true);
    // The Builder may never promote, and is logically separate from the Evaluator.
    expect(can("builder", "record:promote")).toBe(false);
    expect(can("builder", "record:evaluate")).toBe(false);
    expect(can("maintainer", "record:promote")).toBe(true);
    expect(() => assertCan("builder", "record:promote")).toThrow(PermissionError);
  });
});

describe("constraints", () => {
  it("fails content-blind for a lead declaring raw content", () => {
    const check = checkContentBlind(
      sampleLead({ featureInputs: [], declaredForbiddenInputs: ["raw-prompt"] }),
    );
    expect(check.passed).toBe(false);
  });
  it("rejects customer-application changes", () => {
    expect(checkAvoidsCustomerAppChanges(sampleLead({ changesCustomerApplication: true })).passed).toBe(false);
  });
  it("defaults to a 2% quality ceiling", () => {
    expect(DEFAULT_MAX_QUALITY_DEGRADATION).toBe(0.02);
  });
});

describe("ledger", () => {
  it("creates a lead and records a hash-chained discovery event", () => {
    const ledger = new LabLedger(root, { now });
    const record = ledger.createLead("scout", sampleLead());
    expect(record.id).toBe("OPT-0001");
    expect(record.status).toBe("discovered");
    const integrity = ledger.verifyIntegrity();
    expect(integrity.ok).toBe(true);
  });

  it("blocks a duplicate idea and requires a new reason to reopen a settled one", () => {
    const ledger = new LabLedger(root, { now });
    ledger.createLead("scout", sampleLead());
    // Same fingerprint, still in flight -> blocked.
    expect(() => ledger.createLead("scout", sampleLead())).toThrow(DuplicateLeadError);
  });

  it("enforces the capability required by the record's current stage", () => {
    const ledger = new LabLedger(root, { now });
    const record = ledger.createLead("scout", sampleLead());
    // A builder cannot perform the research-stage transition out of 'discovered'.
    expect(() => ledger.advance("builder", record.id, "designed", {}, "nope")).toThrow(PermissionError);
  });

  it("detects tampering in the audit trail", () => {
    const ledger = new LabLedger(root, { now });
    ledger.createLead("scout", sampleLead());
    const eventsPath = join(root, "events.jsonl");
    const tampered = readFileSync(eventsPath, "utf8").replace("deduplication", "routing");
    writeFileSync(eventsPath, tampered);
    const integrity = ledger.verifyIntegrity();
    expect(integrity.ok).toBe(false);
  });

  it("only the maintainer may write to the portfolio", () => {
    const ledger = new LabLedger(root, { now });
    expect(() =>
      ledger.addToPortfolio("builder", {
        id: "OPT-0001",
        title: "x",
        category: "deduplication",
        controlSurface: "deduplication",
        params: {},
        measuredTokenReductionPercent: 1,
        measuredCostReductionPercent: 1,
        measuredQualityDelta: 0,
        promotedAt: now(),
        justification: "x",
        codeLinks: [],
      }),
    ).toThrow(PermissionError);
  });
});

describe("scout", () => {
  it("discovers catalogue leads and skips ones already in the ledger", () => {
    const ledger = new LabLedger(root, { now });
    const first = scoutDispatch(ledger, { now });
    expect(first.created.length).toBeGreaterThan(0);
    const second = scoutDispatch(ledger, { now });
    expect(second.created.length).toBe(0);
    expect(second.skipped.length).toBeGreaterThan(0);
  });
});

describe("continuous scouting", () => {
  it("generates parameter-sweep leads once the catalogue is drained", () => {
    const ledger = new LabLedger(root, { now });
    // Drain the catalogue (no generation).
    while (scoutDispatch(ledger, { now }).created.length > 0) {
      /* keep discovering catalogue leads */
    }
    const before = ledger.listRecords().length;
    const generated = scoutDispatch(ledger, { now, generate: true });
    expect(generated.generated).toBeGreaterThan(0);
    expect(generated.created.length).toBe(generated.generated);
    expect(ledger.listRecords().length).toBeGreaterThan(before);
    // Generated leads are real, content-blind, runnable variants.
    const variant = ledger.listRecords().find((r) => r.techniqueKey.includes("@minimumBlockTokens="));
    expect(variant).toBeDefined();
    expect(variant!.lead!.changesCustomerApplication).toBe(false);
  });

  it("runs the loop continuously to quiescence and keeps the audit trail intact", async () => {
    const ledger = new LabLedger(root, { now });
    const noSleep = async () => {};
    const summary = await runContinuous(ledger, { now, sleep: noSleep, intervalMs: 0, maxIdleTicks: 3, maxTicks: 2000 });
    expect(summary.stoppedIdle).toBe(true); // stopped because nothing was left to do
    expect(summary.integrity.ok).toBe(true);
    // It explored beyond the seed catalogue: more records than the catalogue holds.
    expect(ledger.listRecords().length).toBeGreaterThan(12);
    // A tuned variant was measured and promoted alongside the seed winners.
    const promotedVariant = ledger
      .listRecords({ status: "promoted" })
      .find((r) => r.techniqueKey.includes("@minimumBlockTokens="));
    expect(promotedVariant).toBeDefined();
    expect(promotedVariant!.evaluation!.tokenReductionPercent).toBeGreaterThan(0);
  });

  it("honours maxTicks as a hard cap", async () => {
    const ledger = new LabLedger(root, { now });
    const noSleep = async () => {};
    const summary = await runContinuous(ledger, { now, sleep: noSleep, maxTicks: 3, maxIdleTicks: 99 });
    expect(summary.ticks).toBe(3);
  });
});

describe("end-to-end pipeline", () => {
  it("runs Scout -> Research -> Design -> Build -> Red Team -> Evaluate -> Maintain to quiescence", () => {
    const ledger = new LabLedger(root, { now });
    const summary = runToQuiescence(ledger, { now });

    // Every outcome path is exercised by the seed catalogue.
    expect(summary.statusCounts.promoted).toBeGreaterThanOrEqual(1);
    expect(summary.statusCounts.rejected).toBeGreaterThanOrEqual(1);
    expect(summary.statusCounts.inconclusive).toBeGreaterThanOrEqual(1);
    expect(summary.integrity.ok).toBe(true);

    // No record is left mid-pipeline.
    const records = ledger.listRecords();
    expect(records.every((r) => ["promoted", "rejected", "failed", "inconclusive"].includes(r.status))).toBe(true);
  });

  it("measures a real token reduction with zero quality drop for lossless dedup", () => {
    const ledger = new LabLedger(root, { now });
    runToQuiescence(ledger, { now });
    const dedup = ledger.listRecords({ category: "deduplication" }).find((r) => r.status === "promoted");
    expect(dedup).toBeDefined();
    expect(dedup!.evaluation!.verdict).toBe("PASS");
    expect(dedup!.evaluation!.tokenReductionPercent).toBeGreaterThan(20);
    expect(dedup!.evaluation!.qualityDelta).toBe(0);
    // Promotion requires the quality drop to be within the 2% ceiling.
    expect(dedup!.evaluation!.qualityDelta).toBeLessThanOrEqual(DEFAULT_MAX_QUALITY_DEGRADATION);
  });

  it("promotes only through the maintainer and populates the portfolio", () => {
    const ledger = new LabLedger(root, { now });
    runToQuiescence(ledger, { now });
    const portfolio = ledger.readPortfolio();
    expect(portfolio.levers.length).toBe(summaryPromotedCount(ledger));
    for (const lever of portfolio.levers) {
      expect(lever.measuredTokenReductionPercent).toBeGreaterThan(0);
    }
  });

  it("rejects a content-blind-violating idea at Research (never reaches build)", () => {
    const ledger = new LabLedger(root, { now });
    runToQuiescence(ledger, { now });
    const rejected = ledger.listRecords({ status: "rejected" });
    expect(rejected.length).toBeGreaterThanOrEqual(1);
    for (const r of rejected) {
      expect(r.build).toBeUndefined();
      expect(r.compatibility!.verdict).toBe("rejected");
    }
  });

  it("evaluates a spec-only lead as INCONCLUSIVE", () => {
    const ledger = new LabLedger(root, { now });
    runToQuiescence(ledger, { now });
    const inconclusive = ledger.listRecords({ status: "inconclusive" });
    expect(inconclusive.length).toBeGreaterThanOrEqual(1);
    for (const r of inconclusive) expect(r.evaluation!.verdict).toBe("INCONCLUSIVE");
  });
});

describe("agentic workflows", () => {
  it("promotes agentic levers and covers all three traffic verticals", () => {
    const ledger = new LabLedger(root, { now });
    runToQuiescence(ledger, { now });
    const promotedKeys = ledger.listRecords({ status: "promoted" }).map((r) => r.techniqueKey);
    // The highest-priority verticals produce measured wins, not just one-shot.
    expect(promotedKeys).toContain("minify-tool-schemas"); // autonomous-agent
    expect(promotedKeys).toContain("agent-history-prefix-dedup"); // always-on-agent

    const coverage = ledger.coverageByShape();
    expect(coverage["always-on-agent"].promoted).toBeGreaterThanOrEqual(1);
    expect(coverage["autonomous-agent"].promoted).toBeGreaterThanOrEqual(1);
    expect(coverage["one-shot"].total).toBeGreaterThan(0);
  });

  it("ranks agentic leads ahead of one-shot when discovery is budget-limited", () => {
    const ledger = new LabLedger(root, { now });
    // A single-lead dispatch should pick an agentic shape first.
    const result = scoutDispatch(ledger, { now, count: 1 });
    const picked = ledger.getRecord(result.created[0]!)!;
    expect(picked.lead!.shape).not.toBe("one-shot");
  });
});

describe("fleet % saved for the end user", () => {
  it("rolls the promoted portfolio into a blended saving across the consumer mix", () => {
    const ledger = new LabLedger(root, { now });
    runToQuiescence(ledger, { now });
    const fleet = fleetSavings(ledger);

    expect(fleet.fleetPercentSaved).toBeGreaterThan(10);
    const byDomain = Object.fromEntries(fleet.workloads.map((w) => [w.domain, w]));
    // The biggest token-billed consumer workloads show proven savings.
    expect(byDomain.chat.savingsPercent).toBeGreaterThan(0);
    expect(byDomain["coding-agent"].savingsPercent).toBeGreaterThan(0);
    expect(byDomain["always-on-agent"].savingsPercent).toBeGreaterThan(0);
    // Image/video are parked, not addressed (founder decision), never faked.
    expect(byDomain["image-gen"].addressable).toBe("parked-advisory-only");
    expect(byDomain["image-gen"].savingsPercent).toBe(0);
    // Reasoning is the acknowledged output-side frontier: 0% proven so far.
    expect(byDomain.reasoning.savingsPercent).toBe(0);
    // Spend weights are a coherent mix.
    expect(fleet.workloads.reduce((s, w) => s + w.spendShare, 0)).toBeCloseTo(1, 5);
  });
});

describe("qualification on real wire captures", () => {
  it("replays the captures through the product reducer + cache model", () => {
    const q = qualifyOnCaptures();
    expect(q.basis).toBe("derived-from-captures");
    expect(q.sessions.length).toBeGreaterThanOrEqual(6);
    for (const session of q.sessions) {
      // A lever may never make a real session cost more.
      for (const arm of Object.values(session.arms)) expect(arm.savingPercent).toBeGreaterThanOrEqual(0);
    }
  });

  it("documents the honest floor: lossless levers add almost nothing on well-built traffic", () => {
    const q = qualifyOnCaptures();
    // Small (< cache minimum) and already-cached traffic: the constructed-fixture
    // numbers must NOT be read as a real-traffic saving. If this starts failing
    // upward, a lever genuinely improved on real captures — update the floor.
    expect(q.totals.text.savingPercent).toBeLessThan(5);
    expect(q.totals.stamp.savingPercent).toBeLessThan(5);
  });

  it("never credits Mesh for caching the customer already has", () => {
    const q = qualifyOnCaptures();
    const customerCached = q.sessions.filter((s) => s.baselinePolicy === "anthropic-ephemeral-5m");
    expect(customerCached.length).toBeGreaterThan(0);
    for (const session of customerCached) expect(session.arms.stamp.savingPercent).toBeLessThan(1);
  });

  it("exposes the volatile-prefix opportunity the captures contain", () => {
    const lite = qualifyOnCaptures().sessions.filter((s) => s.capture.startsWith("litellm"));
    const [volatile, stable] = lite;
    // Same prompt, same stamps — a clock at the head of the prefix makes it far dearer.
    expect(volatile!.baselineCostUsd).toBeGreaterThan(stable!.baselineCostUsd * 2);
  });
});

describe("learning", () => {
  it("tallies category outcomes to steer future research", () => {
    const ledger = new LabLedger(root, { now });
    runToQuiescence(ledger, { now });
    const outcomes = ledger.categoryOutcomes();
    expect(outcomes.deduplication.promoted).toBeGreaterThanOrEqual(1);
    expect(outcomes.other.rejected).toBeGreaterThanOrEqual(1);
  });
});

describe("orchestrator stepping", () => {
  it("advances exactly one unit of work per step and finishes in-flight work before scouting", () => {
    const ledger = new LabLedger(root, { now });
    const first = step(ledger, { now });
    expect(first.action).toBe("scout"); // nothing in flight -> discover
    const second = step(ledger, { now });
    expect(second.action).toBe("advance"); // now process the furthest-along record
  });

  it("research validates a clean lead and rejects an invalid one", () => {
    const ledger = new LabLedger(root, { now });
    const good = ledger.createLead("scout", sampleLead());
    const bad = ledger.createLead(
      "scout",
      sampleLead({
        title: "bad",
        category: "other",
        techniqueKey: "customer-rewrite",
        changesCustomerApplication: true,
        featureInputs: [],
        declaredForbiddenInputs: ["raw-prompt"],
        techniqueId: undefined,
        datasetFixtureId: undefined,
      }),
    );
    expect(researchRun(ledger, ledger.getRecord(good.id)!).status).toBe("designed");
    expect(researchRun(ledger, ledger.getRecord(bad.id)!).status).toBe("rejected");
  });
});

function summaryPromotedCount(ledger: LabLedger): number {
  return ledger.listRecords({ status: "promoted" }).length;
}
