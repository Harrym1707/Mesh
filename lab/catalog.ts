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
    featureInputs: ["structural-counts", "token-counts", "aggregated-telemetry"],
    changesCustomerApplication: false,
    expectedTokenReductionPercent: 18,
    // Spec-only + needs a fat-tool-result capture that does not exist yet.
    techniqueId: "stale-tool-result-compaction",
    defaultParams: { ageTurns: 6 },
    datasetFixtureId: "rag-duplicate-passages",
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
