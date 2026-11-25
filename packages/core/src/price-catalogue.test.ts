import { describe, expect, it } from "vitest";
import { publishedModelPrices } from "./model-prices.js";
import {
  lookupPrice,
  mergePriceCatalogues,
  parsePriceCatalogue,
  priceUsage,
  repriceUsage,
  resolveModelId,
  validatePriceCatalogue,
  type ModelPriceEntry,
  type PriceCatalogue,
} from "./price-catalogue.js";

const provenance = { source: "https://example.test/pricing", capturedOn: "2026-01-01" };

function priced(overrides: Partial<ModelPriceEntry> = {}): ModelPriceEntry {
  return {
    provider: "acme",
    model: "big",
    mode: "standard",
    effectiveFrom: "2026-01-01",
    tiers: [{ inputPerMillion: 10, outputPerMillion: 50, cachedInputPerMillion: 1 }],
    provenance,
    ...overrides,
  };
}

function catalogue(entries: ModelPriceEntry[], negotiated: PriceCatalogue["negotiated"] = []): PriceCatalogue {
  return validatePriceCatalogue({ entries, negotiated });
}

describe("price catalogue", () => {
  it("prices recorded usage from the catalogued rate", () => {
    const result = priceUsage(catalogue([priced()]), { provider: "acme", model: "big", at: "2026-06-01" }, {
      inputTokens: 1_000_000,
      outputTokens: 100_000,
    });
    expect(result.status).toBe("priced");
    expect(result.status === "priced" && result.costUsd).toBeCloseTo(15);
  });

  it("charges cached input at the cached rate", () => {
    const result = priceUsage(catalogue([priced()]), { provider: "acme", model: "big", at: "2026-06-01" }, {
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cachedInputTokens: 500_000,
    });
    expect(result.status === "priced" && result.costUsd).toBeCloseTo(10.5);
  });

  it("reports a model with no catalogued rate as unpriced rather than free", () => {
    const result = priceUsage(catalogue([priced()]), { provider: "acme", model: "unknown", at: "2026-06-01" }, {
      inputTokens: 1_000,
      outputTokens: 1_000,
    });
    expect(result.status).toBe("unpriced");
    expect(result.status === "unpriced" && result.reason).toMatch(/No standard rate is catalogued/);
  });

  it("refuses to apply a current rate to a billing date the catalogue does not cover", () => {
    const result = lookupPrice(catalogue([priced({ effectiveFrom: "2026-05-01" })]), {
      provider: "acme",
      model: "big",
      at: "2026-01-15",
    });
    expect(result.status).toBe("unpriced");
    expect(result.status === "unpriced" && result.reason).toMatch(/covers 2026-01-15/);
  });

  it("resolves a dated rate change to exactly one price per billing date", () => {
    const history = catalogue([
      priced({ effectiveFrom: "2026-01-01", effectiveTo: "2026-06-01" }),
      priced({
        effectiveFrom: "2026-06-01",
        tiers: [{ inputPerMillion: 5, outputPerMillion: 25, cachedInputPerMillion: 0.5 }],
      }),
    ]);
    const before = priceUsage(history, { provider: "acme", model: "big", at: "2026-03-01" }, {
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    const after = priceUsage(history, { provider: "acme", model: "big", at: "2026-07-01" }, {
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(before.status === "priced" && before.costUsd).toBeCloseTo(10);
    expect(after.status === "priced" && after.costUsd).toBeCloseTo(5);
  });

  it("rejects overlapping rates instead of picking one", () => {
    expect(() => catalogue([priced(), priced({ effectiveFrom: "2026-03-01" })]))
      .toThrow(/overlaps another rate/);
  });

  it("requires provenance so a cost figure can be traced to a published price", () => {
    expect(() => catalogue([priced({ provenance: { source: "  ", capturedOn: "2026-01-01" } })]))
      .toThrow(/provenance\.source/);
  });

  it("reports unpriced when cached tokens were billed but no cached rate is catalogued", () => {
    const noCacheRate = catalogue([priced({ tiers: [{ inputPerMillion: 10, outputPerMillion: 50 }] })]);
    const result = priceUsage(noCacheRate, { provider: "acme", model: "big", at: "2026-06-01" }, {
      inputTokens: 1_000,
      outputTokens: 1_000,
      cachedInputTokens: 500,
    });
    expect(result.status).toBe("unpriced");
    expect(result.status === "unpriced" && result.reason).toMatch(/no cached-input rate/);
  });

  it("applies a negotiated discount over the published rate", () => {
    const withContract = catalogue([priced()], [{
      provider: "acme",
      model: "big",
      effectiveFrom: "2026-01-01",
      discountPercent: 20,
      provenance,
    }]);
    const result = priceUsage(withContract, { provider: "acme", model: "big", at: "2026-06-01" }, {
      inputTokens: 1_000_000,
      outputTokens: 100_000,
    });
    expect(result.status === "priced" && result.costUsd).toBeCloseTo(12);
    expect(result.status === "priced" && result.negotiated?.discountPercent).toBe(20);
  });

  it("requires a negotiated rate to set exactly one of discountPercent or tiers", () => {
    expect(() => catalogue([priced()], [{
      provider: "acme",
      model: "big",
      effectiveFrom: "2026-01-01",
      discountPercent: 10,
      tiers: [{ inputPerMillion: 1, outputPerMillion: 2 }],
      provenance,
    }])).toThrow(/exactly one of discountPercent or tiers/);
  });

  it("reports no saving when either side of a comparison is unpriced", () => {
    const comparison = repriceUsage(
      catalogue([priced()]),
      { provider: "acme", model: "big", at: "2026-06-01" },
      { provider: "acme", model: "unknown", at: "2026-06-01" },
      { inputTokens: 1_000_000, outputTokens: 100_000 },
    );
    expect(comparison.savingsUsd).toBeUndefined();
    expect(comparison.savingsPercent).toBeUndefined();
    expect(comparison.candidate.status).toBe("unpriced");
  });

  it("quantifies a saving when both sides price", () => {
    const pool = catalogue([
      priced(),
      priced({ model: "small", tiers: [{ inputPerMillion: 1, outputPerMillion: 5, cachedInputPerMillion: 0.1 }] }),
    ]);
    const comparison = repriceUsage(
      pool,
      { provider: "acme", model: "big", at: "2026-06-01" },
      { provider: "acme", model: "small", at: "2026-06-01" },
      { inputTokens: 1_000_000, outputTokens: 100_000 },
    );
    expect(comparison.savingsUsd).toBeCloseTo(13.5);
    expect(comparison.savingsPercent).toBeCloseTo(90);
  });

  it("parses and merges externally supplied catalogues", () => {
    const parsed = parsePriceCatalogue({ entries: [priced()] });
    expect(parsed.negotiated).toEqual([]);
    const merged = mergePriceCatalogues(parsed, catalogue([priced({ model: "small" })]));
    expect(merged.entries).toHaveLength(2);
  });

  it("rejects a catalogue payload that is not shaped like one", () => {
    expect(() => parsePriceCatalogue({ rates: [] })).toThrow(/needs an `entries` array/);
  });
});

describe("published model prices", () => {
  it("validates on load", () => {
    expect(() => validatePriceCatalogue(publishedModelPrices)).not.toThrow();
    expect(publishedModelPrices.entries.length).toBeGreaterThan(0);
  });

  it("carries a traceable source and capture date on every rate", () => {
    for (const row of publishedModelPrices.entries) {
      expect(row.provenance.source).toMatch(/^https:\/\//);
      expect(row.provenance.capturedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("prices a flagship model from published rates", () => {
    const result = priceUsage(publishedModelPrices, { provider: "openai", model: "gpt-5", at: "2026-10-08" }, {
      inputTokens: 2_000_000,
      outputTokens: 500_000,
    });
    expect(result.status === "priced" && result.costUsd).toBeCloseTo(7.5);
  });

  it("selects the prompt-size band for a tiered model", () => {
    const query = { provider: "anthropic", model: "Haiku 5.5", at: "2026-10-08" } as const;
    const small = priceUsage(publishedModelPrices, query, { inputTokens: 50_000, outputTokens: 10_000 });
    const large = priceUsage(publishedModelPrices, query, { inputTokens: 200_000, outputTokens: 10_000 });
    expect(small.status === "priced" && small.costUsd).toBeCloseTo(0.01);
    expect(large.status === "priced" && large.costUsd).toBeCloseTo(0.125);
  });

  it("prices batch mode separately from standard", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 100_000 };
    const standard = priceUsage(publishedModelPrices, { provider: "openai", model: "gpt-6-astra", at: "2026-10-08" }, usage);
    const batch = priceUsage(
      publishedModelPrices,
      { provider: "openai", model: "gpt-6-astra", mode: "batch", at: "2026-10-08" },
      usage,
    );
    expect(standard.status === "priced" && standard.costUsd).toBeCloseTo(15);
    expect(batch.status === "priced" && batch.costUsd).toBeCloseTo(7.5);
  });

  it("will not price traffic from before the catalogue was captured", () => {
    const result = priceUsage(publishedModelPrices, { provider: "openai", model: "gpt-5", at: "2026-04-01" }, {
      inputTokens: 1_000,
      outputTokens: 1_000,
    });
    expect(result.status).toBe("unpriced");
  });
});

describe("model identifier resolution", () => {
  it("matches a catalogue key exactly", () => {
    const result = resolveModelId(publishedModelPrices, "openai", "gpt-5");
    expect(result).toMatchObject({ status: "resolved", model: "gpt-5", via: "exact" });
  });

  it("strips a trailing release date rather than failing", () => {
    expect(resolveModelId(publishedModelPrices, "anthropic", "claude-sonnet-5-5-20260514"))
      .toMatchObject({ status: "resolved", model: "Sonnet 5.5" });
  });

  it("prefers the longest matching key, so 5.5 beats 5", () => {
    expect(resolveModelId(publishedModelPrices, "openai", "gpt-5.5"))
      .toMatchObject({ status: "resolved", model: "gpt-5.5" });
  });

  it("does not let a dated gpt-5 build price as gpt-5.2", () => {
    // Substring matching made "gpt52" a substring of "gpt520260101", billing a
    // gpt-5 request at $1.75/M instead of $1.25/M. Segment matching cannot.
    expect(resolveModelId(publishedModelPrices, "openai", "gpt-5-2026-01-01"))
      .toMatchObject({ status: "resolved", model: "gpt-5" });
    expect(resolveModelId(publishedModelPrices, "openai", "gpt-5-20260101"))
      .toMatchObject({ status: "resolved", model: "gpt-5" });
  });

  it("resolves a release pointer through the alias table", () => {
    expect(resolveModelId(publishedModelPrices, "openai", "chatgpt-4o-latest"))
      .toMatchObject({ status: "resolved", model: "gpt-4o", via: "alias" });
  });

  it("resolves a prefix alias", () => {
    expect(resolveModelId(publishedModelPrices, "openai", "gpt-4o-2024-08-06"))
      .toMatchObject({ status: "resolved", model: "gpt-4o", via: "alias" });
  });

  it("leaves an unknown model unresolved instead of guessing", () => {
    const result = resolveModelId(publishedModelPrices, "openai", "some-finetune-v3");
    expect(result.status).toBe("unresolved");
    expect(result.status === "unresolved" && result.reason).toMatch(/add an alias/);
  });

  it("refuses to choose between two equally good matches", () => {
    const ambiguous = validatePriceCatalogue({
      // Two published names that normalise to the same segments.
      entries: [priced({ model: "turbo v2" }), priced({ model: "Turbo-V2" })],
      negotiated: [],
    });
    const result = resolveModelId(ambiguous, "acme", "acme-turbo-v2");
    expect(result.status).toBe("unresolved");
    expect(result.status === "unresolved" && result.reason).toMatch(/equally well/);
    expect(result.status === "unresolved" && result.candidates).toHaveLength(2);
  });

  it("does not price a later version at an earlier version's rate", () => {
    // "Fable 5" and "Opus 4" are catalogued; an id that goes on to name a
    // version the catalogue does not have must not fall back onto them.
    for (const id of ["claude-fable-5-3", "claude-opus-5-6", "claude-opus-4-9", "claude-sonnet-5-7"]) {
      expect(resolveModelId(publishedModelPrices, "anthropic", id).status, id).toBe("unresolved");
    }
    expect(resolveModelId(publishedModelPrices, "openai", "gpt-5.3").status).toBe("unresolved");
  });

  it("does not price a size or tier variant at the base model's rate", () => {
    expect(resolveModelId(publishedModelPrices, "openai", "gpt-5-mini").status).toBe("unresolved");
    expect(resolveModelId(publishedModelPrices, "anthropic", "claude-opus-5-5-fast").status).toBe("unresolved");
  });

  it("resolves every Claude API id on the pricing page, dated or not", () => {
    const expected: Record<string, string> = {
      "claude-fable-5-2": "Fable 5.2",
      "claude-mythos-5-2": "Mythos 5.2",
      "claude-fable-5-1": "Fable 5.1",
      "claude-mythos-5-1": "Mythos 5.1",
      "claude-fable-5": "Fable 5",
      "claude-mythos-5": "Mythos 5",
      "claude-opus-5-5": "Opus 5.5",
      "claude-opus-5": "Opus 5",
      "claude-opus-4-8": "Opus 4.8",
      "claude-opus-4-7": "Opus 4.7",
      "claude-opus-4-6": "Opus 4.6",
      "claude-opus-4-5-20251101": "Opus 4.5",
      "claude-opus-4-1-20250805": "Opus 4.1",
      "claude-opus-4-20250514": "Opus 4",
      "claude-sonnet-5-5": "Sonnet 5.5",
      "claude-sonnet-5": "Sonnet 5",
      "claude-sonnet-4-6": "Sonnet 4.6",
      "claude-sonnet-4-5-20250929": "Sonnet 4.5",
      "claude-sonnet-4-20250514": "Sonnet 4",
      "claude-haiku-5-5": "Haiku 5.5",
      // What Claude Code's `haiku` alias sent on 2026-11-25.
      "claude-haiku-4-5-20251001": "Haiku 4.5",
    };
    for (const [id, model] of Object.entries(expected)) {
      expect(resolveModelId(publishedModelPrices, "anthropic", id), id)
        .toMatchObject({ status: "resolved", model });
    }
  });

  it("reports an alias pointing at a model that is not catalogued", () => {
    const broken = validatePriceCatalogue({
      entries: [priced()],
      negotiated: [],
      aliases: [{ provider: "acme", id: "big-latest", model: "not-catalogued" }],
    });
    const result = resolveModelId(broken, "acme", "big-latest");
    expect(result.status).toBe("unresolved");
    expect(result.status === "unresolved" && result.reason).toMatch(/not catalogued/);
  });

  it("reports a provider with no catalogued models", () => {
    const result = resolveModelId(publishedModelPrices, "nobody", "any-model");
    expect(result.status).toBe("unresolved");
    expect(result.status === "unresolved" && result.reason).toMatch(/No models are catalogued/);
  });
});

describe("Anthropic batch rates (catalogued 2026-10-27 from the definitive 50% statement)", () => {
  const at = "2026-10-27";
  it("prices every Anthropic batch model at exactly half its standard input/output rate", () => {
    for (const model of ["Opus 5.5", "Sonnet 5.5", "Fable 5.1"]) {
      const std = lookupPrice(publishedModelPrices, { provider: "anthropic", model, at });
      const batch = lookupPrice(publishedModelPrices, { provider: "anthropic", model, mode: "batch", at });
      expect(std.status).toBe("priced");
      expect(batch.status).toBe("priced");
      if (std.status !== "priced" || batch.status !== "priced") continue;
      expect(batch.price.inputPerMillion).toBeCloseTo(std.price.inputPerMillion / 2, 10);
      expect(batch.price.outputPerMillion).toBeCloseTo(std.price.outputPerMillion / 2, 10);
      expect(batch.entry.provenance.source).toBe("https://claude.com/pricing");
    }
  });

  it("halves Haiku's over-100K band too", () => {
    const big = { provider: "anthropic", model: "Haiku 5.5", at } as const;
    const std = lookupPrice(publishedModelPrices, big, 150_000);
    const batch = lookupPrice(publishedModelPrices, { ...big, mode: "batch" }, 150_000);
    if (std.status !== "priced" || batch.status !== "priced") throw new Error("expected priced");
    expect(batch.price.inputPerMillion).toBeCloseTo(std.price.inputPerMillion / 2, 10);
    expect(batch.price.outputPerMillion).toBeCloseTo(std.price.outputPerMillion / 2, 10);
  });

  it("prices a batch classification request at half a standard one", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 200_000 };
    const std = priceUsage(publishedModelPrices, { provider: "anthropic", model: "Sonnet 5.5", at }, usage);
    const batch = priceUsage(publishedModelPrices, { provider: "anthropic", model: "Sonnet 5.5", mode: "batch", at }, usage);
    if (std.status !== "priced" || batch.status !== "priced") throw new Error("expected priced");
    expect(batch.costUsd).toBeCloseTo(std.costUsd / 2, 10);
  });

  it("does not guess a cache-WRITE premium under batch (unpublished → unpriced, never zero)", () => {
    const withWrite = priceUsage(
      publishedModelPrices,
      { provider: "anthropic", model: "Sonnet 5.5", mode: "batch", at },
      { inputTokens: 1000, outputTokens: 500, cacheWriteInputTokens: 2000 },
    );
    expect(withWrite.status).toBe("unpriced");
  });

  it("leaves batch unpriced before its effectiveFrom rather than backdating the discount", () => {
    const before = lookupPrice(publishedModelPrices, { provider: "anthropic", model: "Sonnet 5.5", mode: "batch", at: "2026-10-20" });
    expect(before.status).toBe("unpriced");
  });
});

describe("Claude models added 2026-11-25 (the rest of Anthropic's pricing page)", () => {
  const added = [
    "Fable 5.2", "Mythos 5.2", "Mythos 5.1", "Fable 5", "Mythos 5",
    "Opus 5", "Opus 4.8", "Opus 4.7", "Opus 4.6", "Opus 4.5", "Opus 4.1", "Opus 4",
    "Sonnet 5", "Sonnet 4.6", "Sonnet 4.5", "Sonnet 4", "Haiku 4.5",
  ];

  it("prices each of them from the day it was read, and not before", () => {
    for (const model of added) {
      const on = lookupPrice(publishedModelPrices, { provider: "anthropic", model, at: "2026-11-25" });
      const before = lookupPrice(publishedModelPrices, { provider: "anthropic", model, at: "2026-11-24" });
      expect(on.status, model).toBe("priced");
      expect(before.status, model).not.toBe("priced");
    }
  });

  it("carries the page's own five rates for Fable 5.2 and Haiku 4.5", () => {
    const fable = lookupPrice(publishedModelPrices, { provider: "anthropic", model: "Fable 5.2", at: "2026-11-25" });
    const haiku = lookupPrice(publishedModelPrices, { provider: "anthropic", model: "Haiku 4.5", at: "2026-11-25" });
    if (fable.status !== "priced" || haiku.status !== "priced") throw new Error("expected priced");
    expect(fable.price).toMatchObject({
      inputPerMillion: 8, outputPerMillion: 40, cachedInputPerMillion: 0.2,
      cacheWriteInputPerMillion: 10, cacheWrite1hInputPerMillion: 16,
    });
    expect(haiku.price).toMatchObject({
      inputPerMillion: 1, outputPerMillion: 5, cachedInputPerMillion: 0.1,
      cacheWriteInputPerMillion: 1.25, cacheWrite1hInputPerMillion: 2,
    });
  });

  it("lists every cache write at 1.25x and 2x the base input, as the page states", () => {
    for (const model of added) {
      const found = lookupPrice(publishedModelPrices, { provider: "anthropic", model, at: "2026-11-25" });
      if (found.status !== "priced") throw new Error(`expected ${model} priced`);
      expect(found.price.cacheWriteInputPerMillion, model).toBeCloseTo(found.price.inputPerMillion * 1.25, 10);
      expect(found.price.cacheWrite1hInputPerMillion, model).toBeCloseTo(found.price.inputPerMillion * 2, 10);
    }
  });

  it("lists every batch rate at half the standard input and output", () => {
    for (const model of added) {
      const std = lookupPrice(publishedModelPrices, { provider: "anthropic", model, at: "2026-11-25" });
      const batch = lookupPrice(publishedModelPrices, { provider: "anthropic", model, mode: "batch", at: "2026-11-25" });
      if (std.status !== "priced" || batch.status !== "priced") throw new Error(`expected ${model} priced`);
      expect(batch.price.inputPerMillion, model).toBeCloseTo(std.price.inputPerMillion / 2, 10);
      expect(batch.price.outputPerMillion, model).toBeCloseTo(std.price.outputPerMillion / 2, 10);
    }
  });

  it("prices a real Claude Code request on the id its `haiku` alias sends", () => {
    const resolved = resolveModelId(publishedModelPrices, "anthropic", "claude-haiku-4-5-20251001");
    if (resolved.status !== "resolved") throw new Error("expected resolved");
    const result = priceUsage(publishedModelPrices, { provider: "anthropic", model: resolved.model, at: "2026-11-25" }, {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(result.status === "priced" && result.costUsd).toBeCloseTo(6);
  });
});
