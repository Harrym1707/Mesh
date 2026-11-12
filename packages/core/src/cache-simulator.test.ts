import { describe, expect, it } from "vitest";
import type { TokenPrice } from "./cost.js";
import type { BillableEvent } from "./savings-ledger.js";
import {
  ANTHROPIC_CACHE_5M,
  ANTHROPIC_NO_CACHE,
  OPENAI_CACHE,
  buildAgentSession,
  estimateCompactionEconomics,
  estimateCompactionFromLedger,
  ledgerTurnsByTask,
  simulateCache,
  type AgentSessionSpec,
  type CompactionSpec,
  type SimulatedRequest,
} from "./cache-simulator.js";

// Base rates only, so the simulator derives cached and write rates from the
// policy's multipliers rather than from a catalogue entry.
const price: TokenPrice = { inputPerMillion: 1.25, outputPerMillion: 10 };

/** Roughly four characters per token, so sizes here are predictable. */
function filler(tokens: number): string {
  return Array.from({ length: tokens }, (_, index) => `word${index}`).join(" ");
}

function stream(prompts: string[], spacingSeconds = 10): SimulatedRequest[] {
  return prompts.map((prompt, index) => ({
    atSeconds: index * spacingSeconds,
    prompt,
    outputTokens: 100,
  }));
}

