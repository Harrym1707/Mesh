// Harness evidence: the measurement behind a lead that cannot be judged by a
// text technique on a fixture.
//
// Cache levers change billing rather than text; lossy levers need a grader with
// consequences; the block-array repair only shows up on a real capture. The
// lab's harnesses (paying shape, cadence sweep, wire captures) measure those,
// and this module is the single place a lead's techniqueKey is mapped to its
// measurement — so the pipeline can return a verdict instead of INCONCLUSIVE.
//
// Every piece of evidence carries its basis and its grader. A lossy lever that
// passes only a SIMULATED grader is never promoted: the Maintainer rests it at
// `needs_gate` until a real replay gate has run.

import { qualifyOnCaptures, capturesAvailable } from "./captures.js";
import { qualifyPayingShape } from "./paying-shape.js";
import { cadenceSweep } from "./sweeps.js";

export type HarnessEvidence = {
  harness: "paying-shape" | "cadence-sweep" | "wire-captures";
  /**
   * The lever's saving. For paying-shape levers this is the POINTS of whole-bill
   * saving the lever adds on top of the rung below it; for the others it is the
   * saving on the shape named in `scope`.
   */
  savingPercent: number;
  scope: string;
  /** Clean-rate drop measured by the grader; null when quality was not measured. */
  qualityDrop: number | null;
  lossless: boolean;
  basis: string;
  grader: string;
  note: string;
};

/** Points a ladder rung adds over the rung before it, with that rung's own quality drop. */
function rungEvidence(id: string, scope: string, note: string): HarnessEvidence {
  const result = qualifyPayingShape();
  const index = result.arms.findIndex((arm) => arm.id === id);
  if (index < 1) throw new Error(`No paying-shape rung "${id}" above the base.`);
  const arm = result.arms[index]!;
  const below = result.arms[index - 1]!;
  return {
    harness: "paying-shape",
    savingPercent: arm.savingPercent - below.savingPercent,
    scope,
    // Quality lost BY THIS LEVER: what the rung drops beyond the rung below it.
    qualityDrop: arm.qualityDrop - below.qualityDrop,
    lossless: arm.lossless,
    basis: "SIMULATOR — repo agent fixture (uncached Claude agent, 40 tasks × 5 turns), whole bill",
    grader: "simulated model (evals/agent-fixture.ts answer())",
    note: `${note} Stack saving ${below.savingPercent.toFixed(1)}% → ${arm.savingPercent.toFixed(1)}%, clean ${arm.cleanTasks}/${arm.totalTasks}.`,
  };
}

const EVIDENCE: Record<string, () => HarnessEvidence | undefined> = {
  "fresh-tool-result-cap": () =>
    rungEvidence(
      "freshCap",
      "points of whole-bill saving added on the paying shape",
      "Caps oversized tool results at injection, before first send.",
    ),

  "tool-schema-description-prune": () =>
    rungEvidence(
      "descriptions",
      "points of whole-bill saving added on the paying shape",
      "Truncates tool descriptions to 40 tokens.",
    ),

  "stale-tool-result-compaction": () =>
    rungEvidence(
      "history",
      "points of whole-bill saving added on the paying shape, on top of the fresh cap",
      "History compaction of stale tool results; subsumed once the fresh cap is on (+2.2 pt alone, isolated).",
    ),

  "output-token-cap": () =>
    rungEvidence(
      "outputCap",
      "points of whole-bill saving added on the paying shape",
      "Caps output at 2,000 tokens; saves only by truncating long answers.",
    ),

  "cache-ttl-policy": () => {
    const slow = cadenceSweep([480], 4)[0]!;
    return {
      harness: "cadence-sweep",
      savingPercent: slow.ttl1h.savingPercent,
      scope: "whole-bill saving on conversations whose turns are 8 minutes apart",
      qualityDrop: slow.ttl1h.qualityDrop,
      lossless: true, // a TTL choice changes billing, never content
      basis: "SIMULATOR — repo agent fixture; turn gap is a synthetic ESTIMATE",
      grader: "simulated model (content is byte-identical, so quality cannot move)",
      note:
        `Choosing the 1h TTL from the observed gap saves ${slow.ttl1h.savingPercent.toFixed(1)}%, where a 5m stamp ` +
        `gives ${slow.ttl5m.savingPercent.toFixed(1)}% (every write expires unread).`,
    };
  },

  "block-array-prefix-repair": () => {
    if (!capturesAvailable()) return undefined;
    const volatile = qualifyOnCaptures().sessions.find(
      (session) => session.capture.startsWith("litellm") && session.arms.blockRepair.savingPercent > 1,
    );
    if (!volatile) return undefined;
    return {
      harness: "wire-captures",
      savingPercent: volatile.arms.blockRepair.savingPercent,
      scope: "input-bill saving on the volatile LiteLLM session of the real wire capture",
      qualityDrop: null, // it moves a date anchor; no grader here is sensitive to that
      lossless: false,
      basis: "SIMULATOR — product cache model on a real captured session (derived-from-captures)",
      grader: "none",
      note: "Lab-local experiment (lab/experiments/block-array-repair.ts); one session, not a fleet number.",
    };
  },
};

const cache = new Map<string, HarnessEvidence | undefined>();

/** The harness measurement for a lead, if one exists. Deterministic, so memoised. */
export function harnessEvidence(techniqueKey: string): HarnessEvidence | undefined {
  if (!(techniqueKey in EVIDENCE)) return undefined;
  if (!cache.has(techniqueKey)) cache.set(techniqueKey, EVIDENCE[techniqueKey]!());
  return cache.get(techniqueKey);
}

export function hasHarnessEvidence(techniqueKey: string): boolean {
  return techniqueKey in EVIDENCE;
}
