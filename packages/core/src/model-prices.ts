import {
  validatePriceCatalogue,
  type ModelAlias,
  type ModelPriceEntry,
  type PriceCatalogue,
} from "./price-catalogue.js";

/**
 * Published list rates, read from each provider's own pricing page.
 *
 * `effectiveFrom` is the date the rate was OBSERVED, not the date the provider
 * introduced it, because published pages do not carry change history. A lookup
 * for an earlier billing date therefore returns `unpriced` instead of quietly
 * applying today's rate to last quarter's traffic. Backfill earlier rates with
 * their own dated entries when auditing older spend.
 *
 * Model keys are the names as published. Providers' marketing names and API
 * model identifiers do not always match, so map them explicitly for your own
 * traffic rather than assuming a key matches the string your SDK sends.
 */

const ANTHROPIC = {
  source: "https://claude.com/pricing",
  capturedOn: "2026-10-08",
  note: "Published display names; cache read/write rates as listed. 5m cache writes bill 1.25x base input, " +
    "1h cache writes 2x base input, per the published prompt-caching pricing.",
} as const;

const OPENAI = {
  source: "https://developers.openai.com/api/docs/pricing",
  capturedOn: "2026-10-08",
  note: "Standard tier unless the entry says otherwise.",
} as const;

// The Message Batches API discount, catalogued only because the pricing page now
// states it as a definitive, unhedged rate: "Save 50% with batch processing"
// (claude.com/pricing, verified 2026-10-27 — previously hedged as "typically"
// half, which is why these were not seeded before). The 50% is applied to the
// same published standard input/output/cached-input rates above; cache WRITE
// premiums under batch are not separately published, so they are left off these
// entries and price unpriced rather than guessed.
const ANTHROPIC_BATCH = {
  source: "https://claude.com/pricing",
  capturedOn: "2026-10-27",
  note: "Batch processing = 50% of standard, per the page's definitive \"Save 50% with " +
    "batch processing\". Derived by halving the dated standard rates; cache-write premiums " +
    "under batch are not published and are omitted (priced unpriced, never guessed).",
} as const;

// The rest of the Claude models Anthropic serves or still prices, read from the
// model pricing and batch processing tables on Anthropic's pricing page on
// 2026-11-25. They were missing: a request on claude-fable-5-2 or
// claude-haiku-4-5-20251001 (what Claude Code's `haiku` alias sent that day)
// resolved to nothing, so it was recorded unpriced and could never show a saving.
// Each row is the page's own figure; nothing here is derived from a multiplier.
// Dated from the day they were read, so earlier traffic stays unpriced.
const ANTHROPIC_2026_11_25 = {
  source: "https://platform.claude.com/docs/en/about-claude/pricing",
  capturedOn: "2026-11-25",
  note: "Model pricing table: base input, 5m cache writes, 1h cache writes, cache hits and refreshes, " +
    "output. Retired models are listed because the page still prices them for other cloud platforms.",
} as const;

const ANTHROPIC_BATCH_2026_11_25 = {
  source: "https://platform.claude.com/docs/en/about-claude/pricing",
  capturedOn: "2026-11-25",
  note: "Batch processing table: batch input and batch output as listed. Cache rates under batch " +
    "are not listed per model and are omitted (priced unpriced, never guessed).",
} as const;

// DeepSeek publishes TIME-OF-DAY pricing: off-peak rates are half the peak
// rates, with peak hours 01:00-04:00 and 06:00-10:00 UTC Mon-Fri (excluding
// Chinese public holidays), everything else off-peak. The catalogue has no
// time-of-day dimension, so these entries use the OFF-PEAK (lower) rate: MESH
// then never OVER-values a DeepSeek saving, and conservatively under-counts it
// during the peak windows until a time-of-day rate dimension lands. Current API
// models are deepseek-flash and deepseek-v4-pro (deepseek-v4-flash is a legacy
// alias billed at the Flash rate). Read from DeepSeek's own pricing page.
const DEEPSEEK = {
  source: "https://api-docs.deepseek.com/quick_start/pricing",
  capturedOn: "2026-11-03",
  note: "Off-peak list rates (peak is 2x in the 01-10 UTC weekday windows); catalogued at " +
    "off-peak so a saving is never over-valued. Per 1M tokens.",
} as const;

const OBSERVED_FROM = "2026-10-08";

