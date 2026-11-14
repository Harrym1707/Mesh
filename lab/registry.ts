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
  minifyJsonBlocks,
  approximateTokenCount,
  type Reducer,
  type ReductionRisk,
} from "../packages/core/src/token-reduction.js";
import { minifyToolSchemas } from "../packages/core/src/tool-schema.js";

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

  "minify-tool-schemas": {
    id: "minify-tool-schemas",
    title: "Tool-schema compaction (lossless)",
    risk: "lossless",
    runnable: true,
    // Agentic lever: the input is the request's serialized tool catalogue. Strip
    // plumbing ($schema/$id/…) and redundant titles the model never reads —
    // lossless by construction (core keeps descriptions by default).
    apply: (input) => {
      let tools: unknown;
      try {
        tools = JSON.parse(input);
      } catch {
        const tokens = approximateTokenCount(input);
        return { candidateText: input, notes: [], tokensBefore: tokens, tokensAfter: tokens, risk: "lossless" };
      }
      if (!Array.isArray(tools)) {
        const tokens = approximateTokenCount(input);
        return { candidateText: input, notes: [], tokensBefore: tokens, tokensAfter: tokens, risk: "lossless" };
      }
      const result = minifyToolSchemas(tools); // lossless defaults (descriptions kept)
      const candidateText = JSON.stringify(result.tools);
      return {
        candidateText,
        notes: result.changes.filter((c) => c.lossless).map((c) => c.detail),
        tokensBefore: approximateTokenCount(input),
        tokensAfter: approximateTokenCount(candidateText),
        risk: "lossless",
      };
    },
  },

  "cache-prefix-read": {
    id: "cache-prefix-read",
    title: "Stable-prefix cache placement (steady-state read)",
    risk: "lossless",
    runnable: true,
    // Mesh's core lever: a stable system+tools prefix, re-sent every turn, is
    // cached and billed at the provider's read rate (~0.1x) instead of full
    // price. Content is byte-identical — only the billing of the prefix changes.
    // Models the steady-state read (prefix already cached); the first-turn write
    // premium amortizes away for long-lived / high-frequency traffic.
    apply: (input, params) => {
      const readMultiplier = Number(params.readMultiplier ?? 0.1);
      const index = input.indexOf("\n\n");
      const prefix = index >= 0 ? input.slice(0, index) : input;
      const suffix = index >= 0 ? input.slice(index + 2) : "";
      const prefixTokens = approximateTokenCount(prefix);
      const suffixTokens = approximateTokenCount(suffix);
      const tokensBefore = prefixTokens + suffixTokens;
      const tokensAfter = Math.ceil(prefixTokens * readMultiplier) + suffixTokens;
      return {
        candidateText: input, // byte-identical: caching changes billing, not content
        notes: [`Stable ${prefixTokens}-token prefix billed at ${readMultiplier}x on cache-read turns.`],
        tokensBefore,
        tokensAfter,
        risk: "lossless",
      };
    },
  },

  "minify-json-blocks": {
    id: "minify-json-blocks",
    title: "JSON tool-result minification",
    risk: "lossless",
    runnable: true,
    apply: (input) => runReducers(input, [minifyJsonBlocks()], "lossless"),
  },

  "full-lossless-stack": {
    id: "full-lossless-stack",
    title: "Full lossless stack (dedup + JSON minify + whitespace)",
    risk: "lossless",
    runnable: true,
    // Captures every lossless feature real traffic carries at once — re-sent
    // duplicates, fat JSON tool results, and redundant whitespace — so it beats
    // any single reducer on a realistic workload.
    apply: (input, params) => {
      const minimumBlockTokens = Number(params.minimumBlockTokens ?? 16);
      return runReducers(
        input,
        [dedupeRepeatedBlocks(minimumBlockTokens), minifyJsonBlocks(), collapseWhitespace()],
        "lossless",
      );
    },
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
