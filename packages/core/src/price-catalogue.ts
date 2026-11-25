import { createHash } from "node:crypto";
import { estimateTokenCost, type TokenPrice } from "./cost.js";

/**
 * Where a rate came from, so a cost figure in a report can be traced back to a
 * published price rather than taken on trust.
 */
export type PriceProvenance = {
  /** Published source the rate was read from. */
  source: string;
  /** ISO date (YYYY-MM-DD) the rate was read. */
  capturedOn: string;
  note?: string;
};

/**
 * One rate band. Providers tier some models by prompt size, so a single model can
 * carry several bands; exactly one band is unbounded.
 */
export type PriceTier = TokenPrice & {
  /** Applies when input tokens are at most this value; omit for the unbounded band. */
  maxInputTokens?: number;
};

/** A provider's published rate for one model over one date range. */
export type ModelPriceEntry = {
  provider: string;
  model: string;
  /** Billing mode; distinct modes price independently over the same dates. */
  mode: "standard" | "batch" | "flex";
  /** Inclusive ISO date this rate took effect. */
  effectiveFrom: string;
  /** Exclusive ISO date this rate stopped applying; omit while current. */
  effectiveTo?: string;
  tiers: PriceTier[];
  provenance: PriceProvenance;
};

/**
 * A customer's contracted rate, layered over published prices. Either a flat
 * discount on the published rate or a full replacement set of bands.
 */
export type NegotiatedRate = {
  provider: string;
  model: string;
  mode?: ModelPriceEntry["mode"];
  effectiveFrom: string;
  effectiveTo?: string;
  /** Percentage off every published rate, 0-100. Mutually exclusive with `tiers`. */
  discountPercent?: number;
  /** Replacement bands. Mutually exclusive with `discountPercent`. */
  tiers?: PriceTier[];
  provenance: PriceProvenance;
};

export type PriceCatalogue = {
  entries: ModelPriceEntry[];
  negotiated: NegotiatedRate[];
  /** API-identifier to catalogue-key mappings; see resolveModelId. */
  aliases?: ModelAlias[];
};

export type PriceLookup =
  | { status: "priced"; price: TokenPrice; entry: ModelPriceEntry; negotiated?: NegotiatedRate }
  | { status: "unpriced"; reason: string };

export type UsagePricing =
  | { status: "priced"; costUsd: number; price: TokenPrice; entry: ModelPriceEntry; negotiated?: NegotiatedRate }
  | { status: "unpriced"; reason: string };

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  /** TOTAL cache writes, inclusive of any 1h share below. */
  cacheWriteInputTokens?: number;
  /** The share of the writes above that carried the 1h TTL (bills a premium). */
  cacheWrite1hInputTokens?: number;
};

export type PriceQuery = {
  provider: string;
  model: string;
  mode?: ModelPriceEntry["mode"];
  /** ISO date the request was billed on. */
  at: string;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const OPEN_ENDED = "9999-12-31";

function assertIsoDate(value: string, label: string): void {
  if (!ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO calendar date (YYYY-MM-DD); received ${JSON.stringify(value)}.`);
  }
}

function assertRate(value: number | undefined, label: string): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number of USD per million tokens.`);
  }
}

function assertTiers(tiers: PriceTier[], label: string): void {
  if (tiers.length === 0) throw new Error(`${label} must declare at least one price tier.`);
  const unbounded = tiers.filter((tier) => tier.maxInputTokens === undefined);
  if (unbounded.length !== 1) {
    throw new Error(`${label} must declare exactly one tier without maxInputTokens; found ${unbounded.length}.`);
  }
  const bounds = tiers
    .map((tier) => tier.maxInputTokens)
    .filter((bound): bound is number => bound !== undefined);
  if (bounds.some((bound) => !Number.isInteger(bound) || bound <= 0)) {
    throw new Error(`${label} tier bounds must be positive integers.`);
  }
  if (new Set(bounds).size !== bounds.length) {
    throw new Error(`${label} declares duplicate tier bounds.`);
  }
  for (const tier of tiers) {
    assertRate(tier.inputPerMillion, `${label} inputPerMillion`);
    assertRate(tier.outputPerMillion, `${label} outputPerMillion`);
    assertRate(tier.cachedInputPerMillion, `${label} cachedInputPerMillion`);
    assertRate(tier.cacheWriteInputPerMillion, `${label} cacheWriteInputPerMillion`);
    assertRate(tier.cacheWrite1hInputPerMillion, `${label} cacheWrite1hInputPerMillion`);
  }
}

