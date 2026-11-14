// Design agent — converts a validated lead into the smallest experiment that
// tests the hypothesis. Quality gates default to strict (≤2% degradation).

import { DEFAULT_MAX_QUALITY_DEGRADATION } from "../constraints.js";
import type { LabLedger } from "../ledger.js";
import type { ExperimentSpec, OptimisationRecord } from "../types.js";

export type DesignOptions = {
  maxQualityDegradation?: number;
  minimumSamples?: number;
  minimumCostSavingsPercent?: number;
  minimumCandidateAccuracy?: number;
};

export function designRun(
  ledger: LabLedger,
  record: OptimisationRecord,
  options: DesignOptions = {},
): OptimisationRecord {
  const lead = record.lead;
  if (!lead) throw new Error(`Record ${record.id} has no lead to design from.`);

  const maxQualityDegradation = options.maxQualityDegradation ?? DEFAULT_MAX_QUALITY_DEGRADATION;
  const expectedTokenReductionPercent = lead.expectedTokenReductionPercent;

  const spec: ExperimentSpec = {
    hypothesis: lead.hypothesis,
    proposedOptimisation: `Apply "${lead.techniqueKey}" on the ${lead.controlSurface} surface.`,
    expectedTokenReductionPercent,
    // Cost tracks tokens for input-side reductions on a fixed price.
    expectedCostReductionPercent: expectedTokenReductionPercent,
    risks: [
      "Candidate could degrade quality if the reduction is not truly lossless on some shape.",
      "Candidate could increase tokens on an input that does not match the assumed shape.",
    ],
    requiredTests: [
      "Token-reduction measurement on the fixture.",
      "Lossless round-trip on a no-duplicate / empty input.",
      "Replay gate: candidate accuracy and cost-savings thresholds.",
    ],
    qualityGates: {
      maxQualityDegradation,
      minimumSamples: options.minimumSamples ?? 4,
      minimumCostSavingsPercent: options.minimumCostSavingsPercent ?? 3,
      minimumCandidateAccuracy: options.minimumCandidateAccuracy ?? 0.7,
      evaluator: "classification",
    },
    successCriteria: [
      `Token reduction ≥ ${Math.max(3, Math.round(expectedTokenReductionPercent * 0.5))}% on the fixture.`,
      `Accuracy drop ≤ ${(maxQualityDegradation * 100).toFixed(0)}%.`,
      "No unresolved critical Red Team finding.",
    ],
    failureCriteria: [
      "Accuracy drop exceeds the configured ceiling.",
      "Any input increases token count.",
      "An unresolved critical Red Team finding.",
    ],
    rollbackCriteria: [
      "Post-promotion drift monitor shows accuracy regression → revert to the prior policy version.",
      "Observed token increase on live traffic → disable the lever.",
    ],
    implementation: { techniqueId: lead.techniqueId, params: lead.defaultParams ?? {} },
    datasetFixtureId: lead.datasetFixtureId,
  };

  return ledger.advance(
    "design",
    record.id,
    "building",
    { spec, expectedSavingPercent: expectedTokenReductionPercent },
    "Experiment specified (smallest viable implementation).",
    "spec",
    { techniqueId: lead.techniqueId, fixtureId: lead.datasetFixtureId },
  );
}
