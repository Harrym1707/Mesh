import { describe, expect, it } from "vitest";
import { publishedModelPrices } from "./model-prices.js";
import { ingestTraffic, measureTraffic, normaliseTrafficRow, trafficFingerprint } from "./traffic.js";

const AT = "2026-10-08";

function usageRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "r1", model: "gpt-5", input_tokens: 1_000, output_tokens: 100, at: AT, ...overrides };
}

describe("traffic ingestion", () => {
  it("reads the OpenAI Responses shape, where cached tokens sit inside input_tokens", () => {
    const result = normaliseTrafficRow({
      id: "a",
      request: { model: "gpt-5" },
      response: { usage: { input_tokens: 1_000, output_tokens: 50, input_tokens_details: { cached_tokens: 400 } } },
    }, AT, 0);
    expect("record" in result).toBe(true);
    if (!("record" in result)) return;
    expect(result.adapter).toBe("openai-responses");
    expect(result.record.inputTokens).toBe(1_000);
    expect(result.record.cachedInputTokens).toBe(400);
  });

  it("reads the Anthropic shape, where cache reads sit outside input_tokens", () => {
    const result = normaliseTrafficRow({
      id: "a",
      request: { model: "Sonnet 5.5" },
      response: {
        usage: {
          input_tokens: 900,
          cache_read_input_tokens: 3_400,
          cache_creation_input_tokens: 100,
          output_tokens: 50,
        },
      },
    }, AT, 0);
    if (!("record" in result)) throw new Error("expected a record");
    expect(result.adapter).toBe("anthropic-messages");
    // Total input is fresh plus cache reads plus cache writes.
    expect(result.record.inputTokens).toBe(4_400);
    expect(result.record.cachedInputTokens).toBe(3_400);
    expect(result.record.provider).toBe("anthropic");
  });

  it("reads the Chat Completions shape", () => {
    const result = normaliseTrafficRow({
      model: "gpt-4o",
      usage: { prompt_tokens: 500, completion_tokens: 25, prompt_tokens_details: { cached_tokens: 100 } },
    }, AT, 0);
    if (!("record" in result)) throw new Error("expected a record");
    expect(result.adapter).toBe("openai-chat");
    expect(result.record.inputTokens).toBe(500);
  });

  it("reports a row it cannot read instead of dropping it", () => {
    const result = ingestTraffic([usageRow(), { nonsense: true }, "not an object"], AT);
    expect(result.records).toHaveLength(1);
    expect(result.issues).toHaveLength(2);
    expect(result.issues[0]!.reason).toMatch(/No model field/);
  });

  it("rejects cached tokens exceeding total input", () => {
    const result = normaliseTrafficRow(usageRow({ cached_tokens: 5_000 }), AT, 0);
    expect("issue" in result && result.issue).toMatch(/exceed total input/);
  });

  it("fingerprints a sample stably and distinctly", () => {
    const first = ingestTraffic([usageRow(), usageRow({ id: "r2" })], AT).records;
    const reordered = ingestTraffic([usageRow({ id: "r2" }), usageRow()], AT).records;
    expect(trafficFingerprint(first)).toBe(trafficFingerprint(reordered));
    expect(trafficFingerprint(first)).not.toBe(trafficFingerprint([usageRow()].map((row) =>
      ingestTraffic([row], AT).records[0]!)));
  });
});

describe("episode identification", () => {
  const names = [
    "episodeId", "episode_id", "conversationId", "conversation_id",
    "threadId", "thread_id", "sessionId", "session_id", "traceId", "trace_id", "runId", "run_id",
  ];

  it.each(names)("picks up a task identifier named %s", (field) => {
    const result = normaliseTrafficRow(usageRow({ [field]: "task-1" }), AT, 0);
    if (!("record" in result)) throw new Error("expected a record");
    expect(result.record.episodeId).toBe("task-1");
  });

  it("picks up a nested metadata session id", () => {
    const result = normaliseTrafficRow(usageRow({ metadata: { session_id: "task-9" } }), AT, 0);
    if (!("record" in result)) throw new Error("expected a record");
    expect(result.record.episodeId).toBe("task-9");
  });

  it("leaves episodeId unset when the log carries no task identifier", () => {
    const result = normaliseTrafficRow(usageRow(), AT, 0);
    if (!("record" in result)) throw new Error("expected a record");
    expect(result.record.episodeId).toBeUndefined();
  });

  it("counts round trips per task when identifiers are present", () => {
    const rows = Array.from({ length: 10 }, (_, index) =>
      usageRow({ id: `r${index}`, conversation_id: `task-${Math.floor(index / 5)}` }));
    const measurement = measureTraffic(ingestTraffic(rows, AT).records, publishedModelPrices);
    const episodes = measurement.workloads[0]!.episodes;
    expect(measurement.episodesIdentified).toBe(true);
    expect(episodes.episodes).toBe(2);
    expect(episodes.meanRoundTrips).toBe(5);
    expect(episodes.identified).toBe(true);
  });

  it("says so rather than pretending when no identifier exists", () => {
    const rows = Array.from({ length: 6 }, (_, index) => usageRow({ id: `r${index}` }));
    const measurement = measureTraffic(ingestTraffic(rows, AT).records, publishedModelPrices);
    const episodes = measurement.workloads[0]!.episodes;
    expect(measurement.episodesIdentified).toBe(false);
    expect(episodes.identified).toBe(false);
    // Every request became its own episode, so this figure carries no information.
    expect(episodes.meanRoundTrips).toBe(1);
    expect(measurement.notes.some((note) => /task identifier/.test(note))).toBe(true);
  });

  it("reports the longest task, not just the mean", () => {
    const rows = [
      ...Array.from({ length: 2 }, (_, i) => usageRow({ id: `a${i}`, session_id: "short" })),
      ...Array.from({ length: 8 }, (_, i) => usageRow({ id: `b${i}`, session_id: "long" })),
    ];
    const measurement = measureTraffic(ingestTraffic(rows, AT).records, publishedModelPrices);
    const episodes = measurement.workloads[0]!.episodes;
    expect(episodes.meanRoundTrips).toBe(5);
    expect(episodes.maxRoundTrips).toBe(8);
  });
});

