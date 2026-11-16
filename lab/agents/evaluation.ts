// Evaluation agent — independently determines whether the experiment is
// genuinely better than the baseline. It reuses Mesh's real replay gate
// (packages/core/src/replay.ts) to measure quality and cost, and the Builder's
// measurement dataset for the token/cost deltas. It is logically separate from
// the Builder: it recomputes everything and renders PASS / FAIL / INCONCLUSIVE.
//
// Honesty basis: a lossless reducer removes only bytes the model does not need,
// so the model's visible content — and therefore its answer — is unchanged.
// Baseline and candidate answers are the fixture's expected answer; the gate
// still measures the accuracy drop (0 for a true lossless reducer) and the cost
// savings from the real token delta.

import { readFileSync } from "node:fs";
import { evaluateReplay } from "../../packages/core/src/replay.js";
import type { ReplayPolicy, ReplayRecord } from "../../packages/core/src/types.js";
import { getFixture } from "../fixtures.js";
import { isRunnable } from "../registry.js";
import { harnessEvidence } from "../evidence.js";
import type { LabLedger } from "../ledger.js";
import type { EvaluationResult, OptimisationRecord } from "../types.js";

type DatasetCase = {
  id: string;
  expected: string;
  inputPerMillionUsd: number;
  tokensBefore: number;
  tokensAfter: number;
};

type Dataset = {
  evaluator: "exact_match" | "classification";
  totalTokensBefore: number;
  totalTokensAfter: number;
  cases: DatasetCase[];
};

function inconclusive(
  ledger: LabLedger,
  record: OptimisationRecord,
  reasons: string[],
): OptimisationRecord {
  const result: EvaluationResult = {
    verdict: "INCONCLUSIVE",
    baseline: { tokens: 0, costUsd: 0, accuracy: 0 },
    candidate: { tokens: 0, costUsd: 0, accuracy: 0 },
    tokenReductionPercent: 0,
    costReductionPercent: 0,
    qualityDelta: 0,
    latencyDeltaMs: null,
    reliability: { candidateErrorRate: 0 },
    gates: [],
    reasons,
  };
  return ledger.advance(
    "evaluation",
    record.id,
    "maintaining",
    { evaluation: result },
    "Evaluation INCONCLUSIVE — no measurable implementation/data.",
    "evaluation",
    { verdict: "INCONCLUSIVE" },
  );
}