function assertProvenance(provenance: PriceProvenance, label: string): void {
  if (!provenance || typeof provenance.source !== "string" || provenance.source.trim() === "") {
    throw new Error(`${label} needs a provenance.source so the rate can be traced to a published price.`);
  }
  assertIsoDate(provenance.capturedOn, `${label} provenance.capturedOn`);
}

function rangeKey(item: { provider: string; model: string; mode?: string }): string {
  return `${item.provider} ${item.model} ${item.mode ?? "standard"}`;
}

function overlaps(
  left: { effectiveFrom: string; effectiveTo?: string },
  right: { effectiveFrom: string; effectiveTo?: string },
): boolean {
  return left.effectiveFrom < (right.effectiveTo ?? OPEN_ENDED) &&
    right.effectiveFrom < (left.effectiveTo ?? OPEN_ENDED);
}

/**
 * Validate a catalogue. Overlapping date ranges for one provider/model/mode are
 * rejected rather than resolved, because silently picking one of two candidate
 * rates would make a cost figure unreproducible.
 */
export function validatePriceCatalogue(catalogue: PriceCatalogue): PriceCatalogue {
  const seen = new Map<string, Array<{ effectiveFrom: string; effectiveTo?: string }>>();
  for (const entry of catalogue.entries) {
    const label = `Price entry ${entry.provider}/${entry.model} (${entry.mode}) from ${entry.effectiveFrom}`;
    if (!entry.provider.trim() || !entry.model.trim()) {
      throw new Error("Price entries need a non-empty provider and model.");
    }
    assertIsoDate(entry.effectiveFrom, `${label} effectiveFrom`);
    if (entry.effectiveTo !== undefined) {
      assertIsoDate(entry.effectiveTo, `${label} effectiveTo`);
      if (entry.effectiveTo <= entry.effectiveFrom) {
        throw new Error(`${label} ends on or before it starts.`);
      }
    }
    assertTiers(entry.tiers, label);
    assertProvenance(entry.provenance, label);
    const key = rangeKey(entry);
    const ranges = seen.get(key) ?? [];
    const clash = ranges.find((range) => overlaps(range, entry));
    if (clash) {
      throw new Error(
        `${label} overlaps another rate for the same model and mode starting ${clash.effectiveFrom}; ` +
        "close the earlier rate with effectiveTo so each billing date resolves to exactly one price.",
      );
    }
    ranges.push(entry);
    seen.set(key, ranges);
  }

  const negotiatedSeen = new Map<string, Array<{ effectiveFrom: string; effectiveTo?: string }>>();
  for (const rate of catalogue.negotiated) {
    const label = `Negotiated rate ${rate.provider}/${rate.model} from ${rate.effectiveFrom}`;
    const hasDiscount = rate.discountPercent !== undefined;
    const hasTiers = rate.tiers !== undefined;
    if (hasDiscount === hasTiers) {
      throw new Error(`${label} must set exactly one of discountPercent or tiers.`);
    }
    assertIsoDate(rate.effectiveFrom, `${label} effectiveFrom`);
    if (rate.effectiveTo !== undefined) {
      assertIsoDate(rate.effectiveTo, `${label} effectiveTo`);
      if (rate.effectiveTo <= rate.effectiveFrom) throw new Error(`${label} ends on or before it starts.`);
    }
    if (hasDiscount && (!Number.isFinite(rate.discountPercent) || rate.discountPercent! < 0 || rate.discountPercent! >= 100)) {
      throw new Error(`${label} discountPercent must be at least 0 and below 100.`);
    }
    if (hasTiers) assertTiers(rate.tiers!, label);
    assertProvenance(rate.provenance, label);
    const key = rangeKey(rate);
    const ranges = negotiatedSeen.get(key) ?? [];
    if (ranges.some((range) => overlaps(range, rate))) {
      throw new Error(`${label} overlaps another negotiated rate for the same model and mode.`);
    }
    ranges.push(rate);
    negotiatedSeen.set(key, ranges);
  }
  return catalogue;
}

function applicable<T extends { effectiveFrom: string; effectiveTo?: string }>(items: T[], at: string): T | undefined {
  return items.find((item) => item.effectiveFrom <= at && (item.effectiveTo === undefined || at < item.effectiveTo));
}

