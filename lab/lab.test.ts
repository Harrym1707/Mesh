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
import { GATE_REQUIRED_ARMS, qualifyOnCaptures } from "./captures.js";
import { repairBlockArraySystem } from "./experiments/block-array-repair.js";
import { qualifyPayingShape } from "./paying-shape.js";
import { cadenceSweep, sessionLengthSweep } from "./sweeps.js";
import { harnessEvidence } from "./evidence.js";
import { guardStudy, liveResidual, priceSession, stampStudy } from "./live-study.js";
import { SpanKeyedStamper } from "./experiments/span-keyed-stamp.js";
import { LegacyVolatilityGuard } from "./experiments/legacy-guard.js";
import { browsingArm, browsingSession, priceBrowsing, qualifyBrowsingShape } from "./browsing-shape.js";
import {
  SUPERSEDED_STUB,
  dedupeStaleSnapshotLines,
  isPageSnapshot,
  maskRef,
  moveBreakpointBeforeFreshSnapshot,
  supersedeStaleSnapshots,
} from "./experiments/page-snapshots.js";
import {
  LIVE_CODING_CONFIG,
  LIVE_MODEL,
  LIVE_PREAMBLE,
  liveCodingAgentRequests,
  liveSupportChatRequests,
} from "./live-shapes.js";
import { reduceRequest } from "../packages/sdk-js/src/reduce-request.js";
import { CachePrefixVolatilityGuard } from "../packages/sdk-js/src/cache-volatility-guard.js";
import { isTerminal } from "./types.js";
import { readLiveNumbers } from "./numbers.js";
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
    expect(records.every((r) => isTerminal(r.status))).toBe(true);
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

  it("block-array repair recovers the volatile session and touches nothing else", () => {
    const q = qualifyOnCaptures();
    const [volatile, stable] = q.sessions.filter((s) => s.capture.startsWith("litellm"));
    expect(volatile!.arms.blockRepair.savingPercent).toBeGreaterThan(60);
    // It brings the volatile session close to what the stable one already pays.
    expect(volatile!.arms.blockRepair.costUsd).toBeLessThan(stable!.baselineCostUsd * 1.2);
    expect(stable!.arms.blockRepair.savingPercent).toBeLessThan(1);
    for (const session of q.sessions.filter((s) => s.capture.startsWith("frameworks"))) {
      expect(session.arms.blockRepair.savingPercent).toBeCloseTo(session.arms.stampRepair.savingPercent, 5);
    }
    // Gate-required arms are never folded into the lossless floor.
    expect(GATE_REQUIRED_ARMS).toContain("blockRepair");
    expect(q.totals.stamp.savingPercent).toBeLessThan(5);
  });
});

describe("paying-shape tier (repo agent fixture, simulated grader)", () => {
  const result = qualifyPayingShape();

  it("reproduces the SIMULATOR rows recorded in docs/NUMBERS.md", () => {
    // If these drift, either the fixture changed or docs/NUMBERS.md needs reconciling.
    expect(result.cacheContributionPercent).toBeCloseTo(37.9, 1);
    expect(result.arms.at(-1)!.savingPercent).toBeCloseTo(57.3, 1);
    expect(result.basis).toBe("SIMULATOR");
  });

  it("the lossless arm saves on the paying shape with zero quality loss", () => {
    const lossless = result.arms.find((arm) => arm.lossless)!;
    expect(lossless.cleanTasks).toBe(lossless.totalTasks);
    expect(lossless.qualityDrop).toBe(0);
    expect(lossless.savingPercent).toBeGreaterThan(20);
  });

  it("names the lever that breaks the 2% quality ceiling", () => {
    expect(result.maxQualityDegradation).toBe(DEFAULT_MAX_QUALITY_DEGRADATION);
    const full = result.arms.at(-1)!;
    expect(full.withinCeiling).toBe(false);
    expect(result.ceilingBreaker).toContain("output cap");
  });

  it("picks the best stack that stays inside the ceiling", () => {
    const best = result.bestWithinCeiling!;
    expect(best.withinCeiling).toBe(true);
    expect(best.qualityDrop).toBeLessThanOrEqual(DEFAULT_MAX_QUALITY_DEGRADATION);
    // Cleaner than the full stack, and more saving than lossless alone.
    expect(best.savingPercent).toBeLessThan(result.arms.at(-1)!.savingPercent);
    expect(best.savingPercent).toBeGreaterThan(result.arms.find((arm) => arm.lossless)!.savingPercent);
    // Savings only ever grow as levers are added.
    for (let i = 1; i < result.arms.length; i += 1) {
      expect(result.arms[i]!.savingPercent).toBeGreaterThanOrEqual(result.arms[i - 1]!.savingPercent - 1e-9);
    }
  });

  it("a looser ceiling admits the full stack", () => {
    const loose = qualifyPayingShape({ maxQualityDegradation: 0.05 });
    expect(loose.bestWithinCeiling!.id).toBe("outputCap");
    expect(loose.ceilingBreaker).toBeUndefined();
  });
});