describe("traffic measurement", () => {
  it("separates input already arriving cached from what MESH could save", () => {
    const rows = Array.from({ length: 4 }, (_, index) => usageRow({ id: `r${index}`, cached_tokens: 500 }));
    const measurement = measureTraffic(ingestTraffic(rows, AT).records, publishedModelPrices);
    expect(measurement.alreadyCachedShare).toBeCloseTo(0.5, 6);
    expect(measurement.workloads[0]!.alreadyCachedInputTokens).toBe(2_000);
  });

  it("excludes a model it cannot price rather than treating it as free", () => {
    const rows = [usageRow({ model: "mystery-model-v9" })];
    const measurement = measureTraffic(ingestTraffic(rows, AT).records, publishedModelPrices);
    expect(measurement.totalBaselineCostUsd).toBe(0);
    expect(measurement.unpricedModels.length).toBeGreaterThan(0);
    expect(measurement.workloads[0]!.baselineCostUsd).toBeUndefined();
  });

  it("prices a resolved identifier and records what it resolved to", () => {
    const rows = Array.from({ length: 2 }, (_, index) =>
      usageRow({ id: `r${index}`, model: "claude-sonnet-5-5-20260514" }));
    const measurement = measureTraffic(ingestTraffic(rows, AT).records, publishedModelPrices);
    expect(measurement.workloads[0]!.resolvedModel).toBe("Sonnet 5.5");
    expect(measurement.workloads[0]!.baselineCostUsd).toBeGreaterThan(0);
  });

  it("applies the model's own cacheable minimum to the shared prefix", () => {
    // About 1,500 tokens: above the 1,024 Sonnet/Opus minimum, below Haiku's 2,048.
    const system = Array.from({ length: 750 }, (_, index) => `word${index}`).join(" ");
    const rowsFor = (model: string): Record<string, unknown>[] => Array.from({ length: 3 }, (_, index) => ({
      id: `r${index}`,
      at: AT,
      request: { model, system, messages: [{ role: "user", content: `Question ${index}` }] },
      response: {
        usage: { input_tokens: 1_600, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 50 },
      },
    }));
    const cachingFor = (model: string) => {
      const workload = measureTraffic(ingestTraffic(rowsFor(model), AT).records, publishedModelPrices).workloads[0]!;
      expect(workload.provider).toBe("anthropic");
      return workload.caching!;
    };

    const sonnet = cachingFor("claude-sonnet-5-5-latest");
    expect(sonnet.sharedPrefixTokens).toBeGreaterThan(1_024);
    expect(sonnet.sharedPrefixTokens).toBeLessThan(2_048);
    expect(sonnet.cacheablePrefixShare).toBeGreaterThan(0);
    expect(sonnet.projection.status === "priced" && sonnet.projection.savingUsd > 0).toBe(true);

    const haiku = cachingFor("claude-haiku-5-5-latest");
    // The same prefix is measured, but the provider would not cache it.
    expect(haiku.sharedPrefixTokens).toBe(sonnet.sharedPrefixTokens);
    expect(haiku.cacheablePrefixShare).toBe(0);
    expect(haiku.projection.status === "priced" && haiku.projection.savingUsd === 0).toBe(true);
  });

  it("needs at least one record", () => {
    expect(() => measureTraffic([], publishedModelPrices)).toThrow(/at least one record/);
  });
});
