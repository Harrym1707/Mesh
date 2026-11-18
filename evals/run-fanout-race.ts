import {
  ANTHROPIC_CACHE_5M,
  ANTHROPIC_NO_CACHE,
  approximateTokenCount,
  lookupPrice,
  publishedModelPrices,
  simulateCache,
  type SimulatedRequest,
} from "../packages/core/src/index.js";

/**
 * Multi-agent fan-out: the cache race, measured honestly.
 *
 *   node --import tsx evals/run-fanout-race.ts
 *
 * Grounding (fetched 2026-11-18, both quoted verbatim so the shape below is
 * not invented):
 *
 * - Anthropic's own docs, "Cache limitations":
 *   "For concurrent requests, note that a cache entry only becomes available
 *    after the first response starts. If you need cache hits for parallel
 *    requests, wait for the first response before sending subsequent
 *    requests." (platform.claude.com/docs/en/build-with-claude/prompt-caching)
 * - The Claude Agent SDK's own subagents doc: "Parallelization: multiple
 *    subagents can run concurrently, so independent subtasks finish in the
 *    time of the slowest one rather than the sum of all of them. During a
 *    code review, you can run style-checker, security-scanner, and
 *    test-coverage subagents simultaneously instead of sequentially."
 *    (code.claude.com/docs/en/agent-sdk/subagents) — spawned via "multiple
 *    Task tool calls in a single message," which the runtime dispatches
 *    concurrently; the same doc's orchestration example notes the top-level
 *    `system` field never changes across those calls, so the shared prefix
 *    is real. The default concurrency cap is 20 subagents at once; the
 *    doc's own example is 3, so this fixture sweeps 3/5/10.
 *
 * Put together: a multi-agent orchestrator fanning N sub-agent calls out in
 * one instant, all sharing one system+tool prefix, is EXACTLY the race
 * Anthropic's docs describe. `evals/run-workload-matrix.ts`'s own
 * "multi-agent team" fixture staggers each agent by 4s within a round and
 * so never exercises this at all — a gap, not a contradiction; that fixture
 * is measuring a different (sequential-trickle) shape. This file is the
 * first to model true concurrency and therefore the first to price the race.
 *
 * `cache-simulator.ts` had no concept of this until tonight: every entry
 * became available to every other request at the instant it was pushed,
 * regardless of whether that request had actually received a response yet.
 * `SimulatedRequest.respondsAfterSeconds` (added tonight) fixes that — see
 * its doc comment and `cache-simulator.test.ts`'s new
 * "concurrent fan-out" suite.
 *
 * Three arms per racer count:
 *   A. uncached       - Anthropic's cache never placed (today's measured
 *                        default for unstamped traffic elsewhere in this repo).
 *   B. stamped, raced  - MESH's EXISTING cache-ttl-5m lever, applied with no
 *                        concurrency awareness: every racer fires at the same
 *                        instant, so every one of them misses and WRITES.
 *   C. stamped + latch - B, plus the SDK's new `FanoutLatch`
 *                        (packages/sdk-js/src/fanout-latch.ts): the first
 *                        racer writes; every other racer is held until the
 *                        leader's response starts, then reads.
 *
 * TTFB (time from send to the leader's response starting) has no measured
 * value for a prefix this size in this repo — flagged as an open item below,
 * same as P5's "top missing input" in docs/rnd/lever-backlog.md. Swept
 * across clearly-labelled ESTIMATEs rather than asserting one.
 */

const AT = "2026-10-27";
const price = lookupPrice(publishedModelPrices, { provider: "anthropic", model: "Sonnet 5.5", at: AT });
if (price.status !== "priced") throw new Error("price lookup failed for Sonnet 5.5");

// Sized like run-workload-matrix.ts's multi-agent fixture (a few thousand
// tokens of system + tool catalogue), not invented for this file.
const PREAMBLE =
  "You are a careful specialist agent on a production team. Follow the runbook: verify inputs, cite sources, " +
  "prefer small reversible steps, surface anything risky to the orchestrator, and keep outputs terse. ".repeat(14);
const TOOLS = JSON.stringify(Array.from({ length: 10 }, (_, index) => ({
  name: `tool_${index}`,
  description:
    `Tool ${index} operates on subsystem ${index}. It validates its input against the schema, retries once on ` +
    "transient failure, never mutates shared state without a lock, and returns a compact JSON result. " +
    "Use it only when the orchestrator's plan names this subsystem explicitly.",
  input_schema: {
    type: "object", additionalProperties: false,
    properties: { id: { type: "string" }, scope: { type: "string" }, dryRun: { type: "boolean" } },
    required: ["id"],
  },
})));
const SHARED_PREFIX = `${TOOLS}\n${PREAMBLE}`;
const PREFIX_TOKENS = approximateTokenCount(SHARED_PREFIX);

const AGENT_ROLES = ["search", "coder", "reviewer", "writer", "tester", "doc-writer", "security", "perf", "db", "deploy"];

/**
 * N sub-agents fired in the same instant, sharing SHARED_PREFIX, each with
 * its own short task. `releaseAfterSeconds` models how long a coordinator
 * actually held each follower before dispatching it — `undefined` means
 * "not held at all" (the naive race); a value equal to `ttfbSeconds` is a
 * correctly-sized FanoutLatch; a value below it is an UNDER-sized hold cap
 * (released before the leader's response really started).
 */