describe("live study — what the real run still leaves on the table", () => {
  it("the replicas still match the script that produced the live spools", () => {
    const script = readFileSync(new URL("../evals/run-live-agents.ts", import.meta.url), "utf8");
    for (const fragment of [
      "Operating rule ${i}: cite sources, escalate anything risky, keep answers tight.",
      "Record ${i}: settlement entry nominal, reconciliation standard, no notification sent, annotation routine.",
      "Current time: 2026-10-13T09:0${turn}:00Z",
      "Investigate account 1009 and summarise.",
      "how do I reset my password?",
      "Look up records in subsystem ${i}. Use this for questions about topic ${i}. Returns a paginated list.",
    ]) {
      expect(script).toContain(fragment);
    }
  });

  it("LIVE: after Mesh, output is the largest part of the remaining bill", () => {
    const residual = liveResidual()!;
    for (const row of [...residual.rows, residual.total]) {
      expect(row.freshInput + row.cacheRead + row.cacheWrite + row.output).toBeCloseTo(1, 6);
    }
    expect(residual.total.output).toBeGreaterThan(0.5);
    expect(residual.rows.find((r) => r.agent === "coding-agent")!.output).toBeGreaterThan(0.5);
  });

  it("the replica reproduces the live coding agent's stamp pattern under the guard as it shipped then", () => {
    const study = guardStudy();
    expect(study.legacyStamps).toEqual([true, true, false, false, false]);
    expect(study.live!.stampPattern).toEqual(["stamped", "stamped", "suppressed", "suppressed", "suppressed"]);
    // The provider read the prefix back on turn 2 — the repaired prefix IS stable.
    expect(study.live!.provenCachedTokens).toBeGreaterThan(1024);
  });

  it("the product guard now keeps the stamp on every turn of that replica", () => {
    const study = guardStudy();
    expect(study.productStamps).toEqual([true, true, true, true, true]);
    // Same placement, same cost as the lab's first-sight arm: the experiment is in the product.
    expect(study.productCost).toBe(study.spanFirstSightCost);
    expect(study.productCost).toBeLessThan(study.legacyCost);
    expect(study.productInputSavingPercent).toBeGreaterThan(40);
  });

  it("span-keyed stamping recovers the suppressed turns", () => {
    const study = guardStudy();
    expect(study.spanOnRepeatStamps).toEqual([false, true, true, true, true]);
    expect(study.spanFirstSightStamps).toEqual([true, true, true, true, true]);
    expect(study.spanFirstSightCost).toBeLessThan(study.spanOnRepeatCost);
    expect(study.spanOnRepeatCost).toBeLessThan(study.legacyCost);
    // DERIVED-FROM-LIVE: a real share of the real bill, bounded on both sides.
    expect(study.live!.onRepeatPercentOfBill).toBeGreaterThan(10);
    expect(study.live!.firstSightPercentOfBill).toBeGreaterThan(study.live!.onRepeatPercentOfBill);
    expect(study.live!.firstSightPercentOfBill).toBeLessThan(25);
  });

  it("is lossless: it emits only bytes the product already emits, stamped or unstamped", () => {
    const { cacheTtl: _ttl, ...unstampedConfig } = LIVE_CODING_CONFIG;
    const strip = (value: unknown) => JSON.stringify(value, (key, inner) => (key === "cache_control" ? undefined : inner));
    const stamper = new SpanKeyedStamper(LIVE_CODING_CONFIG);
    for (const request of liveCodingAgentRequests()) {
      const outcome = stamper.reduce(request);
      const productStamped = reduceRequest(request, LIVE_CODING_CONFIG).request;
      const productUnstamped = reduceRequest(request, unstampedConfig).request;
      if (outcome.systemStamped) expect(strip(outcome.request)).toBe(strip(productStamped));
      else expect(outcome.request).toEqual(productUnstamped);
    }
  });

  it("never pays a write premium on a prefix that does not repeat", () => {
    // A build counter at the head of the prompt: not a timestamp or UUID, so
    // prefix repair cannot move it and the stamped span is different every turn.
    const tools = liveSupportChatRequests()[0]!.tools;
    const churning = Array.from({ length: 5 }, (_unused, i) => ({
      model: LIVE_MODEL,
      system: `Build ${i + 17}\n${LIVE_PREAMBLE}`,
      tools,
      messages: [{ role: "user", content: `question ${i}` }],
      max_tokens: 500,
    }));
    const config = { toolSchemas: true, duplicateContext: true, repairCachePrefix: true, cacheTtl: "5m" } as const;
    const onRepeat = new SpanKeyedStamper(config);
    const outcomes = churning.map((request) => onRepeat.reduce(request));
    expect(outcomes.every((o) => !o.systemStamped)).toBe(true);
    const cautious = priceSession(outcomes.map((o) => o.request));
    expect(cautious.cost).toBe(cautious.uncachedCost); // no premium, no loss
    // Stamping at first sight on the same traffic DOES lose — which is why it
    // is reserved for a route whose span is already known to repeat.
    const eager = new SpanKeyedStamper(config, { stampOnFirstSight: true });
    const eagerCost = priceSession(churning.map((request) => eager.reduce(request).request));
    expect(eagerCost.cost).toBeGreaterThan(eagerCost.uncachedCost);
  });

  it("stamps a repaired prefix even though the raw clock ticks — with a history that extends properly", () => {
    const tools = liveSupportChatRequests()[0]!.tools;
    const script = [
      { role: "user", content: "Open the incident." },
      { role: "assistant", content: "Opened. What next?" },
      { role: "user", content: "Check the error rate." },
      { role: "assistant", content: "Error rate is nominal." },
      { role: "user", content: "Close it." },
    ];
    // Turn k re-sends the first 2k+1 messages verbatim: a real, extending conversation.
    const ticking = [0, 1, 2].map((turn) => ({
      model: LIVE_MODEL,
      system: `Current time: 2026-10-13T09:0${turn}:00Z\n${LIVE_PREAMBLE}`,
      tools,
      messages: script.slice(0, turn * 2 + 1),
      max_tokens: 500,
    }));
    const config = { toolSchemas: true, duplicateContext: true, repairCachePrefix: true, cacheTtl: "5m" } as const;

    // The guard as shipped for the live run: the raw system changed, so it
    // suppresses — although repair has made the stamped span stable.
    const legacyGuard = new LegacyVolatilityGuard();
    const legacy = ticking.map(
      (request) => reduceRequest(request, { ...config, cacheVolatilityGuard: legacyGuard }).request as Record<string, unknown>,
    );
    expect(priceSession(legacy).perRequest.map((r) => r.stamped)).toEqual([true, false, false]);
    // The product guard now compares the span the breakpoint covers.
    const guard = new CachePrefixVolatilityGuard();
    const product = ticking.map(
      (request) => reduceRequest(request, { ...config, cacheVolatilityGuard: guard }).request as Record<string, unknown>,
    );
    expect(priceSession(product).perRequest.map((r) => r.stamped)).toEqual([true, true, true]);
    expect(priceSession(product).cost).toBeLessThan(priceSession(legacy).cost);

    const stamper = new SpanKeyedStamper(config, { stampOnFirstSight: true });
    const spanKeyed = priceSession(ticking.map((request) => stamper.reduce(request).request));
    expect(spanKeyed.perRequest.map((r) => r.stamped)).toEqual([true, true, true]);
    // Turns 2 and 3 read the prefix turn 1 wrote.
    expect(spanKeyed.perRequest[1]!.read).toBeGreaterThan(1024);
    expect(spanKeyed.perRequest[2]!.read).toBeGreaterThan(1024);
    expect(spanKeyed.cost).toBe(priceSession(product).cost);
  });

  it("keeps the system breakpoint when the client rewrites its history", () => {
    const tools = liveSupportChatRequests()[0]!.tools;
    // Stable tools + system, same opening message, but the rest of the history is replaced each turn.
    const rewriting = Array.from({ length: 4 }, (_unused, i) => ({
      model: LIVE_MODEL,
      system: LIVE_PREAMBLE,
      tools,
      messages: [
        { role: "user", content: "Start the session." },
        { role: "assistant", content: `Rolling summary, revision ${i}.` },
        { role: "user", content: `Next step ${i}.` },
      ],
      max_tokens: 500,
    }));
    const config = { toolSchemas: true, duplicateContext: true, cacheTtl: "5m" } as const;

    // The guard as shipped for the live run: all-or-nothing — once the history
    // stops extending, no breakpoint at all.
    const legacyGuard = new LegacyVolatilityGuard();
    const legacy = rewriting.map(
      (request) => reduceRequest(request, { ...config, cacheVolatilityGuard: legacyGuard }).request as Record<string, unknown>,
    );
    expect(priceSession(legacy).perRequest.map((r) => r.stamped)).toEqual([true, false, false, false]);
    // The product guard now withholds only the newest-message breakpoint.
    const guard = new CachePrefixVolatilityGuard();
    const product = rewriting.map(
      (request) => reduceRequest(request, { ...config, cacheVolatilityGuard: guard }).request as Record<string, unknown>,
    );
    expect(priceSession(product).perRequest.map((r) => r.stamped)).toEqual([true, true, true, true]);
    expect(product.slice(1).every((request) => !JSON.stringify(request.messages).includes("cache_control"))).toBe(true);
    expect(priceSession(product).cost).toBeLessThan(priceSession(legacy).cost);

    const stamper = new SpanKeyedStamper(config);
    const outcomes = rewriting.map((request) => stamper.reduce(request));
    expect(outcomes.map((o) => o.systemStamped)).toEqual([false, true, true, true]);
    // The history breakpoint is withheld on the turns where the history was rewritten.
    expect(outcomes.slice(1).every((o) => !o.messageStamped)).toBe(true);
    expect(priceSession(outcomes.map((o) => o.request)).cost).toBeLessThan(priceSession(legacy).cost);
  });

  it("the never-stamped support chat would have read its shared prefix", () => {
    const study = stampStudy();
    expect(study.prefixShare).toBeGreaterThan(0.8);
    expect(study.spanOnRepeatCost).toBeLessThan(study.unstampedCost);
    expect(study.live!.onRepeatPercentOfBill).toBeGreaterThan(20);
    expect(study.live!.firstSightPercentOfBill).toBeGreaterThan(study.live!.onRepeatPercentOfBill);
    // The prefix size comes from what the provider really cached, not the replica's estimate.
    expect(study.live!.prefixTokens).toBe(guardStudy().live!.provenCachedTokens);
  });

  it("the pipeline promotes it as lossless and records that the saving is a counterfactual", () => {
    const ledger = new LabLedger(root, { now });
    runToQuiescence(ledger, { now });
    const lead = ledger.listRecords().find((r) => r.techniqueKey === "span-keyed-cache-stamping")!;
    expect(lead.status).toBe("promoted");
    expect(lead.evaluation!.lossless).toBe(true);
    expect(lead.evaluation!.basis).toContain("DERIVED-FROM-LIVE");
    expect(lead.redTeam!.findings.some((f) => /counterfactual/i.test(f.description))).toBe(true);
  });
});