describe("cache simulator", () => {
  it("caches nothing below the provider's minimum prefix length", () => {
    const short = filler(200);
    const result = simulateCache(stream([short, short, short]), OPENAI_CACHE, price);
    expect(result.cachedInputTokens).toBe(0);
    expect(result.savingUsd).toBe(0);
    expect(result.missReasons["below-minimum"] ?? result.missReasons["no-matching-prefix"])
      .toBeGreaterThan(0);
  });

  it("caches a long repeated prefix and charges the cached rate for it", () => {
    const prefix = filler(3_000);
    const prompts = Array.from({ length: 5 }, (_, index) => `${prefix}\nQuestion ${index}`);
    const result = simulateCache(stream(prompts), OPENAI_CACHE, price);
    expect(result.hitRate).toBeGreaterThan(0.5);
    expect(result.totalCostUsd).toBeLessThan(result.uncachedCostUsd);
    expect(result.savingPercent).toBeGreaterThan(10);
  });

  it("loses the whole prefix when an early character differs", () => {
    const body = filler(3_000);
    // A per-request value at the very front, which is what a clock in a system
    // prompt does: everything after it stops matching.
    const prompts = Array.from({ length: 5 }, (_, index) => `t=${index}\n${body}`);
    const result = simulateCache(stream(prompts), OPENAI_CACHE, price);
    expect(result.hitRate).toBe(0);
    // Floating-point summation, so compare against zero with a tolerance.
    expect(result.savingUsd).toBeCloseTo(0, 10);
  });

  it("recovers that prefix once the varying value moves to the end", () => {
    const body = filler(3_000);
    const broken = simulateCache(
      stream(Array.from({ length: 5 }, (_, index) => `t=${index}\n${body}`)),
      OPENAI_CACHE,
      price,
    );
    const repaired = simulateCache(
      stream(Array.from({ length: 5 }, (_, index) => `${body}\nt=${index}`)),
      OPENAI_CACHE,
      price,
    );
    expect(repaired.hitRate).toBeGreaterThan(broken.hitRate);
    expect(repaired.totalCostUsd).toBeLessThan(broken.totalCostUsd);
  });

  it("goes cold when requests are spread beyond the time to live", () => {
    const prefix = filler(3_000);
    const prompts = Array.from({ length: 6 }, (_, index) => `${prefix}\nQuestion ${index}`);
    const warm = simulateCache(stream(prompts, 30), OPENAI_CACHE, price);
    // Spacing beyond the 300s TTL means every entry has expired by the next call.
    const cold = simulateCache(stream(prompts, 600), OPENAI_CACHE, price);
    expect(warm.hitRate).toBeGreaterThan(0.5);
    expect(cold.hitRate).toBe(0);
    expect(cold.expiries).toBeGreaterThan(0);
    expect(cold.savingUsd).toBeLessThanOrEqual(warm.savingUsd);
  });

  it("can make caching a net loss where a write premium is charged and nothing repeats", () => {
    const prefix = filler(3_000);
    // Each prompt is unique and spaced past the TTL, so every call pays a write
    // premium and no call ever reads. Anthropic charges 1.25x to write.
    const prompts = Array.from({ length: 4 }, (_, index) => `${prefix}-${index}-${filler(50)}`);
    const result = simulateCache(stream(prompts, 900), ANTHROPIC_CACHE_5M, price);
    expect(result.cachedInputTokens).toBe(0);
    expect(result.savingUsd).toBeLessThan(0);
  });

  it("grants hits in whole increments of the policy's granularity", () => {
    const prefix = filler(3_000);
    const result = simulateCache(
      stream([`${prefix}a`, `${prefix}b`]),
      OPENAI_CACHE,
      price,
    );
    const hit = result.calls[1]!;
    expect(hit.cachedInputTokens % OPENAI_CACHE.incrementTokens).toBe(0);
  });

  it("splits every call's input into cached, written and fresh without losing tokens", () => {
    const prefix = filler(3_000);
    const result = simulateCache(
      stream(Array.from({ length: 4 }, (_, index) => `${prefix}\nQ${index}`)),
      OPENAI_CACHE,
      price,
    );
    for (const call of result.calls) {
      expect(call.cachedInputTokens + call.writtenInputTokens + call.freshInputTokens)
        .toBe(call.totalInputTokens);
      expect(call.freshInputTokens).toBeGreaterThanOrEqual(0);
    }
  });

  it("never reports a saving on the very first call", () => {
    const result = simulateCache(stream([filler(3_000)]), OPENAI_CACHE, price);
    expect(result.calls[0]!.cachedInputTokens).toBe(0);
    expect(result.calls[0]!.missReason).toBe("first-request");
  });

  it("orders requests by time regardless of input order", () => {
    const prefix = filler(3_000);
    const out: SimulatedRequest[] = [
      { atSeconds: 60, prompt: `${prefix}\nsecond`, outputTokens: 10 },
      { atSeconds: 0, prompt: `${prefix}\nfirst`, outputTokens: 10 },
    ];
    const result = simulateCache(out, OPENAI_CACHE, price);
    expect(result.calls[0]!.atSeconds).toBe(0);
    expect(result.calls[1]!.atSeconds).toBe(60);
  });

  it("validates its inputs", () => {
    expect(() => simulateCache([], OPENAI_CACHE, price)).toThrow(/at least one request/);
    expect(() => simulateCache(stream([filler(100)]), { ...OPENAI_CACHE, incrementTokens: 0 }, price))
      .toThrow(/at least 1 token/);
  });
});

