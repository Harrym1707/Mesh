// Maintainer agent — the final gate before promotion, and the ONLY role that
// may promote. It verifies every promotion gate before admitting a change to
// the live lever portfolio:
//   - required tests pass (a runnable implementation was built and measured);
//   - the independent evaluation passed;
//   - quality degradation is within the configured threshold (default 2%);
//   - the Red Team left no unresolved critical finding;
//   - the content-blind constraint still holds;
//   - the change is documented (has a spec);
//   - the change is reversible (a lever is a policy version; rollback = revert).

import { checkContentBlind } from "../constraints.js";
import type { LabLedger } from "../ledger.js";
import type { OptimisationRecord, PromotedLever, PromotionDecision } from "../types.js";

export function maintainerRun(ledger: LabLedger, record: OptimisationRecord): OptimisationRecord {
  const { spec, build, redTeam, evaluation, lead } = record;
  if (!evaluation) throw new Error(`Record ${record.id} has no evaluation.`);

  const now = record.updatedAt; // deterministic: reuse the ledger clock via the record
  const maxQuality = spec?.qualityGates.maxQualityDegradation ?? 0.02;
  const contentBlind = lead ? checkContentBlind(lead).passed : false;

  const checks: PromotionDecision["checkedGates"] = [
    {
      name: "required-tests-pass",
      passed: Boolean(build?.runnable),
      detail: build?.runnable ? "Runnable implementation built and measured." : "No runnable implementation.",
    },
    {
      name: "evaluation-passed",
      passed: evaluation.verdict === "PASS",
      detail: `Independent evaluation verdict: ${evaluation.verdict}.`,
    },
    {
      name: "quality-within-threshold",
      passed: evaluation.qualityDelta <= maxQuality,
      detail: `Quality drop ${(evaluation.qualityDelta * 100).toFixed(2)}% vs ceiling ${(maxQuality * 100).toFixed(0)}%.`,
    },
    {
      name: "no-unresolved-critical",
      passed: (redTeam?.unresolvedCritical ?? 0) === 0,
      detail: `${redTeam?.unresolvedCritical ?? 0} unresolved critical Red Team finding(s).`,
    },
    {
      name: "content-blind-intact",
      passed: contentBlind,
      detail: contentBlind ? "Reads only blind features." : "Content-blind constraint not satisfied.",
    },
    {
      name: "documented",
      passed: Boolean(spec),
      detail: spec ? "Experiment spec on record." : "No spec.",
    },
    {
      name: "reversible",
      passed: true,
      detail: "Lever is a policy version; rollback = publish the previous version.",
    },
  ];

  const allPass = checks.every((c) => c.passed);

  // Resolve the terminal status from the evaluation verdict + the gates.
  let status: "promoted" | "needs_gate" | "failed" | "inconclusive";
  let decision: PromotionDecision["decision"];
  let reason: string;

  // A lossy lever that passed on harness evidence has only been judged by a
  // simulated grader (or not judged at all). Its saving is real enough to
  // pursue and NOT proven enough to ship: it rests at needs_gate.
  const lossyOnSimulatedEvidence = Boolean(build?.harness) && evaluation.lossless === false;

  if (evaluation.verdict === "INCONCLUSIVE") {
    status = "inconclusive";
    decision = "REJECTED";
    reason = `Not promoted: evaluation inconclusive (${evaluation.reasons.join("; ") || "no measurable data"}).`;
  } else if (evaluation.verdict === "PASS" && allPass && lossyOnSimulatedEvidence) {
    status = "needs_gate";
    decision = "NEEDS_GATE";
    reason =
      `Not promoted yet: saves ${evaluation.tokenReductionPercent.toFixed(1)} on harness evidence ` +
      (evaluation.qualityUnmeasured
        ? "with quality UNMEASURED"
        : `with a ${(evaluation.qualityDelta * 100).toFixed(1)}% quality drop on a simulated grader`) +
      `, but it changes what the model reads — it needs a real replay gate on real traffic first. ` +
      `Basis: ${evaluation.basis ?? "unknown"}.`;
  } else if (evaluation.verdict === "PASS" && allPass) {
    status = "promoted";
    decision = "PROMOTED";
    reason = `Promoted: ${evaluation.tokenReductionPercent.toFixed(1)}% token reduction, quality drop ${(evaluation.qualityDelta * 100).toFixed(2)}% within ${(maxQuality * 100).toFixed(0)}% ceiling, all gates clear.`;
  } else {
    status = "failed";
    decision = "REJECTED";
    const failedGates = checks.filter((c) => !c.passed).map((c) => c.name);
    reason =
      evaluation.verdict === "FAIL"
        ? `Not promoted: evaluation FAILED (${evaluation.reasons.join("; ")}).`
        : `Not promoted: gate(s) failed — ${failedGates.join(", ")}.`;
  }

  const promotion: PromotionDecision = {
    decision,
    checkedGates: checks,
    reason,
    reversible: true,
    codeLinks: record.codeLinks,
    decidedAt: now,
  };

  const updated = ledger.advance(
    "maintainer",
    record.id,
    status,
    {
      promotion,
      finalDecision: decision,
      decisionReason: reason,
    },
    reason,
    "promotion",
    { decision, status },
  );

  if (status === "promoted" && lead) {
    const lever: PromotedLever = {
      id: record.id,
      title: record.title,
      category: record.category,
      controlSurface: lead.controlSurface,
      techniqueId: build?.techniqueId,
      params: build?.params ?? {},
      measuredTokenReductionPercent: evaluation.tokenReductionPercent,
      measuredCostReductionPercent: evaluation.costReductionPercent,
      measuredQualityDelta: evaluation.qualityDelta,
      promotedAt: now,
      justification: reason,
      codeLinks: record.codeLinks,
    };
    ledger.addToPortfolio("maintainer", lever);
  }

  return updated;
}
