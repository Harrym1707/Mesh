import {
  ANTHROPIC_CACHE_5M,
  ANTHROPIC_NO_CACHE,
  approximateTokenCount,
  lookupPrice,
  publishedModelPrices,
  simulateCache,
  type CachePolicy,
  type SimulatedRequest,
} from "../packages/core/src/index.js";

/**
 * Lever P5 — shared-prefix fan-out serialization (lever backlog, docs/rnd/lever-backlog.md).
 *
 *   node --import tsx evals/run-fanout-serialization.ts
 *
 * Mechanism: Anthropic's documented rule is that a cache entry exists only
 * once the WRITE that created it has a response in flight, not at the
 * moment the write was sent. Several requests sharing one cacheable prefix
 * (model + tools + system), dispatched within the same instant, therefore
 * cannot see each other: every one of them misses and pays the write
 * premium. This is the structural shape of multi-agent fan-out — several
 * sub-agents sharing one system prompt and tool catalogue, dispatched
 * together. The official Claude Agent SDK subagents page documents exactly
 * this dispatch pattern: several `Agent` tool calls issued in one message
 * are "launched... simultaneously" (code.claude.com/docs/en/agent-sdk/subagents);
 * it also documents that a subagent's own system prompt is NOT inherited
 * from its parent, which is why this fixture models fresh, same-role,
 * same-tools sub-agent instances sharing a prefix with each other — not a
 * persistent per-role conversation carried across rounds, which is what
 * `evals/run-workload-matrix.ts`'s existing `multiAgentTeam()` fixture
 * models instead, 4 SECONDS apart per agent. That spacing is far longer
 * than any realistic cache-write time-to-first-byte for a ~2,200-token
 * prefix (see the latency model below), so it never actually exercises a
 * race: this is a genuinely different, and more realistic, fixture for the
 * same workload shape, not a variant of the existing one.
 *
 * TONIGHT'S PREREQUISITE (owed since 2026-10-22's findings and restated in
 * every lever-backlog entry for this shape): the cache simulator assumed a
 * cache write becomes instantly readable the moment it is sent, so two
 * requests at the exact same `atSeconds` already looked like "one write,
 * one read" even though no real network round trip could have happened
 * between them. That silently modelled the LEVER this file measures as
 * already shipped, for every workload, always-on, for free. The "ARM 0"
 * below reproduces that bug on purpose, side by side with the fix
 * (`writeAvailabilityLatencySeconds` on `CachePolicy`, packages/core/src/cache-simulator.ts),
 * so the size of the correction is visible, not just asserted.
 *
 * Honesty constraints:
 * - The write-availability latency function is an ESTIMATE: no provider
 *   publishes a cache-write time-to-first-byte benchmark (checked tonight;
 *   see docs/rnd/2026-11-08-NOTES.md). The constants below are a reasoned
 *   order of magnitude (network/queueing overhead + prefill time at an
 *   assumed throughput), not a measurement, and every number this file
 *   prints under "corrected" is labelled accordingly.
 * - The lever itself (FanoutSerializer, packages/sdk-js/src/fanout-serializer.ts,
 *   wired into the proxy behind `serializeFanoutWrites`) is lossless: it
 *   changes when a request is sent, never a byte the model reads. No
 *   replay gate applies.
 * - Collision frequency, not just per-racer saving, is the thing that was
 *   missing from the original P5 estimate. This fixture makes that
 *   assumption explicit (one cold-start burst per independent session,
 *   spaced past the TTL) instead of hiding it inside a continuous-traffic
 *   average; the per-burst and whole-fixture numbers are reported
 *   separately so neither can be read as the other.
 */

const AT = "2026-10-27";
const price = lookupPrice(publishedModelPrices, { provider: "anthropic", model: "Sonnet 5.5", at: AT });
if (price.status !== "priced") throw new Error("price lookup failed for Sonnet 5.5");

// --- The shared cacheable prefix: one role's system prompt + tool catalogue ---

const SYSTEM_PROMPT =
  "You are a specialist sub-agent spawned for one focused subtask. Work only from the task given to you, " +
  "cite what you relied on, keep your final report terse, and return control the moment the subtask is done. ".repeat(14);

const TOOLS = Array.from({ length: 10 }, (_, index) => ({
  name: `tool_${index}`,
  description:
    `Tool ${index} operates on subsystem ${index}. It validates its input against the schema, retries once on ` +
    "transient failure, never mutates shared state without a lock, and returns a compact JSON result. " +
    "Use it only when the task names this subsystem explicitly.",
  input_schema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    additionalProperties: false,
    properties: { id: { type: "string" }, scope: { type: "string" }, dryRun: { type: "boolean" } },
    required: ["id"],
  },
}));