describe("compaction economics", () => {
  // Anthropic 5m rates, so writes cost 1.25x and cached reads 0.1x of input.
  const anthropicPrice: TokenPrice = {
    inputPerMillion: 3,
    cachedInputPerMillion: 0.3,
    cacheWriteInputPerMillion: 3.75,
    outputPerMillion: 15,
  };

  // An agentic session: stable system block, a chunky transcript appended each
  // turn, enough turns for compaction to have something to shrink.
  const session: AgentSessionSpec = {
    systemPromptTokens: 1_200,
    turns: 12,
    userTurnTokens: 900,
    assistantTurnTokens: 300,
    secondsPerTurn: 20,
  };
  const compaction: CompactionSpec = { atTurn: 6, summaryTokens: 500 };

  it("grows the baseline transcript one segment per turn, system block fixed", () => {
    const requests = buildAgentSession(session);
    expect(requests).toHaveLength(session.turns);
    // Later prompts strictly contain earlier ones: appends only, exact prefixes.
    expect(requests[5]!.prompt.startsWith(requests[0]!.prompt)).toBe(true);
    expect(requests.at(-1)!.prompt.length).toBeGreaterThan(requests[0]!.prompt.length);
  });

  it("inserts a summarisation call before the compaction turn by default", () => {
    const plain = buildAgentSession(session);
    const compacted = buildAgentSession(session, compaction);
    // One extra call — the summarisation read — over the straight-through run.
    expect(compacted).toHaveLength(plain.length + 1);
    const suppressed = buildAgentSession(session, { ...compaction, chargeSummarizationCall: false });
    expect(suppressed).toHaveLength(plain.length);
  });

  it("prices the cache invalidation and the summarisation call as costs", () => {
    const economics = estimateCompactionEconomics(
      session,
      compaction,
      ANTHROPIC_CACHE_5M,
      anthropicPrice,
    );
    // Collapsing the prefix to the system block costs money on that turn.
    expect(economics.cacheInvalidationCostUsd).toBeGreaterThan(0);
    expect(economics.summarizationCostUsd).toBeGreaterThan(0);
  });

  it("helps more when the cache is cold than when it is warm", () => {
    // Warm 5m cache: the baseline already reads its transcript at 0.1x, so
    // compaction shrinks something that was already cheap.
    const warm = estimateCompactionEconomics(session, compaction, ANTHROPIC_CACHE_5M, anthropicPrice);
    // No cache_control placed: every turn re-sends the whole transcript at full
    // price, the quadratic tax is real, and a smaller prefix saves on all of it.
    const cold = estimateCompactionEconomics(session, compaction, ANTHROPIC_NO_CACHE, {
      inputPerMillion: 3,
      outputPerMillion: 15,
    });
    expect(cold.netSavingUsd).toBeGreaterThan(warm.netSavingUsd);
    expect(cold.worthwhile).toBe(true);
    expect(cold.breakEvenTurns).not.toBeNull();
    expect(cold.breakEvenTurns!).toBeGreaterThanOrEqual(0);
  });

  it("drops the summarisation cost to zero when it is not charged", () => {
    const economics = estimateCompactionEconomics(
      session,
      { ...compaction, chargeSummarizationCall: false },
      ANTHROPIC_CACHE_5M,
      anthropicPrice,
    );
    expect(economics.summarizationCostUsd).toBe(0);
    // The cache penalty stands on its own regardless of the summarisation call.
    expect(economics.cacheInvalidationCostUsd).toBeGreaterThan(0);
  });

  it("rejects a compaction point outside the session", () => {
    expect(() => buildAgentSession(session, { atTurn: 1, summaryTokens: 100 }))
      .toThrow(/after the first turn/);
    expect(() => buildAgentSession(session, { atTurn: 99, summaryTokens: 100 }))
      .toThrow(/within the session/);
  });
});