describe("browsing agents: stale page snapshots", () => {
  type Message = { role: string; content: Array<{ type: string; content?: string; cache_control?: unknown }> | string };
  const snapshots = (request: Record<string, unknown>): string[] =>
    (request.messages as Message[]).flatMap((message) =>
      Array.isArray(message.content)
        ? message.content.filter((block) => block.type === "tool_result").map((block) => block.content!)
        : [],
    );
  const session = browsingSession(12);
  const final = session.requests.at(-1)!;

  it("recognises a snapshot by shape, for both ref styles, and nothing else", () => {
    expect(snapshots(final).every(isPageSnapshot)).toBe(true);
    expect(snapshots(browsingSession(3, { interactiveOnly: true }).requests.at(-1)!).every(isPageSnapshot)).toBe(true);
    expect(isPageSnapshot("PASS src/a.test.ts\n".repeat(20))).toBe(false);
    expect(isPageSnapshot(SUPERSEDED_STUB)).toBe(false);
  });

  it("never touches the newest snapshot — the one the agent acts on", () => {
    for (const rewrite of [dedupeStaleSnapshotLines, supersedeStaleSnapshots]) {
      for (const request of session.requests) {
        const before = snapshots(request);
        const after = snapshots(rewrite(request));
        expect(after.at(-1)).toBe(before.at(-1));
        expect(after).toHaveLength(before.length);
      }
    }
    for (const id of ["lineDedup", "supersede", "both"]) {
      expect(browsingArm(qualifyBrowsingShape(), id).freshPagesAltered).toBe(0);
    }
  });

  it("line dedup keeps every element and every piece of text the agent saw", () => {
    const original = new Set(snapshots(final).flatMap((text) => text.split("\n")).filter((l) => l.trim() !== "").map(maskRef));
    const kept = new Set(snapshots(dedupeStaleSnapshotLines(final)).flatMap((text) => text.split("\n")).map(maskRef));
    for (const line of original) expect(kept.has(line)).toBe(true);
    const arm = browsingArm(qualifyBrowsingShape(), "lineDedup");
    expect(arm.factsReadable).toBe(arm.factsTotal);
  });

  it("supersession does lose earlier page text — which is why it needs a gate", () => {
    const superseded = snapshots(supersedeStaleSnapshots(final));
    expect(superseded.slice(0, -1).every((text) => text === SUPERSEDED_STUB)).toBe(true);
    const arm = browsingArm(qualifyBrowsingShape(), "supersede");
    expect(arm.factsReadable).toBeLessThan(arm.factsTotal);
  });

  it("rewrites each older snapshot once and leaves it byte-stable, so the cache keeps extending", () => {
    for (const rewrite of [dedupeStaleSnapshotLines, supersedeStaleSnapshots]) {
      for (let index = 2; index < session.requests.length - 1; index += 1) {
        const earlier = snapshots(rewrite(session.requests[index]!));
        const later = snapshots(rewrite(session.requests[index + 1]!));
        // Everything except the snapshot that was newest last turn is unchanged.
        expect(later.slice(0, earlier.length - 1)).toEqual(earlier.slice(0, -1));
      }
      // Idempotent: running the rewrite over its own output changes nothing.
      expect(rewrite(rewrite(final))).toEqual(rewrite(final));
    }
  });

  it("moving the breakpoint changes placement only, and is what makes the rewrite pay", () => {
    const config = { toolSchemas: true, duplicateContext: true, repairCachePrefix: true, cacheTtl: "5m" } as const;
    const strip = (value: unknown) => JSON.stringify(value, (key, inner) => (key === "cache_control" ? undefined : inner));
    const stamped = session.requests.map((request) => reduceRequest(supersedeStaleSnapshots(request), config).request as Record<string, unknown>);
    const moved = stamped.map(moveBreakpointBeforeFreshSnapshot);
    moved.forEach((request, index) => expect(strip(request)).toBe(strip(stamped[index])));
    // The fresh snapshot no longer carries a marker; the block before it does.
    const last = (moved.at(-1)!.messages as Message[]).at(-1)!;
    expect(JSON.stringify(last)).not.toContain("cache_control");
    expect(JSON.stringify((moved.at(-1)!.messages as Message[]).at(-2))).toContain("cache_control");
    // With the breakpoint ON the fresh snapshot, each write is spoiled a turn later.
    expect(priceBrowsing(moved, session.outputTokens).cost).toBeLessThan(priceBrowsing(stamped, session.outputTokens).cost);
  });

  it("out of the box Mesh saves nothing on this shape; the cache flag is what pays", () => {
    const result = qualifyBrowsingShape();
    expect(browsingArm(result, "defaults").savingVsRawPercent).toBeCloseTo(0, 1);
    expect(browsingArm(result, "today").savingVsRawPercent).toBeGreaterThan(60);
    expect(browsingArm(result, "today").factsReadable).toBe(result.arms[0]!.factsTotal);
  });

  it("both Mesh arms beat today, grow with session length, and do not depend on stable refs", () => {
    const savings = (steps: number, id: string, stableRefs = true) =>
      browsingArm(qualifyBrowsingShape({ steps, stableRefs }), id).savingVsTodayPercent;
    for (const id of ["lineDedup", "supersede"]) {
      expect(savings(6, id)).toBeGreaterThan(0);
      expect(savings(12, id)).toBeGreaterThan(savings(6, id));
      expect(savings(24, id)).toBeGreaterThan(savings(12, id));
      expect(savings(12, id, false)).toBeCloseTo(savings(12, id, true), 6);
    }
    expect(savings(12, "supersede")).toBeGreaterThan(savings(12, "lineDedup"));
  });

  it("the source-side idea and Mesh's are complementary, and the generic fresh cap is unsafe here", () => {
    const result = qualifyBrowsingShape();
    const both = browsingArm(result, "both").savingVsTodayPercent;
    expect(both).toBeGreaterThan(browsingArm(result, "atSource").savingVsTodayPercent);
    expect(both).toBeGreaterThan(browsingArm(result, "supersede").savingVsTodayPercent);
    expect(browsingArm(result, "atSource").needsCustomerChange).toBe(true);
    expect(browsingArm(result, "supersede").needsCustomerChange).toBe(false);
    // The generic cap truncates every page the agent is about to act on.
    expect(browsingArm(result, "freshCap").freshPagesAltered).toBe(result.steps);
  });

  it("the pipeline rests both levers at needs_gate with quality unmeasured", () => {
    const ledger = new LabLedger(root, { now });
    runToQuiescence(ledger, { now });
    for (const key of ["stale-page-snapshot-line-dedup", "stale-page-snapshot-supersession"]) {
      const lead = ledger.listRecords().find((r) => r.techniqueKey === key)!;
      expect(lead.status).toBe("needs_gate");
      expect(lead.evaluation!.lossless).toBe(false);
      expect(lead.evaluation!.qualityUnmeasured).toBe(true);
      expect(lead.evaluation!.basis).toContain("SIMULATOR");
    }
  });
});