type Rates = {
  input: number;
  output: number;
  cachedInput?: number;
  cacheWriteInput?: number;
  cacheWrite1hInput?: number;
  maxInputTokens?: number;
};

function entry(
  provider: string,
  model: string,
  provenance: ModelPriceEntry["provenance"],
  bands: Rates[],
  mode: ModelPriceEntry["mode"] = "standard",
  effectiveFrom: string = OBSERVED_FROM,
): ModelPriceEntry {
  return {
    provider,
    model,
    mode,
    effectiveFrom,
    provenance,
    tiers: bands.map((band) => ({
      ...(band.maxInputTokens === undefined ? {} : { maxInputTokens: band.maxInputTokens }),
      inputPerMillion: band.input,
      outputPerMillion: band.output,
      ...(band.cachedInput === undefined ? {} : { cachedInputPerMillion: band.cachedInput }),
      ...(band.cacheWriteInput === undefined ? {} : { cacheWriteInputPerMillion: band.cacheWriteInput }),
      ...(band.cacheWrite1hInput === undefined ? {} : { cacheWrite1hInputPerMillion: band.cacheWrite1hInput }),
    })),
  };
}

const anthropic: ModelPriceEntry[] = [
  entry("anthropic", "Fable 5.1", ANTHROPIC, [
    { input: 10, output: 50, cachedInput: 0.25, cacheWriteInput: 12.5, cacheWrite1hInput: 20 },
  ]),
  entry("anthropic", "Opus 5.5", ANTHROPIC, [
    { input: 4, output: 20, cachedInput: 0.2, cacheWriteInput: 5, cacheWrite1hInput: 8 },
  ]),
  entry("anthropic", "Sonnet 5.5", ANTHROPIC, [
    { input: 2, output: 10, cachedInput: 0.1, cacheWriteInput: 2.5, cacheWrite1hInput: 4 },
  ]),
  // Haiku 5.5 is tiered by prompt size: the higher band applies above 100K input tokens.
  entry("anthropic", "Haiku 5.5", ANTHROPIC, [
    { maxInputTokens: 100_000, input: 0.1, output: 0.5, cachedInput: 0.01, cacheWriteInput: 0.125, cacheWrite1hInput: 0.2 },
    { input: 0.5, output: 2.5, cachedInput: 0.05, cacheWriteInput: 0.625, cacheWrite1hInput: 1 },
  ]),

  // Batch mode: 50% of standard, per the definitive "Save 50% with batch processing"
  // (ANTHROPIC_BATCH provenance). Each rate is exactly half its standard entry above.
  entry("anthropic", "Fable 5.1", ANTHROPIC_BATCH, [
    { input: 5, output: 25, cachedInput: 0.125 },
  ], "batch", "2026-10-27"),
  entry("anthropic", "Opus 5.5", ANTHROPIC_BATCH, [
    { input: 2, output: 10, cachedInput: 0.1 },
  ], "batch", "2026-10-27"),
  entry("anthropic", "Sonnet 5.5", ANTHROPIC_BATCH, [
    { input: 1, output: 5, cachedInput: 0.05 },
  ], "batch", "2026-10-27"),
  entry("anthropic", "Haiku 5.5", ANTHROPIC_BATCH, [
    { maxInputTokens: 100_000, input: 0.05, output: 0.25, cachedInput: 0.005 },
    { input: 0.25, output: 1.25, cachedInput: 0.025 },
  ], "batch", "2026-10-27"),

  // Every other model on the pricing page (ANTHROPIC_2026_11_25 provenance).
  entry("anthropic", "Fable 5.2", ANTHROPIC_2026_11_25, [
    { input: 8, output: 40, cachedInput: 0.2, cacheWriteInput: 10, cacheWrite1hInput: 16 },
  ], "standard", "2026-11-25"),
  entry("anthropic", "Mythos 5.2", ANTHROPIC_2026_11_25, [
    { input: 8, output: 40, cachedInput: 0.2, cacheWriteInput: 10, cacheWrite1hInput: 16 },
  ], "standard", "2026-11-25"),
  entry("anthropic", "Mythos 5.1", ANTHROPIC_2026_11_25, [
    { input: 10, output: 50, cachedInput: 0.25, cacheWriteInput: 12.5, cacheWrite1hInput: 20 },
  ], "standard", "2026-11-25"),
  entry("anthropic", "Fable 5", ANTHROPIC_2026_11_25, [
    { input: 10, output: 50, cachedInput: 1, cacheWriteInput: 12.5, cacheWrite1hInput: 20 },
  ], "standard", "2026-11-25"),
  entry("anthropic", "Mythos 5", ANTHROPIC_2026_11_25, [
    { input: 10, output: 50, cachedInput: 1, cacheWriteInput: 12.5, cacheWrite1hInput: 20 },
  ], "standard", "2026-11-25"),
  entry("anthropic", "Opus 5", ANTHROPIC_2026_11_25, [
    { input: 5, output: 25, cachedInput: 0.5, cacheWriteInput: 6.25, cacheWrite1hInput: 10 },
  ], "standard", "2026-11-25"),
  entry("anthropic", "Opus 4.8", ANTHROPIC_2026_11_25, [
    { input: 5, output: 25, cachedInput: 0.5, cacheWriteInput: 6.25, cacheWrite1hInput: 10 },
  ], "standard", "2026-11-25"),
  entry("anthropic", "Opus 4.7", ANTHROPIC_2026_11_25, [
    { input: 5, output: 25, cachedInput: 0.5, cacheWriteInput: 6.25, cacheWrite1hInput: 10 },
  ], "standard", "2026-11-25"),
  entry("anthropic", "Opus 4.6", ANTHROPIC_2026_11_25, [
    { input: 5, output: 25, cachedInput: 0.5, cacheWriteInput: 6.25, cacheWrite1hInput: 10 },
  ], "standard", "2026-11-25"),
  entry("anthropic", "Opus 4.5", ANTHROPIC_2026_11_25, [
    { input: 5, output: 25, cachedInput: 0.5, cacheWriteInput: 6.25, cacheWrite1hInput: 10 },
  ], "standard", "2026-11-25"),
  entry("anthropic", "Opus 4.1", ANTHROPIC_2026_11_25, [
    { input: 15, output: 75, cachedInput: 1.5, cacheWriteInput: 18.75, cacheWrite1hInput: 30 },
  ], "standard", "2026-11-25"),
  entry("anthropic", "Opus 4", ANTHROPIC_2026_11_25, [
    { input: 15, output: 75, cachedInput: 1.5, cacheWriteInput: 18.75, cacheWrite1hInput: 30 },
  ], "standard", "2026-11-25"),
  entry("anthropic", "Sonnet 5", ANTHROPIC_2026_11_25, [
    { input: 2, output: 10, cachedInput: 0.2, cacheWriteInput: 2.5, cacheWrite1hInput: 4 },
  ], "standard", "2026-11-25"),
  entry("anthropic", "Sonnet 4.6", ANTHROPIC_2026_11_25, [
    { input: 3, output: 15, cachedInput: 0.3, cacheWriteInput: 3.75, cacheWrite1hInput: 6 },
  ], "standard", "2026-11-25"),
  entry("anthropic", "Sonnet 4.5", ANTHROPIC_2026_11_25, [
    { input: 3, output: 15, cachedInput: 0.3, cacheWriteInput: 3.75, cacheWrite1hInput: 6 },
  ], "standard", "2026-11-25"),
  entry("anthropic", "Sonnet 4", ANTHROPIC_2026_11_25, [
    { input: 3, output: 15, cachedInput: 0.3, cacheWriteInput: 3.75, cacheWrite1hInput: 6 },
  ], "standard", "2026-11-25"),
  entry("anthropic", "Haiku 4.5", ANTHROPIC_2026_11_25, [
    { input: 1, output: 5, cachedInput: 0.1, cacheWriteInput: 1.25, cacheWrite1hInput: 2 },
  ], "standard", "2026-11-25"),

  // Their batch rates, as listed in the page's batch processing table.
  entry("anthropic", "Fable 5.2", ANTHROPIC_BATCH_2026_11_25, [
    { input: 4, output: 20 },
  ], "batch", "2026-11-25"),
  entry("anthropic", "Mythos 5.2", ANTHROPIC_BATCH_2026_11_25, [
    { input: 4, output: 20 },
  ], "batch", "2026-11-25"),
  entry("anthropic", "Mythos 5.1", ANTHROPIC_BATCH_2026_11_25, [
    { input: 5, output: 25 },
  ], "batch", "2026-11-25"),
  entry("anthropic", "Fable 5", ANTHROPIC_BATCH_2026_11_25, [
    { input: 5, output: 25 },
  ], "batch", "2026-11-25"),
  entry("anthropic", "Mythos 5", ANTHROPIC_BATCH_2026_11_25, [
    { input: 5, output: 25 },
  ], "batch", "2026-11-25"),
  entry("anthropic", "Opus 5", ANTHROPIC_BATCH_2026_11_25, [
    { input: 2.5, output: 12.5 },
  ], "batch", "2026-11-25"),
  entry("anthropic", "Opus 4.8", ANTHROPIC_BATCH_2026_11_25, [
    { input: 2.5, output: 12.5 },
  ], "batch", "2026-11-25"),
  entry("anthropic", "Opus 4.7", ANTHROPIC_BATCH_2026_11_25, [
    { input: 2.5, output: 12.5 },
  ], "batch", "2026-11-25"),
  entry("anthropic", "Opus 4.6", ANTHROPIC_BATCH_2026_11_25, [
    { input: 2.5, output: 12.5 },
  ], "batch", "2026-11-25"),
  entry("anthropic", "Opus 4.5", ANTHROPIC_BATCH_2026_11_25, [
    { input: 2.5, output: 12.5 },
  ], "batch", "2026-11-25"),
  entry("anthropic", "Opus 4.1", ANTHROPIC_BATCH_2026_11_25, [
    { input: 7.5, output: 37.5 },
  ], "batch", "2026-11-25"),
  entry("anthropic", "Opus 4", ANTHROPIC_BATCH_2026_11_25, [
    { input: 7.5, output: 37.5 },
  ], "batch", "2026-11-25"),
  entry("anthropic", "Sonnet 5", ANTHROPIC_BATCH_2026_11_25, [
    { input: 1, output: 5 },
  ], "batch", "2026-11-25"),
  entry("anthropic", "Sonnet 4.6", ANTHROPIC_BATCH_2026_11_25, [
    { input: 1.5, output: 7.5 },
  ], "batch", "2026-11-25"),
  entry("anthropic", "Sonnet 4.5", ANTHROPIC_BATCH_2026_11_25, [
    { input: 1.5, output: 7.5 },
  ], "batch", "2026-11-25"),
  entry("anthropic", "Sonnet 4", ANTHROPIC_BATCH_2026_11_25, [
    { input: 1.5, output: 7.5 },
  ], "batch", "2026-11-25"),
  entry("anthropic", "Haiku 4.5", ANTHROPIC_BATCH_2026_11_25, [
    { input: 0.5, output: 2.5 },
  ], "batch", "2026-11-25"),
];

