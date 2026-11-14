// Red Team agent — tries to prove the optimisation should NOT ship. It is
// expected to be sceptical and actively hunts: hidden quality degradation,
// privacy / content-blind violations, token increase on edge inputs,
// reliability problems, invalid assumptions and regressions.

import { readFileSync } from "node:fs";
import { checkContentBlind } from "../constraints.js";
import type { LabLedger } from "../ledger.js";
import { getTechnique } from "../registry.js";
import { harnessEvidence } from "../evidence.js";
import type { OptimisationRecord, RedTeamFinding, RedTeamReport } from "../types.js";

// Inputs that are already clean (no duplicate blocks, no redundant whitespace):
// a lossless reducer must return them byte-identical.
const CLEAN_INPUTS = [
  "Alpha beta gamma delta epsilon.\n\nZeta eta theta iota kappa.",
  "",
  "Single line with nothing to remove.",
];

export function redTeamRun(ledger: LabLedger, record: OptimisationRecord): OptimisationRecord {
  const findings: RedTeamFinding[] = [];
  ledger.note("red-team", record.id, "status-change", { to: "red_team" });

  // 1. Content-blind / privacy.
  if (record.lead) {
    const blind = checkContentBlind(record.lead);
    if (!blind.passed) {
      findings.push({
        severity: "critical",
        category: "content-blind-violation",
        description: "Lead is not content-blind.",
        evidence: blind.detail,
        resolved: false,
      });
    }
  }
  // The build artifact must not have persisted raw request text.
  if (record.build?.datasetPath) {
    try {
      const dataset = JSON.parse(readFileSync(record.build.datasetPath, "utf8")) as {
        cases: Record<string, unknown>[];
      };
      const leaked = dataset.cases.some((c) => "input" in c || "candidateText" in c || "text" in c);
      if (leaked) {
        findings.push({
          severity: "critical",
          category: "privacy",
          description: "Measurement dataset persisted raw request text.",
          evidence: "A case carried an input/candidateText/text field.",
          resolved: false,
        });
      }
    } catch {
      /* missing dataset is handled as a reliability finding below */
    }
  }

  const technique = getTechnique(record.build?.techniqueId);

  const evidence = record.build?.harness ? harnessEvidence(record.techniqueKey) : undefined;

  // 2a. Harness-measured levers: attack the EVIDENCE rather than a text transform.
  if (evidence) {
    if (!evidence.lossless) {
      findings.push({
        severity: "major",
        category: "hidden-quality",
        description:
          evidence.qualityDrop === null
            ? "Lossy lever with NO quality measurement — only its cost effect is known."
            : "Lossy lever judged only by a simulated grader, which cannot see every way a real model degrades.",
        evidence: `grader: ${evidence.grader}; basis: ${evidence.basis}`,
        resolved: false,
      });
    }
    if (evidence.savingPercent < 0) {
      findings.push({
        severity: "critical",
        category: "token-increase",
        description: "The lever RAISES the bill on its own measurement shape.",
        evidence: `${evidence.savingPercent.toFixed(1)} (${evidence.scope})`,
        resolved: false,
      });
    }
    if (/ESTIMATE|synthetic|one session|counterfactual/i.test(`${evidence.basis} ${evidence.note}`)) {
      findings.push({
        severity: "minor",
        category: "invalid-assumption",
        description:
          "The measurement rests on a synthetic, single-sample or counterfactual input, not on a run of this lever against representative traffic.",
        evidence: evidence.basis,
        resolved: false,
      });
    }
  }
  // 2b. Token-increase edge cases + lossless round-trip on clean inputs.
  else if (record.build?.runnable && technique) {
    for (const input of CLEAN_INPUTS) {
      try {
        const applied = technique.apply(input, record.build.params);
        if (applied.tokensAfter > applied.tokensBefore) {
          findings.push({
            severity: "critical",
            category: "token-increase",
            description: "Technique increased token count on an edge input.",
            evidence: `tokensBefore=${applied.tokensBefore} tokensAfter=${applied.tokensAfter}`,
            resolved: false,
          });
        }
        if (technique.risk === "lossless" && applied.candidateText !== input) {
          findings.push({
            severity: "major",
            category: "hidden-quality",
            description: "A 'lossless' technique altered a clean input (should be byte-identical).",
            evidence: `input length ${input.length} -> ${applied.candidateText.length}`,
            resolved: false,
          });
        }
      } catch (error) {
        findings.push({
          severity: "critical",
          category: "reliability",
          description: "Technique threw on an edge input.",
          evidence: String(error instanceof Error ? error.message : error),
          resolved: false,
        });
      }
    }
  } else {
    // 3. Not runnable — cannot verify. Major (blocks a PASS), not critical
    //    (so the pipeline proceeds and the Evaluator records INCONCLUSIVE).
    findings.push({
      severity: "major",
      category: "invalid-assumption",
      description: "No runnable implementation or measured data; the saving is unverifiable.",
      evidence: `techniqueId=${record.build?.techniqueId ?? "none"} runnable=${record.build?.runnable ?? false}`,
      resolved: false,
    });
  }

  // 4. Invalid assumption — expected saving far above what the build measured.
  if (record.build?.runnable && record.build.datasetPath) {
    try {
      const dataset = JSON.parse(readFileSync(record.build.datasetPath, "utf8")) as {
        measuredReductionPercent: number;
      };
      const expected = record.expectedSavingPercent ?? 0;
      if (expected > 0 && dataset.measuredReductionPercent < expected * 0.3) {
        findings.push({
          severity: "minor",
          category: "invalid-assumption",
          description: "Measured reduction is far below the Scout's projection.",
          evidence: `expected≈${expected}% measured=${dataset.measuredReductionPercent.toFixed(1)}%`,
          resolved: false,
        });
      }
    } catch {
      /* ignore */
    }
  }

  const unresolvedCritical = findings.filter((f) => f.severity === "critical" && !f.resolved).length;
  const report: RedTeamReport = {
    findings,
    unresolvedCritical,
    verdict: unresolvedCritical > 0 ? "blocked" : "clear",
  };

  if (report.verdict === "blocked") {
    return ledger.advance(
      "red-team",
      record.id,
      "failed",
      {
        redTeam: report,
        finalDecision: "FAILED",
        decisionReason: `Red Team blocked: ${unresolvedCritical} unresolved critical finding(s).`,
      },
      "Red Team blocked the experiment.",
      "red-team",
      { verdict: "blocked", unresolvedCritical },
    );
  }

  return ledger.advance(
    "red-team",
    record.id,
    "evaluating",
    { redTeam: report },
    `Red Team clear (${findings.length} non-critical finding(s)).`,
    "red-team",
    { verdict: "clear", findings: findings.length },
  );
}