describe("harness evidence in the pipeline", () => {
  const byKey = (ledger: LabLedger, key: string) => ledger.listRecords().find((r) => r.techniqueKey === key)!;

  it("rests a lossy lever with a measured saving at needs_gate — never promoted on a simulated grader", () => {
    const ledger = new LabLedger(root, { now });
    runToQuiescence(ledger, { now });
    const cap = byKey(ledger, "fresh-tool-result-cap");
    expect(cap.status).toBe("needs_gate");
    expect(cap.evaluation!.verdict).toBe("PASS");
    expect(cap.evaluation!.lossless).toBe(false);
    expect(cap.evaluation!.basis).toContain("SIMULATOR");
    expect(cap.actualSavingPercent).toBeGreaterThan(5);
    expect(cap.promotion!.decision).toBe("NEEDS_GATE");
    // Nothing lossy reaches the portfolio.
    expect(ledger.readPortfolio().levers.some((lever) => lever.id === cap.id)).toBe(false);
    // The Red Team flagged the simulated grader.
    expect(cap.redTeam!.findings.some((f) => f.category === "hidden-quality")).toBe(true);
  });

  it("fails the output cap on quality and records why, so it is not re-investigated blind", () => {
    const ledger = new LabLedger(root, { now });
    runToQuiescence(ledger, { now });
    const outputCap = byKey(ledger, "output-token-cap");
    expect(outputCap.status).toBe("failed");
    expect(outputCap.evaluation!.qualityDelta).toBeGreaterThan(DEFAULT_MAX_QUALITY_DEGRADATION);
    expect(outputCap.decisionReason).toContain("maximum_quality_drop");
    // A second scouting pass does not re-open it.
    expect(() => ledger.createLead("scout", { ...outputCap.lead! })).toThrow(DuplicateLeadError);
  });

  it("fails levers that add nothing on the paying shape", () => {
    const ledger = new LabLedger(root, { now });
    runToQuiescence(ledger, { now });
    for (const key of ["stale-tool-result-compaction", "tool-schema-description-prune"]) {
      const record = byKey(ledger, key);
      expect(record.status).toBe("failed");
      expect(record.decisionReason).toContain("minimum_saving");
    }
  });

  it("promotes the cadence-aware TTL choice — lossless, so no gate is needed", () => {
    const ledger = new LabLedger(root, { now });
    runToQuiescence(ledger, { now });
    const ttl = byKey(ledger, "cache-ttl-policy");
    expect(ttl.status).toBe("promoted");
    expect(ttl.evaluation!.lossless).toBe(true);
    expect(ttl.evaluation!.qualityDelta).toBe(0);
  });

  it("keeps the block-array repair at needs_gate with quality marked unmeasured", () => {
    const ledger = new LabLedger(root, { now });
    runToQuiescence(ledger, { now });
    const repair = byKey(ledger, "block-array-prefix-repair");
    expect(repair.status).toBe("needs_gate");
    expect(repair.evaluation!.qualityUnmeasured).toBe(true);
    expect(repair.actualSavingPercent).toBeGreaterThan(60);
  });

  it("leaves levers with no harness and no implementation INCONCLUSIVE", () => {
    const ledger = new LabLedger(root, { now });
    runToQuiescence(ledger, { now });
    expect(harnessEvidence("reasoning-effort-governor")).toBeUndefined();
    expect(byKey(ledger, "reasoning-effort-governor").status).toBe("inconclusive");
  });
});

