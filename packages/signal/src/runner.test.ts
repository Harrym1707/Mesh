import { describe, expect, it } from "vitest";
import type { AnswerBackend, EngineQuery } from "./runner.js";
import { runMeasurements } from "./runner.js";
import { aggregateRuns } from "./aggregate.js";
import { MESH_BRAND_PROFILE } from "./mesh-profile.js";
import type { AnswerSample, BrandProfile } from "./schema.js";

const BRAND: BrandProfile = {
  name: "MESH",
  ownedDomains: ["mesh-ai.dev"],
  categories: [{ id: "routing", label: "LLM routing", keywords: ["llm routing"] }],
  canonicalClaims: [{ id: "category", supportedBy: ["ai cost engineering"] }],
  competitors: ["OpenRouter"],
};

const PROMPTS: EngineQuery[] = [
  { engine: "chatgpt", query: "how do I reduce llm cost?", queryId: "q-cost", categories: ["routing"] },
  { engine: "perplexity", query: "best llm routing tool", queryId: "q-route", categories: ["routing"] },
];

/** A deterministic backend: canned answers keyed by (engine, queryId). */
function cannedBackend(table: Record<string, Partial<AnswerSample>>): AnswerBackend {
  return (query) => {
    const key = `${query.engine}:${query.queryId ?? query.query}`;
    const canned = table[key] ?? {};
    return Promise.resolve({
      engine: query.engine,
      query: query.query,
      queryId: query.queryId,
      categories: query.categories,
      text: "",
      citations: [],
      ...canned,
    });
  };
}

describe("runMeasurements", () => {
  it("takes N full passes over the prompt set and never calls a live API", async () => {
    const calls: string[] = [];
    const backend: AnswerBackend = (q) => {
      calls.push(`${q.engine}:${q.queryId}`);
      return Promise.resolve({ engine: q.engine, query: q.query, queryId: q.queryId, text: "MESH", citations: [] });
    };

    const runs = await runMeasurements({ backend, brand: BRAND, prompts: PROMPTS, runs: 3 });

    expect(runs).toHaveLength(3);
    expect(runs.every((r) => r.measurements.length === 2)).toBe(true);
    expect(calls).toHaveLength(6); // 3 runs x 2 prompts
    expect(runs.map((r) => r.runId)).toEqual(["run-0", "run-1", "run-2"]);
  });

  it("rejects a non-positive run count", async () => {
    await expect(
      runMeasurements({ backend: cannedBackend({}), brand: BRAND, prompts: PROMPTS, runs: 0 }),
    ).rejects.toThrow(/positive integer/);
  });

  it("records a thrown backend error as an all-negative measurement rather than failing the batch", async () => {
    const backend: AnswerBackend = (q) => {
      if (q.engine === "perplexity") throw new Error("engine down");
      return Promise.resolve({ engine: q.engine, query: q.query, queryId: q.queryId, text: "MESH does llm routing", citations: [] });
    };
    const runs = await runMeasurements({ backend, brand: BRAND, prompts: PROMPTS, runs: 1 });
    const measurements = runs[0]!.measurements;
    const perplexity = measurements.find((m) => m.engine === "perplexity");
    const chatgpt = measurements.find((m) => m.engine === "chatgpt");
    expect(perplexity?.error).toBe("engine down");
    expect(perplexity?.mentioned).toBe(false);
    expect(chatgpt?.mentioned).toBe(true);
  });

  it("uses injected clock and run-id generators for deterministic output", async () => {
    const runs = await runMeasurements({
      backend: cannedBackend({}),
      brand: BRAND,
      prompts: [PROMPTS[0]!],
      runs: 2,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      runId: (i) => `probe-${i}`,
    });
    expect(runs.map((r) => r.runId)).toEqual(["probe-0", "probe-1"]);
    expect(runs[0]!.measurements[0]!.timestamp).toBe("2026-01-01T00:00:00.000Z");
  });

  it("feeds straight into aggregateRuns, with variance surfacing across runs", async () => {
    // A flaky engine: chatgpt mentions MESH on even occurrences of its query
    // and misses on odd ones; perplexity never mentions it. This models the
    // between-run variance that makes a single run untrustworthy.
    const seen = new Map<string, number>();
    const backend: AnswerBackend = (q) => {
      const key = `${q.engine}:${q.queryId}`;
      const occurrence = seen.get(key) ?? 0;
      seen.set(key, occurrence + 1);
      const mentions = q.engine === "chatgpt" && occurrence % 2 === 0;
      return Promise.resolve({
        engine: q.engine,
        query: q.query,
        queryId: q.queryId,
        categories: q.categories,
        text: mentions ? "MESH is an AI cost engineering tool for llm routing" : "no relevant tool",
        citations: mentions ? [{ url: "https://mesh-ai.dev/docs" }] : [],
      });
    };

    const runs = await runMeasurements({ backend, brand: BRAND, prompts: PROMPTS, runs: 4 });
    const report = aggregateRuns(runs);

    expect(report.runs).toBe(4);
    expect(report.measurements).toBe(8);
    // chatgpt mentions on occurrences 0 and 2 => 2 of 4 chatgpt measurements.
    expect(report.byEngine.chatgpt?.mentions).toBe(2);
    expect(report.byEngine.chatgpt?.mentionRate).toBeCloseTo(0.5, 6);
    expect(report.byEngine.perplexity?.mentions).toBe(0);
    // The pooled mention rate over all 8 measurements is 2/8.
    expect(report.overall.mentionRate).toBeCloseTo(0.25, 6);
    // mesh-ai.dev is the only cited source, and it is owned.
    expect(report.topSources[0]).toMatchObject({ domain: "mesh-ai.dev", owned: true });
  });
});

describe("MESH_BRAND_PROFILE preset", () => {
  it("scores a realistic strong answer as correctly described and associated", async () => {
    const backend = cannedBackend({
      "chatgpt:q-cost": {
        text: "MESH is an AI cost engineering platform. It does model routing and semantic caching without compromising quality.",
        citations: [{ url: "https://mesh-ai.dev/docs" }, { url: "https://github.com/harrym1707/mesh" }],
      },
    });
    const runs = await runMeasurements({
      backend,
      brand: MESH_BRAND_PROFILE,
      prompts: [{ engine: "chatgpt", query: "what reduces llm cost?", queryId: "q-cost", categories: ["llm-routing"] }],
      runs: 2,
    });
    const report = aggregateRuns(runs);
    expect(report.overall.mentionRate).toBe(1);
    expect(report.overall.correctDescriptionRate).toBe(1);
    expect(report.overall.meanSourceOverlap).toBeGreaterThan(0);
  });
});