describe("compaction priced from recorded ledger traffic", () => {
  const ledgerPrice: TokenPrice = {
    inputPerMillion: 3,
    cachedInputPerMillion: 0.3,
    cacheWriteInputPerMillion: 3.75,
    outputPerMillion: 15,
  };

  // Build a recorded event in the exact shape the proxy writes, for a single
  // multi-turn task whose transcript grows ~2000 tokens a turn.
  function event(
    taskId: string,
    turnIndex: number,
    inputTokens: number,
    cached: boolean,
    overrides: Partial<BillableEvent> = {},
  ): BillableEvent {
    return {
      schemaVersion: 1,
      requestId: `${taskId}-${turnIndex}`,
      applicationId: "app",
      taskId,
      turnIndex,
      invoicePeriod: "2026-11",
      timestamp: new Date(1_700_000_000_000 + turnIndex * 20_000).toISOString(),
      provider: "anthropic",
      model: "claude-x",
      executionMode: "standard",
      pricingStatus: "priced",
      usage: {
        inputTokens,
        outputTokens: 400,
        cachedInputTokens: cached ? Math.max(0, inputTokens - 2_000) : 0,
        cacheWriteInputTokens: 0,
      },
      levers: [],
      status: "succeeded",
      ...overrides,
    };
  }

  function task(taskId: string, cached: boolean): BillableEvent[] {
    // Turn t carries system (~2000) plus t growth steps of ~2000.
    return Array.from({ length: 10 }, (_, index) =>
      event(taskId, index + 1, 2_000 + (index + 1) * 2_000, cached));
  }

  it("groups events into tasks, in turn order, dropping failed and usage-less events", () => {
    const events: BillableEvent[] = [
      ...task("warm", true),
      event("warm", 11, 99_999, true, { status: "failed" }),
      event("warm", 12, 0, true, { usage: undefined }),
      ...task("cold", false),
    ];
    const byTask = ledgerTurnsByTask(events);
    expect([...byTask.keys()].sort()).toEqual(["cold", "warm"]);
    const warm = byTask.get("warm")!;
    expect(warm).toHaveLength(10); // the failed and usage-less events were dropped
    expect(warm.map((turn) => turn.turnIndex)).toEqual([...warm.map((t) => t.turnIndex)].sort((a, b) => a - b));
  });

  it("values the removed context and reports a break-even horizon", () => {
    const turns = ledgerTurnsByTask(task("warm", true)).get("warm")!;
    const estimate = estimateCompactionFromLedger(turns, { atTurn: 6, summaryTokens: 800 }, ledgerPrice);
    // Compaction at turn 6 discards the history carried into it, minus summary.
    expect(estimate.removedTokensPerTurn).toBeGreaterThan(0);
    expect(estimate.postCompactionTurns).toBe(5);
    expect(estimate.recordedCostUsd).toBeGreaterThan(0);
  });

  it("derives the warm/cold split from the recorded cache usage, not an assumption", () => {
    const warm = estimateCompactionFromLedger(
      ledgerTurnsByTask(task("warm", true)).get("warm")!,
      { atTurn: 6, summaryTokens: 800 },
      ledgerPrice,
    );
    const cold = estimateCompactionFromLedger(
      ledgerTurnsByTask(task("cold", false)).get("cold")!,
      { atTurn: 6, summaryTokens: 800 },
      ledgerPrice,
    );
    // Same tokens removed either way — only the realized rate differs.
    expect(cold.removedTokensPerTurn).toBe(warm.removedTokensPerTurn);
    // Cold traffic paid full rate for the context, so removing it saves ~10x more.
    expect(cold.netSavingUsd).toBeGreaterThan(warm.netSavingUsd);
    expect(cold.worthwhile).toBe(true);
    expect(cold.grossSavingUsd).toBeGreaterThan(warm.grossSavingUsd * 5);
  });

  it("agrees in direction with the synthetic simulator on events built from a real run", () => {
    // Turn a string simulation into recorded-shape events, then price compaction
    // from those events. The ledger path should see a saving where the string
    // path does, with no shared code between them.
    const spec: AgentSessionSpec = {
      systemPromptTokens: 2_000, turns: 10, userTurnTokens: 1_500, assistantTurnTokens: 500, secondsPerTurn: 20,
    };
    const compaction: CompactionSpec = { atTurn: 6, summaryTokens: 800 };
    const sim = simulateCache(buildAgentSession(spec), ANTHROPIC_NO_CACHE, { inputPerMillion: 3, outputPerMillion: 15 });
    const events: BillableEvent[] = sim.calls.map((call, index) =>
      event("replay", index + 1, call.totalInputTokens, call.cachedInputTokens > 0, {
        usage: {
          inputTokens: call.totalInputTokens,
          outputTokens: call.outputTokens,
          cachedInputTokens: call.cachedInputTokens,
          cacheWriteInputTokens: call.writtenInputTokens,
        },
      }));
    const fromLedger = estimateCompactionFromLedger(
      ledgerTurnsByTask(events).get("replay")!,
      compaction,
      { inputPerMillion: 3, outputPerMillion: 15 },
    );
    const fromSim = estimateCompactionEconomics(
      spec, compaction, ANTHROPIC_NO_CACHE, { inputPerMillion: 3, outputPerMillion: 15 });
    expect(fromLedger.worthwhile).toBe(true);
    expect(fromSim.worthwhile).toBe(true);
  });

  it("validates its inputs", () => {
    const turns = ledgerTurnsByTask(task("warm", true)).get("warm")!;
    expect(() => estimateCompactionFromLedger(turns.slice(0, 1), { atTurn: 2, summaryTokens: 100 }, ledgerPrice))
      .toThrow(/at least two/);
    expect(() => estimateCompactionFromLedger(turns, { atTurn: 1, summaryTokens: 100 }, ledgerPrice))
      .toThrow(/after the first turn/);
  });
});

