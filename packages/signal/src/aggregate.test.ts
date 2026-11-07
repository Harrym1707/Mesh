import { describe, expect, it } from "vitest";
import type { MeasurementRun, SignalMeasurement } from "./schema.js";
import { aggregateRuns, rateMeasurements } from "./aggregate.js";

/** Build a measurement with only the fields a given test cares about. */
function measurement(partial: Partial<SignalMeasurement>): SignalMeasurement {
  return {
    engine: "chatgpt",
    query: "q",
    queryId: "q",
    runId: "run-0",
    timestamp: "2026-11-07T00:00:00.000Z",
    mentioned: false,
    cited: false,
    linked: false,
    categoriesAssociated: [],
    factualDescription: { present: false, correct: false, supportedClaims: [], contradictedClaims: [] },
    sourceOverlap: { citedDomains: [], ownedDomainsCited: [], overlapRatio: null },
    categoriesProbed: [],
    competitorMentions: [],
    ...partial,
  };
}

function run(runId: string, measurements: SignalMeasurement[]): MeasurementRun {
  return { runId, timestamp: "2026-11-07T00:00:00.000Z", measurements };
}

describe("rateMeasurements", () => {
  it("uses the right denominator for each signal", () => {
    // 4 measurements: 2 mention, of those 1 cited, 1 linked, 2 describe (1 correct).
    const rates = rateMeasurements([
      measurement({
        mentioned: true,
        cited: true,
        factualDescription: { present: true, correct: true, supportedClaims: ["category"], contradictedClaims: [] },
      }),
      measurement({
        mentioned: true,
        linked: true,
        factualDescription: { present: true, correct: false, supportedClaims: [], contradictedClaims: ["category"] },
      }),
      measurement({ mentioned: false }),
      measurement({ mentioned: false }),
    ]);

    expect(rates.mentionRate).toBeCloseTo(2 / 4, 6); // over all measurements
    expect(rates.citationRate).toBeCloseTo(1 / 2, 6); // over mentions
    expect(rates.linkRate).toBeCloseTo(1 / 2, 6); // over mentions
    expect(rates.descriptionPresentRate).toBeCloseTo(2 / 2, 6); // over mentions
    expect(rates.correctDescriptionRate).toBeCloseTo(1 / 2, 6); // over descriptions present
  });

  it("keeps conditional rates in [0,1] when citations occur without a mention (regression)", () => {
    // 2 measurements: one mentions and cites; one cites but does NOT mention.
    // Before the fix, citations(2) / mentions(1) = 2.0 — a rate above 1.
    const rates = rateMeasurements([
      measurement({ mentioned: true, cited: true, linked: true }),
      measurement({ mentioned: false, cited: true, linked: true }),
    ]);
    expect(rates.mentions).toBe(1);
    expect(rates.citations).toBe(1); // only the mention-positive citation counts
    expect(rates.links).toBe(1);
    expect(rates.citationRate).toBe(1); // not 2
    expect(rates.linkRate).toBe(1);
    expect(rates.citationRate).toBeLessThanOrEqual(1);
    expect(rates.linkRate).toBeLessThanOrEqual(1);
  });

  it("ignores citations entirely in a run with zero mentions", () => {
    const rates = rateMeasurements([measurement({ mentioned: false, cited: true, linked: true })]);
    expect(rates.citations).toBe(0);
    expect(rates.links).toBe(0);
    expect(rates.citationRate).toBeNull(); // 0 mentions -> undefined, not inflated
    expect(rates.linkRate).toBeNull();
  });

  it("returns null rates when the denominator is zero", () => {
    const rates = rateMeasurements([measurement({ mentioned: false })]);
    expect(rates.mentionRate).toBe(0); // 0/1
    expect(rates.citationRate).toBeNull(); // 0 mentions
    expect(rates.correctDescriptionRate).toBeNull(); // 0 descriptions
    expect(rates.meanSourceOverlap).toBeNull(); // nothing cited
  });

  it("averages source overlap only over measurements that cited something", () => {
    const rates = rateMeasurements([
      measurement({ sourceOverlap: { citedDomains: ["a"], ownedDomainsCited: ["a"], overlapRatio: 1 } }),
      measurement({ sourceOverlap: { citedDomains: ["b"], ownedDomainsCited: [], overlapRatio: 0 } }),
      measurement({ sourceOverlap: { citedDomains: [], ownedDomainsCited: [], overlapRatio: null } }),
    ]);
    expect(rates.meanSourceOverlap).toBeCloseTo(0.5, 6); // (1 + 0) / 2, null ignored
  });
});

