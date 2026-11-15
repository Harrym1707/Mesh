import { estimateTokenCost, type TokenPrice } from "./cost.js";

/**
 * Composable cost-reduction model.
 *
 * A single lever looks unimpressive. Model routing on LLMRouterBench's MMLU-Pro
 * returned 9.73% and bought it with quality. The levers below are different in
 * two ways: most of them do not touch the answer, and they attack disjoint parts
 * of a request, so they compose rather than compete.
 *
 * A request is modelled as segments, because each lever only reaches some of
 * them. Tool-schema minification cannot help a RAG prompt with no tools, and
 * prefix caching cannot help the one segment that changes every request. Summing
 * headline percentages across levers double-counts; applying them to the
 * segments they actually target does not.
 *
 * Order matters and is fixed: reducers shrink segments first, then caching prices
 * whatever stable tokens remain. Minifying a tool catalogue and then caching it
 * must charge the cache rate on the minified size, not the original.
 *
 * Every lever carries the published evidence for its reduction factor. Those
 * factors come from their authors' benchmarks, not from MESH measuring them on
 * your traffic, so a projection from this model is a hypothesis to verify by
 * replay, never a realised saving. Realised savings come from provider-reported
 * usage priced through the catalogue.
 */

export type WorkloadSegment =
  | "toolSchemas"
  | "systemPrompt"
  | "retrievedContext"
  | "history"
  | "userTurn"
  | "output";

export const INPUT_SEGMENTS: readonly WorkloadSegment[] = [
  "toolSchemas",
  "systemPrompt",
  "retrievedContext",
  "history",
  "userTurn",
];

/**
 * How confident a saving is before it is measured on the customer's own traffic.
 *
 * - `deterministic`: the request is provably equivalent, or the provider bills
 *   the same tokens at a lower rate. Nothing about the answer can change.
 * - `needs-verification`: the prompt or the output budget changes, so quality
 *   has to be shown to hold by replay before the lever is enabled.
 */
export type LeverRisk = "deterministic" | "needs-verification";

export type LeverEvidence = {
  /** Where the reduction factor comes from. */
  source: string;
  /** What that source measured, in its own terms. */
  claim: string;
};

export type Lever = {
  id: string;
  description: string;
  risk: LeverRisk;
  /** Segments this lever can reach; it has no effect on any other. */
  targets: readonly WorkloadSegment[];
  /** Share of targeted tokens removed, between 0 and 1. */
  reduction: number;
  /**
   * How this lever changes the number of calls a task takes. 1 leaves it
   * unchanged, 1.5 adds half a round trip per existing one, 0.3 removes most of
   * them. Above 1 can make a lever net negative however much it trims per
   * prompt, which is the whole reason this field exists: a published bench found
   * progressive disclosure modelled at ~77% delivering ~13%, because the router
   * it adds costs one extra round trip per novel tool call.
   */
  roundTripMultiplier?: number;
  evidence: LeverEvidence;
};

export type WorkloadProfile = {
  name: string;
  /** Requests the projection covers; caching needs more than one to pay off. */
  requests: number;
  /** Mean tokens per request in each segment. */
  segments: Record<WorkloadSegment, number>;
  /**
   * Segments byte-identical across requests, so a provider's prefix cache can
   * serve them. Order is the prompt order: caching stops at the first segment
   * that changes, so anything listed after a volatile segment cannot cache.
   */
  stableSegments: readonly WorkloadSegment[];
};

export type LeverContribution = {
  lever: string;
  risk: LeverRisk;
  tokensRemoved: number;
  costRemovedUsd: number;
  /** Share of the baseline bill this lever alone removes, given the levers before it. */
  sharePercent: number;
  evidence: LeverEvidence;
};