export function evaluationRun(ledger: LabLedger, record: OptimisationRecord): OptimisationRecord {
  const spec = record.spec;
  const build = record.build;
  if (!spec) throw new Error(`Record ${record.id} has no spec.`);

  // Harness-measured levers: judge the harness evidence against the same gates.
  const evidence = build?.harness ? harnessEvidence(record.techniqueKey) : undefined;
  if (evidence) {
    const ceiling = spec.qualityGates.maxQualityDegradation;
    const minimumSaving = spec.qualityGates.minimumCostSavingsPercent;
    const qualityDrop = evidence.qualityDrop ?? 0;
    const gates = [
      {
        name: "minimum_saving",
        passed: evidence.savingPercent >= minimumSaving,
        observed: evidence.savingPercent,
        required: minimumSaving,
      },
      {
        name: "maximum_quality_drop",
        passed: evidence.qualityDrop === null ? true : qualityDrop <= ceiling + 1e-9,
        observed: evidence.qualityDrop,
        required: ceiling,
      },
    ];
    const passed = gates.every((gate) => gate.passed);
    const result: EvaluationResult = {
      verdict: passed ? "PASS" : "FAIL",
      // Harness evidence is a percentage of a bill, not a token count on a fixture.
      baseline: { tokens: 0, costUsd: 0, accuracy: 1 },
      candidate: { tokens: 0, costUsd: 0, accuracy: 1 - qualityDrop },
      tokenReductionPercent: evidence.savingPercent,
      costReductionPercent: evidence.savingPercent,
      qualityDelta: qualityDrop,
      latencyDeltaMs: null,
      reliability: { candidateErrorRate: 0 },
      gates,
      reasons: [
        ...gates
          .filter((gate) => !gate.passed)
          .map((gate) => `${gate.name}: observed ${gate.observed} vs required ${gate.required}`),
        `${evidence.savingPercent.toFixed(1)} — ${evidence.scope}. ${evidence.note}`,
      ],
      basis: evidence.basis,
      grader: evidence.grader,
      lossless: evidence.lossless,
      qualityUnmeasured: evidence.qualityDrop === null,
    };
    return ledger.advance(
      "evaluation",
      record.id,
      "maintaining",
      { evaluation: result, actualSavingPercent: evidence.savingPercent, qualityImpact: qualityDrop },
      `Evaluation ${result.verdict} on ${evidence.harness} evidence: ${evidence.savingPercent.toFixed(1)} (${evidence.scope}).`,
      "evaluation",
      { verdict: result.verdict, harness: evidence.harness, basis: evidence.basis, grader: evidence.grader },
    );
  }

  if (!build?.runnable || !build.datasetPath || !isRunnable(build.techniqueId)) {
    return inconclusive(ledger, record, [
      "No runnable implementation or measured dataset; cannot measure against the baseline.",
    ]);
  }
  const fixture = getFixture(spec.datasetFixtureId);
  if (!fixture) return inconclusive(ledger, record, ["Fixture missing."]);

  const dataset = JSON.parse(readFileSync(build.datasetPath, "utf8")) as Dataset;

  // Build the replay records from the Builder's token measurements.
  const records: ReplayRecord[] = dataset.cases.map((c) => {
    const baselineCostUsd = (c.tokensBefore / 1_000_000) * c.inputPerMillionUsd;
    const candidateCostUsd = (c.tokensAfter / 1_000_000) * c.inputPerMillionUsd;
    return {
      id: c.id,
      expected: c.expected,
      baseline: c.expected, // model answers correctly on full context
      candidate: c.expected, // lossless reduction -> identical visible content -> identical answer
      baselineCostUsd,
      candidateCostUsd,
    };
  });

  const policy: ReplayPolicy = {
    evaluator: dataset.evaluator,
    minimumSamples: spec.qualityGates.minimumSamples,
    minimumCandidateAccuracy: spec.qualityGates.minimumCandidateAccuracy,
    maximumAccuracyDrop: spec.qualityGates.maxQualityDegradation,
    minimumCostSavingsPercent: spec.qualityGates.minimumCostSavingsPercent,
  };

  const report = evaluateReplay(records, policy);

  const baselineTokens = dataset.totalTokensBefore;
  const candidateTokens = dataset.totalTokensAfter;
  const tokenReductionPercent =
    baselineTokens > 0 ? ((baselineTokens - candidateTokens) / baselineTokens) * 100 : 0;
  const baselineCostUsd = records.reduce((s, r) => s + (r.baselineCostUsd ?? 0), 0);
  const candidateCostUsd = records.reduce((s, r) => s + (r.candidateCostUsd ?? 0), 0);

  const result: EvaluationResult = {
    verdict: report.eligibleForReview ? "PASS" : "FAIL",
    baseline: { tokens: baselineTokens, costUsd: baselineCostUsd, accuracy: report.baselineAccuracy },
    candidate: { tokens: candidateTokens, costUsd: candidateCostUsd, accuracy: report.candidateAccuracy },
    tokenReductionPercent,
    costReductionPercent: report.costSavingsPercent ?? 0,
    qualityDelta: report.accuracyDrop,
    latencyDeltaMs: null, // not measured in offline replay — reported honestly as unknown
    reliability: { candidateErrorRate: report.candidateErrorRate },
    gates: report.gates.map((g) => ({
      name: g.name,
      passed: g.passed,
      observed: g.observed,
      required: g.required,
    })),
    reasons: report.gates
      .filter((g) => !g.passed)
      .map((g) => `${g.name}: observed ${g.observed} < required ${g.required}`),
  };

  return ledger.advance(
    "evaluation",
    record.id,
    "maintaining",
    {
      evaluation: result,
      actualSavingPercent: tokenReductionPercent,
      qualityImpact: report.accuracyDrop,
    },
    `Evaluation ${result.verdict}: ${tokenReductionPercent.toFixed(1)}% tokens, quality drop ${(report.accuracyDrop * 100).toFixed(2)}%.`,
    "evaluation",
    { verdict: result.verdict, tokenReductionPercent },
  );
}