describe("aggregateRuns", () => {
  it("pools headline rates and reports the per-run distribution", () => {
    // Two runs of one query each. Run A mentions, run B does not. Pooled
    // mention rate is 1/2; per-run rates are [1, 0]; mean 0.5, stddev 0.5.
    const runs = [
      run("run-0", [measurement({ mentioned: true })]),
      run("run-1", [measurement({ runId: "run-1", mentioned: false })]),
    ];
    const report = aggregateRuns(runs);

    expect(report.runs).toBe(2);
    expect(report.measurements).toBe(2);
    expect(report.overall.mentionRate).toBeCloseTo(0.5, 6);

    const dist = report.distribution.mentionRate;
    expect(dist.values).toEqual([1, 0]);
    expect(dist.mean).toBeCloseTo(0.5, 6);
    expect(dist.stddev).toBeCloseTo(0.5, 6);
    expect(dist.min).toBe(0);
    expect(dist.max).toBe(1);
    expect(dist.runs).toBe(2);
  });

  it("drops null per-run rates from a distribution instead of counting them as zero", () => {
    // Neither run mentions the brand, so citationRate is null in both runs.
    const runs = [
      run("run-0", [measurement({ mentioned: false })]),
      run("run-1", [measurement({ runId: "run-1", mentioned: false })]),
    ];
    const dist = aggregateRuns(runs).distribution.citationRate;
    expect(dist.values).toEqual([null, null]);
    expect(dist.runs).toBe(0);
    expect(dist.mean).toBeNull();
    expect(dist.stddev).toBeNull();
  });

  it("splits rates by engine", () => {
    const runs = [
      run("run-0", [
        measurement({ engine: "chatgpt", mentioned: true }),
        measurement({ engine: "perplexity", mentioned: false }),
      ]),
    ];
    const report = aggregateRuns(runs);
    expect(report.byEngine.chatgpt?.mentionRate).toBe(1);
    expect(report.byEngine.perplexity?.mentionRate).toBe(0);
  });

  it("computes category association as associated / probed", () => {
    const runs = [
      run("run-0", [
        measurement({ categoriesProbed: ["routing"], mentioned: true, categoriesAssociated: ["routing"] }),
        measurement({ categoriesProbed: ["routing"], mentioned: true, categoriesAssociated: [] }),
        measurement({ categoriesProbed: ["caching"], mentioned: false }),
      ]),
    ];
    const byCategory = aggregateRuns(runs).byCategory;
    const routing = byCategory.find((c) => c.categoryId === "routing");
    const caching = byCategory.find((c) => c.categoryId === "caching");
    expect(routing).toMatchObject({ probed: 2, associated: 1, associationRate: 0.5 });
    expect(caching).toMatchObject({ probed: 1, associated: 0, associationRate: 0 });
  });

  it("ranks cited sources by frequency, flagging owned domains", () => {
    const runs = [
      run("run-0", [
        measurement({ sourceOverlap: { citedDomains: ["mesh-ai.dev", "openai.com"], ownedDomainsCited: ["mesh-ai.dev"], overlapRatio: 0.5 } }),
        measurement({ sourceOverlap: { citedDomains: ["mesh-ai.dev"], ownedDomainsCited: ["mesh-ai.dev"], overlapRatio: 1 } }),
      ]),
    ];
    const sources = aggregateRuns(runs).topSources;
    expect(sources[0]).toEqual({ domain: "mesh-ai.dev", count: 2, owned: true });
    expect(sources[1]).toEqual({ domain: "openai.com", count: 1, owned: false });
  });

  it("tallies competitor co-occurrence across runs", () => {
    const runs = [
      run("run-0", [measurement({ competitorMentions: ["OpenRouter", "LiteLLM"] })]),
      run("run-1", [measurement({ runId: "run-1", competitorMentions: ["OpenRouter"] })]),
    ];
    expect(aggregateRuns(runs).competitorMentions).toEqual({ LiteLLM: 1, OpenRouter: 2 });
  });
});