export type SavingsProjection = {
  workload: string;
  requests: number;
  baselineCostUsd: number;
  projectedCostUsd: number;
  savingUsd: number;
  savingPercent: number;
  /** The share achievable without any possibility of changing an answer. */
  deterministicSavingPercent: number;
  /** The additional share that requires a replay check before rollout. */
  needsVerificationSavingPercent: number;
  contributions: LeverContribution[];
  inputTokensBefore: number;
  inputTokensAfter: number;
  outputTokensBefore: number;
  outputTokensAfter: number;
  cachedInputTokens: number;
  /** Calls per task before any lever. */
  roundTripsBefore: number;
  /** Calls per task after every lever's effect on call count. */
  roundTripsAfter: number;
  warnings: string[];
};

function assertFraction(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be between 0 and 1.`);
  }
}

/**
 * Published levers, with the evidence for each factor.
 *
 * Factors are deliberately set at or below the conservative end of what each
 * source reports. A model that projects a vendor's best-case number is the thing
 * this project exists to argue against.
 */
export const PUBLISHED_LEVERS: Record<string, Lever> = {
  toolSchemaCompaction: {
    id: "tool-schema-compaction",
    description:
      "Remove JSON indentation, schema plumbing the model never reads ($schema, $id, $comment), and `title` " +
      "fields that only restate their property name. The decoded schema is semantically identical.",
    risk: "deterministic",
    targets: ["toolSchemas"],
    // Measured per catalogue by auditToolCatalogue; this is a conservative stand-in.
    reduction: 0.15,
    evidence: {
      source: "Measured directly from the request's own tool definitions by auditToolCatalogue",
      claim: "Formatting and plumbing only. Tool selection cannot change because the decoded schema is unchanged.",
    },
  },
  toolSchemaMinification: {
    id: "tool-schema-description-trim",
    description:
      "Trim prose descriptions and docstrings in tool/MCP JSON Schema, keeping names, types and required fields. " +
      "Agent runtimes resend the whole catalogue on every turn because the APIs are stateless, so a 20-turn task " +
      "pays for it 20 times. Descriptions are how the model chooses between tools, so this is a behaviour change.",
    risk: "needs-verification",
    targets: ["toolSchemas"],
    // Sources report >76% on a single schema and 30-60% across large catalogues.
    reduction: 0.6,
    evidence: {
      source: "github.com/olivomarco/github-copilot-token-optimization, InfoQ on GitHub's agent audits",
      claim:
        "Schema minification took one catalogue from 3,198 to under 750 tokens (>76%); tool-schema compression " +
        "reduces per-request overhead 30-60%; GitHub cut agent workflow token spend up to 62% with MCP pruning.",
    },
  },
  unusedToolRemoval: {
    id: "unused-tool-removal",
    description:
      "Drop tools the workload never calls. A typical MCP server exposes 20-30 tools at 300-500 tokens each, and " +
      "six connected servers run to 60,000-90,000 tokens of catalogue per request. Removing a tool removes the " +
      "model's ability to call it, so this holds only where the tool is genuinely unreachable for the workload.",
    risk: "needs-verification",
    targets: ["toolSchemas"],
    reduction: 0.3,
    evidence: {
      source: "mindstudio.ai MCP optimisation, buildmvpfast MCP token cost analysis",
      claim: "Removing unused MCP entries cuts 8-12 KB of context per call; unused tools are the most common inefficiency.",
    },
  },
  progressiveDisclosure: {
    id: "progressive-disclosure",
    description:
      "Replace the tool catalogue with a search/meta tool the model queries for the definitions it needs, so " +
      "the full catalogue is never sent. Cuts the prompt hard, but adds a round trip per novel tool invocation.",
    risk: "needs-verification",
    targets: ["toolSchemas"],
    // Solo.io measured 10,877 -> 970 prompt tokens, a 91.1% cut.
    reduction: 0.91,
    // The reason this lever usually disappoints. Archestra measured ~77% modelled
    // against ~13% in production on a 20-step run; 1.5 is a conservative middle.
    roundTripMultiplier: 1.5,
    evidence: {
      source: "solo.io agentgateway progressive disclosure; archestra.ai modelled-vs-measured bench",
      claim:
        "Prompt overhead fell 10,877 to 970 tokens (91.1%) on Claude Sonnet 4.6. But a router adds a hop: the " +
        "same approach modelled at ~77% measured ~13% in production, because every novel tool call costs an " +
        "extra round trip and an extra model decision.",
    },
  },
  toolSearchDefer: {
    id: "tool-search-defer",
    description:
      "Anthropic Tool Search: inject a built-in search tool and set defer_loading on the non-resident tools, so " +
      "the provider excludes their definitions from the model's processed prefix. The full definitions are still " +
      "sent, but the model only loads the 3-5 resident tools and searches for the rest server-side in the same " +
      "request. The GA, server-side sibling of progressive disclosure — same prompt cut without the client hop.",
    risk: "needs-verification",
    targets: ["toolSchemas"],
    // Anthropic reports ~85% off a large (~55k-token) definition set. Set to 0.70,
    // below that headline, because the resident 3-5 tools are never deferred and
    // the saving lands only on cold / cache-miss turns (a cache-warm turn already
    // discounts the definitions to ~0.1x, so deferral buys almost nothing there).
    reduction: 0.70,
    // The reason this holds up where progressive disclosure disappoints: the search
    // runs server-side INSIDE the same request, so there is no extra client round
    // trip per novel tool call. 1.0 = call count unchanged.
    roundTripMultiplier: 1.0,
    evidence: {
      source: "Anthropic API docs, Tool Search (GA tool_search_tool_bm25/regex_20251119); claude-api skill 2026-11",
      claim:
        "Anthropic reports a ~55,000-token tool-definition set reduced by over 85%, loading only the 3-5 tools a " +
        "turn needs; deferred tools are retrieved by a server-side search in the same request, so unlike a client-" +
        "side router it adds no extra round trip. Supported on Claude 4.5 and later.",
    },
  },
  codeMode: {
    id: "code-mode",
    description:
      "Expose a handful of meta-tools (list, describe, call, call-sequential) and let the model write code that " +
      "orchestrates the real tools in a sandbox, so it never sees the full definitions. Cuts the prompt and the " +
      "number of calls at the same time.",
    risk: "needs-verification",
    targets: ["toolSchemas"],
    // Bifrost measured 92.8% at 508 tools; Anthropic reported 150k -> 2k (98.7%).
    reduction: 0.9,
    // The reason this one holds up: 3-4x fewer round trips, modelled at the
    // conservative end of that range.
    roundTripMultiplier: 0.35,
    evidence: {
      source: "Bifrost code mode benchmarks; Anthropic engineering on code execution with MCP",
      claim:
        "Bifrost cut input tokens up to 92.8% at 508 tools with a 100% pass rate and ran ~40% faster, needing " +
        "3-4x fewer round trips. Anthropic reported a workflow falling from 150,000 to 2,000 tokens (98.7%) " +
        "rewritten as code execution. Requires a sandbox and changes how the agent is built.",
    },
  },
  retrievedContextPruning: {
    id: "retrieved-context-pruning",
    description:
      "Rerank retrieved chunks and keep only those that add information, instead of passing a fixed large top-k.",
    risk: "needs-verification",
    targets: ["retrievedContext"],
    // Sources span 50-90%; held well below that.
    reduction: 0.6,
    evidence: {
      source: "arXiv:2601.17532 (Information Gain Pruning), AWS Bedrock query-aware compression",
      claim:
        "IGP cut final-stage input tokens 76-79% while improving average F1 by 12-20%; rerank plus compression " +
        "reached 10.1x fewer tokens at 36% cost saving; right-sized chunks with top-k 3-8 cut context 50-90%.",
    },
  },
  promptCompression: {
    id: "prompt-compression",
    description:
      "Token-level compression of the variable prompt body, dropping tokens a small model judges predictable.",
    risk: "needs-verification",
    targets: ["history", "retrievedContext"],
    // LLMLingua reports up to 20x (95%); 50% is far inside that.
    reduction: 0.5,
    evidence: {
      source: "arXiv:2403.12968 (LLMLingua-2), Microsoft Research",
      claim:
        "Up to 20x compression with a 1.5 point drop on GSM8K and BBH, and under 2% quality loss on CoQA, " +
        "HotpotQA and TriviaQA.",
    },
  },
  historyCompaction: {
    id: "history-compaction",
    description: "Summarise or window old conversation turns rather than resending every turn verbatim.",
    risk: "needs-verification",
    targets: ["history"],
    reduction: 0.4,
    evidence: {
      source: "Provider guidance on context management; measured per workload by replay",
      claim: "Workload-specific. Conservative placeholder until measured on real traffic.",
    },
  },
  outputBudget: {
    id: "output-budget",
    description:
      "Match reasoning and output budget to task difficulty via reasoning_effort or budget_tokens, instead of " +
      "letting every request reason at full effort. Output is the expensive half of the bill: 5x input on " +
      "Sonnet 5.5 and 8x on gpt-5.",
    risk: "needs-verification",
    targets: ["output"],
    // TALE-EP reports 67%; held slightly below.
    reduction: 0.6,
    evidence: {
      source: "TALE-EP; arXiv:2508.17196 (BudgetThinker); provider reasoning-effort controls",
      claim:
        "67% average output token reduction at under 3% accuracy drop across seven datasets. On GSM8K accuracy " +
        "rose from 81.35% to 84.46% while mean output fell from 318 to 77 tokens, so shorter was also better.",
    },
  },
  duplicateContextRemoval: {
    id: "duplicate-context-removal",
    description:
      "Remove exact duplicate context blocks. Overlapping retrieval chunks and system prompts echoed into the " +
      "first user turn are routine; the model already has the text.",
    risk: "deterministic",
    targets: ["retrievedContext", "history"],
    reduction: 0.1,
    evidence: {
      source: "Measured directly from the customer's own traffic by dedupeRepeatedBlocks",
      claim: "Exact duplicates only, so removal cannot change the prompt's meaning.",
    },
  },
};

/**
 * Project the cost of a workload after a set of levers.
 *
 * Caching is applied last and only to stable segments that remain contiguous
 * from the start of the prompt, because providers match on an exact prefix: the
 * first segment that varies ends the cacheable region regardless of what follows.
 */
export function projectSavings(
  profile: WorkloadProfile,
  levers: Lever[],
  price: TokenPrice,
  options: { minimumCacheableTokens?: number } = {},
): SavingsProjection {
  if (!Number.isInteger(profile.requests) || profile.requests < 1) {
    throw new Error("A workload profile needs at least one request.");
  }
  for (const [segment, tokens] of Object.entries(profile.segments)) {
    if (!Number.isFinite(tokens) || tokens < 0) {
      throw new Error(`Segment ${segment} must hold a non-negative token count.`);
    }
  }
  for (const lever of levers) {
    assertFraction(lever.reduction, `Lever ${lever.id} reduction`);
    if (lever.roundTripMultiplier !== undefined &&
        (!Number.isFinite(lever.roundTripMultiplier) || lever.roundTripMultiplier <= 0)) {
      throw new Error(`Lever ${lever.id} roundTripMultiplier must be a positive finite number.`);
    }
  }
  const minimumCacheable = options.minimumCacheableTokens ?? 1024;
  const warnings: string[] = [];

  const remaining: Record<WorkloadSegment, number> = { ...profile.segments };
  const inputTokensBefore = INPUT_SEGMENTS.reduce((sum, segment) => sum + profile.segments[segment], 0);
  const outputTokensBefore = profile.segments.output;

  // A lever that changes how many calls a task takes scales the whole bill, so
  // cost is always requests x multiplier x per-call cost.
  let callMultiplier = 1;
  const costOf = (input: number, output: number): number =>
    estimateTokenCost(input, output, price) * profile.requests * callMultiplier;

  const baselineCostUsd = costOf(inputTokensBefore, outputTokensBefore);
  let runningCost = baselineCostUsd;
  const contributions: LeverContribution[] = [];

  for (const lever of levers) {
    let tokensRemoved = 0;
    for (const segment of lever.targets) {
      const removed = remaining[segment] * lever.reduction;
      remaining[segment] -= removed;
      tokensRemoved += removed;
    }
    callMultiplier *= lever.roundTripMultiplier ?? 1;
    const input = INPUT_SEGMENTS.reduce((sum, segment) => sum + remaining[segment], 0);
    const cost = costOf(input, remaining.output);
    const costRemovedUsd = runningCost - cost;
    contributions.push({
      lever: lever.id,
      risk: lever.risk,
      tokensRemoved: tokensRemoved * profile.requests,
      costRemovedUsd,
      sharePercent: baselineCostUsd === 0 ? 0 : (costRemovedUsd / baselineCostUsd) * 100,
      evidence: lever.evidence,
    });
    runningCost = cost;
  }

  // Caching: walk the prompt in stable-segment order and stop at the first gap.
  let cacheableTokens = 0;
  for (const segment of profile.stableSegments) {
    if (!INPUT_SEGMENTS.includes(segment)) {
      warnings.push(`Segment ${segment} cannot be part of a cached prefix and was ignored for caching.`);
      continue;
    }
    cacheableTokens += remaining[segment];
  }
  const inputTokensAfter = INPUT_SEGMENTS.reduce((sum, segment) => sum + remaining[segment], 0);

  if (price.cachedInputPerMillion === undefined) {
    if (cacheableTokens > 0) {
      warnings.push("The supplied price has no cached-input rate, so no caching saving is projected.");
    }
    cacheableTokens = 0;
  } else if (cacheableTokens < minimumCacheable) {
    if (cacheableTokens > 0) {
      warnings.push(
        `The stable prefix is ${Math.round(cacheableTokens)} tokens, below the provider's ${minimumCacheable}-token ` +
        "cacheable minimum, so no caching saving is projected.",
      );
    }
    cacheableTokens = 0;
  }
  if (profile.requests === 1 && cacheableTokens > 0) {
    warnings.push("A single request cannot benefit from a prefix cache; it only populates it.");
    cacheableTokens = 0;
  }

  let projectedCostUsd = runningCost;
  if (cacheableTokens > 0) {
    const body = inputTokensAfter - cacheableTokens;
    // The first request populates the cache, the rest read it.
    const write = price.cacheWriteInputPerMillion === undefined
      ? estimateTokenCost(cacheableTokens, 0, price)
      : estimateTokenCost(cacheableTokens, 0, price, { cacheWriteInputTokens: cacheableTokens });
    const read = estimateTokenCost(cacheableTokens, 0, price, { cachedInputTokens: cacheableTokens });
    const perRequestRest = estimateTokenCost(body, remaining.output, price);
    const calls = profile.requests * callMultiplier;
    // The prefix is written once however many calls follow it.
    const cached = write + Math.max(0, calls - 1) * read + calls * perRequestRest;
    contributions.push({
      lever: "prefix-caching",
      risk: "deterministic",
      tokensRemoved: 0,
      costRemovedUsd: projectedCostUsd - cached,
      sharePercent: baselineCostUsd === 0 ? 0 : ((projectedCostUsd - cached) / baselineCostUsd) * 100,
      evidence: {
        source: "Provider published rates, captured in model-prices.ts",
        claim:
          "Cached input is billed at a fraction of fresh input (Sonnet 5.5 $2.00 to $0.10; gpt-5 $1.25 to $0.125). " +
          "The same tokens are sent and the same answer returns, so only the rate changes.",
      },
    });
    projectedCostUsd = cached;
  }

  const savingUsd = baselineCostUsd - projectedCostUsd;
  const share = (risk: LeverRisk): number => contributions
    .filter((contribution) => contribution.risk === risk)
    .reduce((sum, contribution) => sum + contribution.sharePercent, 0);

  return {
    workload: profile.name,
    requests: profile.requests,
    baselineCostUsd,
    projectedCostUsd,
    savingUsd,
    savingPercent: baselineCostUsd === 0 ? 0 : (savingUsd / baselineCostUsd) * 100,
    deterministicSavingPercent: share("deterministic"),
    needsVerificationSavingPercent: share("needs-verification"),
    contributions,
    inputTokensBefore: inputTokensBefore * profile.requests,
    inputTokensAfter: inputTokensAfter * profile.requests * callMultiplier,
    outputTokensBefore: outputTokensBefore * profile.requests,
    outputTokensAfter: remaining.output * profile.requests * callMultiplier,
    cachedInputTokens: cacheableTokens * profile.requests * callMultiplier,
    roundTripsBefore: profile.requests,
    roundTripsAfter: profile.requests * callMultiplier,
    warnings,
  };
}

