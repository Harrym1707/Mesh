// The candidate-technique registry.
//
// A technique is a runnable, Mesh-side reduction the Builder can wire into an
// experiment and the Evaluator can measure. Runnable techniques wrap the REAL
// core reducers (packages/core/src/token-reduction.ts) — the lab measures
// genuine token reduction, it does not mock it. Techniques with no runnable
// implementation yet are registered as spec-only so the pipeline can still
// carry them, and the Evaluator returns INCONCLUSIVE for want of a measurement.

import {
  applyReducers,
  collapseWhitespace,
  dedupeRepeatedBlocks,
  approximateTokenCount,
  type Reducer,
  type ReductionRisk,
} from "../packages/core/src/token-reduction.js";

export type TechniqueApplication = {
  candidateText: string;
  notes: string[];
  tokensBefore: number;
  tokensAfter: number;
  risk: ReductionRisk;
};

export type Technique = {
  id: string;
  title: string;
  risk: ReductionRisk;
  /** Whether this technique has a runnable implementation. */
  runnable: boolean;
  apply: (input: string, params: Record<string, unknown>) => TechniqueApplication;
};

function runReducers(input: string, reducers: Reducer[], risk: ReductionRisk): TechniqueApplication {
  const result = applyReducers(input, reducers, approximateTokenCount);
  const notes = result.outcomes.flatMap((outcome) => outcome.notes);
  return {
    candidateText: result.text,
    notes,
    tokensBefore: result.tokensBefore,
    tokensAfter: result.tokensAfter,
    risk,
  };
}

const TECHNIQUES: Record<string, Technique> = {
  "dedupe-repeated-blocks": {
    id: "dedupe-repeated-blocks",
    title: "Exact duplicate-block removal",
    risk: "lossless",
    runnable: true,
    apply: (input, params) => {
      const minimumBlockTokens = Number(params.minimumBlockTokens ?? 24);
      return runReducers(input, [dedupeRepeatedBlocks(minimumBlockTokens)], "lossless");
    },
  },

  "collapse-whitespace": {
    id: "collapse-whitespace",
    title: "Redundant-whitespace collapse",
    risk: "lossless",
    runnable: true,
    apply: (input) => runReducers(input, [collapseWhitespace()], "lossless"),
  },

  "dedupe-then-collapse": {
    id: "dedupe-then-collapse",
    title: "Dedup + whitespace compaction (lossless stack)",
    risk: "lossless",
    runnable: true,
    apply: (input, params) => {
      const minimumBlockTokens = Number(params.minimumBlockTokens ?? 24);
      return runReducers(
        input,
        [dedupeRepeatedBlocks(minimumBlockTokens), collapseWhitespace()],
        "lossless",
      );
    },
  },
};

/** A spec-only technique: carried by the pipeline, but not yet runnable. */
export function specOnlyTechnique(id: string, title: string, risk: ReductionRisk): Technique {
  return {
    id,
    title,
    risk,
    runnable: false,
    apply: () => {
      throw new Error(`Technique "${id}" is spec-only and has no runnable implementation.`);
    },
  };
}

export function getTechnique(id: string | undefined): Technique | undefined {
  if (!id) return undefined;
  return TECHNIQUES[id];
}

export function isRunnable(id: string | undefined): boolean {
  return Boolean(id && TECHNIQUES[id]?.runnable);
}

export function listTechniques(): Technique[] {
  return Object.values(TECHNIQUES);
}