function tierFor(tiers: PriceTier[], inputTokens: number): PriceTier {
  const bounded = tiers
    .filter((tier): tier is PriceTier & { maxInputTokens: number } => tier.maxInputTokens !== undefined)
    .sort((left, right) => left.maxInputTokens - right.maxInputTokens);
  const match = bounded.find((tier) => inputTokens <= tier.maxInputTokens);
  return match ?? tiers.find((tier) => tier.maxInputTokens === undefined)!;
}

function withoutBound(tier: PriceTier): TokenPrice {
  const { maxInputTokens: _bound, ...price } = tier;
  return price;
}

function discounted(tier: PriceTier, discountPercent: number): TokenPrice {
  const factor = 1 - discountPercent / 100;
  return {
    inputPerMillion: tier.inputPerMillion * factor,
    outputPerMillion: tier.outputPerMillion * factor,
    ...(tier.cachedInputPerMillion === undefined
      ? {}
      : { cachedInputPerMillion: tier.cachedInputPerMillion * factor }),
    ...(tier.cacheWriteInputPerMillion === undefined
      ? {}
      : { cacheWriteInputPerMillion: tier.cacheWriteInputPerMillion * factor }),
    ...(tier.cacheWrite1hInputPerMillion === undefined
      ? {}
      : { cacheWrite1hInputPerMillion: tier.cacheWrite1hInputPerMillion * factor }),
  };
}

/**
 * Resolve the rate that applied to one model on one date. Returns an explicit
 * `unpriced` result rather than a zero, so a missing price can never be mistaken
 * for free inference.
 */
export function lookupPrice(
  catalogue: PriceCatalogue,
  query: PriceQuery,
  inputTokens = 0,
): PriceLookup {
  assertIsoDate(query.at, "Price query `at`");
  const mode = query.mode ?? "standard";
  const candidates = catalogue.entries.filter((entry) =>
    entry.provider === query.provider && entry.model === query.model && entry.mode === mode);
  if (candidates.length === 0) {
    return { status: "unpriced", reason: `No ${mode} rate is catalogued for ${query.provider}/${query.model}.` };
  }
  const entry = applicable(candidates, query.at);
  if (!entry) {
    const ranges = candidates
      .map((candidate) => `${candidate.effectiveFrom} to ${candidate.effectiveTo ?? "current"}`)
      .join("; ");
    return {
      status: "unpriced",
      reason: `No ${mode} rate for ${query.provider}/${query.model} covers ${query.at}; catalogued ranges are ${ranges}.`,
    };
  }
  const tier = tierFor(entry.tiers, inputTokens);
  const override = applicable(
    catalogue.negotiated.filter((rate) =>
      rate.provider === query.provider && rate.model === query.model && (rate.mode ?? "standard") === mode),
    query.at,
  );
  if (!override) return { status: "priced", price: withoutBound(tier), entry };
  const price = override.tiers
    ? withoutBound(tierFor(override.tiers, inputTokens))
    : discounted(tier, override.discountPercent!);
  return { status: "priced", price, entry, negotiated: override };
}

/**
 * Cost of one recorded request. Token counts come from the provider's own usage
 * fields; the rate comes from the catalogue, never from the traffic itself.
 */