const SHARED_PREFIX = SYSTEM_PROMPT + JSON.stringify(TOOLS);
const sharedPrefixTokens = approximateTokenCount(SHARED_PREFIX);

// --- Write-availability latency model (ESTIMATE — see header) -------------

const BASE_DISPATCH_SECONDS = 0.3;
const ASSUMED_PREFILL_TOKENS_PER_SECOND = 15_000;

/** ESTIMATE: time from a write being sent to its response headers arriving. */
function estimatedWriteAvailabilityLatencySeconds(totalPromptTokens: number): number {
  return BASE_DISPATCH_SECONDS + totalPromptTokens / ASSUMED_PREFILL_TOKENS_PER_SECOND;
}

const CORRECTED_POLICY: CachePolicy = {
  ...ANTHROPIC_CACHE_5M,
  writeAvailabilityLatencySeconds: estimatedWriteAvailabilityLatencySeconds,
};

// --- The fixture: independent cold-start fan-out bursts --------------------

const AGENTS_PER_BURST = 5;
const BURSTS = 8;
// Spaced well past the 300s TTL: each burst is its own independent session,
// not a continuation — so every burst genuinely starts with an empty cache,
// which is the only time this race can happen at all (a request that finds
// ANY already-visible entry for the shared prefix never races).
const SECONDS_BETWEEN_BURSTS = 400;
// Real concurrent dispatch (several `Agent` calls issued in one message) is
// event-loop/network jitter, not a deliberate gap: milliseconds, not seconds.
const DISPATCH_JITTER_SECONDS = [0, 0.004, 0.009, 0.015, 0.022];

type Tagged = SimulatedRequest & { burst: number; slot: number };

function fanoutBurst(): Tagged[] {
  const stream: Tagged[] = [];
  for (let burst = 0; burst < BURSTS; burst += 1) {
    for (let slot = 0; slot < AGENTS_PER_BURST; slot += 1) {
      const task = `Subtask ${burst}.${slot}: investigate ticket ${100 + burst * AGENTS_PER_BURST + slot} and report findings.`;
      stream.push({
        atSeconds: burst * SECONDS_BETWEEN_BURSTS + DISPATCH_JITTER_SECONDS[slot]!,
        prompt: `${SHARED_PREFIX}\n${task}`,
        outputTokens: 220,
        burst,
        slot,
      });
    }
  }
  return stream;
}

/**
 * The lever, applied as a RE-TIMING of the request stream: FanoutSerializer
 * holds every request but the first for a key until the first's response
 * has started, then releases it — which is exactly "send no earlier than
 * the first write's availability". Simulating that as a timestamp shift
 * reproduces the proxy's real effect without needing a live server here.
 */
function applySerialization(requests: readonly Tagged[]): SimulatedRequest[] {
  const firstAvailableAtByBurst = new Map<number, number>();
  for (const request of requests) {
    if (!firstAvailableAtByBurst.has(request.burst)) {
      const totalTokens = approximateTokenCount(request.prompt);
      firstAvailableAtByBurst.set(
        request.burst,
        request.atSeconds + estimatedWriteAvailabilityLatencySeconds(totalTokens),
      );
    }
  }
  return requests.map((request) => {
    if (request.slot === 0) return request; // the first sender: never held
    const availableAt = firstAvailableAtByBurst.get(request.burst)!;
    return { ...request, atSeconds: Math.max(request.atSeconds, availableAt) };
  });
}

// --- Measure -----------------------------------------------------------------

const requests = fanoutBurst();
const serialized = applySerialization(requests);

const arm0_today = simulateCache(requests, ANTHROPIC_CACHE_5M, price.price);
const arm1_correctedNoLever = simulateCache(requests, CORRECTED_POLICY, price.price);
const arm2_correctedWithLever = simulateCache(serialized, CORRECTED_POLICY, price.price);
const uncached = simulateCache(requests, ANTHROPIC_NO_CACHE, price.price);

function pct(saved: number, base: number): string {
  return base === 0 ? "n/a" : `${((saved / base) * 100).toFixed(1)}%`;
}