describe("cache availability delay (fan-out collision semantics)", () => {
  const delay = () => 5; // a flat 5s stand-in for time-to-first-byte

  it("without a delay, simultaneous same-prefix requests already read each other (today's optimistic default)", () => {
    const prefix = filler(3_000);
    const requests: SimulatedRequest[] = [
      { atSeconds: 0, prompt: `${prefix}\nagent-a`, outputTokens: 100 },
      { atSeconds: 0, prompt: `${prefix}\nagent-b`, outputTokens: 100 },
      { atSeconds: 0, prompt: `${prefix}\nagent-c`, outputTokens: 100 },
    ];
    const result = simulateCache(requests, ANTHROPIC_CACHE_5M, price);
    // Two of the three read the first one's write — the instant-availability
    // assumption this option exists to correct.
    expect(result.calls[1]!.cachedInputTokens).toBeGreaterThan(0);
    expect(result.calls[2]!.cachedInputTokens).toBeGreaterThan(0);
  });

  it("with a realistic availability delay, simultaneous same-prefix requests all collide and all write", () => {
    const prefix = filler(3_000);
    const requests: SimulatedRequest[] = [
      { atSeconds: 0, prompt: `${prefix}\nagent-a`, outputTokens: 100 },
      { atSeconds: 0, prompt: `${prefix}\nagent-b`, outputTokens: 100 },
      { atSeconds: 0, prompt: `${prefix}\nagent-c`, outputTokens: 100 },
    ];
    const result = simulateCache(requests, ANTHROPIC_CACHE_5M, price, { cacheAvailabilityDelaySeconds: delay });
    expect(result.calls[1]!.cachedInputTokens).toBe(0);
    expect(result.calls[2]!.cachedInputTokens).toBe(0);
    expect(result.calls[1]!.missReason).toBe("racing-write");
    expect(result.calls[2]!.missReason).toBe("racing-write");
    expect(result.cachedInputTokens).toBe(0);
  });

  it("a request arriving after the delay elapses reads normally — only true simultaneity collides", () => {
    const prefix = filler(3_000);
    const requests: SimulatedRequest[] = [
      { atSeconds: 0, prompt: `${prefix}\nagent-a`, outputTokens: 100 },
      { atSeconds: 0, prompt: `${prefix}\nagent-b`, outputTokens: 100 },
      // Arrives once agent-a's write would have registered.
      { atSeconds: 10, prompt: `${prefix}\nagent-c`, outputTokens: 100 },
    ];
    const result = simulateCache(requests, ANTHROPIC_CACHE_5M, price, { cacheAvailabilityDelaySeconds: delay });
    expect(result.calls[1]!.missReason).toBe("racing-write");
    expect(result.calls[2]!.cachedInputTokens).toBeGreaterThan(0);
  });

  it("an explicit zero-delay function is indistinguishable from the omitted option", () => {
    const prefix = filler(3_000);
    const requests: SimulatedRequest[] = [
      { atSeconds: 0, prompt: `${prefix}\nagent-a`, outputTokens: 100 },
      { atSeconds: 0, prompt: `${prefix}\nagent-b`, outputTokens: 100 },
    ];
    const withZero = simulateCache(requests, ANTHROPIC_CACHE_5M, price, { cacheAvailabilityDelaySeconds: () => 0 });
    const omitted = simulateCache(requests, ANTHROPIC_CACHE_5M, price);
    expect(withZero.totalCostUsd).toBe(omitted.totalCostUsd);
    expect(withZero.cachedInputTokens).toBe(omitted.cachedInputTokens);
  });
});
