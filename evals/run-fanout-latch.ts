import {
  ANTHROPIC_CACHE_5M,
  lookupPrice,
  publishedModelPrices,
  simulateCache,
  type CachePolicy,
  type SimulatedRequest,
} from "../packages/core/src/index.js";
import { FanOutLatch, fanOutPrefixHash } from "../packages/sdk-js/src/fanout-latch.js";

/**
 * Multi-agent fan-out: the shared-prefix cache race, and the latch that
 * repairs it (lever P5 in docs/rnd/lever-backlog.md).
 *
 *   node --import tsx evals/run-fanout-latch.ts
 *
 * The question: when an orchestrator starts several sub-agents that share a
 * system+tools prefix AT THE SAME INSTANT — the normal way multi-agent
 * frameworks fan out — does the shared prefix cache once, or does every
 * racer pay a separate write premium?
 *
 * Grounding for "at the same instant": LangGraph's `Send` API runs every
 * dispatched node within one superstep (not staggered); CrewAI's
 * `akickoff_for_each` / `asyncio.gather(*[crew.akickoff(...) for ...])`
 * pattern starts every kickoff together. Neither framework serializes
 * sub-agent starts by design — concurrency is the point of fanning out.
 *
 * `evals/run-workload-matrix.ts`'s existing "multi-agent team" shape staggers
 * its five agents by 4 seconds within each round. That was never measuring
 * the race this eval measures — a 4-second stagger is already enough
 * separation for a real write to complete, so that fixture has always
 * reported the SERIALIZED outcome, never the concurrent one. This eval adds
 * the concurrent case instead of changing that one.
 *
 * What the OLD simulator could not see, and could not have gotten right
 * either way: `simulateCache` processed every request in strict order and
 * made each entry visible to the very next request with no delay, so two
 * requests at the identical timestamp already looked like one write and one
 * cheap read — the latch's entire benefit, for free, with no latch and no
 * latency cost. Tonight's `writeAvailabilityDelaySeconds` (see
 * packages/core/src/cache-simulator.ts) fixes that: an entry is not visible
 * until some time after its write started, so genuinely simultaneous
 * requests now correctly ALL miss unless something holds the followers back.
 * Every PUBLISHED number is untouched by this (the field defaults to 0,
 * reproducing the exact prior behaviour); this eval is the first thing that
 * sets it to something else.
 */

type AnyObject = Record<string, unknown>;

const AT = "2026-10-27";
const price = lookupPrice(publishedModelPrices, { provider: "anthropic", model: "Sonnet 5.5", at: AT });
if (price.status !== "priced") throw new Error("price lookup failed for Sonnet 5.5");

// The shared prefix: a realistic orchestrator system prompt + a 10-tool
// catalogue, same shape and size as run-workload-matrix.ts's multi-agent
// fixture, so this eval's baseline cost is comparable to the published one.
const PREAMBLE =
  "You are a careful specialist agent on a production team. Follow the runbook: verify inputs, cite sources, " +
  "prefer small reversible steps, surface anything risky to the orchestrator, and keep outputs terse. ".repeat(14);

const TOOLS = Array.from({ length: 10 }, (_, index) => ({
  name: `tool_${index}`,
  description:
    `Tool ${index} operates on subsystem ${index}. It validates its input against the schema, retries once on ` +
    "transient failure, never mutates shared state without a lock, and returns a compact JSON result. " +
    "Use it only when the orchestrator's plan names this subsystem explicitly.",
  input_schema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    additionalProperties: false,
    properties: { id: { type: "string" }, scope: { type: "string" }, dryRun: { type: "boolean" } },
    required: ["id"],
  },
}));

const AGENTS = ["search", "coder", "reviewer", "writer", "tester"];
const ROUNDS = 6;
// Comfortably past ANTHROPIC_CACHE_5M's 300s TTL, so every round starts cold
// and is its own fresh race rather than a continuation of a still-warm cache
// from the previous round (90s, inside the TTL, would make only round 0 race
// and every later round a trivial warm hit regardless of the latch).
const ROUND_GAP_SECONDS = 400;

