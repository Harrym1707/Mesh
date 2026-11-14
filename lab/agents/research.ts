// Research agent — determines whether a lead is technically credible and
// compatible with Mesh. It rejects weak ideas early, against the six criteria:
//   1. content-blind   2. operates via the Mesh optimisation layer
//   3. no customer-app changes   4. objectively testable
//   5. meaningful saving   6. acceptable privacy/reliability/quality risk

import {
  checkAcceptableRisk,
  checkAvoidsCustomerAppChanges,
  checkContentBlind,
  checkMeaningfulSaving,
  checkMeshSideOnly,
  checkObjectivelyTestable,
} from "../constraints.js";
import type { LabLedger } from "../ledger.js";
import type { CompatibilityAssessment, OptimisationRecord } from "../types.js";

export function researchRun(
  ledger: LabLedger,
  record: OptimisationRecord,
): OptimisationRecord {
  if (!record.lead) throw new Error(`Record ${record.id} has no lead to research.`);

  // Make RESEARCHING visible in the hash-chained trail without persisting it as
  // the resting status.
  ledger.note("research", record.id, "status-change", { to: "researching" });

  const checks = [
    checkContentBlind(record.lead),
    checkMeshSideOnly(record.lead),
    checkAvoidsCustomerAppChanges(record.lead),
    checkObjectivelyTestable(record.lead),
    checkMeaningfulSaving(record.lead),
    checkAcceptableRisk(record.lead),
  ];
  const failed = checks.filter((c) => !c.passed);

  const assessment: CompatibilityAssessment = {
    contentBlind: checks[0]!.passed,
    meshSideOnly: checks[1]!.passed,
    avoidsCustomerAppChanges: checks[2]!.passed,
    objectivelyTestable: checks[3]!.passed,
    meaningfulSaving: checks[4]!.passed,
    acceptableRisk: checks[5]!.passed,
    notes: checks.map((c) => `${c.passed ? "PASS" : "FAIL"} ${c.name}: ${c.detail}`),
    verdict: failed.length === 0 ? "validated" : "rejected",
    rejectionReasons: failed.map((c) => `${c.name}: ${c.detail}`),
  };

  if (assessment.verdict === "rejected") {
    return ledger.advance(
      "research",
      record.id,
      "rejected",
      {
        compatibility: assessment,
        finalDecision: "REJECTED",
        decisionReason: `Failed research: ${assessment.rejectionReasons.join("; ")}`,
      },
      "Rejected by Research on compatibility constraints.",
      "assessment",
      { verdict: "rejected", rejectionReasons: assessment.rejectionReasons },
    );
  }

  return ledger.advance(
    "research",
    record.id,
    "designed",
    { compatibility: assessment },
    "Validated by Research; ready for Design.",
    "assessment",
    { verdict: "validated" },
  );
}