const openai: ModelPriceEntry[] = [
  entry("openai", "gpt-6-astra", OPENAI, [{ input: 10, output: 50, cachedInput: 1 }]),
  entry("openai", "gpt-6.1-sol", OPENAI, [{ input: 2, output: 10, cachedInput: 0.1 }]),
  entry("openai", "gpt-6-luna", OPENAI, [{ input: 0.1, output: 0.5, cachedInput: 0.01 }]),
  entry("openai", "gpt-5.5", OPENAI, [{ input: 5, output: 30, cachedInput: 0.5 }]),
  entry("openai", "gpt-5.4", OPENAI, [{ input: 2.5, output: 15, cachedInput: 0.25 }]),
  entry("openai", "gpt-5.2", OPENAI, [{ input: 1.75, output: 14, cachedInput: 0.175 }]),
  entry("openai", "gpt-5", OPENAI, [{ input: 1.25, output: 10, cachedInput: 0.125 }]),
  entry("openai", "gpt-4o", OPENAI, [{ input: 2.5, output: 10, cachedInput: 1.25 }]),
  entry("openai", "gpt-4o-mini", OPENAI, [{ input: 0.15, output: 0.6, cachedInput: 0.075 }]),
  entry("openai", "o1", OPENAI, [{ input: 15, output: 60, cachedInput: 7.5 }]),
  entry("openai", "o3-mini", OPENAI, [{ input: 1.1, output: 4.4, cachedInput: 0.55 }]),
  // Only the batch rate published explicitly is catalogued. The page describes batch
  // and flex as "typically" half of standard; that is not a rate, so it is not seeded.
  entry("openai", "gpt-6-astra", OPENAI, [{ input: 5, output: 25, cachedInput: 0.5 }], "batch"),
  // Flex processing is billed at Batch API rates = 50% of standard, on a
  // synchronous API, per OpenAI's flex-processing guide. Cached-input discount
  // stacks on top. Catalogued so the ledger can price flex-tier events rather
  // than leaving async savings unpriced.
  entry("openai", "gpt-5", OPENAI, [{ input: 0.625, output: 5, cachedInput: 0.0625 }], "flex"),
];