/**
 * Workload shapes the levers behave very differently on. The headline number a
 * customer sees depends far more on which of these they are than on anything
 * MESH does, which is why one global percentage would be misleading.
 */
export const WORKLOAD_ARCHETYPES: Record<string, WorkloadProfile> = {
  /** Coding or ops agent with several MCP servers connected. Catalogue dominates. */
  toolHeavyAgent: {
    name: "Tool-heavy agent (6 MCP servers)",
    requests: 1_000,
    segments: {
      toolSchemas: 60_000,
      systemPrompt: 5_000,
      retrievedContext: 0,
      history: 20_000,
      userTurn: 500,
      output: 2_000,
    },
    stableSegments: ["toolSchemas", "systemPrompt"],
  },
  /** Support assistant: long fixed instructions, short varied questions. */
  supportAssistant: {
    name: "Support assistant",
    requests: 10_000,
    segments: {
      toolSchemas: 2_000,
      systemPrompt: 8_000,
      retrievedContext: 4_000,
      history: 1_500,
      userTurn: 300,
      output: 400,
    },
    stableSegments: ["toolSchemas", "systemPrompt"],
  },
  /** Document QA over retrieval. Retrieved context dominates. */
  ragDocumentQa: {
    name: "RAG document QA",
    requests: 10_000,
    segments: {
      toolSchemas: 0,
      systemPrompt: 1_200,
      retrievedContext: 12_000,
      history: 0,
      userTurn: 200,
      output: 600,
    },
    stableSegments: ["systemPrompt"],
  },
  /** Reasoning-heavy evaluation or analysis. Output dominates the bill. */
  reasoningHeavy: {
    name: "Reasoning-heavy analysis",
    requests: 5_000,
    segments: {
      toolSchemas: 0,
      systemPrompt: 2_000,
      retrievedContext: 1_000,
      history: 0,
      userTurn: 800,
      output: 8_000,
    },
    stableSegments: ["systemPrompt"],
  },
  /** One-shot varied prompts with nothing shared. The honest worst case. */
  oneShotVaried: {
    name: "One-shot varied prompts",
    requests: 10_000,
    segments: {
      toolSchemas: 0,
      systemPrompt: 200,
      retrievedContext: 0,
      history: 0,
      userTurn: 1_500,
      output: 700,
    },
    stableSegments: [],
  },
};

/** Levers applicable to a profile, in the order they should be applied. */
export function leversFor(profile: WorkloadProfile): Lever[] {
  const order = [
    PUBLISHED_LEVERS.toolSchemaCompaction!,
    PUBLISHED_LEVERS.unusedToolRemoval!,
    PUBLISHED_LEVERS.toolSchemaMinification!,
    PUBLISHED_LEVERS.duplicateContextRemoval!,
    PUBLISHED_LEVERS.retrievedContextPruning!,
    PUBLISHED_LEVERS.historyCompaction!,
    PUBLISHED_LEVERS.promptCompression!,
    PUBLISHED_LEVERS.outputBudget!,
  ];
  return order.filter((lever) =>
    lever.targets.some((segment) => (profile.segments[segment] ?? 0) > 0));
}
