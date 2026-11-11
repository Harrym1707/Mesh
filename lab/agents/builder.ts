// Builder agent — implements an approved experiment in ISOLATION. It works in
// a per-record workspace directory under the ledger root, makes the smallest
// viable implementation (wiring the registry technique to the fixture), records
// every decision, and produces the measurement dataset. It NEVER promotes its
// own work and never touches the production branch: all it writes is its own
// workspace + ledger artifacts.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LabLedger } from "../ledger.js";
import { getFixture } from "../fixtures.js";
import { getTechnique, isRunnable } from "../registry.js";
import { harnessEvidence } from "../evidence.js";
import type { BuildArtifact, OptimisationRecord } from "../types.js";

export function builderRun(ledger: LabLedger, record: OptimisationRecord): OptimisationRecord {
  const spec = record.spec;
  if (!spec) throw new Error(`Record ${record.id} has no spec to build.`);

  const workspaceDir = ledger.workspaceDir(record.id);
  mkdirSync(workspaceDir, { recursive: true });

  const techniqueId = spec.implementation.techniqueId;
  const fixture = getFixture(spec.datasetFixtureId);
  // Some levers are measured by a lab harness (paying shape, cadence sweep,
  // wire captures) rather than by a text technique on a fixture.
  const evidence = harnessEvidence(record.techniqueKey);
  const textRunnable = isRunnable(techniqueId) && Boolean(fixture);
  const runnable = textRunnable || evidence !== undefined;
  const decisionsLog: string[] = [];
  const implementationNotes: string[] = [];

  decisionsLog.push(`Selected technique "${techniqueId}" with params ${JSON.stringify(spec.implementation.params)}.`);
  decisionsLog.push(`Target fixture: ${spec.datasetFixtureId ?? "none"}.`);

  let datasetPath: string | undefined;

  if (evidence) {
    implementationNotes.push(
      `Measured by the ${evidence.harness} harness: ${evidence.savingPercent.toFixed(1)} (${evidence.scope}). ${evidence.note}`,
    );
    decisionsLog.push(`Bound to harness "${evidence.harness}" — basis: ${evidence.basis}; grader: ${evidence.grader}.`);
  } else if (textRunnable && fixture) {
    const technique = getTechnique(techniqueId)!;
    // The Builder produces the IMPLEMENTATION ARTIFACT: the transformed inputs
    // and their token measurements. It does NOT decide pass/fail — that is the
    // Evaluator's job (Builder and Evaluator are logically separate).
    const cases = fixture.cases.map((c) => {
      const applied = technique.apply(c.input, spec.implementation.params);
      return {
        id: c.id,
        expected: c.expected,
        inputPerMillionUsd: c.inputPerMillionUsd,
        tokensBefore: applied.tokensBefore,
        tokensAfter: applied.tokensAfter,
        risk: applied.risk,
        notesCount: applied.notes.length,
      };
    });
    const totalBefore = cases.reduce((s, c) => s + c.tokensBefore, 0);
    const totalAfter = cases.reduce((s, c) => s + c.tokensAfter, 0);
    const reductionPercent = totalBefore > 0 ? ((totalBefore - totalAfter) / totalBefore) * 100 : 0;
    implementationNotes.push(
      `Applied ${technique.id} to ${cases.length} fixture cases: ${totalBefore} → ${totalAfter} tokens (${reductionPercent.toFixed(1)}% reduction).`,
    );
    datasetPath = join(workspaceDir, "dataset.json");
    writeFileSync(
      datasetPath,
      `${JSON.stringify(
        {
          recordId: record.id,
          techniqueId,
          params: spec.implementation.params,
          fixtureId: fixture.id,
          evaluator: fixture.evaluator,
          totalTokensBefore: totalBefore,
          totalTokensAfter: totalAfter,
          measuredReductionPercent: reductionPercent,
          cases,
        },
        null,
        2,
      )}\n`,
    );
    decisionsLog.push(`Wrote measurement dataset to ${datasetPath}.`);
  } else {
    implementationNotes.push(
      `No runnable implementation for "${techniqueId}" yet (spec-only). Built the spec + measurement plan; evaluation will be INCONCLUSIVE until an implementation and measured data exist.`,
    );
    decisionsLog.push("Marked build as spec-only (not runnable).");
  }

  const build: BuildArtifact = {
    workspaceDir,
    techniqueId,
    runnable,
    params: spec.implementation.params,
    implementationNotes,
    datasetPath,
    harness: evidence?.harness,
    decisionsLog,
  };
  writeFileSync(join(workspaceDir, "build.json"), `${JSON.stringify(build, null, 2)}\n`);

  return ledger.advance(
    "builder",
    record.id,
    "red_team",
    { build, codeLinks: [...record.codeLinks, `lab/registry.ts#${techniqueId}`] },
    runnable ? "Built isolated implementation + measurement dataset." : "Built spec-only (not runnable).",
    "build",
    { runnable, datasetPath },
  );
}