// DeepSeek — OpenAI-compatible provider, reachable through `mesh start --openai-base
// https://api.deepseek.com`. Off-peak rates per the DEEPSEEK provenance note above.
const deepseek: ModelPriceEntry[] = [
  entry("deepseek", "deepseek-flash", DEEPSEEK, [{ input: 0.15, output: 0.6, cachedInput: 0.003 }], "standard", "2026-11-03"),
  entry("deepseek", "deepseek-v4-pro", DEEPSEEK, [{ input: 0.66, output: 1.98, cachedInput: 0.022 }], "standard", "2026-11-03"),
];

/**
 * API identifiers to catalogue keys.
 *
 * Catalogue keys are the names on the pricing pages; application logs carry API
 * identifiers. Normalised matching in resolveModelId handles the common case
 * (stripping case, punctuation and a trailing release date), so these entries
 * exist for the ids normalisation cannot reach: aliases, "-latest" pointers, and
 * ids whose shape does not contain the published name.
 *
 * A wrong entry here mis-prices real traffic, so each one is an exact id or an
 * explicit prefix. Nothing is inferred.
 */
const aliases: ModelAlias[] = [
  // Anthropic ids embed the published name, so normalisation covers dated
  // builds such as claude-sonnet-5-5-20260514. These cover the pointers.
  { provider: "anthropic", id: "claude-sonnet-5-5-latest", model: "Sonnet 5.5" },
  { provider: "anthropic", id: "claude-opus-5-5-latest", model: "Opus 5.5" },
  { provider: "anthropic", id: "claude-haiku-5-5-latest", model: "Haiku 5.5" },
  { provider: "anthropic", id: "claude-fable-5-1-latest", model: "Fable 5.1" },
  // OpenAI ids match their published names directly; these are the pointers
  // and the dated snapshots that do not normalise onto a catalogued key.
  { provider: "openai", id: "chatgpt-4o-latest", model: "gpt-4o" },
  { provider: "openai", id: "gpt-4o-2024-*", model: "gpt-4o" },
  { provider: "openai", id: "gpt-4o-mini-2024-*", model: "gpt-4o-mini" },
  { provider: "openai", id: "o3-mini-2025-*", model: "o3-mini" },
  // DeepSeek: the current ids match their keys (normalisation covers them); only
  // the legacy pointer needs an explicit map. deepseek-v4-flash bills at Flash,
  // per DeepSeek's pricing page.
  { provider: "deepseek", id: "deepseek-v4-flash", model: "deepseek-flash" },
];