type Shaped = { atSeconds: number; prompt: string; outputTokens: number; groupKey: string };

function buildPrompt(agent: string, round: number): string {
  const system = PREAMBLE;
  const tools = TOOLS;
  const messages = [{ role: "user", content: `Round ${round} task for ${agent}: advance ticket 7, step ${round}.` }];
  return JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 500, system, tools, messages });
}

/** Every agent in a round fires at the SAME instant — the concurrent fan-out shape. */
function concurrentFanOut(): Shaped[] {
  const stream: Shaped[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const atSeconds = round * ROUND_GAP_SECONDS;
    for (const agent of AGENTS) {
      stream.push({
        atSeconds,
        prompt: buildPrompt(agent, round),
        outputTokens: 220,
        groupKey: fanOutPrefixHash({ model: "claude-sonnet-5-5", tools: TOOLS, system: PREAMBLE }),
      });
    }
  }
  return stream;
}

/**
 * What the proxy's FanOutLatch actually produces: within each same-instant
 * group sharing a prefix, the first arrival (the leader) is sent at its
 * original time; every other arrival is held and resent at
 * `leaderTime + holdSeconds` — the moment the leader's headers would arrive.
 * This mirrors `FanOutLatch.acquire`/`release` exactly, just applied to a
 * timestamp instead of a live request, because the simulator deals in
 * timestamps.
 */
function applyLatch(stream: Shaped[], holdSeconds: number): SimulatedRequest[] {
  const leaderSeenAt = new Map<string, number>();
  return stream.map((item) => {
    const key = `${item.groupKey}@${item.atSeconds}`;
    const leaderAt = leaderSeenAt.get(key);
    if (leaderAt === undefined) {
      leaderSeenAt.set(key, item.atSeconds);
      return { atSeconds: item.atSeconds, prompt: item.prompt, outputTokens: item.outputTokens };
    }
    return { atSeconds: leaderAt + holdSeconds, prompt: item.prompt, outputTokens: item.outputTokens };
  });
}

function toSimulated(stream: Shaped[]): SimulatedRequest[] {
  return stream.map(({ atSeconds, prompt, outputTokens }) => ({ atSeconds, prompt, outputTokens }));
}

function report(label: string, result: ReturnType<typeof simulateCache>, baselineCost?: number): void {
  const vsBaseline = baselineCost === undefined ? "" :
    `   vs naive ${(((baselineCost - result.totalCostUsd) / baselineCost) * 100).toFixed(1)}%`;
  console.log(
    `${label.padEnd(32)} cost $${result.totalCostUsd.toFixed(4)}   hits ${(result.hitRate * 100).toFixed(0)}%` +
    `   writes ${result.calls.filter((c) => c.writtenInputTokens > 0).length}/${result.calls.length}${vsBaseline}`,
  );
}

// --- Measurement -----------------------------------------------------------

console.log(`${AGENTS.length} sub-agents x ${ROUNDS} rounds, every round genuinely concurrent (same instant)\n`);

// Assumption, stated plainly: how long after a cold write starts until its
// first response bytes (and therefore the provider's committed cache entry)
// arrive. NOT measured — no capture in this repo carries timestamps, so this
// cannot be derived from real traffic yet (see docs/rnd/lever-backlog.md P5's
// own open item). 1.5s is a reasoned placeholder for a ~2,500-token cold
// Anthropic write; treat every number below as ESTIMATE-dependent, and
// recompute once a real TTFB measurement exists.
const ASSUMED_HOLD_SECONDS = 1.5;

const raceyPolicy: CachePolicy = { ...ANTHROPIC_CACHE_5M, writeAvailabilityDelaySeconds: ASSUMED_HOLD_SECONDS };

const naiveStream = concurrentFanOut();