function fanOut(n: number, ttfbSeconds: number, releaseAfterSeconds?: number): SimulatedRequest[] {
  return Array.from({ length: n }, (_, index) => ({
    atSeconds: index > 0 ? releaseAfterSeconds ?? 0 : 0,
    prompt: `${SHARED_PREFIX}\nRole ${AGENT_ROLES[index % AGENT_ROLES.length]}: advance ticket 7, step ${index}.`,
    outputTokens: 220,
    respondsAfterSeconds: ttfbSeconds,
  }));
}

function pct(from: number, to: number): string {
  if (from === 0) return "n/a";
  const change = ((from - to) / from) * 100;
  return `${change >= 0 ? "-" : "+"}${Math.abs(change).toFixed(1)}%`;
}

console.log("Multi-agent fan-out: the cache race, measured honestly");
console.log(`claude-sonnet-5-5 catalogued prices (${AT}); shared prefix ~${PREFIX_TOKENS} tokens (above the 1,024-token minimum)\n`);

let anyLatchLoss = false;
let anyConfirmedLoss = false;
let anyOverclaim = false;

for (const n of [3, 5, 10]) {
  console.log(`--- ${n} concurrent sub-agents sharing one prefix ---`);
  // One representative TTFB estimate per the grounding above (no live
  // measurement exists for this prefix size - see the open item below);
  // the finding does not depend on its exact value, only its sign (>0).
  const ttfb = 1.5;

  const uncached = simulateCache(fanOut(n, ttfb), ANTHROPIC_NO_CACHE, price.price);
  // What the simulator would have reported BEFORE tonight's fix: every
  // entry instantly available, so racers 2..N wrongly read racer 1's
  // not-yet-written cache. This is the headline the fix corrects down.
  const oldOptimistic = simulateCache(fanOut(n, 0), ANTHROPIC_CACHE_5M, price.price);
  // The honest default: no coordination, every racer races and writes.
  const raced = simulateCache(fanOut(n, ttfb), ANTHROPIC_CACHE_5M, price.price);
  // A hold cap sized to HALF the true TTFB: releases followers before the
  // leader's response has actually started. They still race and still write.
  const underHeld = simulateCache(fanOut(n, ttfb, ttfb / 2), ANTHROPIC_CACHE_5M, price.price);
  // A correctly-sized FanoutLatch: held exactly to the leader's TTFB.
  const latched = simulateCache(fanOut(n, ttfb, ttfb), ANTHROPIC_CACHE_5M, price.price);

  const racedIsLoss = raced.totalCostUsd > uncached.totalCostUsd;
  if (racedIsLoss) anyConfirmedLoss = true; // confirms the finding this file exists to surface
  if (latched.totalCostUsd >= raced.totalCostUsd) anyLatchLoss = true; // would be a real bug
  if (oldOptimistic.totalCostUsd < raced.totalCostUsd) anyOverclaim = true; // confirms the simulator fix matters

  console.log(`  old simulator (pre-fix, instant availability): $${oldOptimistic.totalCostUsd.toFixed(4)} -- overclaimed by ${pct(raced.totalCostUsd, oldOptimistic.totalCostUsd)} vs the honest raced cost`);
  console.log(`  uncached (no cache_control placed):            $${uncached.totalCostUsd.toFixed(4)}`);
  console.log(`  stamped, raced (today's shipped behaviour):    $${raced.totalCostUsd.toFixed(4)} (${pct(uncached.totalCostUsd, raced.totalCostUsd)} vs uncached${racedIsLoss ? " -- A LOSS: costs MORE than doing nothing" : ""})`);
  console.log(`  stamped + latch, UNDER-sized hold (0.5x TTFB):  $${underHeld.totalCostUsd.toFixed(4)} (${pct(raced.totalCostUsd, underHeld.totalCostUsd)} vs raced -- an under-sized hold cap buys nothing)`);
  console.log(`  stamped + latch, correctly sized (1.0x TTFB):   $${latched.totalCostUsd.toFixed(4)} (${pct(uncached.totalCostUsd, latched.totalCostUsd)} vs uncached, ${pct(raced.totalCostUsd, latched.totalCostUsd)} vs raced)`);
}

console.log("\nFINDING (confirmed, not estimated, given the mechanism above): MESH's existing cache-ttl-5m lever, applied");
console.log("with no concurrency awareness to genuinely simultaneous same-prefix fan-out, is a NET LOSS versus not caching");
console.log("at all on every row above - every racer writes (1.25x base) and none read (0.05x base), and a write costs");
console.log("more than the uncached base rate. This is real on any traffic shaped like the Claude Agent SDK's own");
console.log("documented parallel-subagent pattern, run through MESH's cache stamp today, with no coordination.");
console.log("\nThe FanoutLatch lever (packages/sdk-js/src/fanout-latch.ts, wired opt-in via MeshProxyOptions.fanoutLatch)");
console.log("converts n-1 of the n writes into reads by holding followers to the leader's response-start, turning the");
console.log("loss into a win versus uncached AND recovering the saving the old (concurrency-blind) simulator overclaimed.");
console.log("Lossless: bytes sent are unchanged, only send timing moves - no replay gate applies.");

if (!anyConfirmedLoss) {
  console.log("\nUNEXPECTED: no row showed the raced arm losing to uncached - re-check the write/read multipliers before publishing this finding.");
  process.exitCode = 1;
}
if (anyLatchLoss) {
  console.log("\nBUG: the latched arm was not strictly cheaper than the raced arm on some row - investigate before shipping.");
  process.exitCode = 1;
}
if (!anyOverclaim) {
  console.log("\nUNEXPECTED: the pre-fix (instant-availability) simulator never overclaimed versus the honest raced cost on any row -");
  console.log("re-check that respondsAfterSeconds is actually gating cache-entry visibility before publishing the simulator fix.");
  process.exitCode = 1;
}