export function priceUsage(
  catalogue: PriceCatalogue,
  query: PriceQuery,
  usage: TokenUsage,
): UsagePricing {
  for (const [name, value] of Object.entries(usage)) {
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Token usage ${name} must be a non-negative finite number.`);
    }
  }
  const lookup = lookupPrice(catalogue, query, usage.inputTokens);
  if (lookup.status === "unpriced") return lookup;
  const cached = usage.cachedInputTokens ?? 0;
  const cacheWrite = usage.cacheWriteInputTokens ?? 0;
  const cacheWrite1h = usage.cacheWrite1hInputTokens ?? 0;
  if (cacheWrite1h > cacheWrite) {
    return {
      status: "unpriced",
      reason: `${query.provider}/${query.model} reports more 1h cache writes (${cacheWrite1h}) than total cache writes (${cacheWrite}).`,
    };
  }
  if ((cached > 0 && lookup.price.cachedInputPerMillion === undefined) ||
      (cacheWrite - cacheWrite1h > 0 && lookup.price.cacheWriteInputPerMillion === undefined) ||
      (cacheWrite1h > 0 && lookup.price.cacheWrite1hInputPerMillion === undefined)) {
    return {
      status: "unpriced",
      reason: `${query.provider}/${query.model} billed cached input tokens on ${query.at}, but the catalogue has no cached-input rate for it.`,
    };
  }
  const costUsd = estimateTokenCost(usage.inputTokens, usage.outputTokens, lookup.price, {
    cachedInputTokens: usage.cachedInputTokens,
    cacheWriteInputTokens: usage.cacheWriteInputTokens,
    cacheWrite1hInputTokens: usage.cacheWrite1hInputTokens,
  });
  return { status: "priced", costUsd, price: lookup.price, entry: lookup.entry, negotiated: lookup.negotiated };
}

export type RepriceComparison = {
  baseline: UsagePricing;
  candidate: UsagePricing;
  /** Set only when both sides priced; positive means the candidate is cheaper. */
  savingsUsd?: number;
  savingsPercent?: number;
};

/**
 * Re-price recorded usage against a different model, provider, or billing mode.
 * Both sides must price before a saving is reported: a comparison against an
 * unpriced model is not a comparison.
 */
export function repriceUsage(
  catalogue: PriceCatalogue,
  baseline: PriceQuery,
  candidate: PriceQuery,
  usage: TokenUsage,
): RepriceComparison {
  const left = priceUsage(catalogue, baseline, usage);
  const right = priceUsage(catalogue, candidate, usage);
  if (left.status !== "priced" || right.status !== "priced") return { baseline: left, candidate: right };
  const savingsUsd = left.costUsd - right.costUsd;
  return {
    baseline: left,
    candidate: right,
    savingsUsd,
    savingsPercent: left.costUsd === 0 ? 0 : (savingsUsd / left.costUsd) * 100,
  };
}

/** Parse an externally supplied catalogue, for example a customer's contracted rates. */
export function parsePriceCatalogue(value: unknown): PriceCatalogue {
  if (typeof value !== "object" || value === null) throw new Error("A price catalogue must be an object.");
  const raw = value as { entries?: unknown; negotiated?: unknown; aliases?: unknown };
  if (!Array.isArray(raw.entries)) throw new Error("A price catalogue needs an `entries` array.");
  if (raw.negotiated !== undefined && !Array.isArray(raw.negotiated)) {
    throw new Error("A price catalogue `negotiated` field must be an array when present.");
  }
  if (raw.aliases !== undefined && !Array.isArray(raw.aliases)) {
    throw new Error("A price catalogue `aliases` field must be an array when present.");
  }
  return validatePriceCatalogue({
    entries: raw.entries as ModelPriceEntry[],
    negotiated: (raw.negotiated ?? []) as NegotiatedRate[],
    aliases: (raw.aliases ?? []) as ModelAlias[],
  });
}

/** Combine catalogues, for example published rates plus a customer's contract. */
export function mergePriceCatalogues(...catalogues: PriceCatalogue[]): PriceCatalogue {
  return validatePriceCatalogue({
    entries: catalogues.flatMap((catalogue) => catalogue.entries),
    negotiated: catalogues.flatMap((catalogue) => catalogue.negotiated),
    aliases: catalogues.flatMap((catalogue) => catalogue.aliases ?? []),
  });
}

/**
 * Deterministic JSON: object keys sorted recursively, `undefined` members
 * omitted. Two structurally equal values always serialise to identical bytes,
 * which is what makes content hashes over catalogues and ledger events stable.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, member]) => member !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`);
  return `{${entries.join(",")}}`;
}

/**
 * Content hash of a catalogue. Pinned onto every ledger event at write time, so
 * an invoice names the exact rates it was computed against and a later
 * catalogue update can never silently re-price history.
 */
export function catalogueVersion(catalogue: PriceCatalogue): string {
  return createHash("sha256").update(canonicalJson(catalogue)).digest("hex").slice(0, 16);
}

/** Maps an API model identifier onto a catalogue key. */
export type ModelAlias = {
  provider: string;
  /** Exact API model id, or a prefix ending in "*". */
  id: string;
  /** Catalogue model key this resolves to. */
  model: string;
};

export type ModelResolution =
  | { status: "resolved"; model: string; via: "exact" | "alias" | "normalised" }
  | { status: "unresolved"; reason: string; candidates: string[] };