console.log("=== corrected baseline: concurrent fan-out, race modeled, NO latch ===");
const naiveResult = simulateCache(toSimulated(naiveStream), raceyPolicy, price.price);
report("naive concurrent (racey)", naiveResult);
console.log(`  miss reasons: ${JSON.stringify(naiveResult.missReasons)}`);

console.log("\n=== OLD simulator behaviour on the exact same stream (writeAvailabilityDelaySeconds unset) ===");
const oldSimulatorResult = simulateCache(toSimulated(naiveStream), ANTHROPIC_CACHE_5M, price.price);
report("naive concurrent, old sim", oldSimulatorResult, naiveResult.totalCostUsd);
console.log(
  "  caveat: this is what every eval in this repo computed before tonight — concurrent racers already read\n" +
  "  each other's writes for free, with no latch and no latency cost, because the simulator had no concept\n" +
  "  of a write taking any time to become visible. That is the overstatement lever P5's own notes warned\n" +
  "  about (\"retire the ~92% headline until collision frequency is measured\"); it is NOT this lever's number.",
);

console.log(`\n=== WITH the fan-out latch (hold = ${ASSUMED_HOLD_SECONDS}s, the same assumption as the baseline) ===`);
const latchedStream = applyLatch(naiveStream, ASSUMED_HOLD_SECONDS);
const latchedResult = simulateCache(latchedStream, raceyPolicy, price.price);
report("latched (followers held)", latchedResult, naiveResult.totalCostUsd);
console.log(`  miss reasons: ${JSON.stringify(latchedResult.missReasons)}`);

console.log(
  `\nRESULT: against the CORRECTED (race-modeled) baseline, the latch recovers ` +
  `${(((naiveResult.totalCostUsd - latchedResult.totalCostUsd) / naiveResult.totalCostUsd) * 100).toFixed(1)}% ` +
  `of this shape's cost. Against the OLD, over-optimistic simulator baseline the latch adds ` +
  `${(((oldSimulatorResult.totalCostUsd - latchedResult.totalCostUsd) / oldSimulatorResult.totalCostUsd) * 100).toFixed(1)}% ` +
  `(near zero, as expected: the old simulator was already crediting this traffic the latch's own benefit).`,
);
console.log(
  "\ncaveats (binding, per lever P5's adversarial conditions):\n" +
  "- ASSUMED_HOLD_SECONDS is a placeholder, not a measurement. It is also the number the baseline bakes in,\n" +
  "  so this is an internally-consistent comparison, not a claim about any specific provider's real TTFB.\n" +
  "- This prices BYTES only. It does NOT price the held followers' added wall-clock latency, which is a real\n" +
  "  cost to the customer and is exactly why the proxy's FanOutLatch is opt-in (fanOutLatch) and bounded\n" +
  "  (maxHoldMs, fail-open) rather than a default.\n" +
  "- Collision frequency in real traffic is unmeasured (no capture in this repo carries timestamps); this\n" +
  "  shape assumes every round's sub-agents start within the same instant, which is the documented behaviour\n" +
  "  of LangGraph's Send superstep and CrewAI's asyncio.gather fan-out, not a measured collision rate.",
);

// --- Unit-ish self-checks, so a future refactor of this eval cannot silently invert the finding -----------
const writesPerRound = AGENTS.length; // naive: every racer in a round writes
const naiveWriteCount = naiveResult.calls.filter((c) => c.writtenInputTokens > 0).length;
const latchedWriteCount = latchedResult.calls.filter((c) => c.writtenInputTokens > 0).length;
if (naiveWriteCount !== writesPerRound * ROUNDS) {
  throw new Error(`expected every naive racer to write (${writesPerRound * ROUNDS}), got ${naiveWriteCount}`);
}
if (latchedWriteCount !== ROUNDS) {
  throw new Error(`expected exactly one write per round under the latch (${ROUNDS}), got ${latchedWriteCount}`);
}
console.log(`\nself-check passed: naive writes ${naiveWriteCount}/${naiveResult.calls.length}, latched writes ${latchedWriteCount}/${latchedResult.calls.length}`);