describe("sweeps over the paying shape", () => {
  it("a 5-minute stamp LOSES money once turns are more than 5 minutes apart; the 1-hour TTL does not", () => {
    const [fast, slow] = cadenceSweep([3, 480], 4);
    // Busy cadence: the cheap 5m write wins.
    expect(fast!.ttl5m.savingPercent).toBeGreaterThan(0);
    expect(fast!.better).toBe("5m");
    // Slow cadence: every 5m write expires unread — pure premium, a real loss.
    expect(slow!.ttl5m.cacheHitRate).toBe(0);
    expect(slow!.ttl5m.savingPercent).toBeLessThan(0);
    expect(slow!.ttl1h.savingPercent).toBeGreaterThan(0);
    expect(slow!.better).toBe("1h");
    // Stamping never changes content, so quality is untouched at any cadence.
    for (const row of [fast!, slow!]) {
      expect(row.ttl5m.qualityDrop).toBe(0);
      expect(row.ttl1h.qualityDrop).toBe(0);
    }
  }, 60_000);

  it("savings grow with session length, and the fresh cap subsumes history compaction", () => {
    const [short, long] = sessionLengthSweep([3, 8], 3);
    expect(long!.lossless.savingPercent).toBeGreaterThan(short!.lossless.savingPercent);
    expect(long!.freshCap.savingPercent).toBeGreaterThan(long!.lossless.savingPercent);
    // With the cap on at injection there is nothing stale and oversized left to compact.
    expect(Math.abs(long!.historyAddsPoints)).toBeLessThan(0.5);
    for (const row of [short!, long!]) {
      expect(row.history.cleanTasks).toBe(row.history.totalTasks);
      expect(row.history.withinCeiling).toBe(true);
    }
  }, 60_000);
});