console.log(`shared prefix: ${sharedPrefixTokens} tokens (system + ${TOOLS.length} tool schemas)`);
console.log(`fixture: ${BURSTS} independent fan-out bursts x ${AGENTS_PER_BURST} sub-agents, ${SECONDS_BETWEEN_BURSTS}s apart (TTL 300s)`);
console.log(`write-availability latency for this prefix size: ~${estimatedWriteAvailabilityLatencySeconds(sharedPrefixTokens + 20).toFixed(2)}s (ESTIMATE, see header)`);
console.log();
console.log("ARM 0  today (uncorrected simulator — no concurrency semantics):");
console.log(`       cost $${arm0_today.totalCostUsd.toFixed(4)}  hit rate ${(arm0_today.hitRate * 100).toFixed(1)}%  vs uncached ${pct(uncached.totalCostUsd - arm0_today.totalCostUsd, uncached.totalCostUsd)}`);
console.log();
console.log("ARM 1  corrected simulator, NO lever (racers each pay the write premium):");
console.log(`       cost $${arm1_correctedNoLever.totalCostUsd.toFixed(4)}  hit rate ${(arm1_correctedNoLever.hitRate * 100).toFixed(1)}%  vs uncached ${pct(uncached.totalCostUsd - arm1_correctedNoLever.totalCostUsd, uncached.totalCostUsd)}`);
console.log(`       racing-write misses: ${arm1_correctedNoLever.missReasons["racing-write"] ?? 0} of ${requests.length} requests`);
console.log();
console.log("ARM 2  corrected simulator, WITH the serialization lever (FanoutSerializer re-timing):");
console.log(`       cost $${arm2_correctedWithLever.totalCostUsd.toFixed(4)}  hit rate ${(arm2_correctedWithLever.hitRate * 100).toFixed(1)}%  vs uncached ${pct(uncached.totalCostUsd - arm2_correctedWithLever.totalCostUsd, uncached.totalCostUsd)}`);
console.log();
console.log("LEVER CREDIT — the delta this lever actually earns, against the HONEST (corrected) no-lever baseline, never the bugged arm 0:");
const leverSavingUsd = arm1_correctedNoLever.totalCostUsd - arm2_correctedWithLever.totalCostUsd;
console.log(`       $${leverSavingUsd.toFixed(4)} = ${pct(leverSavingUsd, arm1_correctedNoLever.totalCostUsd)} of the no-lever corrected cost (whole fixture, diluted by each agent's own non-shared task text)`);
console.log();
console.log("BUG SIZE — what the old (uncorrected) simulator was silently crediting to NOTHING:");
const bugSizeUsd = arm1_correctedNoLever.totalCostUsd - arm0_today.totalCostUsd;
console.log(`       arm0 (today) UNDERSTATED this fixture's true no-lever cost by $${bugSizeUsd.toFixed(4)} (${pct(bugSizeUsd, arm1_correctedNoLever.totalCostUsd)} of the honest no-lever cost) — with zero lever code anywhere in the codebase before tonight.`);
console.log(`       arm0 cost $${arm0_today.totalCostUsd.toFixed(4)} vs arm2 (lever actually applied) $${arm2_correctedWithLever.totalCostUsd.toFixed(4)} — within rounding, arm0 === arm2: the bug was already simulating this lever, for free, always-on, by accident.`);
console.log();

// Isolate the per-racer effect on JUST the shared prefix, undiluted by each
// agent's own unique task text — the number the backlog's "(1.25x-0.1x)/1.25x
// ~= 92% of the shared-prefix cost per actual racer" claim refers to.
const perRacerWriteUsd = (sharedPrefixTokens / 1_000_000) * (price.price.cacheWriteInputPerMillion ?? price.price.inputPerMillion * ANTHROPIC_CACHE_5M.writeMultiplier);
const perRacerReadUsd = (sharedPrefixTokens / 1_000_000) * (price.price.cachedInputPerMillion ?? price.price.inputPerMillion * ANTHROPIC_CACHE_5M.readMultiplier);
const racersPerBurst = AGENTS_PER_BURST - 1; // the first sender never races
const totalRacers = BURSTS * racersPerBurst;
console.log(`PER-RACER ISOLATED EFFECT (shared-prefix tokens only, ${sharedPrefixTokens} tok): write $${perRacerWriteUsd.toFixed(5)} vs read $${perRacerReadUsd.toFixed(5)} = ${pct(perRacerWriteUsd - perRacerReadUsd, perRacerWriteUsd)} per converted racer`);
console.log(`COLLISION VOLUME in this fixture: ${totalRacers} racers across ${BURSTS} cold-start bursts (1 non-racing sender per burst) — basis: reasoned from documented cache-availability semantics + this fixture's own burst count, NOT measured production collision frequency (still the top missing input per the backlog).`);