/** Published list rates as observed on the capture date. */
export const publishedModelPrices: PriceCatalogue = validatePriceCatalogue({
  entries: [...anthropic, ...openai, ...deepseek],
  negotiated: [],
  aliases,
});

/**
 * Anthropic's documented minimum cacheable prompt length, by model class:
 * 1,024 tokens for Opus- and Sonnet-class models, 2,048 tokens for
 * Haiku-class models (https://docs.claude.com/en/docs/build-with-claude/
 * prompt-caching, captured 2026-10-08, same capture date as `ANTHROPIC`
 * above). Below this minimum the provider processes the request without
 * caching at all — not an error, a silent no-op — so a breakpoint placed on
 * a shorter prefix can never be read back and would make MESH claim a
 * saving that cannot happen.
 *
 * Matched on the raw model id by substring rather than through
 * `resolveModelId`, because the minimum only depends on which model
 * CLASS was called (Haiku vs. everything else), not on resolving the exact
 * dated build to a catalogued price entry — a model id the price catalogue
 * cannot resolve (an older or unlisted Claude build) still has a real
 * minimum, and guessing wrong in the lenient direction (1,024 for an
 * unrecognised id) risks stamping a Haiku-class model's too-short prefix.
 * An id that is not recognisably Claude at all should never reach this
 * function; callers only call it after confirming an Anthropic-shaped
 * request.
 */
export function anthropicCacheableMinimumTokens(modelId: string): number {
  return /haiku/i.test(modelId) ? 2048 : 1024;
}