describe("docs/NUMBERS.md is the source of truth for LIVE figures", () => {
  it("reads the current headline and per-agent LIVE numbers from the doc", () => {
    const live = readLiveNumbers();
    expect(live.source).toBe("docs/NUMBERS.md");
    expect(live.headlinePercent).toBeGreaterThan(0);
    expect(live.perAgent.coding).toBeGreaterThan(0);
    expect(live.perAgent.rag).toBeGreaterThan(0);
  });

  it("degrades to 'unknown' rather than inventing a number when the doc is missing", () => {
    const live = readLiveNumbers("/nonexistent/NUMBERS.md");
    expect(live.headlinePercent).toBeUndefined();
    expect(live.perAgent).toEqual({});
  });
});

describe("experiment: block-array system prefix repair", () => {
  const turn = (clock: string) => ({
    model: "claude-sonnet-4-5",
    system: [
      {
        type: "text",
        text: `Current time: ${clock}\nYou are the support agent.\nPolicy 1: verify the tier.`,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: "hi" }],
  });

  it("keeps the stamped block byte-identical across turns with different clocks", () => {
    const a = repairBlockArraySystem(turn("2026-10-25T09:00:00Z")).request.system as { text: string }[];
    const b = repairBlockArraySystem(turn("2026-10-25T09:01:00Z")).request.system as { text: string }[];
    expect(JSON.stringify(a[0])).toBe(JSON.stringify(b[0]));
    expect(a[1]!.text).toContain("09:00:00Z");
    // The relocated block is never stamped.
    expect("cache_control" in (a[1] as object)).toBe(false);
  });

  it("preserves every line verbatim — only position changes", () => {
    const original = turn("2026-10-25T09:00:00Z");
    const repaired = repairBlockArraySystem(original);
    const before = original.system.flatMap((block) => block.text.split("\n")).sort();
    const after = (repaired.request.system as { text: string }[]).flatMap((block) => block.text.split("\n")).sort();
    expect(after).toEqual(before);
    expect(repaired.moved).toEqual(["Current time: 2026-10-25T09:00:00Z"]);
  });

  it("is a no-op when there is nothing to repair, and idempotent when there is", () => {
    const stringSystem = { system: "Current time: 2026-10-25T09:00:00Z\nrules", messages: [] };
    expect(repairBlockArraySystem(stringSystem).request).toBe(stringSystem);
    const stable = { system: [{ type: "text", text: "rules only" }], messages: [] };
    expect(repairBlockArraySystem(stable).request).toBe(stable);
    // A block that is ONLY volatile is left alone rather than emptied (an empty text block is a 400).
    const onlyVolatile = { system: [{ type: "text", text: "Current time: 2026-10-25T09:00:00Z" }], messages: [] };
    expect(repairBlockArraySystem(onlyVolatile).request).toBe(onlyVolatile);
    const once = repairBlockArraySystem(turn("2026-10-25T09:00:00Z")).request;
    expect(repairBlockArraySystem(once).request).toBe(once);
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