/**
 * Break a model identifier into comparable segments.
 *
 * Segment-aligned rather than substring matching, because substrings mis-price.
 * Normalising "gpt-5-2026-01-01" to "gpt520260101" makes the catalogue key
 * "gpt-5.2" ("gpt52") a substring of it, so a gpt-5 request would be billed at
 * the gpt-5.2 rate: $1.75/M instead of $1.25/M, a 40% overstatement on input.
 * Comparing [gpt, 5, 2026, 01, 01] against [gpt, 5, 2] cannot make that mistake.
 */
function canonicalSegments(value: string): string[] {
  return value
    .toLowerCase()
    // Release pointers and dated builds share one rate.
    .replace(/[-_]latest$/, "")
    .replace(/[-_]20\d{2}[-_]\d{2}[-_]\d{2}$/, "")
    .replace(/[-_]20\d{6}$/, "")
    .split(/[^a-z0-9]+/)
    .filter((segment) => segment !== "");
}

/**
 * Whether `key` is the END of `id`'s segments: a vendor prefix may come before
 * it ("claude-", "anthropic."), nothing may come after.
 *
 * Anything after the published name names a different model, and often a
 * different price: a later version ("claude-fable-5-3" is not "Fable 5",
 * "gpt-5.3" is not "gpt-5"), a size ("gpt-5-mini") or a tier
 * ("claude-opus-5-5-fast"). Release dates and "-latest" are already stripped by
 * canonicalSegments, so they do not count as a suffix. An id that carries one
 * stays unresolved until it has its own entry or an explicit alias.
 */
function containsSegments(id: string[], key: string[]): boolean {
  if (key.length === 0 || key.length > id.length) return false;
  const offset = id.length - key.length;
  return key.every((segment, index) => id[offset + index] === segment);
}

/**
 * Resolve the model id a log carries onto a catalogue key.
 *
 * Catalogue keys are the names providers publish on their pricing pages
 * ("Sonnet 5.5"); logs carry API identifiers ("claude-sonnet-5-5-20260514").
 * Without this every real row prices as unpriced.
 *
 * Resolution never guesses. Exact matches win, then explicit aliases, then a
 * normalised comparison that strips punctuation, case and a trailing release
 * date. Where normalisation admits more than one catalogue key the longest
 * match wins, so "sonnet 5.5" beats "sonnet 5" on `claude-sonnet-5-5`; where two
 * keys tie, the result is unresolved and names the candidates, because pricing
 * traffic against a coin flip is a billing error rather than a convenience.
 */
export function resolveModelId(
  catalogue: PriceCatalogue,
  provider: string,
  rawModelId: string,
): ModelResolution {
  const known = [...new Set(catalogue.entries
    .filter((entry) => entry.provider === provider)
    .map((entry) => entry.model))];
  if (known.length === 0) {
    return { status: "unresolved", reason: `No models are catalogued for provider ${provider}.`, candidates: [] };
  }
  if (known.includes(rawModelId)) return { status: "resolved", model: rawModelId, via: "exact" };

  for (const alias of catalogue.aliases ?? []) {
    if (alias.provider !== provider) continue;
    const matches = alias.id.endsWith("*")
      ? rawModelId.startsWith(alias.id.slice(0, -1))
      : alias.id === rawModelId;
    if (!matches) continue;
    if (!known.includes(alias.model)) {
      return {
        status: "unresolved",
        reason: `Alias ${alias.id} points at ${alias.model}, which is not catalogued for ${provider}.`,
        candidates: known,
      };
    }
    return { status: "resolved", model: alias.model, via: "alias" };
  }

  const target = canonicalSegments(rawModelId);
  const hits = known
    .map((model) => ({ model, key: canonicalSegments(model) }))
    .filter(({ key }) => containsSegments(target, key))
    // Most segments wins, so "Sonnet 5.5" beats "Sonnet 5" on claude-sonnet-5-5.
    .sort((left, right) => right.key.length - left.key.length ||
      right.key.join("").length - left.key.join("").length);
  if (hits.length === 0) {
    return {
      status: "unresolved",
      reason: `No catalogue key for ${provider} matches ${rawModelId}; add an alias.`,
      candidates: known,
    };
  }
  const longest = hits[0]!.key.length;
  const tied = hits.filter(({ key }) => key.length === longest);
  if (tied.length > 1) {
    return {
      status: "unresolved",
      reason: `${rawModelId} matches ${tied.length} catalogue keys equally well; add an explicit alias.`,
      candidates: tied.map(({ model }) => model),
    };
  }
  return { status: "resolved", model: hits[0]!.model, via: "normalised" };
}
