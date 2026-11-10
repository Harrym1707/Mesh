// The Scout's seed catalogue of optimisation techniques.
//
// Entries are distilled from the existing hand-maintained lever backlog
// (docs/rnd/lever-backlog.md) and the scout syntheses (docs/rnd/scout/*). Each
// carries the fields a lead needs: control surface, declared blind-feature
// inputs, whether it would touch the customer's application, a rough expected
// saving, and — where one exists — a runnable registry technique + a fixture to
// measure against. The catalogue deliberately includes:
//   - runnable, content-blind winners (dedup, whitespace) that should promote;
//   - spec-only leads with a measurement plan but no implementation yet
//     (cache-TTL, stale-tool compaction) that should evaluate INCONCLUSIVE;
//   - a lead that would rewrite the customer's prompts, which Research must
//     reject on the content-blind / Mesh-side-only constraints.

import type { OptimisationLead, OptimisationCategory, ResearchBucket } from "./types.js";

export type CatalogEntry = Omit<OptimisationLead, "source"> & {
  category: OptimisationCategory;
  bucket: ResearchBucket;
};

export const CATALOG: CatalogEntry[] = [
  {
    title: "Exact duplicate-block removal in retrieved context",
    description:
      "RAG pipelines re-send the same passage across overlapping chunks. Dropping later exact copies is lossless: the model already has the text.",
    category: "deduplication",
    bucket: "core",
    techniqueKey: "dedupe-repeated-blocks",
    hypothesis:
      "Removing exact duplicate blocks from retrieved context cuts input tokens with zero quality impact (the model's visible content is unchanged).",
    controlSurface: "deduplication",
    featureInputs: ["structural-counts", "token-counts", "keyed-prefix-hash"],
    changesCustomerApplication: false,
    expectedTokenReductionPercent: 25,
    techniqueId: "dedupe-repeated-blocks",
    defaultParams: { minimumBlockTokens: 20 },
    datasetFixtureId: "rag-duplicate-passages",
  },
  {
    title: "Redundant-whitespace collapse",
    description:
      "Collapse runs of whitespace outside fenced/inline code, where layout is meaningful. Individually tiny, compounding across every request.",
    category: "compaction",
    bucket: "core",
    techniqueKey: "collapse-whitespace",
    hypothesis:
      "Collapsing redundant whitespace reduces input tokens losslessly on prose-heavy prompts.",
    controlSurface: "context-compaction",
    featureInputs: ["token-counts", "structural-counts"],
    changesCustomerApplication: false,
    expectedTokenReductionPercent: 5,
    techniqueId: "collapse-whitespace",
    defaultParams: {},
    datasetFixtureId: "padded-whitespace",
  },
  {
    title: "Lossless dedup + whitespace compaction stack",
    description:
      "Chain exact-duplicate removal and whitespace collapse. Adjacent to the two core levers; measures the stacked lossless win.",
    category: "compaction",
    bucket: "adjacent",
    techniqueKey: "dedupe-then-collapse",
    hypothesis:
      "Stacking the two lossless reducers compounds their savings without compounding risk.",
    controlSurface: "context-compaction",
    featureInputs: ["token-counts", "structural-counts", "keyed-prefix-hash"],
    changesCustomerApplication: false,
    expectedTokenReductionPercent: 28,
    techniqueId: "dedupe-then-collapse",
    defaultParams: { minimumBlockTokens: 20 },
    datasetFixtureId: "rag-duplicate-passages",
  },
  {
    title: "Cadence-aware cache-TTL policy (5m/1h selection)",
    description:
      "Choose cache TTL per prefix from observed inter-arrival timing: <5m gaps keep 5m, 5m–60m layer 1h over the frozen core. Lossless; metadata only.",
    category: "cache-placement",
    bucket: "core",
    techniqueKey: "cache-ttl-policy",
    hypothesis:
      "Selecting cache TTL from the inter-arrival histogram beats a fixed 5m policy on human-paced traffic.",
    controlSurface: "cache-placement",
    shape: "always-on-agent",
    featureInputs: ["inter-arrival-timing", "keyed-prefix-hash", "aggregated-telemetry"],
    changesCustomerApplication: false,
    expectedTokenReductionPercent: 12,
    // Spec-only: a measurement plan exists but no runnable implementation yet,
    // and no capture carries timestamps — so this should evaluate INCONCLUSIVE.
    techniqueId: "cache-ttl-policy",
    defaultParams: { shortTtlSeconds: 300, longTtlSeconds: 3600 },
    datasetFixtureId: "rag-duplicate-passages",
  },
  {
    title: "Stale tool-result compaction (age-based masking)",
    description:
      "Age-based masking of stale tool_result bodies on cache-cold traffic. Adjacent compaction lever; lossy, so gate-required.",
    category: "compaction",
    bucket: "adjacent",
    techniqueKey: "stale-tool-result-compaction",
    hypothesis:
      "Masking stale tool-result bodies that fall outside any live cached prefix reduces tokens without changing the agent's next action.",
    controlSurface: "context-compaction",
    shape: "autonomous-agent",
    featureInputs: ["structural-counts", "token-counts", "aggregated-telemetry"],
    changesCustomerApplication: false,
    expectedTokenReductionPercent: 18,
    // Spec-only + needs a fat-tool-result capture that does not exist yet.
    techniqueId: "stale-tool-result-compaction",
    defaultParams: { ageTurns: 6 },
    datasetFixtureId: "rag-duplicate-passages",
  },
  {
    title: "JSON tool-result minification",
    description:
      "Lab-generated. Agent loops re-send pretty-printed JSON tool results whose indentation the model never needs. Minifying JSON inside fenced blocks is lossless to the model and attacks the fat-tool-result cost the lever backlog (P7) flags.",
    category: "compaction",
    bucket: "core",
    techniqueKey: "minify-json-blocks",
    hypothesis:
      "Stripping whitespace from JSON tool-result bodies reduces input tokens with no change to the values the model reads.",
    shape: "autonomous-agent",
    controlSurface: "context-compaction",
    featureInputs: ["structural-counts", "token-counts"],
    changesCustomerApplication: false,
    expectedTokenReductionPercent: 12,
    techniqueId: "minify-json-blocks",
    defaultParams: {},
    datasetFixtureId: "json-tool-results",
  },
  {
    title: "Tool-schema compaction (lossless plumbing + title strip)",
    description:
      "Agentic lever. Tool schemas dominate every cold/cache-miss agent turn and carry JSON-Schema plumbing ($schema/$id/$comment) and titles that restate property names — none of which the model reads. Stripping them is lossless (core keeps descriptions by default).",
    category: "compaction",
    bucket: "core",
    techniqueKey: "minify-tool-schemas",
    hypothesis:
      "Removing tool-schema plumbing and redundant titles cuts input tokens on agent turns with no change to tool selection.",
    shape: "autonomous-agent",
    controlSurface: "context-compaction",
    featureInputs: ["structural-counts", "token-counts", "keyed-prefix-hash"],
    changesCustomerApplication: false,
    expectedTokenReductionPercent: 10,
    techniqueId: "minify-tool-schemas",
    defaultParams: {},
    datasetFixtureId: "agent-tool-schemas",
  },
  {
    title: "Always-on agent history-prefix dedup",
    description:
      "Agentic lever (highest-priority vertical). Long-lived agents re-send the same large system+tools prefix every turn. Dropping the exact-duplicate re-sends is lossless — the model already has the text — and this is where most always-on spend sits.",
    category: "deduplication",
    bucket: "core",
    techniqueKey: "agent-history-prefix-dedup",
    hypothesis:
      "Removing exact-duplicate re-sent system/history prefixes from always-on agent turns cuts input tokens with zero quality impact.",
    shape: "always-on-agent",
    controlSurface: "deduplication",
    featureInputs: ["keyed-prefix-hash", "structural-counts", "token-counts"],
    changesCustomerApplication: false,
    expectedTokenReductionPercent: 30,
    techniqueId: "dedupe-repeated-blocks",
    defaultParams: { minimumBlockTokens: 16 },
    datasetFixtureId: "agent-history-resend",
  },
  {
    title: "Lossy tool-schema description pruning",
    description:
      "Agentic lever. Truncating or dropping verbose tool descriptions on worker routes saves more than the lossless tier — but descriptions are how the model chooses between tools, so it is lossy and needs a task-completion gate.",
    category: "compaction",
    bucket: "adjacent",
    techniqueKey: "tool-schema-description-prune",
    hypothesis:
      "Pruning tool descriptions on opt-in worker routes reduces tokens while holding tool-selection accuracy.",
    shape: "autonomous-agent",
    controlSurface: "context-compaction",
    featureInputs: ["structural-counts", "token-counts", "route-id"],
    changesCustomerApplication: false,
    expectedTokenReductionPercent: 20,
    // Spec-only: lossy, so it needs a real task-completion grader before it can
    // be measured — INCONCLUSIVE until then.
    techniqueId: "tool-schema-description-prune",
    defaultParams: { descriptions: "truncate", maximumDescriptionTokens: 16 },
    datasetFixtureId: "agent-tool-schemas",
  },
  {
    title: "Agent output re-emission metering",
    description:
      "Agentic lever (always-on vertical). Agents re-emit prior output into later turns; metering and diffing re-emitted output avoids re-billing content the agent already produced. Lossy/diff-shaped, so gate-required.",
    category: "output-caps",
    bucket: "adjacent",
    techniqueKey: "output-reemission-metering",
    hypothesis:
      "Diffing re-emitted agent output against prior turns avoids re-paying for content already generated.",
    shape: "always-on-agent",
    controlSurface: "output-caps",
    featureInputs: ["structural-counts", "token-counts", "keyed-prefix-hash"],
    changesCustomerApplication: false,
    expectedTokenReductionPercent: 15,
    techniqueId: "output-reemission-metering",
    defaultParams: {},
    datasetFixtureId: "agent-history-resend",
  },
  {
    title: "Proxy-side output-conciseness governor (Mesh reframe of Ponytail)",
    description:
      "Lab-generated. Captures Ponytail's lever — constrain a verbose agent's output — without its delivery: instead of editing the customer's repo config, Mesh transiently injects a terse-output directive (or uses provider effort dials) into the outgoing request on opt-in worker routes. The customer's application is untouched; lossy, so gated on a customer task-completion metric.",
    category: "output-caps",
    bucket: "adjacent",
    techniqueKey: "output-conciseness-governor",
    hypothesis:
      "A proxy-injected conciseness directive on opt-in worker routes reduces output tokens while holding task completion within the quality ceiling.",
    controlSurface: "output-caps",
    shape: "autonomous-agent",
    featureInputs: ["route-id", "model-id", "structural-counts"],
    changesCustomerApplication: false,
    expectedTokenReductionPercent: 20,
    // Spec-only: needs a real implementation and, critically, a customer
    // task-completion grader before it can be measured — INCONCLUSIVE until then.
    techniqueId: "output-conciseness-governor",
    defaultParams: { routes: "worker-only", directive: "concise" },
    datasetFixtureId: "json-tool-results",
  },
  {
    title: "Cross-request system-prefix cache coalescing",
    description:
      "Lab-generated. Uses keyed prefix hashes to spot identical system/tool prefixes re-sent uncached across requests, and ensures a single cached copy so later requests read the prefix instead of re-paying for it. Lossless; cache metadata only, model-read bytes identical.",
    category: "cache-placement",
    bucket: "adjacent",
    techniqueKey: "system-prefix-cache-coalesce",
    hypothesis:
      "Coalescing repeated uncached system/tool prefixes onto one cache entry converts prefix rewrites into cheap reads.",
    controlSurface: "cache-placement",
    shape: "always-on-agent",
    featureInputs: ["keyed-prefix-hash", "structural-counts", "inter-arrival-timing"],
    changesCustomerApplication: false,
    expectedTokenReductionPercent: 14,
    techniqueId: "system-prefix-cache-coalesce",
    defaultParams: {},
    datasetFixtureId: "rag-duplicate-passages",
  },
  {
    title: "Local-embedding semantic chunk dedup",
    description:
      "Lab-generated. Exact dedup misses near-duplicate retrieved chunks. On-machine embeddings (no content leaves the box) drop semantically redundant passages. Lossy, so gate-required; exploratory upside beyond exact-match dedup.",
    category: "rag-efficiency",
    bucket: "exploratory",
    techniqueKey: "semantic-chunk-dedup",
    hypothesis:
      "Dropping near-duplicate retrieved chunks by local-embedding similarity reduces input tokens while holding answer quality.",
    controlSurface: "deduplication",
    featureInputs: ["structural-counts", "token-counts"],
    changesCustomerApplication: false,
    expectedTokenReductionPercent: 22,
    techniqueId: "semantic-chunk-dedup",
    defaultParams: { similarityThreshold: 0.92 },
    datasetFixtureId: "rag-duplicate-passages",
  },
  {
    title: "Stable-prefix caching — agents",
    description:
      "Mesh's core lever. Long-running and tool-using agents re-send a large stable system+tools prefix every turn; caching it and billing at the provider's read rate (~0.1x) is lossless (content byte-identical) and is the single biggest consumer-token saving.",
    category: "cache-placement",
    bucket: "core",
    techniqueKey: "cache-prefix-agents",
    hypothesis:
      "Caching the stable system+tools prefix of agent turns and billing it at the read rate cuts input tokens with zero quality impact.",
    shape: "always-on-agent",
    controlSurface: "cache-placement",
    featureInputs: ["keyed-prefix-hash", "inter-arrival-timing", "token-counts"],
    changesCustomerApplication: false,
    expectedTokenReductionPercent: 70,
    techniqueId: "cache-prefix-read",
    defaultParams: { readMultiplier: 0.1 },
    datasetFixtureId: "agent-session",
  },
  {
    title: "Stable-prefix caching — chat",
    description:
      "Caching the stable system prompt across a chat conversation and billing it at the read rate. Lossless; the biggest-weight consumer workload.",
    category: "cache-placement",
    bucket: "core",
    techniqueKey: "cache-prefix-chat",
    hypothesis:
      "Caching the stable chat system prompt and billing it at the read rate cuts input tokens with zero quality impact.",
    shape: "always-on-agent",
    controlSurface: "cache-placement",
    featureInputs: ["keyed-prefix-hash", "inter-arrival-timing", "token-counts"],
    changesCustomerApplication: false,
    expectedTokenReductionPercent: 45,
    techniqueId: "cache-prefix-read",
    defaultParams: { readMultiplier: 0.1 },
    datasetFixtureId: "chat-session",
  },
  {
    title: "Full lossless stack — coding agent",
    description:
      "Captures every lossless feature a coding-agent turn carries at once: the re-read duplicate file, the pretty-printed JSON test result, and layout whitespace. Strictly beats any single reducer on the realistic shape.",
    category: "compaction",
    bucket: "core",
    techniqueKey: "full-stack-coding",
    hypothesis:
      "A combined lossless pass (dedup + JSON minify + whitespace) saves more on coding-agent turns than any single reducer, with zero quality impact.",
    shape: "autonomous-agent",
    controlSurface: "context-compaction",
    featureInputs: ["keyed-prefix-hash", "structural-counts", "token-counts"],
    changesCustomerApplication: false,
    expectedTokenReductionPercent: 40,
    techniqueId: "full-lossless-stack",
    defaultParams: { minimumBlockTokens: 16 },
    datasetFixtureId: "coding-agent",
  },
  {
    title: "Full lossless stack — chat",
    description:
      "Combined lossless pass on chat requests: drop the echoed system prompt and collapse layout whitespace in one pass.",
    category: "compaction",
    bucket: "core",
    techniqueKey: "full-stack-chat",
    hypothesis:
      "A combined lossless pass saves more on chat than echo-dedup alone, with zero quality impact.",
    shape: "always-on-agent",
    controlSurface: "context-compaction",
    featureInputs: ["keyed-prefix-hash", "structural-counts", "token-counts"],
    changesCustomerApplication: false,
    expectedTokenReductionPercent: 30,
    techniqueId: "full-lossless-stack",
    defaultParams: { minimumBlockTokens: 16 },
    datasetFixtureId: "chat-conversation",
  },
  {
    title: "Full lossless stack — always-on agent",
    description:
      "Combined lossless pass on always-on agent turns: drop re-sent history prefixes and collapse whitespace in one pass.",
    category: "compaction",
    bucket: "adjacent",
    techniqueKey: "full-stack-history",
    hypothesis:
      "A combined lossless pass saves more on always-on agent turns than prefix-dedup alone.",
    shape: "always-on-agent",
    controlSurface: "context-compaction",
    featureInputs: ["keyed-prefix-hash", "structural-counts", "token-counts"],
    changesCustomerApplication: false,
    expectedTokenReductionPercent: 60,
    techniqueId: "full-lossless-stack",
    defaultParams: { minimumBlockTokens: 16 },
    datasetFixtureId: "agent-history-resend",
  },
  {
    title: "Full lossless stack — RAG",
    description:
      "Combined lossless pass on RAG prompts: drop duplicate retrieved passages and collapse whitespace in one pass.",
    category: "compaction",
    bucket: "adjacent",
    techniqueKey: "full-stack-rag",
    hypothesis:
      "A combined lossless pass saves at least as much on RAG as passage-dedup alone.",
    shape: "one-shot",
    controlSurface: "context-compaction",
    featureInputs: ["keyed-prefix-hash", "structural-counts", "token-counts"],
    changesCustomerApplication: false,
    expectedTokenReductionPercent: 55,
    techniqueId: "full-lossless-stack",
    defaultParams: { minimumBlockTokens: 16 },
    datasetFixtureId: "rag-duplicate-passages",
  },
  {
    title: "Chat system-prompt echo dedup",
    description:
      "Biggest consumer workload. Frameworks often echo the full system prompt into the first user turn; dropping the exact-duplicate echo is lossless and helps every chat request.",
    category: "deduplication",
    bucket: "core",
    techniqueKey: "chat-prompt-echo-dedup",
    hypothesis:
      "Removing the echoed system prompt from chat requests cuts input tokens with zero quality impact.",
    shape: "always-on-agent",
    controlSurface: "deduplication",
    featureInputs: ["keyed-prefix-hash", "structural-counts", "token-counts"],
    changesCustomerApplication: false,
    expectedTokenReductionPercent: 14,
    techniqueId: "dedupe-repeated-blocks",
    defaultParams: { minimumBlockTokens: 16 },
    datasetFixtureId: "chat-conversation",
  },
  {
    title: "Coding-agent file re-read dedup",
    description:
      "Coding agents re-read the same file into context across turns. Dropping the exact-duplicate re-read is lossless and attacks a major share of coding-assistant spend.",
    category: "deduplication",
    bucket: "core",
    techniqueKey: "coding-context-dedup",
    hypothesis:
      "Removing re-read duplicate file blocks from coding-agent turns cuts input tokens with no quality impact.",
    shape: "autonomous-agent",
    controlSurface: "deduplication",
    featureInputs: ["keyed-prefix-hash", "structural-counts", "token-counts"],
    changesCustomerApplication: false,
    expectedTokenReductionPercent: 16,
    techniqueId: "dedupe-repeated-blocks",
    defaultParams: { minimumBlockTokens: 16 },
    datasetFixtureId: "coding-agent",
  },
  {
    title: "Reasoning-effort governor (thinking-token budget)",
    description:
      "The output frontier of agents. Reasoning models emit large thinking-token volumes; a per-route reasoning.effort / thinking-budget dial on opt-in worker routes cuts output spend. Lossy and output-side, so it needs a task-completion gate — the input fixtures cannot measure it.",
    category: "output-caps",
    bucket: "adjacent",
    techniqueKey: "reasoning-effort-governor",
    hypothesis:
      "Lowering reasoning effort on opt-in worker routes cuts thinking tokens while holding task completion.",
    shape: "autonomous-agent",
    controlSurface: "output-caps",
    featureInputs: ["route-id", "model-id", "structural-counts"],
    changesCustomerApplication: false,
    expectedTokenReductionPercent: 25,
    // Spec-only + output-side: needs a real implementation and a task-completion
    // grader, so it evaluates INCONCLUSIVE — the honest state of the frontier.
    techniqueId: "reasoning-effort-governor",
    defaultParams: { effort: "low", routes: "worker-only" },
    datasetFixtureId: "coding-agent",
  },
  {
    title: "Document-to-Markdown conversion (Microsoft MarkItDown)",
    description:
      "Microsoft's open-source MarkItDown (github.com/microsoft/markitdown) converts PDF/Office/HTML into compact, LLM-oriented Markdown. Applied in-path to verbose document payloads, it cuts input tokens; lossy, so gate-required, and must run on-machine so prompts never leave the box.",
    category: "rag-efficiency",
    bucket: "adjacent",
    techniqueKey: "markitdown-doc-to-markdown",
    hypothesis:
      "Converting verbose document formats to clean Markdown before the request is sent reduces input tokens with acceptable, gate-verified quality loss.",
    controlSurface: "context-compaction",
    // Decision inputs are structural (content-type, size); the transform runs
    // in-path like the other reducers, exposing content to no agent.
    featureInputs: ["structural-counts", "token-counts"],
    changesCustomerApplication: false,
    // Third-party blogs claim up to ~80%; unverified, so a conservative figure.
    expectedTokenReductionPercent: 30,
    // Spec-only: no runnable adapter or document fixture yet, so this should
    // evaluate INCONCLUSIVE until one is built and measured.
    techniqueId: "markitdown-doc-to-markdown",
    defaultParams: { formats: ["pdf", "docx", "pptx", "xlsx", "html"] },
    datasetFixtureId: "rag-duplicate-passages",
  },
  {
    title: "Agent output-bloat ruleset (Ponytail)",
    description:
      "Ponytail (github.com/DietrichGebert/ponytail) is a coding-agent ruleset/skill engine that constrains an AI agent to emit less code, cutting output tokens. It works by injecting rules into the customer's agent (.ponytail, CLAUDE.md, .cursorrules) — i.e. it changes the customer's own application, not Mesh's proxy layer.",
    category: "output-caps",
    bucket: "exploratory",
    techniqueKey: "ponytail-agent-ruleset",
    hypothesis:
      "A ruleset that constrains a coding agent's output reduces the tokens it generates.",
    controlSurface: "output-caps",
    featureInputs: [],
    // Out of scope for Mesh: it restructures the customer's agent, so Research
    // should reject it on the no-customer-app-changes constraint.
    changesCustomerApplication: true,
    expectedTokenReductionPercent: 54,
  },
  {
    title: "Rewrite customer prompts for brevity",
    description:
      "Shorten the customer's own prompts by paraphrasing them before sending. Would require reading and restructuring the customer's application content.",
    category: "other",
    bucket: "exploratory",
    techniqueKey: "customer-prompt-rewrite",
    hypothesis:
      "Paraphrasing customer prompts to be terser reduces input tokens.",
    controlSurface: "other-proxy-side",
    featureInputs: [],
    // Violates the content-blind + no-customer-app-change constraints.
    declaredForbiddenInputs: ["raw-prompt"],
    changesCustomerApplication: true,
    expectedTokenReductionPercent: 30,
  },
];

export function catalogEntryByKey(key: string): CatalogEntry | undefined {
  return CATALOG.find((entry) => entry.techniqueKey === key);
}
